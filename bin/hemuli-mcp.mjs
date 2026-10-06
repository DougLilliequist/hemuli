#!/usr/bin/env node
// hemuli MCP server (stdio): long-lived headless Chromium sessions for interactively
// debugging WebGPU / WebGL builds. Each session is its own browser with its own temp profile
// and localhost server. Idle sessions are reaped; everything is torn down when the client goes.
// Nothing may write to stdout except the MCP transport; diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startReaper } from '../lib/reaper.mjs';
import { spawnHost } from '../lib/session-host.mjs';
import { killTree } from '../lib/kill-tree.mjs';

// The server never loads puppeteer: every Claude Code session runs one of these, so it stays under
// 40 MB. Each browser lives in its own host process (lib/session-host.mjs) that exits with it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// Every Claude Code window runs its own server, and a session on a real WebGPU scene holds far more
// than a blank page (GPU memory is system RAM on Apple Silicon), so keep few and drop them quickly.
const MAX_SESSIONS = Number(process.env.HEMULI_MAX_SESSIONS) || 3;
const IDLE_MS = Number(process.env.HEMULI_IDLE_SECONDS) * 1000 || Number(process.env.HEMULI_IDLE_MINUTES) * 60_000 || 30_000;
const IDLE_TEXT = IDLE_MS % 60_000 ? `${IDLE_MS / 1000} s` : `${IDLE_MS / 60_000} min`;
// A call still running after this long counts as stuck, and its session is closed anyway.
const STUCK_MS = Math.max(IDLE_MS, 10 * 60_000);
const DEFAULT_TIMEOUT = 30_000;

const WAIT_SPECS = '"<ms>" sleep · "idle" network idle · "frames:<n>" rAF ticks · "selector:<css>" element exists · ' +
  '"js:<expr>" expression truthy · "console:<regex>" console message matches';

// ---------- session registry ----------
const sessions = new Map(); // id -> { id, host, lastUsed, busy, crashed }
const closedWhy = new Map(); // recently closed id -> reason, for a clearer error on a late call
// If this server is killed outright (Claude Code exiting, TerminateProcess on Windows), no exit
// handler runs. The hosts notice the closed IPC channel and close their browsers; the reaper also
// kills the browsers and deletes their profiles. It is one more node process (~13 MB), so it only
// runs while sessions exist.
let reaper;
let nextId = 1;

function get(id) {
  const entry = sessions.get(id);
  if (!entry) {
    const why = closedWhy.get(id);
    if (why) throw new Error(`Session "${id}" was closed (${why}). Open a new one.`);
    throw new Error(`No session "${id}". Open one with the open tool (live: ${[...sessions.keys()].join(', ') || 'none'}).`);
  }
  if (entry.crashed) {
    closeEntry(id, 'browser crashed');
    throw new Error(`Session "${id}" crashed (browser disconnected) and was removed. Open a new one.`);
  }
  return entry;
}

/** Run an op in the session's host. A session with a call in flight is never idle. */
async function run(entry, op, args) {
  entry.busy++;
  entry.lastUsed = Date.now();
  try { return await entry.host.call(op, args); }
  finally { entry.busy--; entry.lastUsed = Date.now(); }
}
const call = (id, op, args) => run(get(id), op, args);

/**
 * Kill a host, its browser and delete the profile. Normally the host already did this; it covers a
 * host that was SIGKILLed or crashed (the browser is detached, so it would outlive the host).
 */
function cleanupSync(host) {
  const alive = !host.exited;
  if (alive) { try { host.child.kill('SIGKILL'); } catch {} }
  // On Windows the tree is only reachable through a live parent, and PIDs are reused quickly.
  if (host.browserPid && (alive || process.platform !== 'win32')) killTree(host.browserPid);
  if (host.profileDir && existsSync(host.profileDir)) { try { rmSync(host.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
}

async function closeEntry(id, why = 'closed') {
  const entry = sessions.get(id);
  if (!entry) return false;
  sessions.delete(id);
  closedWhy.set(id, why);
  if (closedWhy.size > 50) closedWhy.delete(closedWhy.keys().next().value);
  await entry.host.close();
  cleanupSync(entry.host);
  reaper?.remove(entry.host.browserPid);
  if (!sessions.size && reaper) { reaper.stop(); reaper = null; }
  return true;
}

const idleTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, e] of sessions) {
    const idle = now - e.lastUsed;
    if ((!e.busy && idle > IDLE_MS) || idle > STUCK_MS) {
      const why = e.busy ? `a call was stuck for ${Math.round(idle / 1000)} s` : `idle for ${IDLE_TEXT}`;
      console.error(`[hemuli] closing session ${id}: ${why}`);
      closeEntry(id, why);
    }
  }
}, Math.min(5_000, IDLE_MS));
idleTimer.unref();

