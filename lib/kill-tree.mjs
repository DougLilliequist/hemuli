// Kill a browser together with its helper processes (GPU, renderers, network/utility). Killing
// only the main process leaves the helpers to notice on their own that it is gone, which a GPU
// process holding a large allocation doesn't always do promptly. Kept free of dependencies so the
// reaper child can use it without loading puppeteer.
import { spawnSync } from 'node:child_process';

/**
 * macOS / Linux: puppeteer spawns Chromium detached, so it leads its own process group
 * (pgid = pid) and every helper inherits that group; kill(-pid) takes them all. Also safe after
 * the main process has exited: it sweeps helpers still in the group, and a group with no members
 * left is simply ESRCH.
 * Windows: taskkill /T walks the tree, so it must run while the main process is still alive.
 */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}
