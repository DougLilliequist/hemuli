// Shared engine for the hemuli CLI and MCP server.
// A Session is one isolated headless Chromium (own temp profile, own localhost server)
// with WebGPU/WebGL instrumentation injected into every page it loads.
import puppeteer from 'puppeteer-core';
import { computeExecutablePath, detectBrowserPlatform, install, Browser } from '@puppeteer/browsers';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, createReadStream, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BLANK_PATH = '/__hemuli__/blank.html';
const BLANK_HTML = '<!doctype html><meta charset=utf-8><title>hemuli</title><body></body>';

export class UsageError extends Error {}

function bump(map, kind, detail, n) {
  const key = detail ? `${kind}: ${detail}` : kind;
  map.set(key, (map.get(key) || 0) + n);
}

// ---------- browser engines ----------
// shell:  chrome-headless-shell, the lean default.
// chrome: full Chrome for Testing in new headless mode. Bigger, but it is the same browser as
//         desktop Chrome, so use it if the shell doesn't get a hardware GPU adapter on some machine.
export const ENGINES = { shell: Browser.CHROMEHEADLESSSHELL, chrome: Browser.CHROME };

// Windows defaults to full Chrome: chrome-headless-shell for Windows ships without the DXC
// shader-compiler DLLs (dxil.dll) that WebGPU's D3D12 backend loads (seen on CI, 2026-09).
export function defaultEngine() {
  const e = process.env.HEMULI_ENGINE || (process.platform === 'win32' ? 'chrome' : 'shell');
  if (!ENGINES[e]) throw new UsageError(`HEMULI_ENGINE must be one of: ${Object.keys(ENGINES).join(', ')}`);
  return e;
}

/** Per-user download cache, shared by every install and project. */
export function cacheDir() {
  if (process.env.HEMULI_CACHE) return path.resolve(process.env.HEMULI_CACHE);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hemuli');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'hemuli');
}

function browserSpec(engine) {
  const platform = detectBrowserPlatform();
  if (!platform) throw new UsageError(`Unsupported platform: ${process.platform} ${process.arch}`);
  return { browser: ENGINES[engine], buildId: PKG.hemuli.chromeVersion, cacheDir: cacheDir(), platform };
}

/** Path to the engine's executable, downloading it first if needed. Progress goes to stderr (stdout is reserved). */
export async function ensureBrowser(engine = defaultEngine()) {
  if (process.env.HEMULI_EXECUTABLE) return process.env.HEMULI_EXECUTABLE;
  const spec = browserSpec(engine);
  const exe = computeExecutablePath(spec);
  if (existsSync(exe)) return exe;
  console.error(`[hemuli] downloading ${spec.browser} ${spec.buildId} (${spec.platform}) to ${spec.cacheDir} (one time)...`);
  let last = -1;
  await install({
    ...spec,
    downloadProgressCallback: (done, total) => {
      const pct = Math.floor((done / total) * 10) * 10;
      if (pct !== last) { last = pct; console.error(`[hemuli]   ${pct}%`); }
    },
  });
  return exe;
}

