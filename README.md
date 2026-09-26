# gpu-browser

A throwaway headless Chromium for coding agents to run, debug and validate WebGPU / WebGL builds.

- **Real GPU.** Headless doesn't mean software rendering here. WebGPU and WebGL use Metal on macOS, D3D12/D3D11 on Windows and Vulkan on Linux. If a machine falls back to software rendering, the report says so in `warnings`.
- **macOS, Windows, Linux.** Requires Node 18.17+. The browser downloads itself on first use.
- **Light.** It uses Chrome for Testing's `chrome-headless-shell`, with no browser UI, extensions, sync, history or tab restore. A simple scene costs about 65 MB of memory footprint per instance, measured with macOS `footprint` across all of its processes.
- **Parallel-safe.** Each run has its own temp profile (deleted on exit), its own static server on a random port and a hard timeout. Run as many as you like at once.
- **Two ways in.**
  - The `gpu-browser` CLI is a one-shot run: it launches, loads the page, collects results, prints a JSON report and exits.
  - The `gpu-browser` MCP server keeps sessions open so you can debug interactively: eval, click, drag, screenshot, and reload after a rebuild.

Both use the same instrumentation (`lib/core.mjs`), so they catch the same errors.

**Which to use:** for "did the build load, render and stay error-free?", use the CLI. When you need to poke at a running app over several steps, use the MCP server.

## Install

Install globally from the team repo (or run `npm install -g .` from a clone), then hook it into Claude Code:

```sh
npm install -g github:<org>/gpu-browser
gpu-browser setup-claude
```

`gpu-browser setup-claude` does two things:
- It registers the MCP server with Claude Code at user scope, using the absolute path to your `node`. That avoids PATH/nvm problems and the `cmd /c` wrapper native Windows otherwise needs.
- It installs the agent skill to `~/.claude/skills/gpu-browser/`.

Start a new Claude Code session afterwards. The same commands work in PowerShell, cmd and any Unix shell: npm creates the `gpu-browser` / `gpu-browser-mcp` shims (`.cmd` on Windows).

**The browser download** (about 200 MB, once per machine and version) happens during install. If that's skipped, for example by `--ignore-scripts`, being offline or a proxy, it happens on the first run instead, with progress on stderr. It lives in a per-user cache shared by every project:

| OS | Cache |
|---|---|
| macOS / Linux | `~/.cache/gpu-browser` (or `$XDG_CACHE_HOME/gpu-browser`) |
| Windows | `%LOCALAPPDATA%\gpu-browser` |

Override it with `GPU_BROWSER_CACHE`, or point at an existing Chrome binary with `GPU_BROWSER_EXECUTABLE`. Set `GPU_BROWSER_SKIP_DOWNLOAD=1` to skip the install-time download.

**Check the install:** run `gpu-browser` with no arguments. It prints the GPU report. If `warnings` is missing or empty, you're on hardware.

**Per-project alternative:** instead of `setup-claude`, commit a `.mcp.json` to a repo so everyone working on it gets the server:

```json
{ "mcpServers": { "gpu-browser": { "command": "gpu-browser-mcp" } } }
```

On native Windows, use `"command": "cmd", "args": ["/c", "gpu-browser-mcp"]` instead.

### Engines

| Engine | What | Size |
|---|---|---|
| `shell` (default) | `chrome-headless-shell`: Chromium stripped for headless use, with no UI, extensions, sync or history. About 65 MB of memory per instance on macOS | ~200 MB |
| `chrome` | Full Chrome for Testing in new headless mode. It's the same browser as desktop Chrome, so use it if `shell` reports software rendering on a machine | ~365 MB |

Pick one per run with `--engine chrome` (CLI) or `engine: "chrome"` (MCP `open`), or set it globally with `GPU_BROWSER_ENGINE=chrome`. Both are pinned to the same Chromium version.

## Usage

