#!/usr/bin/env node
// npm postinstall: best-effort download of the default browser engine into the per-user cache.
// Never fails the install: if it can't download now (offline, proxy, --ignore-scripts), the
// first gpu-browser run downloads it instead.
import { ensureBrowser, defaultEngine } from '../lib/core.mjs';

if (process.env.GPU_BROWSER_SKIP_DOWNLOAD) process.exit(0);
try {
  const exe = await ensureBrowser(defaultEngine());
  console.error(`[gpu-browser] browser ready: ${exe}`);
} catch (e) {
  console.error(`[gpu-browser] browser download skipped (${e.message}); it will be fetched on first run.`);
}
