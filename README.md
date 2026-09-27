# hemuli

A lean, throwaway headless Chromium for **coding agents** to run, debug and validate **WebGPU / WebGL** builds, on the real GPU.

Launching full Chrome for every check is heavy, and several agents testing in parallel make it worse. hemuli gives each check its own small, isolated browser (about 65 MB for a simple scene). It loads the build, catches everything that went wrong (WGSL and GLSL errors, WebGPU validation errors, exceptions, 404s, blank frames) and reports back in JSON that an agent can act on.

There are two ways to use it:

| | When | How |
|---|---|---|
| **CLI** (`hemuli`) | "Does this build load, render, and stay error-free?" A one-shot pass/fail check | Launch, load, collect, print a JSON report, exit |
| **MCP server** (`hemuli-mcp`) | Poking at a running app over several steps: eval, click, drag the camera, screenshot, reload after a rebuild | Long-lived sessions driven through MCP tools |

Both share the same instrumentation, so they catch the same problems.

Highlights:
- **Real GPU.** Metal on macOS, D3D12 / D3D11 on Windows, Vulkan on Linux. When a machine falls back to software rendering, the report says so in `warnings`.
- **Parallel-safe.** Every run and session gets its own temporary profile, its own localhost server on a random port and a hard time limit. Nothing is shared, and nothing is left behind.
- **No state.** There's no history, tabs, sync, extensions or UI. Profiles are deleted on exit.
- **Cross-platform.** macOS, Windows and Linux, on Node 18.17 or newer.

---

## Quick start

```sh
npm install -g hemuli
hemuli setup-claude      # download the browser, register the MCP server + skill with Claude Code
hemuli                   # GPU report: no "warnings" means you're on real hardware
```

Then, from any project:

```sh
hemuli dist/ --expect-content --shot frame.png
echo $?                        # 0 = clean; 1 = problems (see "failures" in the JSON)
```

Start a new Claude Code session after `setup-claude`. Agents then discover the tool through the installed skill and the `hemuli` MCP tools.

---

## Install

### 1. Install the package

```sh
npm install -g hemuli
```

- **Latest from GitHub.** `npm install -g github:DougLilliequist/hemuli` installs the current `main` instead of the latest release.
- **Updating.** Re-run the same command.
- **Shells.** The commands work in PowerShell, cmd, bash and zsh. npm creates the `hemuli` and `hemuli-mcp` launchers (`.cmd` files on Windows).

### 2. Set up Claude Code (optional)

```sh
hemuli setup-claude
```

This command:
1. **Downloads the browser** (about 200 MB, once per machine and Chromium version).
2. **Registers the MCP server** with Claude Code at user scope. It uses the absolute path to your `node` binary, which avoids PATH and nvm problems and the `cmd /c` wrapper native Windows otherwise needs.
3. **Installs the agent skill** to `~/.claude/skills/hemuli/SKILL.md`. The skill tells agents when to use the CLI and when to use the MCP tools.

It's safe to re-run; it replaces the previous registration. To remove it: `claude mcp remove hemuli` and delete `~/.claude/skills/hemuli/`.

**Per-project alternative:** instead of the user-level registration, commit a `.mcp.json` to a repo so everyone working in it gets the server:

```json
{ "mcpServers": { "hemuli": { "command": "hemuli-mcp" } } }
```

On native Windows, use `{ "command": "cmd", "args": ["/c", "hemuli-mcp"] }` instead.

### 3. Check it

```sh
hemuli
```

This prints the GPU report: the WebGPU adapter, the WebGL renderer and, if something's off, `warnings`. On real hardware, `warnings` is absent. If it reports software rendering, see [Troubleshooting](#troubleshooting).

### Where the browser lives

The browser downloads on first use (or with `hemuli setup`) into a per-user cache shared by every project and install:

| OS | Cache |
|---|---|
| macOS / Linux | `~/.cache/hemuli` (or `$XDG_CACHE_HOME/hemuli`) |
| Windows | `%LOCALAPPDATA%\hemuli` |

To move it, set `HEMULI_CACHE`. To use an existing Chrome/Chromium binary, set `HEMULI_EXECUTABLE`.

---

## CLI

```
hemuli [target] [options]
hemuli setup [--engine chrome]     download the browser now
hemuli setup-claude                register MCP server + skill with Claude Code
```

