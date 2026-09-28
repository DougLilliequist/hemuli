---
name: hemuli
description: Run, debug and validate WebGPU / WebGL / WGSL / GLSL / three.js builds in a lean headless Chromium with a real GPU, via the `hemuli` CLI (one-shot) or the hemuli MCP tools (interactive sessions). Use whenever you need to check that a graphics build loads, renders (not blank), has no shader compile / WebGPU validation / WebGL / JS errors, take a screenshot of it, read pixel colors, evaluate JS in it, or measure fps. Prefer this over Claude in Chrome or launching Chrome for graphics work; it's cheap enough to run many in parallel.
---

# hemuli

`hemuli` (on PATH; `hemuli --help` lists every option) launches a throwaway `chrome-headless-shell`. It uses the real GPU: Metal on macOS, D3D12/D3D11 on Windows, Vulkan on Linux. It loads the target, prints a JSON report to stdout and exits. Every run has a fresh temp profile, its own localhost server on a random port and a hard timeout, so parallel runs never collide.

Exit codes: `0` ok · `1` problems found (see `failures`) · `2` bad usage or setup · `124` timeout.

## CLI or MCP?

- **One-shot check** ("does it load and render without errors?"): use the CLI below from Bash.
- **Interactive debugging:** use the `hemuli` MCP tools (`mcp__hemuli__*`), for when you need to eval repeatedly, click, drag or scroll to move the camera, screenshot after each change, or `reload` after rebuilding. The flow is `open` → `logs` / `eval` / `input` / `screenshot` → `reload` → `close`.
  - `logs` returns only what's new since the last call, while `failures` always covers the whole current page load.
  - Each session is a whole browser, often hundreds of MB with a real scene. Keep one session per task: `reload` after rebuilding and `navigate` to another page or build instead of opening a new one. Always `close` it when done. Idle sessions close after 5 minutes, and at most 3 can be open.

## Common invocations (CLI)

```sh
hemuli                                         # GPU / WebGPU adapter / WebGL renderer info
hemuli dist/ --expect-content --shot /tmp/f.png   # build dir: loads, no errors, renders something
hemuli src/index.html --root .                 # serve the project root, open this file
hemuli http://localhost:5173/ --wait idle      # already-running dev server
hemuli dist/ --wait console:ready --eval 'scene.children.length' --fps 2
hemuli dist/ --sample 640,360 --size 1280x720  # RGBA at a pixel (checks colors)
```

After `--shot`, Read the PNG to see the frame.

## Options you'll reach for

- `--wait <spec>`: repeatable, runs in order. Default `1500` ms. Specs: `<ms>`, `idle`, `frames:<n>`, `selector:<css>`, `js:<expr>`, `console:<regex>`. Prefer waiting on a readiness signal (`console:` or `js:`) over a fixed sleep.
- `--eval <js>`: repeatable. Takes an expression, or a function body that uses `return`. `await` is allowed.
- `--shot <png>` · `--expect-content` (fails on a ≥99.5% single-color frame) · `--sample x,y`
- `--fps <sec>` · `--size WxH` · `--dpr n` · `--timeout ms` (default 60000)
- `--root <dir>` · `--coi` (COOP/COEP for SharedArrayBuffer) · `--ignore <regex>` · `--gpu-info` · `--flag <chromium switch>` · `--out <json>`

## Reading the report

- `failures`: the deduplicated list of problems, with repeats shown as `(xN)`. Empty with `ok: true` means clean.
- `gpuErrors`: WGSL errors (`line`, `col`, `source` line), WebGPU validation errors (`count` shows how often they repeat), device lost, GLSL compile and link logs, and any pending `gl.getError`.
- `pageErrors` (exceptions and unhandled rejections), `console`, `httpErrors` (404s and similar).
- `app`: what the page asked for (`requestAdapter` options, `requestDevice` features and limits, context types, canvas sizes).
- `image`: screenshot stats (`blank`, `dominantColor`, `distinctColors`, `samples`) · `fps` · `gpu` (adapter / renderer info).

Fix the first root-cause error first. Later ones are often "invalid due to a previous error" cascades.

## If the GPU isn't used

When the report or `open` result has a non-empty `warnings` list, e.g. "software fallback adapter" or "WebGL is software-rendered", the numbers and visuals won't match real hardware. Retry with the full-Chrome engine: pass `--engine chrome` to the CLI, set `engine: "chrome"` on `open`, or set `HEMULI_ENGINE=chrome`. It's already the default on Windows. If a warning says a software adapter is in use (SwiftShader, WARP, llvmpipe), the machine has no usable GPU: rendering correctness can still be checked, but not performance.

## Limits

- It's headless only: no DevTools UI and no extensions.
- WebGPU used from a worker isn't instrumented, though worker console output is captured.
- `fps` covers compositor pacing and the app's rAF CPU time, not GPU time.
