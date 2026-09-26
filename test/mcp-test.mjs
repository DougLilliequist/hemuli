// End-to-end test of the MCP server through a real MCP client over stdio.
// Uses the WebGPU test page when the machine has an adapter, else the WebGL2 one, so it also runs
// on GPU-less CI runners. Strict hardware checks are skipped with CI=1 / GPU_BROWSER_TEST_LENIENT=1.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = (p) => path.join(here, 'pages', p);
const lenient = !!(process.env.CI || process.env.GPU_BROWSER_TEST_LENIENT);

// Only processes this test started are checked: the browsers are direct children of the server
// under test. (Other gpu-browser users on the machine, e.g. a live Claude Code session, are ignored.)
function childPids(pid) {
  try {
    const out = process.platform === 'win32'
      ? execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object -ExpandProperty ProcessId"`)
      : execSync(`pgrep -P ${pid} || true`);
    return out.toString().split(/\r?\n/).map((x) => Number(x.trim())).filter(Boolean);
  } catch { return []; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitGone(pids, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end && pids.some(alive)) await new Promise((r) => setTimeout(r, 250));
  return pids.filter(alive);
}
const profiles = () => new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith('gpu-browser-')));
const before = { profiles: profiles() };

const client = new Client({ name: 'gpu-browser-test', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'bin', 'gpu-browser-mcp.mjs')], env: { ...process.env }, stderr: 'ignore' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content.find((c) => c.type === 'text')?.text;
  let json; try { json = JSON.parse(txt); } catch { json = txt; }
  return { isError: !!r.isError, json, content: r.content };
};
const step = async (label, fn) => {
  const t = Date.now();
  try { await fn(); console.log(`PASS  ${label} (${Date.now() - t} ms)`); }
  catch (e) { console.log(`FAIL  ${label}\n${e.stack}`); process.exitCode = 1; }
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
await step('lists tools', () => assert.deepEqual(tools,
  ['close', 'eval', 'fps', 'gpu_info', 'input', 'list_sessions', 'logs', 'navigate', 'open', 'reload', 'resize', 'screenshot', 'wait']));

// Capabilities (temporary browser) pick the page under test.
const caps = (await call('gpu_info')).json;
// SwiftShader in headless CI renders blank / loses contexts under load: test without the GPU there.
const swiftshader = (s) => lenient && /swiftshader/i.test(s || '');
const webgpu = !!caps.webgpu?.adapter && !caps.webgpu.deviceError && !swiftshader(caps.webgpu.adapter.architecture);
const webgl2 = !!caps.webgl2 && !swiftshader(caps.webgl2.renderer);
const api = webgpu ? 'webgpu' : webgl2 ? 'webgl2' : null; // null: GPU-free page, rendering checks skipped
const mainPage = { webgpu: 'webgpu-triangle.html', webgl2: 'webgl2-triangle.html' }[api] || 'plain.html';
const ready = api ? 'console:rendered-ready' : 'js:frameCount() > 3';
console.log(`engine=${caps.engine} testing with ${api || 'no GPU API (rendering checks skipped)'}${caps.warnings?.length ? `  warnings: ${caps.warnings.join(' | ')}` : ''}`);
await step('temporary gpu_info', () => {
  assert.ok(Array.isArray(caps.warnings));
  if (!lenient) { assert.equal(caps.webgpu.adapter.isFallbackAdapter, false); assert.deepEqual(caps.warnings, []); }
});

let sid;
await step(`open ${api || "GPU-free"} page`, async () => {
  const r = await call('open', { target: page(mainPage), width: 400, height: 300, wait: [ready] });
  assert.equal(r.isError, false, JSON.stringify(r.json));
  sid = r.json.session;
  assert.equal(r.json.ok, true);
  if (api) {
    assert.deepEqual(r.json.app.contexts, [api]);
    assert.equal(r.json.new.console[0].text, 'rendered-ready');
  }
});
await step('logs: nothing new', async () => {
  const r = await call('logs', { session: sid });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.new, {});
});
await step('eval', async () => {
  assert.equal((await call('eval', { session: sid, js: 'frameCount() > 3' })).json.value, true);
  const err = await call('eval', { session: sid, js: 'nope.x' });
  assert.equal(err.isError, true);
});
await step('screenshot + samples', async () => {
  const r = await call('screenshot', { session: sid, samples: [[200, 150], [5, 5]] });
  assert.equal(r.content[0].type, 'image');
  if (api) {
    assert.equal(r.json.blank, false);
    const [red, green] = r.json.samples[0].rgba;
    assert.ok(webgpu ? red > 200 && green < 150 : green > 200 && red < 100, `triangle color ${r.json.samples[0].rgba}`);
  }
  const el = await call('screenshot', { session: sid, selector: api ? 'canvas' : 'body', include_image: false });
  assert.equal(el.content.length, 1);
  assert.equal(el.json.width, 400);
});
await step('input', async () => {
  const r = await call('input', { session: sid, actions: [
    { type: 'click', x: 100, y: 100 }, { type: 'drag', x: 10, y: 10, to_x: 200, to_y: 100 },
    { type: 'wheel', x: 50, y: 50, delta_y: 120 }, { type: 'key', key: 'Shift+KeyW' }, { type: 'type', text: 'ab' },
  ] });
  assert.equal(r.isError, false, JSON.stringify(r.json));
  const log = (await call('eval', { session: sid, js: 'inputLog' })).json.value;
  assert.deepEqual(log, ['pointerdown', 'pointerup', 'pointerdown', 'pointerup', 'wheel', 'keydown:Shift', 'keydown:W', 'keydown:a', 'keydown:b']);
});
await step('fps + wait + resize', async () => {
  assert.ok((await call('fps', { session: sid, seconds: 1 })).json.fps > (lenient ? 5 : 20));
  assert.equal((await call('wait', { session: sid, spec: 'js:frameCount() > 10' })).isError, false);
  await call('resize', { session: sid, width: 320, height: 200 });
  assert.equal((await call('eval', { session: sid, js: 'innerWidth' })).json.value, 320);
});
await step('navigate to broken shader, logs are incremental', async () => {
  const shaderError = { webgpu: 'webgpu-shader-error', webgl2: 'webgl-shader-error' }[api] || 'pageerror';
  const r = await call('navigate', { session: sid, target: page(`${mainPage}?${api ? 'badshader' : 'throw'}`), wait: [lenient ? '3000' : '500'] });
  assert.equal(r.json.ok, false);
  assert.ok(r.json.failures.some((f) => f.startsWith(shaderError) || f.startsWith('webgpu-error (console)')), JSON.stringify(r.json.failures));
  await new Promise((res) => setTimeout(res, 300));
  const again = await call('logs', { session: sid });
  assert.ok(again.json.failures.length > 0, 'failures persist for the load');
  assert.ok(!again.json.new.gpuErrors?.some((e) => e.kind === shaderError && !e.newOccurrences), 'shader error not re-reported');
  assert.ok((again.json.new.gpuErrors || []).every((e) => e.newOccurrences > 0), 'only repeats are new');
});
await step('reload clears state', async () => {
  const r = await call('navigate', { session: sid, target: page(mainPage), wait: ['300'] });
  assert.equal(r.json.ok, true);
  const rl = await call('reload', { session: sid, wait: ['300'] });
  assert.equal(rl.json.ok, true);
  if (api) assert.deepEqual(rl.json.app.contexts, [api]);
});
let sid2;
await step('parallel second session + gpu_info + list', async () => {
  const r = await call('open', { target: page('hang.html'), wait: ['300'] });
  sid2 = r.json.session;
  assert.notEqual(sid2, sid);
  const info = await call('gpu_info', { session: sid });
  assert.equal(info.json.engine, caps.engine);
  const list = await call('list_sessions');
  assert.equal(list.json.length, 2);
});
await step('hung page: eval times out, logs flag it, close works', async () => {
  const e = await call('eval', { session: sid2, js: '1', timeout_ms: 2000 });
  assert.equal(e.isError, true);
  assert.match(e.json, /timed out/);
  const l = await call('logs', { session: sid2 });
  assert.ok(l.json.failures.some((f) => f.startsWith('page-unresponsive')));
  assert.equal((await call('close', { session: sid2 })).json.closed, true);
  assert.equal((await call('logs', { session: sid2 })).isError, true);
});