`target` can be any of:
- **A build directory:** served over `http://localhost`, opening `index.html`.
- **An `.html` file:** its directory is served. A query string works, e.g. `index.html?view=fluid`.
- **A URL:** for example, a dev server that's already running.
- **Nothing:** prints the GPU report only.

Local files are always served over `http://localhost`, a secure context. That makes WebGPU available, and `fetch()`, ES modules and wasm work, which they don't under `file://`. Files are served with no caching, so a rebuild is picked up on the next run.

### Recipes

```sh
# Validate a production build: loads, renders something, no errors
hemuli dist/ --expect-content --shot /tmp/frame.png

# Wait for the app's own readiness signal instead of a fixed sleep
hemuli dist/ --wait console:ready --expect-content

# An already-running Vite dev server, one specific example
hemuli "http://localhost:5173/?view=fluid" --wait idle --wait 2000 --shot /tmp/fluid.png

# Inspect app state and measure frame rate
hemuli dist/ --wait js:window.app?.ready --eval "app.scene.children.length" --fps 3

# Check colors: RGBA at the center pixel
hemuli dist/ --size 800x600 --sample 400,300

# Assets referenced as ../assets/...: serve the project root, open a nested file
hemuli examples/demo/index.html --root .

# SharedArrayBuffer / wasm threads
hemuli dist/ --coi

# Many checks at once: each is fully isolated
for v in fluid ssao taa; do hemuli "dist/index.html?view=$v" --expect-content > "$v.json" & done; wait
```

**Builds with a base path.** Suppose a build expects to live under a sub-path, e.g. Vite `base: '/app/'` so assets load from `/app/assets/...`. Point `--root` at a folder in which `app/` is the build; a symlink works (`mkdir serve && ln -s ../dist serve/app`). Then open `serve/app/index.html` with `--root serve`. Alternatively, run the project's own preview server and pass its URL.

### Options

