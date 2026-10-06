// Session host for the MCP server: one child node process per browser session. It loads
// puppeteer, owns the browser and its log cursors, and exits when the session closes, so the
// memory goes back to the OS with it. A long-lived server that loaded puppeteer itself would
// keep ~100 MB for the rest of the Claude Code session.
//
// Parent side:  const h = spawnHost(); await h.call('open', args); await h.close();
//               h.on('started' | 'crashed' | 'exit')
// Child side:   node lib/session-host.mjs   (requests over the IPC channel)
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);

/**
 * Start a host process. Requests run concurrently; each resolves with the op's result or rejects
 * with its error. All pending requests reject if the host exits.
 */
export function spawnHost() {
  // stdout must stay clean: the parent's stdout is the MCP transport.
  const child = fork(self, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
  const host = new EventEmitter();
  const pending = new Map(); // request id -> { resolve, reject }
  let nextReq = 1;
  host.child = child;
  host.exited = false;
  child.on('message', (m) => {
    if (m.type === 'started') { host.browserPid = m.browserPid; host.profileDir = m.profileDir; host.emit('started', m); return; }
    if (m.type === 'crashed') { host.emit('crashed'); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
  });
  child.on('exit', (code, signal) => {
    host.exited = true;
    for (const p of pending.values()) p.reject(new Error(`session host exited (${signal || `code ${code}`})`));
    pending.clear();
    host.emit('exit', code, signal);
  });
  child.on('error', () => {});
  host.call = (op, args = {}) => new Promise((resolve, reject) => {
    if (host.exited || !child.connected) return reject(new Error('session host is not running'));
    const id = nextReq++;
    pending.set(id, { resolve, reject });
    child.send({ id, op, args }, (err) => { if (err && pending.delete(id)) reject(err); });
  });
  /** Ask the host to close its browser and exit; SIGKILL it if it doesn't within `ms`. */
  host.close = async (ms = 8_000) => {
    if (host.exited) return;
    const exited = new Promise((r) => child.once('exit', r));
    host.call('close').catch(() => {});
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, ms);
    await exited;
    clearTimeout(t);
  };
  return host;
}

// ---------- child ----------
if (process.argv[1] === self) {
  const { Session, gpuWarnings, withTimeout } = await import('./core.mjs');

  let s = null;
  let cursor;
  let gpuSeen;
  const resetCursors = () => {
    cursor = { console: 0, pageErrors: 0, httpErrors: 0, requestsFailed: 0 };
    gpuSeen = new Map();
  };
  const session = () => {
    if (!s) throw new Error('no browser in this host');
    if (s.crashed) throw new Error('browser disconnected');
    return s;
  };

  /** Everything new since the last call, plus the full failure list for the current page load. */
  async function delta({ includeApp = false } = {}) {
    const out = { url: s.page.url(), failures: [] };
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
    for (const k of Object.keys(cursor)) {
      const arr = s.log[k];
      const items = arr.slice(cursor[k]);
      cursor[k] = arr.length;
      if (items.length) fresh[k] = items;
    }
    if (s.log.consoleDropped) fresh.consoleDropped = s.log.consoleDropped;
    const newGpu = [];
    for (const e of gpuErrors) {
      const key = `${e.kind}|${e.message}`;
      const n = e.count || 1;
      const prev = gpuSeen.get(key) || 0;
      if (n > prev) { newGpu.push(prev ? { ...e, newOccurrences: n - prev } : e); gpuSeen.set(key, n); }
    }
    if (newGpu.length) fresh.gpuErrors = newGpu;
    out.new = fresh;
    return out;
  }

  async function runWaits(waits, timeout) {
    const done = [];
    for (const spec of waits) {
      const t = Date.now();
      try { await s.wait(spec, timeout); done.push({ spec, ms: Date.now() - t }); }
      catch (e) { done.push({ spec, error: e.message }); s.fail('wait', `${spec}: ${e.message}`); break; }
    }
    return done;
  }

  async function load(url, waits, timeout, how = 'goto') {
    resetCursors();
    let navError;
    try {
      if (how === 'reload') await s.reload(timeout); else await s.goto(url, timeout);
    } catch (e) { navError = e.message; s.fail('navigation', e.message); }
    const waited = navError ? [] : await runWaits(waits, timeout);
    const out = await delta({ includeApp: true });
    if (waited.length) out.waits = waited;
    return out;
  }

  async function input(actions, timeout) {
    const { mouse, keyboard } = session().page;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const run = async () => {
      for (const act of actions) {
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
    await withTimeout(run(), timeout, 'input');
    return { done: actions.length };
  }

  const gpuReport = async (sess, full) => {
    const gpu = await sess.gpuInfo(!!full);
    return { engine: sess.engine, warnings: gpuWarnings(gpu, sess.engine, sess), ...gpu };
  };

  // Each op receives the tool's arguments; timeouts arrive already defaulted by the server.
  const ops = {
    async open(a) {
      if (s) throw new Error('this host already has a browser');
      s = new Session({ width: a.width, height: a.height, dpr: a.dpr, coi: a.coi, ignore: a.ignore, flags: a.flags, engine: a.engine, protocolTimeout: 90_000 });
      resetCursors();
      await s.start();
      s.browser.on('disconnected', () => { if (!s.closed) process.send?.({ type: 'crashed' }); });
      process.send({ type: 'started', browserPid: s.browser.process()?.pid, profileDir: s.profileDir });
      const url = s.resolve(a.target, a.root);
      s.onNavigate = () => { gpuSeen = new Map(); };
      const out = await load(url, a.wait, a.timeout_ms);
      const { warnings } = await s.gpuCheck(10_000).catch(() => ({ warnings: [] }));
      if (warnings.length) out.warnings = warnings;
      out.engine = s.engine;
      return out;
    },
    navigate: (a) => { const url = session().resolve(a.target, a.root); return load(url, a.wait, a.timeout_ms); },
    reload: (a) => { session(); return load(null, a.wait, a.timeout_ms, 'reload'); },
    logs: () => { session(); return delta({ includeApp: true }); },
    eval: (a) => session().eval(a.js, a.timeout_ms),
    async wait(a) {
      const t = Date.now();
      await session().wait(a.spec, a.timeout_ms);
      return { spec: a.spec, ms: Date.now() - t };
    },
    screenshot: (a) => session().screenshot({ selector: a.selector, samples: a.samples ?? [] }),
    input: (a) => input(a.actions, a.timeout_ms),
    fps: (a) => session().fps(a.seconds),
    async resize(a) {
      const sess = session();
      await sess.resize(a.width, a.height, a.dpr);
      return { width: a.width, height: a.height, dpr: sess.dpr };
    },
    gpu_info: (a) => gpuReport(session(), a.full),
    /** gpu_info without a session: a temporary browser in this host, which then exits. */
    async probe(a) {
      if (s) throw new Error('this host already has a browser');
      // Held in `s` so the disconnect / exit handlers close it if the server goes away mid-probe.
      s = new Session();
      try { await s.start(); return await gpuReport(s, a.full); } finally { await s.close(); }
    },
    info: () => ({
      url: !s ? '(starting)' : s.crashed ? '(crashed)' : s.page?.url(),
      viewport: s ? `${s.width}x${s.height}@${s.dpr}` : undefined,
    }),
    async close() {
      await s?.close();
      setImmediate(() => process.exit(0));
      return { closed: true };
    },
  };

  process.on('message', async ({ id, op, args }) => {
    try {
      if (!ops[op]) throw new Error(`unknown op ${op}`);
      process.send({ id, ok: true, result: await ops[op](args) });
    } catch (e) {
      try { process.send({ id, ok: false, error: e?.message || String(e) }); } catch {}
    }
  });
  // The server went away (even SIGKILL closes the channel): take the browser down with us.
  process.on('disconnect', () => { s?.closeSync(); process.exit(0); });
  // The server owns the lifecycle; Ctrl+C in a terminal reaches it, and it closes us in order.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => { s?.closeSync(); process.exit(0); });
  process.on('exit', () => s?.closeSync());
}
