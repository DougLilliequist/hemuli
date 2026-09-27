#!/usr/bin/env node
// hemuli MCP server (stdio): long-lived headless Chromium sessions for interactively
// debugging WebGPU / WebGL builds. Each session is its own browser with its own temp profile
// and localhost server. Idle sessions are reaped; everything is torn down when the client goes.
// Nothing may write to stdout except the MCP transport; diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startReaper } from '../lib/reaper.mjs';

// core.mjs pulls in puppeteer (~25 MB); every Claude session runs one of these servers, most never
// open a browser, so it is loaded on the first tool call that needs one.
let corePromise;
const core = () => (corePromise ??= import('../lib/core.mjs'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const MAX_SESSIONS = Number(process.env.HEMULI_MAX_SESSIONS) || 8;
const IDLE_MS = (Number(process.env.HEMULI_IDLE_MINUTES) || 15) * 60_000;
const DEFAULT_TIMEOUT = 30_000;

const WAIT_SPECS = '"<ms>" sleep · "idle" network idle · "frames:<n>" rAF ticks · "selector:<css>" element exists · ' +
  '"js:<expr>" expression truthy · "console:<regex>" console message matches';

// ---------- session registry ----------
const sessions = new Map(); // id -> { session, lastUsed, gpuSeen: Map<key,count>, cursor }
// If this server is killed outright (Claude Code exiting, TerminateProcess on Windows), no exit
// handler runs; the reaper then kills the browsers and deletes their profiles. It is a second node
// process (~13 MB), so it only runs while sessions exist.
let reaper;
let nextId = 1;

function resetCursors(entry) {
  entry.cursor = { console: 0, pageErrors: 0, httpErrors: 0, requestsFailed: 0 };
  entry.gpuSeen = new Map();
}

function get(id) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No session "${id}". Open one with the open tool (live: ${[...sessions.keys()].join(', ') || 'none'}).`);
  if (entry.session.crashed) {
    sessions.delete(id);
    entry.session.close();
    throw new Error(`Session "${id}" crashed (browser disconnected) and was removed. Open a new one.`);
  }
  entry.lastUsed = Date.now();
  return entry;
}

async function closeEntry(id) {
  const entry = sessions.get(id);
  if (!entry) return false;
  sessions.delete(id);
  const pid = entry.session.browser?.process()?.pid;
  await entry.session.close();
  reaper?.remove(pid);
  if (!sessions.size && reaper) { reaper.stop(); reaper = null; }
  return true;
}

const idleTimer = setInterval(() => {
  for (const [id, e] of sessions) if (Date.now() - e.lastUsed > IDLE_MS) {
    console.error(`[hemuli] closing idle session ${id}`);
    closeEntry(id);
  }
}, 30_000);
idleTimer.unref();

let shuttingDown = false;
async function shutdownAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...sessions.keys()].map(closeEntry));
  process.exit(code);
}
process.on('SIGINT', () => shutdownAll(0));
process.on('SIGTERM', () => shutdownAll(0));
process.on('exit', () => { for (const e of sessions.values()) e.session.closeSync(); });
process.stdin.on('close', () => shutdownAll(0));

// ---------- helpers ----------
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const errorResult = (e) => ({ isError: true, content: [{ type: 'text', text: e?.message || String(e) }] });

/** Wrap a tool handler: errors become isError results instead of protocol failures. */
const tool = (fn) => async (args) => { try { return await fn(args); } catch (e) { return errorResult(e); } };

/** Everything new since the last call for this session, plus the full failure list for the current page load. */
async function delta(entry, { includeApp = false } = {}) {
  const s = entry.session;
  const out = { session: entry.id, url: s.page.url(), failures: [] };
  let gpuErrors = [];
  try {
    const state = await s.pageState(5_000);
    if (state) {
      gpuErrors = state.errors;
      if (includeApp) out.app = state.app;
    }
  } catch (e) {
    s.fail('page-unresponsive', e.message);
  }
  out.failures = s.failures(gpuErrors);
  out.ok = out.failures.length === 0;

  const fresh = {};
  for (const k of Object.keys(entry.cursor)) {
    const arr = s.log[k];
    const items = arr.slice(entry.cursor[k]);
    entry.cursor[k] = arr.length;
    if (items.length) fresh[k] = items;
  }
  if (s.log.consoleDropped) fresh.consoleDropped = s.log.consoleDropped;
  const newGpu = [];
  for (const e of gpuErrors) {
    const key = `${e.kind}|${e.message}`;
    const n = e.count || 1;
    const prev = entry.gpuSeen.get(key) || 0;
    if (n > prev) { newGpu.push(prev ? { ...e, newOccurrences: n - prev } : e); entry.gpuSeen.set(key, n); }
  }
  if (newGpu.length) fresh.gpuErrors = newGpu;
  out.new = fresh;
  return out;
}

async function runWaits(s, waits, timeout) {
  const done = [];
  for (const spec of waits) {
    const t = Date.now();
    try { await s.wait(spec, timeout); done.push({ spec, ms: Date.now() - t }); }
    catch (e) { done.push({ spec, error: e.message }); s.fail('wait', `${spec}: ${e.message}`); break; }
  }
  return done;
}

async function load(entry, url, waits, timeout, how = 'goto') {
  resetCursors(entry);
  const s = entry.session;
  let navError;
  try {
    if (how === 'reload') await s.reload(timeout); else await s.goto(url, timeout);
  } catch (e) { navError = e.message; s.fail('navigation', e.message); }
  const waited = navError ? [] : await runWaits(s, waits, timeout);
  const out = await delta(entry, { includeApp: true });
  if (waited.length) out.waits = waited;
  return out;
}

// ---------- server ----------
const server = new McpServer(
  { name: 'hemuli', version: PKG.version },
  {
    instructions:
      'Interactive headless Chromium with a real GPU (WebGPU on Metal, WebGL via ANGLE) for debugging WebGPU/WebGL builds. ' +
      'Workflow: open (returns a session id and the load status) → logs / eval / screenshot / input / wait / fps → reload after rebuilding → close. ' +
      'Sessions are isolated browsers (~65 MB each), closed automatically after ' + IDLE_MS / 60000 + ' idle minutes. ' +
      'For a one-shot pass/fail check, the `hemuli` CLI via Bash is simpler.',
  },
);

server.registerTool('open', {
  title: 'Open session',
  description:
    'Launch a new isolated browser session and load a target. Returns the session id, the load status (failures, console, page/GPU errors) and what the app requested from the GPU. ' +
    'target: http(s) URL, a build directory (served on localhost; opens index.html) or an .html file (its directory is served; append ?query if needed). Omit for a blank secure page. ' +
    `wait: steps run in order after load (default ["1000"]): ${WAIT_SPECS}. ` +
    'For one-shot validation with no follow-up, the hemuli CLI is cheaper.',
  inputSchema: {
    target: z.string().optional().describe('URL, directory, or .html file path (absolute paths recommended)'),
    root: z.string().optional().describe('Directory to serve instead of the target file\'s own directory (for ../assets references)'),
    wait: z.array(z.string()).optional().describe('Wait steps after load, default ["1000"]'),
    width: z.number().int().positive().optional().describe('Viewport width, default 1280'),
    height: z.number().int().positive().optional().describe('Viewport height, default 720'),
    dpr: z.number().positive().optional().describe('Device pixel ratio, default 1'),
    coi: z.boolean().optional().describe('Send COOP/COEP headers (SharedArrayBuffer / wasm threads)'),
    ignore: z.array(z.string()).optional().describe('Regexes: matching errors are still listed but not counted as failures'),
    flags: z.array(z.string()).optional().describe('Extra Chromium switches'),
    engine: z.enum(['shell', 'chrome']).optional().describe('shell (lean; default on macOS/Linux) or chrome (full Chrome for Testing; default on Windows). Use chrome if warnings report software rendering'),
    timeout_ms: z.number().int().positive().optional().describe('Per-step timeout, default 30000'),
  },
}, tool(async (a) => {
  if (sessions.size >= MAX_SESSIONS)
    throw new Error(`Session limit (${MAX_SESSIONS}) reached. Close one first: ${[...sessions.keys()].join(', ')}`);
  const { Session } = await core();
  const s = new Session({ width: a.width, height: a.height, dpr: a.dpr, coi: a.coi, ignore: a.ignore, flags: a.flags, engine: a.engine, protocolTimeout: 90_000 });
  const id = `s${nextId++}`;
  const entry = { id, session: s, lastUsed: Date.now() };
  resetCursors(entry);
  try {
    await s.start();
    (reaper ??= startReaper()).add(s.browser.process()?.pid, s.profileDir);
    const url = s.resolve(a.target, a.root);
    sessions.set(id, entry);
    s.onNavigate = () => { entry.gpuSeen = new Map(); };
    const out = await load(entry, url, a.wait ?? (a.target ? ['1000'] : []), a.timeout_ms ?? DEFAULT_TIMEOUT);
    const { warnings } = await s.gpuCheck(10_000).catch(() => ({ warnings: [] }));
    if (warnings.length) out.warnings = warnings;
    out.engine = s.engine;
    return text(out);
  } catch (e) {
    sessions.delete(id);
    await s.close();
    throw e;
  }
}));

server.registerTool('navigate', {
  title: 'Navigate',
  description: `Load a different target in an existing session (same forms as open). Clears collected logs and returns the new load status. wait: ${WAIT_SPECS}.`,
  inputSchema: {
    session: z.string(),
    target: z.string(),
    root: z.string().optional(),
    wait: z.array(z.string()).optional().describe('Default ["1000"]'),
    timeout_ms: z.number().int().positive().optional(),
  },
}, tool(async (a) => {
  const entry = get(a.session);
  const url = entry.session.resolve(a.target, a.root);
  return text(await load(entry, url, a.wait ?? ['1000'], a.timeout_ms ?? DEFAULT_TIMEOUT));
}));

server.registerTool('reload', {
  title: 'Reload',
  description: 'Reload the current page, e.g. after rebuilding (files are served with no caching). Clears collected logs and returns the new load status.',
  inputSchema: {
    session: z.string(),
    wait: z.array(z.string()).optional().describe('Default ["1000"]'),
    timeout_ms: z.number().int().positive().optional(),
  },
}, tool(async (a) => {
  const entry = get(a.session);
  return text(await load(entry, null, a.wait ?? ['1000'], a.timeout_ms ?? DEFAULT_TIMEOUT, 'reload'));
}));

server.registerTool('logs', {
  title: 'Logs and errors',
  description:
    'What happened since the previous call: new console messages, page errors (exceptions, unhandled rejections), GPU errors ' +
    '(WGSL errors with line/col/source, WebGPU validation errors with counts, device lost, GLSL compile/link logs, pending gl.getError), HTTP errors. ' +
    '"failures" is always the full deduplicated list for the current page load; "ok" is true when it is empty. Also returns app info (contexts, requested features, canvases).',
  inputSchema: { session: z.string() },
}, tool(async (a) => text(await delta(get(a.session), { includeApp: true }))));

server.registerTool('eval', {
  title: 'Evaluate JS',
  description:
    'Run JavaScript in the page: an expression, or a function body using `return`. May use await. Returns the JSON-serialized value. ' +
    'Useful for inspecting app state, toggling settings, or reading back GPU buffers via the app\'s own objects.',
  inputSchema: {
    session: z.string(),
    js: z.string(),
    timeout_ms: z.number().int().positive().optional(),
  },
}, tool(async (a) => {
  const { session } = get(a.session);
  return text(await session.eval(a.js, a.timeout_ms ?? DEFAULT_TIMEOUT));
}));

server.registerTool('wait', {
  title: 'Wait',
  description: `Wait for a condition. spec: ${WAIT_SPECS}.`,
  inputSchema: {
    session: z.string(),
    spec: z.string(),
    timeout_ms: z.number().int().positive().optional(),
  },
}, tool(async (a) => {
  const { session } = get(a.session);
  const t = Date.now();
  await session.wait(a.spec, a.timeout_ms ?? DEFAULT_TIMEOUT);
  return text({ spec: a.spec, ms: Date.now() - t });
}));

server.registerTool('screenshot', {
  title: 'Screenshot',
  description:
    'Capture the viewport (or one element via selector, e.g. "canvas") and return the image plus stats: dominantColor, dominantFraction, distinctColors, and ' +
    'blank (true when ≥99.5% one color, i.e. probably rendered nothing). samples returns RGBA at [x,y] CSS-pixel points relative to the capture.',
  inputSchema: {
    session: z.string(),
    selector: z.string().optional(),
    samples: z.array(z.tuple([z.number(), z.number()])).optional(),
    save_path: z.string().optional().describe('Also write the PNG here'),
    include_image: z.boolean().optional().describe('Default true; false returns only stats'),
  },
}, tool(async (a) => {
  const { session } = get(a.session);
  const { base64, stats } = await session.screenshot({ selector: a.selector, samples: a.samples ?? [] });
  if (a.save_path) {
    mkdirSync(path.dirname(path.resolve(a.save_path)), { recursive: true });
    writeFileSync(a.save_path, Buffer.from(base64, 'base64'));
    stats.savedTo = path.resolve(a.save_path);
  }
  const content = [{ type: 'text', text: JSON.stringify(stats, null, 2) }];
  if (a.include_image !== false) content.unshift({ type: 'image', data: base64, mimeType: 'image/png' });
  return { content };
}));

const Action = z.object({
  type: z.enum(['click', 'move', 'down', 'up', 'drag', 'wheel', 'key', 'type', 'pause']),
  x: z.number().optional(), y: z.number().optional(),
  to_x: z.number().optional().describe('drag end'), to_y: z.number().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  steps: z.number().int().positive().optional().describe('Intermediate mouse moves for move/drag, default 10'),
  delta_x: z.number().optional(), delta_y: z.number().optional().describe('wheel'),
  key: z.string().optional().describe('For key: e.g. "Enter", "ArrowLeft", "KeyW", "Shift+KeyR" (modifiers joined with +)'),
  text: z.string().optional().describe('For type'),
  ms: z.number().optional().describe('For pause, or hold time for key'),
});

server.registerTool('input', {
  title: 'Mouse / keyboard input',
  description:
    'Send real input events in order, coordinates in CSS pixels of the viewport. Types: click{x,y,button}, move{x,y,steps}, down/up{button}, ' +
    'drag{x,y,to_x,to_y,steps,button} (e.g. orbit a camera), wheel{x,y,delta_x,delta_y} (zoom), key{key,ms} (press, optionally held), type{text}, pause{ms}. ' +
    'Follow with screenshot or logs to see the effect.',
  inputSchema: { session: z.string(), actions: z.array(Action).min(1) },
}, tool(async (a) => {
  const { session } = get(a.session);
  const { withTimeout } = await core();
  const { mouse, keyboard } = session.page;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async () => {
    for (const act of a.actions) {
      const button = act.button ?? 'left';
      switch (act.type) {
        case 'click': await mouse.click(act.x ?? 0, act.y ?? 0, { button }); break;
        case 'move': await mouse.move(act.x ?? 0, act.y ?? 0, { steps: act.steps ?? 10 }); break;
        case 'down': if (act.x !== undefined) await mouse.move(act.x, act.y ?? 0); await mouse.down({ button }); break;
        case 'up': if (act.x !== undefined) await mouse.move(act.x, act.y ?? 0); await mouse.up({ button }); break;
        case 'drag':
          await mouse.move(act.x ?? 0, act.y ?? 0);
          await mouse.down({ button });
          await mouse.move(act.to_x ?? 0, act.to_y ?? 0, { steps: act.steps ?? 10 });
          await mouse.up({ button });
          break;
        case 'wheel':
          if (act.x !== undefined) await mouse.move(act.x, act.y ?? 0);
          await mouse.wheel({ deltaX: act.delta_x ?? 0, deltaY: act.delta_y ?? 0 });
          break;
        case 'key': {
          const parts = String(act.key).split('+');
          const main = parts.pop();
          for (const m of parts) await keyboard.down(m);
          if (act.ms) { await keyboard.down(main); await sleep(act.ms); await keyboard.up(main); } else await keyboard.press(main);
          for (const m of parts.reverse()) await keyboard.up(m);
          break;
        }
        case 'type': await keyboard.type(act.text ?? ''); break;
        case 'pause': await sleep(act.ms ?? 100); break;
      }
    }
  };
  await withTimeout(run(), DEFAULT_TIMEOUT, 'input');
  return text({ done: a.actions.length });
}));

server.registerTool('fps', {
  title: 'Measure frame rate',
  description: 'Measure frames delivered over N seconds (p50/p95/max frame time) and the CPU time the app spends in its requestAnimationFrame callbacks. GPU execution time is not included.',
  inputSchema: { session: z.string(), seconds: z.number().positive().max(30).optional().describe('Default 2') },
}, tool(async (a) => {
  const { session } = get(a.session);
  return text(await session.fps(a.seconds ?? 2));
}));

server.registerTool('resize', {
  title: 'Resize viewport',
  description: 'Change the viewport size and/or device pixel ratio (fires resize events in the page).',
  inputSchema: {
    session: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    dpr: z.number().positive().optional(),
  },
}, tool(async (a) => {
  const { session } = get(a.session);
  await session.resize(a.width, a.height, a.dpr);
  return text({ width: a.width, height: a.height, dpr: session.dpr });
}));

server.registerTool('gpu_info', {
  title: 'GPU info',
  description: 'WebGPU adapter (vendor, architecture, fallback?), preferred canvas format, feature count, WebGL/WebGL2 renderer. full=true adds the feature list, limits and WebGL extensions. Uses the given session, or a temporary browser if none.',
  inputSchema: { session: z.string().optional(), full: z.boolean().optional() },
}, tool(async (a) => {
  const { Session, gpuWarnings } = await core();
  const report = async (s) => { const gpu = await s.gpuInfo(!!a.full); return text({ engine: s.engine, warnings: gpuWarnings(gpu, s.engine, s), ...gpu }); };
  if (a.session) return report(get(a.session).session);
  const s = new Session();
  try { await s.start(); return await report(s); } finally { await s.close(); }
}));

server.registerTool('close', {
  title: 'Close session',
  description: 'Close a session: kills its browser and deletes its temp profile. Close sessions when done to free memory.',
  inputSchema: { session: z.string() },
}, tool(async (a) => text({ closed: await closeEntry(a.session) })));

server.registerTool('list_sessions', {
  title: 'List sessions',
  description: 'List open sessions with their current URL, viewport and idle time.',
  inputSchema: {},
}, tool(async () => text([...sessions.values()].map((e) => ({
  session: e.id,
  url: e.session.crashed ? '(crashed)' : e.session.page?.url(),
  viewport: `${e.session.width}x${e.session.height}@${e.session.dpr}`,
  idleSeconds: Math.round((Date.now() - e.lastUsed) / 1000),
})))));

await server.connect(new StdioServerTransport());
console.error(`[hemuli] MCP server ready (max ${MAX_SESSIONS} sessions, idle close after ${IDLE_MS / 60000} min)`);
