// Orphan reaper for long-lived processes (the MCP server). A detached child that is told which
// browsers/profiles exist; when its stdin closes because the parent died for any reason, even
// SIGKILL or TerminateProcess on Windows, where exit handlers never run, it kills those browsers
// and deletes their profiles.
//
// Parent side:  const r = startReaper(); r.add(pid, dir); r.remove(pid); r.stop();
// stop() closes the pipe, so a reaper with nothing tracked just exits (used to drop it when idle).
// Child side:   node lib/reaper.mjs   (reads "add <pid> <dir>" / "del <pid>" lines on stdin)
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);

export function startReaper() {
  const child = spawn(process.execPath, [self], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
  child.unref();
  child.stdin.on('error', () => {});
  child.stdin.unref?.();
  const send = (line) => { try { child.stdin.write(line + '\n'); } catch {} };
  return {
    add: (pid, dir) => pid && send(`add ${pid} ${encodeURIComponent(dir || '')}`),
    remove: (pid) => pid && send(`del ${pid}`),
    stop: () => { try { child.stdin.end(); } catch {} },
  };
}

// ---------- child ----------
if (process.argv[1] === self) {
  const tracked = new Map(); // pid -> profile dir
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const [cmd, pid, dir] = buf.slice(0, i).split(' ');
      buf = buf.slice(i + 1);
      if (cmd === 'add') tracked.set(pid, decodeURIComponent(dir || ''));
      else if (cmd === 'del') tracked.delete(pid);
    }
  });
  const reap = () => {
    for (const pid of tracked.keys()) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true });
      else { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    // Give the processes a moment to release file locks before deleting profiles.
    setTimeout(() => {
      for (const dir of tracked.values()) if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
      process.exit(0);
    }, tracked.size ? 1000 : 0);
  };
  process.stdin.on('end', reap);
  process.stdin.on('close', reap);
}