```sh
gpu-browser                                   # just report GPU / WebGPU / WebGL info
gpu-browser dist/                             # serve a build dir, open index.html
gpu-browser dist/index.html?scene=2           # serve the file's dir, open with query
gpu-browser http://localhost:5173/            # an already-running dev server
```

Typical agent validation run:

```sh
gpu-browser dist/ --wait console:ready --expect-content --shot /tmp/frame.png --fps 2
echo $?   # 0 ok, 1 problems found, 2 usage/setup error, 124 timed out
```

Then read `/tmp/frame.png` to look at the frame.

### Options

| Option | Meaning |
|---|---|
| `--wait <spec>` | Repeatable, runs in order after `load`. Default `1500` (ms). Specs: `<ms>`, `idle`, `frames:<n>`, `selector:<css>`, `js:<expr>`, `console:<regex>` |
| `--eval <js>` | Repeatable. Runs an expression, or a function body that uses `return`. May `await`. Results go in `evals` |
| `--shot <png>` | Takes a viewport screenshot. The report's `image` gets the dominant color and its share, plus a count of distinct colors |
| `--expect-content` | Fails if the frame is ≥99.5% one color, which catches "rendered nothing" |
| `--sample <x,y>` | Repeatable. Reports the RGBA of the screenshot at viewport pixel x,y |
| `--fps <sec>` | Measures frame pacing and the app's own `requestAnimationFrame` CPU cost |
| `--size <WxH>` / `--dpr <n>` | Sets the viewport (default `1280x720`, dpr 1) |
| `--root <dir>` | Serves this dir instead of the target file's dir (for `../assets` references) |
| `--coi` | Sends COOP/COEP headers (needed for SharedArrayBuffer and wasm threads) |
| `--ignore <regex>` | Repeatable. Errors matching this are reported but don't fail the run |
| `--timeout <ms>` | Hard limit on the whole run (default 60000). The browser is killed when it hits |
| `--gpu-info` | Includes full adapter features and limits, plus WebGL extensions |
| `--flag <switch>` | Passes an extra Chromium switch, e.g. `--flag=--enable-dawn-features=dump_shaders` |
| `--out <json>` | Also writes the report to a file |

### What gets caught (and fails the run)

| Kind | Source |
|---|---|
| `pageerror` | Uncaught exceptions and unhandled promise rejections |
| `console.error` | `console.error` calls and failed resource loads (the file path is included) |
| `webgpu-shader-error` | WGSL compile errors, with `line`, `col` and the `source` line |
| `webgpu-uncaptured-error` | Validation and out-of-memory errors. Repeats are collapsed into `count` |
| `webgpu-device-lost` / `webgpu-no-adapter` | Device lost for any reason except `destroy()`; `requestAdapter()` returned null |
| `webgl-shader-error` / `webgl-link-error` | GLSL compile and link failures, with the info log |
| `webgl-error` / `webgl-context-lost` | A `gl.getError()` still pending at the end of the run; a context-lost event |
| `blank-frame` | Only with `--expect-content` |
| `page-unresponsive` | The page's main thread is stuck (e.g. an infinite loop), so the tool can't read its state |
| `wait` / `eval` / `navigation` / `timeout` | A tool step failed |

WebGPU validation errors (shown as `webgpu-uncaptured-error`) still reach the page's own `uncapturederror` handlers. The tool only listens alongside them.

### Report shape (abridged)

```json
{
  "ok": false,
  "failures": ["webgpu-shader-error: unresolved value 'foo'", "webgpu-uncaptured-error: [Invalid CommandBuffer] ... (x48)"],
  "url": "http://localhost:53122/index.html",
  "gpu": { "webgpu": { "adapter": { "vendor": "apple", "architecture": "metal-3" }, "features": 25 }, "webgl2": { "renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro...)" } },
  "console": [{ "type": "log", "text": "ready", "at": "/main.js:12" }],
  "pageErrors": [], "gpuErrors": [{ "kind": "webgpu-shader-error", "line": 14, "col": 9, "source": "let x = foo;", "message": "..." }],
  "httpErrors": [], "requestsFailed": [],
  "evals": [{ "expr": "scene.objects.length", "value": 12 }],
  "fps": { "fps": 60, "frameMs": { "p50": 16.7, "p95": 16.8, "max": 17 }, "appRafAvgMs": 0.4 },
  "image": { "dominantColor": "#0c1a33", "dominantFraction": 0.75, "distinctColors": 214, "blank": false },
  "app": { "contexts": ["webgpu"], "requestDevice": { "requiredFeatures": [] }, "canvases": [{ "width": 1280, "height": 720 }] },
  "jsHeapMB": 3.2, "durationMs": 2400
}
```

