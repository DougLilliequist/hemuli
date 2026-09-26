// Pure-function tests that don't need a browser, including Windows path handling
// (run with path.win32 so they are checked on every OS).
import assert from 'node:assert/strict';
import path from 'node:path';
import { classifyTarget, gpuWarnings } from '../lib/core.mjs';

const win = (t) => classifyTarget(t, { pathMod: path.win32, exists: () => false });
const posix = (t) => classifyTarget(t, { pathMod: path.posix, exists: () => false });
const tests = {
  'drive letter + query': () => assert.deepEqual(win('C:\\proj\\dist\\index.html?view=fluid'), { kind: 'path', fsPath: 'C:\\proj\\dist\\index.html', suffix: '?view=fluid' }),
  'drive letter, forward slashes': () => assert.equal(win('D:/proj/dist/').kind, 'path'),
  'UNC path': () => assert.deepEqual(win('\\\\server\\share\\a.html#x'), { kind: 'path', fsPath: '\\\\server\\share\\a.html', suffix: '#x' }),
  'http URL': () => assert.deepEqual(win('http://localhost:5173/?view=fluid'), { kind: 'url', url: 'http://localhost:5173/?view=fluid' }),
  'https / about / data URLs': () => { for (const u of ['https://x.y/a', 'about:blank', 'data:text/html,hi']) assert.equal(posix(u).kind, 'url'); },
  'relative paths': () => { for (const p of ['dist/', './a.html', 'a.html?x=1', '../b/index.html']) assert.equal(posix(p).kind, 'path'); },
  'no target': () => assert.equal(posix('').kind, 'none'),
  'existing file named like a scheme wins': () => assert.equal(classifyTarget('ab:c', { exists: () => true }).kind, 'path'),
  'warnings: hardware': () => assert.deepEqual(gpuWarnings({ webgpu: { available: true, adapter: { isFallbackAdapter: false } }, webgl2: { renderer: 'ANGLE (NVIDIA, D3D11)' } }, 'shell'), []),
  'warnings: software': () => {
    const w = gpuWarnings({ webgpu: { available: true, adapter: { isFallbackAdapter: true } }, webgl2: { renderer: 'ANGLE (Google, SwiftShader Device)' } }, 'shell');
    assert.equal(w.length, 3);
    assert.match(w[2], /GPU_BROWSER_ENGINE=chrome/);
  },
  'warnings: WARP / no WebGPU, chrome engine gives no engine hint': () => {
    const w = gpuWarnings({ webgpu: { available: false }, webgl2: { renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver)' } }, 'chrome');
    assert.equal(w.length, 2);
  },
};
let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n${e.message}`); }
}
if (failed) process.exit(1);
console.log(`\n${Object.keys(tests).length} passed`);