/** Split a CLI/MCP target into a URL, a filesystem path (with optional ?query#hash), or nothing. */
export function classifyTarget(target, { pathMod = path, exists = existsSync } = {}) {
  if (!target) return { kind: 'none' };
  // Drive letters (C:\x, C:/x) and UNC paths look like URL schemes but are files.
  if (/^[a-zA-Z]:[\\/]/.test(target) || (pathMod === path.win32 && /^[\\/]{2}[^\\/]/.test(target))) {
    const m = target.match(/^([^?#]*)(.*)$/);
    return { kind: 'path', fsPath: m[1], suffix: m[2] };
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(target) && !exists(target)) return { kind: 'url', url: target };
  const m = target.match(/^([^?#]*)(.*)$/);
  return { kind: 'path', fsPath: m[1], suffix: m[2] };
}

/** Human-readable problems with the GPU setup (software rendering, missing APIs). */
// Dawn's error messages: "... - While calling [Device].CreateX(...)", WGSL parse errors, invalid-object cascades.
const WEBGPU_CONSOLE = /\n - While [a-z]+ \[|Error while parsing WGSL|\] is invalid due to a previous error/;

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|warp|basic render|software/i;

export function gpuWarnings(gpu, engine, { sandboxDisabled = false } = {}) {
  const w = [];
  if (sandboxDisabled) w.push('Chromium sandbox unavailable on this system (e.g. Ubuntu AppArmor); running with --no-sandbox. Only load trusted content.');
  if (!gpu || gpu.error) return w;
  const a = gpu.webgpu?.adapter;
  const id = a ? `${a.vendor} ${a.architecture} ${a.description}` : '';
  if (!gpu.webgpu?.available) w.push('WebGPU is unavailable (navigator.gpu is missing).');
  else if (!a) w.push('WebGPU requestAdapter() returned null: no usable GPU backend.');
  else if (a.isFallbackAdapter || SOFTWARE.test(id)) w.push(`WebGPU is using a software adapter (${id.trim()}), not the GPU.`);
  if (a && gpu.webgpu.deviceError) w.push(`WebGPU adapter found but requestDevice() fails: ${gpu.webgpu.deviceError.split('\n')[0]}`);
  const r = gpu.webgl2?.renderer || gpu.webgl?.renderer || '';
  if (!gpu.webgl2 && !gpu.webgl) w.push('WebGL is unavailable.');
  else if (SOFTWARE.test(r)) w.push(`WebGL is software-rendered (${r}).`);
  if (w.length > (sandboxDisabled ? 1 : 0) && engine === 'shell') w.push('Try the full-Chrome engine: set HEMULI_ENGINE=chrome (or pass --engine chrome).');
  return w;
}

// Remove profiles left behind by runs that were themselves killed (e.g. kill -9).
function sweepStaleProfiles() {
  try {
    for (const name of readdirSync(os.tmpdir())) {
      if (!name.startsWith('hemuli-')) continue;
      const dir = path.join(os.tmpdir(), name);
      if (Date.now() - statSync(dir).mtimeMs > 3600_000) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  } catch {}
}

export function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms (page busy or hung?)`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// ---------- static server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.wasm': 'application/wasm', '.wgsl': 'text/plain; charset=utf-8', '.glsl': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8', '.frag': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ktx2': 'image/ktx2', '.basis': 'application/octet-stream',
  '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.obj': 'text/plain', '.mtl': 'text/plain',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

// One server per session; its root can be switched so navigating to another build keeps the origin.
function startServer(state) {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const headers = { 'Cache-Control': 'no-store' };
      if (state.coi) Object.assign(headers, {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      let urlPath;
      try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400, headers); return res.end(); }
      if (urlPath === BLANK_PATH) { res.writeHead(200, { ...headers, 'Content-Type': MIME['.html'] }); return res.end(BLANK_HTML); }
      const rootDir = state.rootDir;
      if (!rootDir) { res.writeHead(404, headers); return res.end(); }
      let file = path.join(rootDir, urlPath);
      if (file !== rootDir && !file.startsWith(rootDir + path.sep)) { res.writeHead(403, headers); return res.end(); }
      try {
        if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
        const st = statSync(file);
        res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
        if (req.method === 'HEAD') return res.end();
        createReadStream(file).pipe(res);
      } catch {
        res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- in-page instrumentation (runs before any page script, in every frame) ----------
function pageHooks() {
  if (window.__gb) return;
  const gb = (window.__gb = { errors: [], app: {}, gl: [], raf: { count: 0, total: 0, max: 0 } });
  // Errors repeat every frame once something is broken: keep the first of each, count the rest.
  const seen = new Map();
  const push = (gb.push = (e) => {
    const key = e.kind + '|' + e.message;
    const prev = seen.get(key);
    if (prev) { prev.count = (prev.count || 1) + 1; return; }
    e.t = Math.round(performance.now());
    if (gb.errors.length < 200) { gb.errors.push(e); seen.set(key, e); }
  });

  if (self.GPUAdapter && self.GPU) {
    const ra = GPU.prototype.requestAdapter;
    GPU.prototype.requestAdapter = async function (o) {
      const a = await ra.call(this, o);
      gb.app.requestAdapter = { options: o || {}, gotAdapter: !!a };
      if (!a) push({ kind: 'webgpu-no-adapter', message: 'navigator.gpu.requestAdapter() returned null' });
      return a;
    };
    const rd = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (d) {
      const dev = await rd.call(this, d);
      gb.app.requestDevice = { requiredFeatures: [...(d?.requiredFeatures || [])], requiredLimits: d?.requiredLimits || {} };
      dev.addEventListener('uncapturederror', (ev) =>
        push({ kind: 'webgpu-uncaptured-error', type: ev.error?.constructor?.name, message: ev.error?.message }));
      dev.lost.then((info) => {
        if (info.reason === 'destroyed') gb.app.deviceDestroyed = true;
        else push({ kind: 'webgpu-device-lost', reason: info.reason, message: info.message });
      });
      return dev;
    };
    const csm = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (desc) {
      const mod = csm.call(this, desc);
      mod.getCompilationInfo?.().then((ci) => {
        const lines = String(desc?.code || '').split('\n');
        for (const msg of ci.messages) {
          if (msg.type === 'info') continue;
          push({
            kind: `webgpu-shader-${msg.type}`, label: desc?.label || undefined, message: msg.message,
            line: msg.lineNum, col: msg.linePos, source: lines[msg.lineNum - 1]?.trim().slice(0, 200),
          });
        }
      }).catch(() => {});
      return mod;
    };
  }

  const hookGetContext = (proto) => {
    if (!proto) return;
    const gc = proto.getContext;
    proto.getContext = function (type, ...rest) {
      const ctx = gc.call(this, type, ...rest);
      if (ctx && !this.__gbSeen) {
        this.__gbSeen = true;
        (gb.app.contexts ||= []).push(type);
        if (/webgl/.test(type)) {
          gb.gl.push(ctx);
          this.addEventListener?.('webglcontextlost', () => push({ kind: 'webgl-context-lost', message: `${type} context lost` }));
          // Shader/program compile/link failures are the most common WebGL bug and are otherwise silent.
          const g = ctx;
          const cs = g.compileShader, lp = g.linkProgram;
          g.compileShader = function (sh) {
            cs.call(this, sh);
            if (!this.getShaderParameter(sh, this.COMPILE_STATUS) && !this.isContextLost()) {
              const kind = this.getShaderParameter(sh, this.SHADER_TYPE) === this.VERTEX_SHADER ? 'vertex' : 'fragment';
              push({ kind: 'webgl-shader-error', stage: kind, message: this.getShaderInfoLog(sh) });
            }
          };
          g.linkProgram = function (p) {
            lp.call(this, p);
            if (!this.getProgramParameter(p, this.LINK_STATUS) && !this.isContextLost())
              push({ kind: 'webgl-link-error', message: this.getProgramInfoLog(p) });
          };
        }
      }
      return ctx;
    };
  };
  hookGetContext(self.HTMLCanvasElement?.prototype);
  hookGetContext(self.OffscreenCanvas?.prototype);

  // Time the app's own rAF callbacks (CPU cost per frame).
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return raf.call(this, (t) => {
      const s = performance.now();
      try { cb(t); } finally {
        const d = performance.now() - s;
        gb.raf.count++; gb.raf.total += d; if (d > gb.raf.max) gb.raf.max = d;
      }
    });
  };
}

// ---------- in-page probes ----------
async function gpuProbe(full) {
  const out = { webgpu: { available: !!navigator.gpu }, webgl2: null, webgl: null, secureContext: isSecureContext };
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter();
      if (a) {
        const i = a.info || {};
        out.webgpu.adapter = { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, isFallbackAdapter: i.isFallbackAdapter };
        out.webgpu.preferredCanvasFormat = navigator.gpu.getPreferredCanvasFormat();
        const feats = [...a.features].sort();
        out.webgpu.features = full ? feats : feats.length;
        if (full) { out.webgpu.limits = {}; for (const k in a.limits) out.webgpu.limits[k] = a.limits[k]; }
        // An adapter isn't enough: device creation can still fail (e.g. missing D3D12 compiler DLLs).
        try { (await a.requestDevice()).destroy(); } catch (e) { out.webgpu.deviceError = String(e.message || e); }
      } else out.webgpu.adapter = null;
    } catch (e) { out.webgpu.error = String(e); }
  }
  for (const type of ['webgl2', 'webgl']) {
    const gl = document.createElement('canvas').getContext(type);
    if (!gl) continue;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out[type] = {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
    };
    if (full) out[type].extensions = gl.getSupportedExtensions();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return out;
}

async function collectPageState() {
  const gb = window.__gb;
  if (!gb) return null;
  const names = { 0x500: 'INVALID_ENUM', 0x501: 'INVALID_VALUE', 0x502: 'INVALID_OPERATION', 0x505: 'OUT_OF_MEMORY', 0x506: 'INVALID_FRAMEBUFFER_OPERATION' };
  for (const gl of gb.gl) {
    if (gl.isContextLost()) continue;
    for (let i = 0, e; i < 8 && (e = gl.getError()) !== gl.NO_ERROR; i++)
      gb.push({ kind: 'webgl-error', message: `gl.getError() = ${names[e] || '0x' + e.toString(16)} (pending when checked)` });
  }
  const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
    id: c.id || undefined, width: c.width, height: c.height, clientWidth: c.clientWidth, clientHeight: c.clientHeight,
  }));
  const { requestAdapter, requestDevice, contexts, deviceDestroyed } = gb.app;
  return { errors: gb.errors, app: { requestAdapter, requestDevice, contexts, deviceDestroyed, canvases, rafCallbacks: gb.raf.count } };
}

async function measureFps(seconds) {
  const gb = window.__gb;
  const r0 = { ...gb.raf };
  const times = [];
  await new Promise((res) => {
    const start = performance.now();
    const tick = (t) => { times.push(t); if (t - start < seconds * 1000) requestAnimationFrame(tick); else res(); };
    requestAnimationFrame(tick);
  });
  const deltas = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const span = times.at(-1) - times[0];
  const appCalls = gb.raf.count - r0.count - times.length; // exclude our own ticks
  const appMs = gb.raf.total - r0.total;
  const pct = (p) => +(deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))] || 0).toFixed(2);
  return {
    seconds,
    fps: +((deltas.length / span) * 1000).toFixed(1),
    frameMs: { p50: pct(0.5), p95: pct(0.95), max: pct(1) },
    appRafCallbacks: Math.max(0, appCalls),
    appRafAvgMs: appCalls > 0 ? +(appMs / (gb.raf.count - r0.count)).toFixed(3) : null,
    note: 'Frame pacing of the headless compositor and CPU time in app rAF callbacks; GPU execution time is not included.',
  };
}

async function imageStats(dataUrl, samples) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
  const counts = new Map();
  const px = bmp.width * bmp.height;
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3); // 15-bit bucket
    const e = counts.get(k);
    if (e) e.n++; else counts.set(k, { n: 1, rgb: [data[i], data[i + 1], data[i + 2]] });
  }
  let dom = { n: 0, rgb: [0, 0, 0] };
  for (const e of counts.values()) if (e.n > dom.n) dom = e;
  const out = {
    width: bmp.width, height: bmp.height,
    dominantColor: '#' + dom.rgb.map((v) => v.toString(16).padStart(2, '0')).join(''), dominantFraction: +(dom.n / px).toFixed(4),
    distinctColors: counts.size,
    blank: dom.n / px > 0.995,
  };
  if (samples.length) out.samples = samples.map(([x, y]) => {
    const i = (Math.min(bmp.height - 1, y) * bmp.width + Math.min(bmp.width - 1, x)) * 4;
    return { x, y, rgba: [data[i], data[i + 1], data[i + 2], data[i + 3]] };
  });
  return out;
}

async function runEval(src) {
  const AsyncFunction = (async () => {}).constructor;
  let fn;
  try { fn = new AsyncFunction(`return (${src}\n);`); } catch { fn = new AsyncFunction(src); }
  const v = await fn();
  if (v === undefined) return { undefined: true };
  try { return { value: JSON.parse(JSON.stringify(v)) }; } catch { return { value: String(v) }; }
}

// ---------- session ----------
const LEAN_ARGS = [
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-default-apps',
  '--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-component-update',
  '--disable-background-networking', '--disable-domain-reliability', '--disable-client-side-phishing-detection',
  '--disable-breakpad', '--metrics-recording-only', '--mute-audio', '--password-store=basic', '--use-mock-keychain',
  '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,BackForwardCache,SpareRendererForSitePerProcess',
  '--renderer-process-limit=2', '--disk-cache-size=1', '--media-cache-size=1',
];

export class Session {
  /**
   * @param {object} o
   * @param {number} [o.width] @param {number} [o.height] @param {number} [o.dpr]
   * @param {string[]} [o.flags] extra Chromium switches
   * @param {boolean} [o.coi] COOP/COEP headers
   * @param {string[]} [o.ignore] regexes; matching errors are recorded but not counted as failures
   * @param {number} [o.maxConsole] @param {number} [o.protocolTimeout]
   */
  constructor(o = {}) {
    this.width = o.width || 1280;
    this.height = o.height || 720;
    this.dpr = o.dpr || 1;
    // HEMULI_EXTRA_FLAGS: space-separated Chromium switches applied to every launch.
    this.flags = [...(process.env.HEMULI_EXTRA_FLAGS || '').split(/\s+/).filter(Boolean), ...(o.flags || [])];
    this.ignores = (o.ignore || []).map((r) => new RegExp(r));
    this.maxConsole = o.maxConsole ?? 200;
    this.protocolTimeout = o.protocolTimeout || 60000;
    this.engine = o.engine || defaultEngine();
    if (!ENGINES[this.engine]) throw new UsageError(`engine must be one of: ${Object.keys(ENGINES).join(', ')}`);
    this.serverState = { rootDir: null, coi: !!o.coi };
    this.consoleWaiters = [];
    this.closed = false;
    this.resetLogs();
  }

  /**
   * Clear what the page reported. `tool` also clears failures of tool steps (navigation, waits,
   * evals...): done when a new load starts, but not at document commit, where a late commit on a
   * slow machine must not erase e.g. a navigation timeout that already happened.
   */
  resetLogs({ tool = true } = {}) {
    this.log = { console: [], consoleDropped: 0, pageErrors: [], httpErrors: [], requestsFailed: [] };
    this.pageFailCounts = new Map();
    if (tool) this.toolFailCounts = new Map();
  }

  ignored(text) { return this.ignores.some((r) => r.test(text)); }

  /** Record a failure of a tool step (navigation, wait, eval, screenshot, timeout...). */
  fail(kind, detail, n = 1) { bump(this.toolFailCounts, kind, detail, n); }

  /** Record a failure the page caused (console.error, exceptions, crashes). */
  failPage(kind, detail, n = 1) { bump(this.pageFailCounts, kind, detail, n); }

  /** Failures from page events plus the given in-page GPU errors, deduplicated with counts. */
  failures(gpuErrors = []) {
    const counts = new Map([...this.toolFailCounts]);
    for (const [k, n] of this.pageFailCounts) counts.set(k, (counts.get(k) || 0) + n);
    const seen = new Set();
    for (const e of gpuErrors) {
      seen.add((e.message || '').trim());
      if (e.kind === 'webgpu-shader-warning' || this.ignored(e.message || '')) continue;
      const key = `${e.kind}: ${(e.message || '').split('\n')[0].slice(0, 300)}`;
      counts.set(key, (counts.get(key) || 0) + (e.count || 1));
    }
    // Chrome also prints uncaptured WebGPU errors as console warnings. Count any the in-page hooks
    // haven't recorded yet (on a slow machine the error event can lag behind the console message).
    for (const c of this.log.console) {
      if (c.type !== 'warn' || !WEBGPU_CONSOLE.test(c.text) || seen.has(c.text.trim()) || this.ignored(c.text)) continue;
      const key = `webgpu-error (console): ${c.text.split('\n')[0].slice(0, 300)}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].map(([k, n]) => (n > 1 ? `${k} (x${n})` : k));
  }

  get origin() { return `http://localhost:${this.server.address().port}`; }

  async start() {
    const exe = await ensureBrowser(this.engine);
    this.server = await startServer(this.serverState);
    sweepStaleProfiles();
    this.profileDir = mkdtempSync(path.join(os.tmpdir(), 'hemuli-'));
    const gpuArgs = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'];
    // Windows shell engine lacks dxil.dll/dxcompiler.dll: have Dawn use FXC (ships with Windows) instead.
    if (process.platform === 'win32' && this.engine === 'shell') gpuArgs.push('--disable-dawn-features=use_dxc');
    if (process.platform === 'darwin') gpuArgs.push('--use-angle=metal');
    if (process.platform === 'linux') {
      gpuArgs.push('--enable-features=Vulkan', '--use-angle=vulkan', '--disable-dev-shm-usage');
      if (process.getuid?.() === 0) gpuArgs.push('--no-sandbox'); // containers / CI run as root
    }
    // Windows: no ANGLE override; Chrome's defaults (D3D11 for WebGL, D3D12 for WebGPU) are right.
    const launch = (extra = []) => puppeteer.launch({
      executablePath: exe,
      headless: this.engine === 'shell' ? 'shell' : true,
      userDataDir: this.profileDir,
      args: [...gpuArgs, ...LEAN_ARGS, `--window-size=${this.width},${this.height}`, ...this.flags, ...extra],
      defaultViewport: { width: this.width, height: this.height, deviceScaleFactor: this.dpr },
      protocolTimeout: this.protocolTimeout,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    try {
      this.browser = await launch();
    } catch (e) {
      // Ubuntu 23.10+ blocks the unprivileged user namespaces Chromium's sandbox needs (AppArmor).
      if (process.platform !== 'linux' || !/No usable sandbox/i.test(e.message) || gpuArgs.includes('--no-sandbox')) throw e;
      console.error('[hemuli] Chromium sandbox unavailable on this system; relaunching with --no-sandbox.');
      this.sandboxDisabled = true;
      this.browser = await launch(['--no-sandbox']);
    }
    this.browser.on('disconnected', () => { if (!this.closed) this.crashed = true; });
    [this.page] = await this.browser.pages();
    await this.page.evaluateOnNewDocument(pageHooks);
    this.attach(this.page);
    return this;
  }

  attach(page) {
    const onConsole = (origin) => (msg) => {
      const loc = msg.location();
      const entry = { type: msg.type(), text: msg.text() };
      if (origin) entry.origin = origin;
      if (loc?.url) entry.at = `${loc.url.replace(/^http:\/\/localhost:\d+/, '')}:${(loc.lineNumber ?? 0) + 1}`;
      if (entry.type === 'error' && /favicon\.ico/.test(loc?.url || '')) return;
      if (this.log.console.length < this.maxConsole) this.log.console.push(entry); else this.log.consoleDropped++;
      if (entry.type === 'error' && !this.ignored(entry.text)) this.failPage('console.error', entry.text.slice(0, 300) + (entry.at ? ` [${entry.at}]` : ''));
      for (const w of this.consoleWaiters.splice(0)) { if (w.re.test(entry.text)) w.resolve(); else this.consoleWaiters.push(w); }
    };
    page.on('console', onConsole());
    page.on('pageerror', (err) => {
      const message = err?.message ?? String(err);
      this.log.pageErrors.push({ message, stack: err?.stack?.split('\n').slice(0, 6).join('\n') });
      if (!this.ignored(message)) this.failPage('pageerror', message.slice(0, 300));
    });
    page.on('error', (err) => this.failPage('renderer-crash', err.message));
    page.on('workercreated', (w) => {
      w.on('error', (err) => { this.log.pageErrors.push({ message: err.message, origin: 'worker' }); if (!this.ignored(err.message)) this.failPage('worker-error', err.message); });
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && !/favicon\.ico$/.test(res.url())) this.log.httpErrors.push({ status: res.status(), url: res.url() });
    });
    page.on('requestfailed', (req) => {
      const err = req.failure()?.errorText;
      if (err !== 'net::ERR_ABORTED') this.log.requestsFailed.push({ url: req.url(), error: err });
    });
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      // Reset again at commit: the previous document can still log (per-frame errors) mid-navigation.
      if (this.resetOnCommit) { this.resetOnCommit = false; this.resetLogs({ tool: false }); }
      this.onNavigate?.();
    });
  }

  /** Map a target (URL, directory, .html file, or nothing) to a URL, pointing the server at local files. */
  resolve(target, root) {
    const t = classifyTarget(target);
    if (t.kind === 'none') return `${this.origin}${BLANK_PATH}`;
    if (t.kind === 'url') return t.url;
    const fsPath = path.resolve(t.fsPath);
    if (!existsSync(fsPath)) throw new UsageError(`Target not found: ${fsPath}`);
    const isDir = statSync(fsPath).isDirectory();
    const rootDir = path.resolve(root || (isDir ? fsPath : path.dirname(fsPath)));
    const rel = path.relative(rootDir, fsPath);
    // Cross-drive relative() on Windows returns an absolute path rather than ../
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new UsageError(`Target ${fsPath} is outside root ${rootDir}`);
    this.serverState.rootDir = rootDir;
    const urlPath = rel.split(path.sep).map(encodeURIComponent).join('/');
    return `${this.origin}/${urlPath}${isDir && urlPath ? '/' : ''}${t.suffix}`;
  }

  /** Navigate and wait for `load`. Clears collected logs. Throws on navigation failure. */
  async goto(url, timeout = 30000) {
    this.resetLogs();
    this.resetOnCommit = true;
    const res = await this.page.goto(url, { waitUntil: 'load', timeout });
    if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()} for ${url}`);
    return url;
  }

  async reload(timeout = 30000) {
    this.resetLogs();
    this.resetOnCommit = true;
    await this.page.reload({ waitUntil: 'load', timeout });
  }

  /** spec: <ms> | idle | frames:<n> | selector:<css> | js:<expr> | console:<regex> */
  async wait(spec, timeout = 30000) {
    const s = String(spec);
    const page = this.page;
    if (/^\d+$/.test(s)) {
      const ms = Number(s);
      await new Promise((r) => setTimeout(r, Math.min(ms, timeout)));
      if (ms > timeout) throw new Error(`sleep of ${ms} ms exceeds the remaining time budget (${timeout} ms)`);
      return;
    }
    if (s === 'idle') return page.waitForNetworkIdle({ idleTime: 500, timeout });
    const [kind, ...rest] = s.split(':');
    const arg = rest.join(':');
    if (kind === 'frames') return withTimeout(page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), Number(arg) || 1), timeout, s);
    if (kind === 'selector') return page.waitForSelector(arg, { timeout });
    if (kind === 'js') {
      // Own polling loop: exceptions (e.g. not defined yet, mid-navigation) count as falsy.
      const end = Date.now() + timeout;
      const probe = `(() => { try { return !!(${arg}\n); } catch { return false; } })()`;
      for (;;) {
        const ok = await withTimeout(page.evaluate(probe), Math.max(100, end - Date.now()), s).catch(() => false);
        if (ok) return;
        if (Date.now() >= end) throw new Error(`${arg} not truthy within ${timeout} ms`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (kind === 'console') {
      const re = new RegExp(arg);
      if (this.log.console.some((c) => re.test(c.text))) return;
      return new Promise((resolve, reject) => {
        const w = { re, resolve: () => { clearTimeout(t); resolve(); } };
        const t = setTimeout(() => {
          this.consoleWaiters = this.consoleWaiters.filter((x) => x !== w);
          reject(new Error(`no console message matched /${arg}/ within ${timeout} ms`));
        }, timeout);
        this.consoleWaiters.push(w);
      });
    }
    throw new UsageError(`unknown wait spec "${s}"`);
  }

  /** Returns { value } or { undefined: true }; throws with the page's error message. */
  eval(src, timeout = 30000) { return withTimeout(this.page.evaluate(runEval, src), timeout, 'eval'); }

  fps(seconds, timeout = 30000) { return withTimeout(this.page.evaluate(measureFps, seconds), timeout + seconds * 1000, 'fps'); }

  /** In-page instrumentation state: { errors, app } (null if hooks are absent, e.g. non-http page). */
  pageState(timeout = 10000) { return withTimeout(this.page.evaluate(collectPageState), timeout, 'page state'); }

  async jsHeapMB() {
    try { return +((await this.page.metrics()).JSHeapUsedSize / 1048576).toFixed(1); } catch { return undefined; }
  }

  /**
   * Runs fn(page) on a blank page with no app code. It is served from 127.0.0.1 (still a secure
   * context) so it is a different site from the app on localhost and gets its own renderer
   * process: a hung app page can't take it down.
   */
  async withProbe(fn, timeout = 15000) {
    const probe = await this.browser.newPage();
    try {
      await probe.goto(`http://127.0.0.1:${this.server.address().port}${BLANK_PATH}`, { timeout });
      return await withTimeout(fn(probe), timeout, 'probe');
    } finally { probe.close().catch(() => {}); }
  }

  gpuInfo(full = false, timeout) { return this.withProbe((p) => p.evaluate(gpuProbe, full), timeout); }

  /** GPU info plus warnings, cached per session (the adapter doesn't change). */
  async gpuCheck(timeout) {
    this._gpuCheck ||= this.gpuInfo(false, timeout).then((gpu) => ({ gpu, warnings: gpuWarnings(gpu, this.engine, this) }));
    return this._gpuCheck;
  }

  /**
   * @param {object} o
   * @param {string} [o.selector] clip to this element (e.g. the canvas)
   * @param {number[][]} [o.samples] [[x,y], ...] in CSS pixels, relative to the capture
   * @returns {{ base64: string, stats: object }}
   */
  async screenshot({ selector, samples = [] } = {}, timeout = 30000) {
    let base64;
    if (selector) {
      const el = await this.page.$(selector);
      if (!el) throw new UsageError(`no element matches ${selector}`);
      base64 = await withTimeout(el.screenshot({ encoding: 'base64' }), timeout, 'screenshot');
    } else {
      base64 = await withTimeout(this.page.screenshot({ encoding: 'base64' }), timeout, 'screenshot');
    }
    const px = samples.map(([x, y]) => [Math.round(x * this.dpr), Math.round(y * this.dpr)]);
    const stats = await this.withProbe((p) => p.evaluate(imageStats, 'data:image/png;base64,' + base64, px), timeout);
    return { base64, stats };
  }

  async resize(width, height, dpr = this.dpr) {
    this.width = width; this.height = height; this.dpr = dpr;
    await this.page.setViewport({ width, height, deviceScaleFactor: dpr });
  }

  /** Kill Chromium and wait for it to exit, so it can't write into the profile after we delete it. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    const proc = this.browser?.process();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      // Graceful first: Chrome stops its child processes, which otherwise keep writing into the
      // profile for a moment after the main process dies. SIGKILL if that doesn't finish quickly.
      await Promise.race([this.browser.close().catch(() => {}), sleep(1500)]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await Promise.race([exited, sleep(2000)]);
    }
    const dir = this.profileDir;
    this.closeSync();
    // Second pass in case a straggling child process recreated part of the profile.
    if (dir) { await sleep(300); if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} } }
  }

  /** Last-resort synchronous cleanup for process 'exit' handlers. */
  closeSync() {
    this.closed = true;
    try { this.browser?.process()?.kill('SIGKILL'); } catch {}
    try { this.server?.close(); } catch {}
    // Retries: on Windows, files stay locked (EBUSY) for a moment while Chrome's child processes exit.
    if (this.profileDir) { try { rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} this.profileDir = null; }
  }
}