## MCP server (interactive sessions)

To register it, see [Install](#install) (`gpu-browser setup-claude`).

| Tool | Does |
|---|---|
| `open` | Launches an isolated browser session and loads a target (URL, build dir or .html). Returns the session id plus load status: failures, console, errors, and what the app requested from the GPU |
| `logs` | Returns what's new since the previous call (console, page errors, GPU errors, HTTP errors), plus the full `failures` list for the current load. Repeating GPU errors show up as `newOccurrences` |
| `eval` | Runs JS in the page (an expression or a `return` body, may `await`) |
| `screenshot` | Returns the image, blank-frame stats and RGBA at `samples`. `selector` clips to one element; `save_path` also writes the PNG |
| `input` | Sends `click`, `move`, `down`/`up`, `drag` (orbit a camera), `wheel` (zoom), `key` (`Shift+KeyW`, optional hold), `type` and `pause` |
| `reload` / `navigate` | Reloads after a rebuild (nothing is cached), or loads another target. Collected logs are cleared |
| `wait` | Same specs as the CLI's `--wait` |
| `fps`, `resize`, `gpu_info` | Same measurements as the CLI flags; `resize` changes the viewport |
| `close`, `list_sessions` | Close sessions when done; each one holds a browser |

Sessions close automatically after 15 idle minutes (`GPU_BROWSER_IDLE_MINUTES`). At most 8 can be open at once (`GPU_BROWSER_MAX_SESSIONS`). When the client disconnects, every browser and temp profile is removed.

Every tool call has a time limit (30 s by default). On a hung page, calls return a "timed out (page busy or hung?)" error, `logs` reports `page-unresponsive`, and `close` still cleans up.

## Notes

- Local paths are served over `http://localhost`, which is a secure context, so WebGPU is available. `fetch()`, ES modules and wasm all work there, which they don't under `file://`.
- Instrumentation covers the page's own frames, not workers: console output from workers is captured, but WebGPU used from a worker isn't hooked.
- `fps` measures the headless compositor's frame pacing plus the CPU time in the app's rAF callbacks. It doesn't include GPU execution time.
- It's headless only: there's no DevTools UI and no extensions. That's what keeps it light.
- A report's `warnings` flags software rendering (a fallback WebGPU adapter, or SwiftShader, llvmpipe or WARP for WebGL). Warnings don't change the exit code.
- On Linux as root (containers, CI), `--no-sandbox` is added automatically.

## Developing

```sh
npm install
npm test        # unit tests (incl. Windows path handling), CLI tests on real WebGPU/WebGL
                # rendering + error detection, then an end-to-end MCP client test of every tool
GPU_BROWSER_ENGINE=chrome npm test   # same against the full-Chrome engine
```

Locally, the tests require a hardware GPU adapter. With `CI=1` (or `GPU_BROWSER_TEST_LENIENT=1`) they only report the adapter and skip cases for APIs the machine lacks, which is what the GitHub Actions matrix uses: 3 OSes × 2 engines, on runners without GPUs. `GPU_BROWSER_TEST_CONCURRENCY` sets how many browsers the tests run at once (default 6).

**Updating Chromium:** change `gpuBrowser.chromeVersion` in `package.json` to a version listed at https://googlechromelabs.github.io/chrome-for-testing/, then run `gpu-browser setup` (add `--engine chrome` for the full-Chrome engine).
