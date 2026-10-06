// End-to-end test of the MCP server through a real MCP client over stdio.
// Uses the WebGPU test page when the machine has an adapter, else the WebGL2 one, so it also runs
// on GPU-less CI runners. Strict hardware checks are skipped with CI=1 / HEMULI_TEST_LENIENT=1.
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
const lenient = !!(process.env.CI || process.env.HEMULI_TEST_LENIENT);

// Only processes this test started are checked: the session hosts are children of the server
// under test and the browsers are theirs. (Other hemuli users on the machine, e.g. a live Claude
// Code session, are ignored.)
// One snapshot of every process: [{ pid, ppid, name }]. (PowerShell takes about a second per
// call, so walking a tree with one call per process is too slow on Windows.)
function processTable() {
  try {
    if (process.platform === 'win32') {
      const csv = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation"').toString();
      return csv.split(/\r?\n/).slice(1).map((l) => l.match(/^"(\d+)","(\d+)","(.*)"$/)).filter(Boolean)
        .map(([, pid, ppid, name]) => ({ pid: +pid, ppid: +ppid, name }));
    }
    return execSync('ps -A -o pid=,ppid=,comm=').toString().split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .map(([, pid, ppid, name]) => ({ pid: +pid, ppid: +ppid, name }));
  } catch { return []; }
}
function descendants(pid) {
  const table = processTable();
  const out = [];
  for (let todo = [pid]; todo.length;) {
    const p = todo.pop();
    for (const c of table) if (c.ppid === p && !out.includes(c.pid)) { out.push(c.pid); todo.push(c.pid); }
  }
  return out;
}
/** Leftover pids with their names and parents, so a failure says what was left behind. */
function describe(pids) {
  if (!pids.length) return [];
  const table = processTable();
  return pids.map((pid) => { const p = table.find((x) => x.pid === pid); return p ? `${pid} ${p.name} (parent ${p.ppid})` : `${pid}`; });
}
// A browser's helpers (GPU, renderers, utility) are not its children, but on POSIX they share the
// browser's process group. Windows is covered by taskkill /T.
function withHelpers(pids) {
  if (process.platform === 'win32') return pids;
  const group = (p) => execSync(`pgrep -g ${p} || true`).toString().split('\n').map(Number).filter(Boolean);
  return [...new Set([...pids, ...pids.flatMap(group)])];
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitGone(pids, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end && pids.some(alive)) await new Promise((r) => setTimeout(r, 250));
  return pids.filter(alive);
}
const profiles = () => new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith('hemuli-')));
const before = { profiles: profiles() };

const serverBin = path.join(here, '..', 'bin', 'hemuli-mcp.mjs');
const connect = async (env = {}) => {
  const c = new Client({ name: 'hemuli-test', version: '1.0.0' });
  const t = new StdioClientTransport({ command: process.execPath, args: [serverBin], env: { ...process.env, ...env }, stderr: 'ignore' });
  await c.connect(t);
  return { c, t };
};
const { c: client, t: transport } = await connect();

const call = async (name, args = {}, c = client) => {
  const r = await c.callTool({ name, arguments: args });
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
  const r = await call('navigate', { session: sid, target: page(`${mainPage}?${api ? 'badshader' : 'throw'}`), wait: [ready, lenient ? '1500' : '300'] });
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
let sid2, sid2Procs = [];
await step('parallel second session + gpu_info + list', async () => {
  const pre = new Set(descendants(transport.pid));
  const r = await call('open', { target: page('hang.html'), wait: ['300'] });
  sid2 = r.json.session;
  sid2Procs = withHelpers(descendants(transport.pid).filter((p) => !pre.has(p)));
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
  assert.ok(sid2Procs.length >= 2, 'found the second session\'s host and browser');
  assert.deepEqual(describe(await waitGone(sid2Procs)), [], 'host, browser and its helper processes gone');
});

// Leave sid open: closing the client must tear it down.
const ours = withHelpers(descendants(transport.pid));
await client.close();
await step('client disconnect cleans up everything', async () => {
  assert.ok(ours.length >= 1, 'found the open session\'s browser');
  assert.deepEqual(describe(await waitGone(ours)), [], 'no browser processes left');
  const end = Date.now() + 10000;
  while (Date.now() < end && [...profiles()].some((p) => !before.profiles.has(p))) await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual([...profiles()].filter((p) => !before.profiles.has(p)), [], 'no temp profiles left');
});

// The server killed outright (SIGKILL, or TerminateProcess on Windows): no exit handlers run,
// so the reaper must kill the browsers and delete their profiles.
await step('hard-killed server leaves no browsers (hosts + reaper)', async () => {
  const { c: c2, t: t2 } = await connect();
  const before2 = profiles();
  for (const p of ['blank.html', 'hang.html']) {
    const r = await c2.callTool({ name: 'open', arguments: { target: page(p), wait: [] } });
    assert.ok(!r.isError, r.content[0].text);
  }
  const main = descendants(t2.pid);
  const created = [...profiles()].filter((p) => !before2.has(p));
  assert.ok(main.length >= 4, `expected 2 hosts and 2 browsers, found ${main.length} processes`);
  const browsers = withHelpers(main);
  process.kill(t2.pid, 'SIGKILL');
  assert.deepEqual(describe(await waitGone(browsers)), [], 'browsers killed');
  const end = Date.now() + 10000;
  while (Date.now() < end && created.some((p) => profiles().has(p))) await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(created.filter((p) => profiles().has(p)), [], 'profiles deleted');
});
// Idle sessions close quickly, and their host processes go with them; a long call is not idle.
await step('idle session closes with its host; a busy one does not', async () => {
  const { c: c3, t: t3 } = await connect({ HEMULI_IDLE_SECONDS: '2' });
  try {
    // The server's own processes (e.g. its conhost.exe on Windows) stay while it runs.
    const pre = new Set(descendants(t3.pid));
    const r = await call('open', { target: page('blank.html'), wait: [] }, c3);
    assert.equal(r.isError, false, JSON.stringify(r.json));
    // Started first: finding the processes can take longer than the idle time on Windows.
    const waiting = call('wait', { session: r.json.session, spec: '7000' }, c3);
    const procs = withHelpers(descendants(t3.pid).filter((p) => !pre.has(p)));
    assert.ok(procs.length >= 2, 'found the host and its browser');
    const w = await waiting;
    assert.equal(w.isError, false, `busy session was closed: ${JSON.stringify(w.json)}`);
    assert.deepEqual(describe(await waitGone(procs, 15000)), [], 'host and browser gone after idle');
    assert.deepEqual((await call('list_sessions', {}, c3)).json, []);
    const late = await call('logs', { session: r.json.session }, c3);
    assert.equal(late.isError, true);
    assert.match(late.json, /idle for 2 s/);
  } finally { await c3.close(); }
});
process.exit(process.exitCode ?? 0);
