#!/usr/bin/env node
// gpu-browser: one-shot headless Chromium run for validating WebGPU / WebGL builds.
// Every invocation gets a fresh temp profile, its own static server on a random port,
// and a hard timeout, so many can run in parallel and none leave state behind.
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Session, UsageError, ensureBrowser, defaultEngine, gpuWarnings } from '../lib/core.mjs';

const HELP = `gpu-browser [target] [options]
gpu-browser setup [--engine chrome]    download the browser now (otherwise done on first run)
gpu-browser setup-claude               register the MCP server + skill with Claude Code

Launches a throwaway headless Chromium on the real GPU (Metal on macOS, D3D12/D3D11 on
Windows, Vulkan on Linux), loads the target, collects errors, prints a JSON report to
stdout, and exits.

target      URL (http://..., https://...), a directory (served; opens index.html),
            or an .html file (its directory is served). Omit to just report GPU info.

Options
  --wait <spec>       Repeatable, run in order after load. Default: 1500
                        <ms>               sleep
                        idle               network idle (500 ms quiet)
                        frames:<n>         n requestAnimationFrame ticks
                        selector:<css>     element exists
                        js:<expr>          expression becomes truthy
                        console:<regex>    a console message matches
  --eval <js>         Repeatable. Expression or function body (use return), may await.
                      Runs after waits; results land in "evals".
  --shot <file.png>   Screenshot of the viewport after evals. The report gets "image" stats
                      (dominant color and its share, distinct colors) to spot blank frames.
  --expect-content    Fail if the screenshot is (nearly) a single flat color. Takes the
                      screenshot in memory if --shot is not given.
  --sample <x,y>      Repeatable. Report the screenshot's RGBA at viewport pixel x,y.
  --fps <seconds>     Measure frames delivered and app rAF callback cost over N seconds.
  --size <WxH>        Viewport, default 1280x720.
  --dpr <n>           Device pixel ratio, default 1.
  --root <dir>        Serve this directory instead of the target file's directory.
  --coi               Send COOP/COEP headers (SharedArrayBuffer / wasm threads).
  --ignore <regex>    Repeatable. Console/page errors matching this don't fail the run.
  --max-console <n>   Keep at most n console entries, default 200.
  --timeout <ms>      Hard limit for the whole run, default 60000. Browser is killed.
  --flag <arg>        Repeatable. Extra Chromium command-line switch.
  --out <file.json>   Also write the report to a file.
  --gpu-info          Include full adapter features and limits.
  --engine <name>     shell (lean chrome-headless-shell; default on macOS/Linux) or chrome
                      (full Chrome for Testing, new headless; default on Windows).
                      Env: GPU_BROWSER_ENGINE. Use chrome if "warnings" says the GPU isn't used.
  -h, --help

Exit codes: 0 ok, 1 errors found, 2 bad usage / setup, 124 timeout.
"warnings" in the report flags software rendering; it doesn't change the exit code.`;

// ---------- subcommands (a directory with the same name still wins) ----------
const sub = process.argv[2];
if ((sub === 'setup' || sub === 'setup-claude') && !existsSync(sub)) {
  try {
    if (sub === 'setup') {
      const i = process.argv.indexOf('--engine');
      console.log(await ensureBrowser(i > 0 ? process.argv[i + 1] : defaultEngine()));
      process.exit(0);
    }
    const { setupClaude } = await import('../lib/setup-claude.mjs');
    process.exit((await setupClaude()) ? 0 : 1);
  } catch (e) { console.error(e.message); process.exit(2); }
}

// ---------- args ----------
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      wait: { type: 'string', multiple: true },
      eval: { type: 'string', multiple: true },
      shot: { type: 'string' },
      fps: { type: 'string' },
      size: { type: 'string', default: '1280x720' },
      dpr: { type: 'string', default: '1' },
      root: { type: 'string' },
      coi: { type: 'boolean', default: false },
      ignore: { type: 'string', multiple: true },
      'max-console': { type: 'string', default: '200' },
      timeout: { type: 'string', default: '60000' },
      flag: { type: 'string', multiple: true },
      out: { type: 'string' },
      'gpu-info': { type: 'boolean', default: false },
      'expect-content': { type: 'boolean', default: false },
      sample: { type: 'string', multiple: true },
      engine: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  console.error(e.message + '\n\n' + HELP);
  process.exit(2);
}
const opt = args.values;
if (opt.help) { console.log(HELP); process.exit(0); }
if (args.positionals.length > 1) { console.error('Only one target allowed.\n\n' + HELP); process.exit(2); }
const target = args.positionals[0];

const [vw, vh] = opt.size.split('x').map(Number);
const timeoutMs = Number(opt.timeout);
if (!vw || !vh || !timeoutMs) { console.error('Bad --size or --timeout.'); process.exit(2); }