let shuttingDown = false;
async function shutdownAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...sessions.keys()].map((id) => closeEntry(id, 'server shut down')));
  process.exit(code);
}
process.on('SIGINT', () => shutdownAll(0));
process.on('SIGTERM', () => shutdownAll(0));
process.on('exit', () => { for (const e of sessions.values()) cleanupSync(e.host); });
process.stdin.on('close', () => shutdownAll(0));

// ---------- helpers ----------
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const errorResult = (e) => ({ isError: true, content: [{ type: 'text', text: e?.message || String(e) }] });

/** Wrap a tool handler: errors become isError results instead of protocol failures. */
const tool = (fn) => async (args) => { try { return await fn(args); } catch (e) { return errorResult(e); } };

// ---------- server ----------
const server = new McpServer(
  { name: 'hemuli', version: PKG.version },
  {
    instructions:
      'Interactive headless Chromium with a real GPU (WebGPU on Metal, WebGL via ANGLE) for debugging WebGPU/WebGL builds. ' +
      'Workflow: open (returns a session id and the load status) → logs / eval / screenshot / input / wait / fps → reload after rebuilding → close. ' +
      'Each session is its own browser: ~65 MB blank, often hundreds of MB with a real scene. Reuse one session (reload after rebuilding, navigate for another target) ' +
      'instead of opening new ones, and close it when done. At most ' + MAX_SESSIONS + ' at once; idle ones close after ' + IDLE_TEXT + ', so open a new one if a rebuild took longer. ' +
      'For a one-shot pass/fail check, the `hemuli` CLI via Bash is simpler.',
  },
);

server.registerTool('open', {
  title: 'Open session',
  description:
    'Launch a new isolated browser session and load a target. To load another build or page, use navigate or reload on an existing session instead of opening another. Returns the session id, the load status (failures, console, page/GPU errors) and what the app requested from the GPU. ' +
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
  // No await between this check and sessions.set below, so parallel opens can't overshoot the limit.
  if (sessions.size >= MAX_SESSIONS)
    throw new Error(`Session limit (${MAX_SESSIONS}) reached. Close one first: ${[...sessions.keys()].join(', ')}`);
  const id = `s${nextId++}`;
  const host = spawnHost();
  const entry = { id, host, lastUsed: Date.now(), busy: 0 };
  // Registered before launching: it counts toward the limit, shutdown closes it, and closing the
  // last other session can't stop the reaper while this browser is starting.
  sessions.set(id, entry);
  host.on('started', (m) => (reaper ??= startReaper()).add(m.browserPid, m.profileDir));
  host.on('crashed', () => { entry.crashed = true; });
  // A host that dies on its own leaves its detached browser behind.
  host.on('exit', () => { if (sessions.get(id) === entry) { entry.crashed = true; cleanupSync(host); } });
  try {
    const out = await run(entry, 'open', { ...a, wait: a.wait ?? (a.target ? ['1000'] : []), timeout_ms: a.timeout_ms ?? DEFAULT_TIMEOUT });
    return text({ session: id, ...out });
  } catch (e) {
    await closeEntry(id, 'open failed');
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
}, tool(async (a) => text({ session: a.session, ...await call(a.session, 'navigate', { ...a, wait: a.wait ?? ['1000'], timeout_ms: a.timeout_ms ?? DEFAULT_TIMEOUT }) })));

server.registerTool('reload', {
  title: 'Reload',
  description: 'Reload the current page, e.g. after rebuilding (files are served with no caching). Clears collected logs and returns the new load status.',
  inputSchema: {
    session: z.string(),
    wait: z.array(z.string()).optional().describe('Default ["1000"]'),
    timeout_ms: z.number().int().positive().optional(),
  },
}, tool(async (a) => text({ session: a.session, ...await call(a.session, 'reload', { wait: a.wait ?? ['1000'], timeout_ms: a.timeout_ms ?? DEFAULT_TIMEOUT }) })));

server.registerTool('logs', {
  title: 'Logs and errors',
  description:
    'What happened since the previous call: new console messages, page errors (exceptions, unhandled rejections), GPU errors ' +
    '(WGSL errors with line/col/source, WebGPU validation errors with counts, device lost, GLSL compile/link logs, pending gl.getError), HTTP errors. ' +
    '"failures" is always the full deduplicated list for the current page load; "ok" is true when it is empty. Also returns app info (contexts, requested features, canvases).',
  inputSchema: { session: z.string() },
}, tool(async (a) => text({ session: a.session, ...await call(a.session, 'logs') })));

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
}, tool(async (a) => text(await call(a.session, 'eval', { js: a.js, timeout_ms: a.timeout_ms ?? DEFAULT_TIMEOUT }))));