| Option | Meaning |
|---|---|
| `--wait <spec>` | Runs after `load`. Repeatable; steps run in order. Default `1500` ms. See [wait specs](#wait-specs) |
| `--eval <js>` | Runs JS in the page after the waits. Takes an expression, or a function body using `return`; may `await`. Repeatable. Results go in `evals` |
| `--shot <file.png>` | Takes a viewport screenshot after the evals. The report's `image` gets the dominant color, its share and the number of distinct colors |
| `--expect-content` | Fails the run if the frame is at least 99.5% one color, which catches "rendered nothing" |
| `--sample <x,y>` | Reports the screenshot's RGBA at a viewport pixel (CSS px). Repeatable |
| `--fps <seconds>` | Measures frame pacing (p50 / p95 / max) and the CPU time of the app's `requestAnimationFrame` callbacks |
| `--size <WxH>`, `--dpr <n>` | Viewport size and device pixel ratio (default `1280x720`, dpr 1) |
| `--root <dir>` | Directory to serve instead of the target's own directory |
| `--coi` | Sends COOP/COEP headers (cross-origin isolation) |
| `--ignore <regex>` | Errors matching this are still listed but don't fail the run. Repeatable |
| `--timeout <ms>` | Hard limit for the whole run (default 60000). Every step fits inside it, and the browser is killed at the limit |
| `--engine <name>` | `shell` or `chrome`; see [Engines](#engines) |
| `--gpu-info` | Includes full adapter features and limits, plus WebGL extensions |
| `--flag <switch>` | Extra Chromium switch, e.g. `--flag=--enable-dawn-features=dump_shaders`. Repeatable |
| `--max-console <n>` | Keeps at most n console entries (default 200) |
| `--out <file.json>` | Also writes the report to a file |

#### Wait specs

| Spec | Waits until |
|---|---|
| `<ms>` | That many milliseconds have passed |
| `idle` | The network has been quiet for 500 ms |
| `frames:<n>` | n `requestAnimationFrame` ticks have run |
| `selector:<css>` | A matching element exists |
| `js:<expr>` | The expression is truthy (exceptions count as false, so `js:window.app?.ready` is fine) |
| `console:<regex>` | A console message matches |

Prefer a readiness signal (`console:` or `js:`) over fixed sleeps: it's faster and not flaky on slow machines. A sleep longer than the remaining time budget fails instead of being silently cut short.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean: `failures` is empty |
| `1` | Problems found: see `failures` |
| `2` | Bad usage or setup (e.g. target not found) |
| `124` | The run hit `--timeout` |

`warnings` (software rendering, sandbox disabled) never changes the exit code.

### What fails a run

| Failure | Source |
|---|---|
| `pageerror` | Uncaught exceptions and unhandled promise rejections |
| `console.error` | `console.error` calls and failed resource loads (with the file path) |
| `webgpu-shader-error` | WGSL compile errors, with `line`, `col` and the offending `source` line |
| `webgpu-uncaptured-error` | Validation and out-of-memory errors. Per-frame repeats are collapsed into one entry with a count, e.g. `(x48)` |
| `webgpu-device-lost`, `webgpu-no-adapter` | The device was lost for any reason other than `destroy()`; `requestAdapter()` returned null |
| `webgpu-error (console)` | A WebGPU error Chrome printed that the hooks hadn't recorded yet (very slow machines) |
| `webgl-shader-error`, `webgl-link-error` | GLSL compile or link failures, with the info log |
| `webgl-error`, `webgl-context-lost` | A `gl.getError()` still pending when checked; a context-lost event |
| `renderer-crash`, `worker-error` | The page's renderer process crashed; an error in a worker |
| `page-unresponsive` | The page's main thread is stuck (e.g. an infinite loop) |
| `blank-frame` | Only with `--expect-content` |
| `navigation`, `wait`, `eval`, `screenshot`, `timeout` | A step of the run itself failed |

The hooks only listen. The page's own `uncapturederror` handlers, error scopes and behavior are unchanged.

### Report

The JSON report (abridged):

```json
{
  "ok": false,
  "failures": [
    "webgpu-shader-error: unresolved value 'undefinedThing'",
    "webgpu-uncaptured-error: [Invalid CommandBuffer] is invalid due to a previous error. (x48)"
  ],
  "warnings": [],
  "url": "http://localhost:53122/index.html",
  "engine": "shell",
  "gpu": {
    "webgpu": { "adapter": { "vendor": "apple", "architecture": "metal-3", "isFallbackAdapter": false }, "features": 25 },
    "webgl2": { "renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, ...)" }
  },
  "console": [{ "type": "log", "text": "ready", "at": "/assets/main.js:12" }],
  "pageErrors": [],
  "gpuErrors": [{ "kind": "webgpu-shader-error", "label": "tri", "line": 1, "col": 60, "source": "return vec4f(undefinedThing, 0, 1);", "message": "..." }],
  "httpErrors": [], "requestsFailed": [],
  "waits": [{ "spec": "console:ready", "ms": 212 }],
  "evals": [{ "expr": "app.scene.children.length", "value": 12 }],
  "fps": { "fps": 60, "frameMs": { "p50": 16.7, "p95": 16.8, "max": 17 }, "appRafAvgMs": 0.4 },
  "image": { "dominantColor": "#0c1a33", "dominantFraction": 0.75, "distinctColors": 214, "blank": false },
  "screenshot": "/tmp/frame.png",
  "app": {
    "requestAdapter": { "options": { "powerPreference": "high-performance" }, "gotAdapter": true },
    "requestDevice": { "requiredFeatures": ["shader-f16", "timestamp-query"], "requiredLimits": {} },
    "contexts": ["webgpu"],
    "canvases": [{ "id": "c", "width": 1280, "height": 720 }]
  },
  "jsHeapMB": 3.2,
  "durationMs": 2400
}
```

`app` shows what the page asked the GPU for, which is handy when a device request fails on another machine.

---

## MCP server

The MCP server keeps browser sessions open so an agent can work with a running app step by step. `hemuli setup-claude` registers it; to run it by hand, use `hemuli-mcp` (stdio transport).

A typical flow:

```
open { target: "dist/" }                  → session id + load status (failures, console, GPU requests)
input { actions: [{ type: "drag", x: 400, y: 300, to_x: 700, to_y: 300 }] }
screenshot { samples: [[640, 360]] }      → image + blank-frame stats + pixel colors
logs                                      → only what's new since the last call
… edit code, rebuild …
reload                                    → fresh load status
close
```

| Tool | What it does |
|---|---|
| `open` | Launches an isolated browser session and loads a target (URL, build dir, `.html` file, or nothing). Takes `target`, `root`, `wait` (default `["1000"]`), `width`, `height`, `dpr`, `coi`, `ignore`, `flags`, `engine`, `timeout_ms` |
| `logs` | Returns what's new since the previous call (console, page errors, GPU errors, HTTP errors). Repeating GPU errors appear with `newOccurrences`. `failures` always covers the whole current page load; `ok` is true when it's empty |
| `eval` | Runs JS in the page: an expression or a `return` body, may `await`. Returns the JSON value |
| `screenshot` | Returns the image plus stats (`blank`, `dominantColor`, `distinctColors`) and RGBA at `samples`. `selector` clips to one element (e.g. `"canvas"`); `save_path` also writes a PNG; `include_image: false` returns stats only |
| `input` | Sends real input in order, in CSS pixels: `click`, `move`, `down`, `up`, `drag` (e.g. orbit a camera), `wheel` (zoom), `key` (`"Enter"`, `"Shift+KeyW"`, optionally held for `ms`), `type`, `pause` |
| `reload` | Reloads the page (e.g. after a rebuild) and returns the new load status. Collected logs are cleared |
| `navigate` | Loads a different target in the same session |
| `wait` | Waits for a [wait spec](#wait-specs) |
| `fps` | Frame pacing and app rAF cost over N seconds |
| `resize` | Changes viewport size / dpr |
| `gpu_info` | Adapter and renderer details plus `warnings`. Uses a session, or a temporary browser if none is given |
| `list_sessions`, `close` | Lists open sessions; closes one (kills its browser, deletes its profile) |

**Limits and cleanup:**
- **Session count:** at most 8 open at once (`HEMULI_MAX_SESSIONS`).
- **Idle sessions:** closed after 15 minutes (`HEMULI_IDLE_MINUTES`).
- **Time limit per call:** 30 s by default. On a frozen page, calls return a "timed out (page busy or hung?)" error, `logs` reports `page-unresponsive`, and `close` still works.
- **Cleanup:** when the client disconnects, every browser and profile is removed. A small reaper process does the same if the server is killed outright (e.g. Claude Code exiting, or `TerminateProcess` on Windows), so no browsers are orphaned.

---

## Engines

Both engines are Chrome for Testing builds, pinned to the same Chromium version (`hemuli.chromeVersion` in `package.json`).

| Engine | What it is | Download |
|---|---|---|
| `shell` (default on macOS / Linux) | `chrome-headless-shell`: Chromium stripped down for headless use. The lightest option | ~200 MB |
| `chrome` (default on Windows) | Full Chrome for Testing in headless mode: the same browser as desktop Chrome | ~365 MB |

Choose per run with `--engine chrome` (CLI) or `engine: "chrome"` (MCP `open`), or everywhere with `HEMULI_ENGINE=chrome`.

**Why Windows defaults to `chrome`:** the Windows build of `chrome-headless-shell` doesn't include `dxil.dll`, the DirectX shader compiler that WebGPU's D3D12 backend loads. Without it, an adapter is found but `requestDevice()` fails. If you force `--engine shell` on Windows, hemuli switches WebGPU to FXC, the older compiler that ships with Windows. That works, but features that need DXC (e.g. `shader-f16`) may be unavailable.

---

## Environment variables

| Variable | Effect |
|---|---|
| `HEMULI_ENGINE` | `shell` or `chrome` (default: `chrome` on Windows, `shell` elsewhere) |
| `HEMULI_CACHE` | Browser download location |
| `HEMULI_EXECUTABLE` | Use this Chrome/Chromium binary instead of downloading one |
| `HEMULI_EXTRA_FLAGS` | Space-separated Chromium switches added to every launch |
| `HEMULI_MAX_SESSIONS` | MCP: max concurrent sessions (default 8) |
| `HEMULI_IDLE_MINUTES` | MCP: close sessions idle this long (default 15) |

---

## Troubleshooting

**`warnings` says software rendering** (a fallback or software WebGPU adapter, or SwiftShader, WARP or llvmpipe for WebGL). The page ran, but not on the GPU, so visuals may differ and performance numbers don't mean much.
- Try `--engine chrome` first.
- Check that the machine actually has a GPU and drivers; VMs, remote desktops and CI runners usually don't.
- Rendering correctness can still be checked on software, but performance can't.

**Windows: `requestDevice()` fails mentioning `dxil.dll`.** This comes from the `shell` engine without the FXC switch: an old hemuli, or `HEMULI_EXECUTABLE` pointing at a headless-shell build. Update hemuli, or use `--engine chrome`.

**Linux: `warnings` mentions `--no-sandbox`.** Ubuntu 23.10+ blocks Chromium's sandbox through AppArmor, and containers running as root can't use it either. hemuli falls back to running without the sandbox. That's fine for your own builds; don't point it at untrusted sites.

**The frame is blank but there are no errors.** The app may simply not have drawn yet. Wait for a readiness signal (`--wait console:<msg>` or `--wait js:<expr>`) rather than a fixed sleep. Also check `app.canvases`: a 0×0 canvas usually means a layout or resize bug.

**A run takes the full `--timeout`.** The page is probably stuck in a loop: look for `page-unresponsive` in `failures`.

---

## Limitations

- **Headless only.** There's no visible window and no DevTools UI. Agents inspect the screenshots instead.
- **Workers aren't instrumented.** WebGPU used inside a web worker isn't hooked, and Chrome doesn't print those errors to the console, so they're not caught. Console output from workers is captured.
- **`fps` is CPU-side.** It measures frame pacing and the app's `requestAnimationFrame` time, not GPU execution time.
- **Hardware coverage.** The tool is verified on macOS with a real GPU. Windows and Linux are verified in CI on GPU-less runners: Windows through WARP (the full rendering suite passes on both engines), and Linux through SwiftShader (rendering checks are skipped there).

---

## How it works

| File | Role |
|---|---|
| `lib/core.mjs` | `Session`: launches the browser, injects the instrumentation, serves local files, collects errors, and handles waits, evals, screenshots and fps |
| `bin/hemuli.mjs` | The CLI: one `Session` per run, JSON report, exit code |
| `bin/hemuli-mcp.mjs` | The MCP server: a registry of long-lived sessions, with the tools described above |
| `lib/reaper.mjs` | Detached watchdog that kills the MCP server's browsers if the server dies without cleaning up |
| `lib/setup-claude.mjs` | `hemuli setup-claude` |
| `skill/SKILL.md` | The agent skill installed by `setup-claude` |

**Instrumentation.** Before any page script runs, a small hook is injected into every frame. It wraps:
- `requestAdapter`, `requestDevice` and `createShaderModule` to collect uncaptured errors, device loss and WGSL compilation messages.
- `getContext` to catch WebGL context loss and GLSL compile/link failures.
- `requestAnimationFrame` to time the app's frames.

Repeated errors are collected once, with a count. GPU info and screenshot analysis run on a separate blank page served from `127.0.0.1`, a different site from the app's `localhost`, so they work even if the app's page is frozen.

---

## Development

```sh
git clone https://github.com/DougLilliequist/hemuli.git && cd hemuli
npm install
npm test                              # unit tests → CLI tests → end-to-end MCP client test
HEMULI_ENGINE=chrome npm test         # the same against the full-Chrome engine
```

- **`test/unit-tests.mjs`:** target parsing (including Windows drive-letter and UNC paths, checked on any OS) and the warnings logic.
- **`test/run-tests.mjs`:** CLI cases against the pages in `test/pages/`: rendering checks with pixel samples, WGSL, GLSL and validation errors, exceptions, 404s, blank frames, hangs, time budgets.
- **`test/mcp-test.mjs`:** drives every MCP tool through a real MCP client, including parallel sessions, a frozen page, cleanup on disconnect, and a hard-killed server.

Locally, the tests require a real hardware GPU adapter. With `CI=1` (or `HEMULI_TEST_LENIENT=1`) they only report the adapter, stretch waits for slow machines, and skip the cases a GPU-less machine can't run. `HEMULI_TEST_CONCURRENCY` sets how many browsers run at once (default 6).

CI (`.github/workflows/test.yml`) runs the suite on macOS, Windows and Linux with both engines.

**Updating Chromium:** set `hemuli.chromeVersion` in `package.json` to a version listed at <https://googlechromelabs.github.io/chrome-for-testing/>, run `hemuli setup` (plus `hemuli setup --engine chrome`), then `npm test`.

---

## License

MIT