// ---------- report ----------
const t0 = Date.now();
const report = {
  ok: false, failures: [], warnings: [], url: null, durationMs: 0, gpu: null,
  console: [], consoleDropped: 0, pageErrors: [], gpuErrors: [], httpErrors: [], requestsFailed: [],
  evals: [], waits: [],
};
let session;
try {
  session = new Session({
  width: vw, height: vh, dpr: Number(opt.dpr) || 1, flags: opt.flag, coi: opt.coi,
  engine: opt.engine, ignore: opt.ignore, maxConsole: Number(opt['max-console']), protocolTimeout: timeoutMs,
  });
} catch (e) { console.error(e.message); process.exit(2); }
const fail = (kind, detail) => session.fail(kind, detail);
let finished = false;

async function finish(code) {
  if (finished) return;
  finished = true;
  Object.assign(report, session.log);
  report.durationMs = Date.now() - t0;
  report.failures = session.failures(report.gpuErrors);
  if (code === undefined) code = report.failures.length ? 1 : 0;
  report.ok = code === 0;
  if (!report.consoleDropped) delete report.consoleDropped;
  if (!report.warnings.length) delete report.warnings;
  if (!report.waits.length) delete report.waits;
  if (!report.evals.length) delete report.evals;
  const json = JSON.stringify(report, null, 2);
  if (opt.out) { try { writeFileSync(opt.out, json); } catch (e) { console.error('Could not write --out: ' + e.message); } }
  await session.close();
  process.stdout.write(json + '\n', () => process.exit(code));
}

const hardTimer = setTimeout(() => { fail('timeout', `run exceeded ${timeoutMs} ms`); finish(124); }, timeoutMs);
hardTimer.unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { fail('interrupted', sig); finish(130); });
process.on('exit', () => session.closeSync());

// ---------- main ----------
async function main() {
  await session.start();
  const url = session.resolve(target, opt.root);
  report.url = target ? url : null;

  const deadline = t0 + timeoutMs - 3000; // leave time to report
  const budget = () => Math.max(1000, deadline - Date.now());
  let shot = null;

  let navigated = false;
  try { await session.goto(url, budget()); navigated = true; } catch (e) { fail('navigation', e.message); }

  if (navigated) {
    for (const spec of opt.wait?.length ? opt.wait : target ? ['1500'] : []) {
      const s = Date.now();
      try { await session.wait(spec, budget()); report.waits.push({ spec, ms: Date.now() - s }); }
      catch (e) { report.waits.push({ spec, error: e.message }); fail('wait', `${spec}: ${e.message}`); break; }
    }
    for (const src of opt.eval || []) {
      try { report.evals.push({ expr: src, ...(await session.eval(src, budget())) }); }
      catch (e) { report.evals.push({ expr: src, error: e.message }); fail('eval', `${src.slice(0, 80)}: ${e.message}`); }
    }
    if (opt.fps) {
      try { report.fps = await session.fps(Number(opt.fps), budget()); } catch (e) { report.fps = { error: e.message }; }
    }
    if (opt.shot || opt['expect-content'] || opt.sample?.length) {
      try {
        const samples = (opt.sample || []).map((s) => s.split(',').map(Number));
        shot = await session.screenshot({ samples }, budget());
        report.image = shot.stats;
        if (opt.shot) {
          mkdirSync(path.dirname(path.resolve(opt.shot)), { recursive: true });
          writeFileSync(opt.shot, Buffer.from(shot.base64, 'base64'));
          report.screenshot = path.resolve(opt.shot);
        }
        if (opt['expect-content'] && shot.stats.blank)
          fail('blank-frame', `screenshot is ${(shot.stats.dominantFraction * 100).toFixed(1)}% ${shot.stats.dominantColor}`);
      } catch (e) { fail('screenshot', e.message); }
    }
  }

  try {
    const state = await session.pageState(budget());
    if (state) { report.app = state.app; report.gpuErrors = state.errors; }
  } catch (e) { report.app = { error: e.message }; fail('page-unresponsive', e.message); }

  // GPU info from a clean page on the same origin, so it can't disturb the app.
  try {
    report.gpu = await session.gpuInfo(opt['gpu-info'], budget());
    report.warnings = gpuWarnings(report.gpu, session.engine, session);
    report.engine = session.engine;
  } catch (e) { report.gpu = { error: e.message }; }
  report.jsHeapMB = await session.jsHeapMB();
}

main().then(() => finish(), async (e) => {
  if (e instanceof UsageError) { console.error(e.message); await session.close(); process.exit(2); }
  fail('internal', e.stack || e.message);
  finish(1);
});