server.registerTool('wait', {
  title: 'Wait',
  description: `Wait for a condition. spec: ${WAIT_SPECS}.`,
  inputSchema: {
    session: z.string(),
    spec: z.string(),
    timeout_ms: z.number().int().positive().optional(),
  },
}, tool(async (a) => text(await call(a.session, 'wait', { spec: a.spec, timeout_ms: a.timeout_ms ?? DEFAULT_TIMEOUT }))));

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
  const { base64, stats } = await call(a.session, 'screenshot', { selector: a.selector, samples: a.samples });
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
}, tool(async (a) => text(await call(a.session, 'input', { actions: a.actions, timeout_ms: DEFAULT_TIMEOUT }))));

server.registerTool('fps', {
  title: 'Measure frame rate',
  description: 'Measure frames delivered over N seconds (p50/p95/max frame time) and the CPU time the app spends in its requestAnimationFrame callbacks. GPU execution time is not included.',
  inputSchema: { session: z.string(), seconds: z.number().positive().max(30).optional().describe('Default 2') },
}, tool(async (a) => text(await call(a.session, 'fps', { seconds: a.seconds ?? 2 }))));

server.registerTool('resize', {
  title: 'Resize viewport',
  description: 'Change the viewport size and/or device pixel ratio (fires resize events in the page).',
  inputSchema: {
    session: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    dpr: z.number().positive().optional(),
  },
}, tool(async (a) => text(await call(a.session, 'resize', { width: a.width, height: a.height, dpr: a.dpr }))));

server.registerTool('gpu_info', {
  title: 'GPU info',
  description: 'WebGPU adapter (vendor, architecture, fallback?), preferred canvas format, feature count, WebGL/WebGL2 renderer. full=true adds the feature list, limits and WebGL extensions. Uses the given session, or a temporary browser if none.',
  inputSchema: { session: z.string().optional(), full: z.boolean().optional() },
}, tool(async (a) => {
  if (a.session) return text(await call(a.session, 'gpu_info', { full: a.full }));
  // A temporary browser in a host of its own, which exits when done.
  const host = spawnHost();
  try { return text(await host.call('probe', { full: a.full })); } finally { await host.close(); cleanupSync(host); }
}));

server.registerTool('close', {
  title: 'Close session',
  description: 'Close a session: kills its browser and deletes its temp profile. Close sessions when done to free memory.',
  inputSchema: { session: z.string() },
}, tool(async (a) => text({ closed: await closeEntry(a.session, 'closed with the close tool') })));

server.registerTool('list_sessions', {
  title: 'List sessions',
  description: 'List open sessions with their current URL, viewport and idle time.',
  inputSchema: {},
}, tool(async () => text(await Promise.all([...sessions.values()].map(async (e) => {
  // Not through run(): listing must not count as use and keep sessions from closing.
  const info = e.crashed ? { url: '(crashed)' } : await Promise.race([
    e.host.call('info').catch(() => ({ url: '(unavailable)' })),
    new Promise((r) => setTimeout(() => r({ url: '(not responding)' }), 2_000)),
  ]);
  return { session: e.id, ...info, idleSeconds: e.busy ? 0 : Math.round((Date.now() - e.lastUsed) / 1000) };
})))));

await server.connect(new StdioServerTransport());
console.error(`[hemuli] MCP server ready (max ${MAX_SESSIONS} sessions, idle close after ${IDLE_TEXT})`);
