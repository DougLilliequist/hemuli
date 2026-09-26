#!/usr/bin/env node
// npm postinstall: best-effort download of the default browser engine into the per-user cache.
// Never fails the install: if it can't download now (offline, proxy, --ignore-scripts), the
// first gpu-browser run downloads it instead. The import is dynamic because npm also runs this
// inside a bare git clone (for github: installs) where dependencies aren't installed yet.
if (process.env.GPU_BROWSER_SKIP_DOWNLOAD) process.exit(0);
try {
  const { ensureBrowser, defaultEngine } = await import('../lib/core.mjs');
  const exe = await ensureBrowser(defaultEngine());
  console.error(`[gpu-browser] browser ready: ${exe}`);
} catch (e) {
  console.error(`[gpu-browser] browser download skipped (${e.message.split('\n')[0]}); it will be fetched on first run.`);
}
