#!/usr/bin/env node
// Best-effort download of the default browser engine into the per-user cache (`npm run setup`
// in a clone). Not an install script: npm's lifecycle scripts are unreliable for github: installs,
// so the browser is fetched by `hemuli setup` / `setup-claude` or on first run instead.
if (process.env.HEMULI_SKIP_DOWNLOAD) process.exit(0);
try {
  const { ensureBrowser, defaultEngine } = await import('../lib/core.mjs');
  const exe = await ensureBrowser(defaultEngine());
  console.error(`[hemuli] browser ready: ${exe}`);
} catch (e) {
  console.error(`[hemuli] browser download skipped (${e.message.split('\n')[0]}); it will be fetched on first run.`);
}
