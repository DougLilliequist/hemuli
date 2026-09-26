// CLI tests: each case runs the CLI and checks the exit code plus a predicate on the report.
// Cases run in parallel on purpose (that is the intended usage), GPU_BROWSER_TEST_CONCURRENCY at a time.
//
// GPU strictness: locally (default) the machine must expose a real, hardware WebGPU adapter.
// With CI=1 or GPU_BROWSER_TEST_LENIENT=1 (GPU-less CI runners) the adapter is only reported,
// and cases needing an API the runner lacks are skipped instead of failed.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'gpu-browser.mjs');
const page = (p) => path.join(here, 'pages', p);
const lenient = !!(process.env.CI || process.env.GPU_BROWSER_TEST_LENIENT);
// GPU-less runners can render at ~2 fps: stretch fixed waits there.
const ms = (n) => String(lenient ? n * 4 : n);

const run = (args) => new Promise((resolve) =>
  execFile(process.execPath, [cli, ...args], { timeout: 120000, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })));

// Capabilities decide which cases apply (and download the browser first if needed).
const info = await run([]);
let gpu;
try { gpu = JSON.parse(info.stdout); } catch { console.error(`gpu-browser failed to start:\n${info.stderr}`); process.exit(1); }
if (!gpu.gpu || gpu.gpu.error) { console.error(`gpu-browser could not start a browser:\n${info.stdout}\n${info.stderr}`); process.exit(1); }
// SwiftShader in headless CI (no GPU at all) renders blank frames and loses contexts under load,
// so rendering can't be validated there; those cases are skipped with that reason in lenient mode.
const swiftshader = (s) => lenient && /swiftshader/i.test(s || '');
const a = gpu.gpu?.webgpu?.adapter;
const has = {
  webgpu: !!a && !gpu.gpu.webgpu.deviceError && !swiftshader(a.architecture),
  webgl2: !!gpu.gpu?.webgl2 && !swiftshader(gpu.gpu.webgl2.renderer),
  hardware: (gpu.warnings || []).length === 0,
};
console.log(`engine=${gpu.engine}  adapter=${JSON.stringify(gpu.gpu?.webgpu?.adapter)}  webgl2=${gpu.gpu?.webgl2?.renderer}`);
if (gpu.warnings?.length) console.log(`warnings: ${gpu.warnings.join(' | ')}`);