// Leave sid open: closing the client must tear it down.
const ours = childPids(transport.pid).filter((p) => p !== transport.pid);
await client.close();
await step('client disconnect cleans up everything', async () => {
  assert.ok(ours.length >= 1, 'found the open session\'s browser');
  assert.deepEqual(await waitGone(ours), [], 'no browser processes left');
  const end = Date.now() + 10000;
  while (Date.now() < end && [...profiles()].some((p) => !before.profiles.has(p))) await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual([...profiles()].filter((p) => !before.profiles.has(p)), [], 'no temp profiles left');
});

// The server killed outright (SIGKILL, or TerminateProcess on Windows): no exit handlers run,
// so the reaper must kill the browsers and delete their profiles.
await step('hard-killed server leaves no browsers (reaper)', async () => {
  const c2 = new Client({ name: 'gpu-browser-kill-test', version: '1.0.0' });
  const t2 = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'bin', 'gpu-browser-mcp.mjs')], env: { ...process.env }, stderr: 'ignore' });
  await c2.connect(t2);
  const before2 = profiles();
  for (const p of ['blank.html', 'hang.html']) {
    const r = await c2.callTool({ name: 'open', arguments: { target: page(p), wait: [] } });
    assert.ok(!r.isError, r.content[0].text);
  }
  const browsers = childPids(t2.pid).filter((p) => p !== t2.pid);
  const created = [...profiles()].filter((p) => !before2.has(p));
  assert.ok(browsers.length >= 2, `expected 2 browsers, found ${browsers.length}`);
  process.kill(t2.pid, 'SIGKILL');
  assert.deepEqual(await waitGone(browsers), [], 'browsers killed');
  const end = Date.now() + 10000;
  while (Date.now() < end && created.some((p) => profiles().has(p))) await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(created.filter((p) => profiles().has(p)), [], 'profiles deleted');
});
process.exit(process.exitCode ?? 0);
