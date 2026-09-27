// `hemuli setup-claude`: registers the MCP server with Claude Code (user scope) and installs
// the hemuli skill, so every Claude Code session on this machine can use it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, ensureBrowser, defaultEngine } from './core.mjs';

// The MCP server is launched with this node binary and an absolute script path, so it works
// regardless of PATH/nvm and without the `cmd /c` wrapper native Windows needs for npm shims.
const serverArgs = [process.execPath, path.join(ROOT, 'bin', 'hemuli-mcp.mjs')];

function claude(args) {
  const win = process.platform === 'win32';
  // On Windows `claude` may be a .cmd shim, which needs a shell; quote args for it.
  const q = (a) => (win && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return spawnSync(win ? 'claude' : 'claude', win ? args.map(q) : args, { encoding: 'utf8', shell: win });
}

export async function setupClaude({ skipMcp = false, skipSkill = false } = {}) {
  let ok = true;
  try { console.log(`Browser ready: ${await ensureBrowser(defaultEngine())}`); }
  catch (e) { console.log(`Browser download failed (${e.message}); it will be retried on first run.`); }
  if (!skipMcp) {
    const probe = claude(['--version']);
    const manual = `claude mcp add --scope user hemuli -- ${serverArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
    if (probe.error || probe.status !== 0) {
      console.log(`Claude Code CLI not found on PATH. Register the MCP server yourself with:\n  ${manual}`);
      ok = false;
    } else {
      claude(['mcp', 'remove', '--scope', 'user', 'hemuli']); // replace any older registration
      claude(['mcp', 'remove', '--scope', 'user', 'gpu-browser']); // this tool's name before 2.0
      const r = claude(['mcp', 'add', '--scope', 'user', 'hemuli', '--', ...serverArgs]);
      if (r.status === 0) console.log(`MCP server registered (user scope): ${serverArgs.join(' ')}`);
      else { console.log(`claude mcp add failed:\n${r.stderr || r.stdout}\nRun it yourself:\n  ${manual}`); ok = false; }
    }
  }
  if (!skipSkill) {
    const dest = path.join(os.homedir(), '.claude', 'skills', 'hemuli');
    mkdirSync(dest, { recursive: true });
    copyFileSync(path.join(ROOT, 'skill', 'SKILL.md'), path.join(dest, 'SKILL.md'));
    console.log(`Skill installed: ${path.join(dest, 'SKILL.md')}`);
    const old = path.join(os.homedir(), '.claude', 'skills', 'gpu-browser');
    if (existsSync(old)) { rmSync(old, { recursive: true, force: true }); console.log(`Removed the old gpu-browser skill: ${old}`); }
  }
  console.log(ok ? '\nDone. Start a new Claude Code session to pick it up.' : '\nPartly done; see above.');
  return ok;
}