// A server that answers only after 4 s: navigation times out, then the document commits late.
// The late commit must not erase the navigation failure (regression seen on a slow Windows runner).
const slow = createServer((req, res) => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>late</p>'); }, 4000));
await new Promise((r) => slow.listen(0, '127.0.0.1', r));
const slowUrl = `http://localhost:${slow.address().port}/`;

const cases = [
  // [name, needs, args, expected exit code, check]
  ['hardware GPU (strict mode only)', lenient ? 'skip' : null, [], 0, (r) => r.gpu.webgpu.adapter && !r.gpu.webgpu.adapter.isFallbackAdapter && r.gpu.webgl2 && !r.warnings],
  ['webgpu renders', 'webgpu', [page('webgpu-triangle.html'), '--wait', 'console:rendered-ready', '--size', '400x300', '--expect-content', '--sample', '200,150'],
    0, (r) => r.image.samples[0].rgba[0] > 200 && r.app.contexts.includes('webgpu')],
  ['webgl2 renders', 'webgl2', [page('webgl2-triangle.html'), '--wait', 'console:rendered-ready', '--size', '400x300', '--expect-content', '--sample', '200,150'],
    0, (r) => r.image.samples[0].rgba[1] > 200],
  ['wgsl error', 'webgpu', [page('webgpu-triangle.html?badshader'), '--wait', 'console:rendered-ready', '--wait', ms(300)], 1, (r) => r.failures.some((f) => /undefinedThing/.test(f))],
  ['webgpu validation', 'webgpu', [page('webgpu-triangle.html?validation'), '--wait', 'console:rendered-ready', '--wait', ms(300)], 1, (r) => r.failures.some((f) => /Buffer usages/.test(f))],
  ['glsl error', 'webgl2', [page('webgl2-triangle.html?badshader'), '--wait', 'console:rendered-ready', '--wait', ms(300)], 1, (r) => r.gpuErrors.some((e) => e.kind === 'webgl-shader-error')],
  ['js exception', null, [page('plain.html?throw'), '--wait', ms(300)], 1, (r) => r.pageErrors.length === 1],
  ['module await rejection', 'webgpu', [page('webgpu-triangle.html?reject'), '--wait', ms(300)], 1, (r) => /requestDevice/.test(r.pageErrors[0]?.message)],
  ['unhandled rejection', null, [page('plain.html?reject'), '--wait', ms(300)], 1, (r) => /async boom/.test(r.pageErrors[0]?.message)],
  ['ignore', null, [page('plain.html?throw'), '--wait', ms(300), '--ignore', 'boom'], 0, (r) => r.pageErrors.length === 1],
  ['404', null, [page('missing-asset.html'), '--wait', '300'], 1, (r) => r.httpErrors.length === 2],
  ['blank frame', null, [page('blank.html'), '--wait', '100', '--expect-content'], 1, (r) => r.image.blank],
  ['evals', null, [page('plain.html'), '--wait', 'js:frameCount() > 3', '--eval', 'frameCount() > 3', '--eval', 'return 6*7'],
    0, (r) => r.evals[0].value === true && r.evals[1].value === 42],
  ['fps', null, [page('plain.html'), '--wait', '300', '--fps', '1'], 0, (r) => r.fps.fps > (lenient ? 0 : 20) && r.fps.appRafCallbacks > 0],
  // Exit 1 flags the hang; on a very slow machine the hard backstop may fire first (124). Never ok.
  ['hung page', null, [page('hang.html'), '--timeout', '20000'], [1, 124], (r) => r.failures.some((f) => /^(page-unresponsive|timeout)/.test(f))],
  // A 60 s wait under a 6 s limit: the run must stop near the limit and fail (exit 1, or 124 if
  // launch was slow enough that the hard backstop fired first).
  ['time budget enforced', null, [page('blank.html'), '--wait', '60000', '--timeout', '6000'], [1, 124], (r) => r.durationMs < 10000 && !r.ok],
  ['bad target', null, [page('does-not-exist.html')], 2, () => true],
  ['late commit keeps navigation failure', null, [slowUrl, '--timeout', '4500'], [1, 124], (r) => !r.ok && r.failures.some((f) => /^(navigation|timeout)/.test(f))],
];

const limit = Number(process.env.GPU_BROWSER_TEST_CONCURRENCY) || 6;
const queue = [...cases];
const pool = async (fn) => { const out = []; await Promise.all(Array.from({ length: limit }, async () => { while (queue.length) { const c = queue.shift(); out[cases.indexOf(c)] = await fn(c); } })); return out; };
const results = await pool(async ([name, needs, args, code, check]) => {
  if (needs === 'skip') return { name, skipped: 'strict mode off' };
  if (needs && !has[needs]) {
    if (!lenient) return { name, ok: false, why: `${needs} unavailable on this machine` };
    return { name, skipped: `${needs} unavailable or software-only (SwiftShader) here` };
  }
  const { code: got, stdout, stderr } = await run(args);
  const codes = [].concat(code);
  let ok = codes.includes(got), why = ok ? '' : `exit ${got}, expected ${codes.join(' or ')}`;
  if (ok && code !== 2) {
    try { if (!check(JSON.parse(stdout))) { ok = false; why = 'check failed'; } } catch (e) { ok = false; why = e.message; }
  }
  return { name, ok, why, stdout: stdout || stderr };
});
slow.close();

// Direct check of the same race: a document commit after a tool failure must not erase it.
results.push(await (async () => {
  const name = 'commit after tool failure keeps it';
  const { Session } = await import('../lib/core.mjs');
  const s = new Session();
  try {
    await s.start();
    await s.goto(s.resolve(page('plain.html')));
    s.fail('navigation', 'simulated timeout');
    s.resetOnCommit = true; // as if goto() had just started this navigation
    await Promise.all([s.page.waitForNavigation(), s.page.evaluate(() => { location.search = '?again'; })]);
    const ok = s.failures().some((f) => f.startsWith('navigation: simulated timeout'));
    return { name, ok, why: ok ? '' : `failures after commit: ${JSON.stringify(s.failures())}` };
  } catch (e) { return { name, ok: false, why: e.message }; } finally { await s.close(); }
})());
for (const r of results) console.log(r.skipped ? `SKIP  ${r.name} (${r.skipped})` : `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.why ? '  -- ' + r.why : ''}`);
const failed = results.filter((r) => r.ok === false);
if (failed.length) { for (const f of failed) console.log(`\n--- ${f.name}\n${(f.stdout || '').slice(0, 2000)}`); process.exit(1); }
console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => r.skipped).length} skipped`);
