# Zbook

[![PyPI release](https://img.shields.io/pypi/v/zbook?label=release)](https://pypi.org/project/zbook/)
[![CI](https://github.com/honglu2875/zbook/actions/workflows/ci.yml/badge.svg)](https://github.com/honglu2875/zbook/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/honglu2875/zbook/blob/main/LICENSE)

**A small local notebook with a built-in Codex assistant.**

Zbook is a fast, keyboard-first AI-assisted notebook for local research work. Its defining features are
- Native Codex-to-notebook interaction;
- `uv` managed environments/kernels;
- A UI that has a different style than Jupyter Notebooks.

Codex runs through the locally installed Codex CLI. It can use your existing CLI login and subscription; Zbook does not require a separate API key.

**Quick start**
```bash
uv tool install zbook
zbook check
zbook run
```

[Watch the short demo](https://github.com/user-attachments/assets/97e3538c-51c9-48e7-a42a-bf471219a79e)

## Where are my standard notebook features?

I intentionally made the UI as simple as possible, and here are the easy-to-ignore corners where you should actually pay attention:

### Lower right: kernel monitoring
The kernel chip at the lower right of the window can expand into a small monitoring panel:

<img width="496" height="430" alt="kernel_monitoring" src="https://github.com/user-attachments/assets/b7342ea3-229d-4faa-b381-6b0d01de8a8c" />


### Lower left: VIM keybinding toggle and key flashcard
The chips at the lower left corner can be toggled to enable VIM binding and a flashcard on some keybindings:

<img width="420" height="450" alt="VIM_keybindings" src="https://github.com/user-attachments/assets/c26c795b-6cea-4e2c-8c51-0b43bd7d1647" />


### Upper right: left/right panel control and Codex info
The upper right corner has the panel toggles (controlling the directory tree to the left and the codex panel to the right) that are very easy
to miss. The Codex panel is also there with history and account details.

<img width="345" height="427" alt="panels_and_codex" src="https://github.com/user-attachments/assets/31e1f25a-1f12-4fec-95f8-3898a8213dd6" />

## What is included

- Native Codex cell tools (cell- and line-based reading/editing/).
- Reviewable Codex edits: streamed red/green proposals stay staged until approved/rejected.
- A compact React and CodeMirror notebook editor with Python highlighting, Markdown rendering, `#@title` cell headings, and optional Vim bindings.
- A workspace-scoped file tree with create, rename, upload, delete, refresh, and external-change protection.
- IPython kernels and Jupyter Server backend.
- Live package installation and removal without coupling the notebook environment to Zbook's own runtime.
- A persistent Codex panel using your own CLI subscription, with model and effort controls, account status, thread history, and selected-line context.

Zbook intentionally does not include terminals, debuggers, dashboards, extension marketplaces, multi-user collaboration, or the rest of the JupyterLab surface area. It is a local, AI-guided notebook rather than a general IDE.

## Starting Zbook

Zbook requires Python 3.11 or newer and [uv](https://docs.astral.sh/uv/getting-started/installation/). [Codex CLI](https://developers.openai.com/codex/cli/) is optional, but required for the assistant panel.

Install Zbook as an isolated tool:

```bash
uv tool install zbook
zbook check
```

Start it in the current directory:

```bash
zbook run
```

Or choose a workspace explicitly:

```bash
zbook run --workspace-dir /path/to/project
```

Zbook uses Jupyter's token authentication and normally opens a URL such as `http://localhost:8888/zbook/?token=...`. Common bind options are first-class:

```bash
zbook run --ip 127.0.0.1 --port 8890
```

Pass other Jupyter Server arguments after `--`:

```bash
zbook run --workspace-dir . -- --ServerApp.log_level=DEBUG
```

If the separator is omitted, Zbook warns and passes unknown arguments through for that launch. Prefer the explicit form so that a misspelled Zbook option cannot silently become a Jupyter option.

> [!WARNING]
> Keep the default loopback address unless you intend to serve remote clients. A client that authenticates to Zbook can run notebook code, access the configured workspace, and invoke Codex. If you bind to `0.0.0.0`, preserve Jupyter authentication and use a trusted network or SSH port forwarding.

## Python environments

Zbook chooses the notebook environment in this order:

1. An explicitly supplied `--ZbookApp.venv`.
2. A usable `.venv` in the workspace.
3. A temporary `uv` environment under the platform temporary directory, removed when Zbook exits.

To choose an environment at launch, use the Jupyter passthrough:

```bash
zbook run -- --ZbookApp.venv=/path/to/project/.venv
```

The environment control at the bottom of the workspace pane can switch among detected `uv` environments, accept a path, and install or uninstall packages live. Each notebook owns its kernel, so changing tabs does not accidentally reuse another notebook's execution state.

The kernel-state chip at the lower right opens the active notebook's lightweight monitor. It reports state, uptime, process count, current memory and host-normalized CPU use, keeps two 90-second sparklines while open, and provides explicit Interrupt or Restart controls. Sampling stops with the popover and never executes hidden code in the notebook kernel.

Interactive controls use the standard Jupyter widget protocol. Core `ipywidgets` controls work when `ipywidgets` is installed in the selected environment. For a draggable Matplotlib figure or `matplotlib.widgets.Slider`, install `ipympl` in that environment and select the widget backend before creating the figure:

```python
%matplotlib widget
import matplotlib.pyplot as plt
```

The normal inline backend intentionally remains static: creating a `Slider` while it is active produces a zoomable PNG, not an interactive canvas. Zbook bundles the core Jupyter controls and the matching `ipympl` frontend; outputs from other third-party widget libraries report a clear unsupported-module message instead of loading arbitrary JavaScript from the network.

## Notebook workflow

The editor saves ordinary changes automatically and also exposes an explicit Save action. Dirty documents have local recovery snapshots. If a notebook changes on disk after it was opened, Zbook reports **Changed on disk** and will not overwrite the newer file without an explicit reload.

Navigation mode keeps common work off the mouse:

- `j` / `k` or the arrow keys move between cells.
- `Enter` or `i` edits the selected cell.
- `a` or `o` inserts a code cell after the selection; `Shift-O` inserts before it.
- `dd`, completed within 500 ms, deletes the selected cell. `u` undoes a structural edit; with Vim enabled, `Ctrl-R` redoes it.
- `c` focuses the Codex prompt. `Escape` returns to the selected notebook cell after dismissing any open Codex popup.
- `Ctrl-Enter` runs in place, `Shift-Enter` runs and advances, and `Alt-Enter` runs and inserts.
- `Ctrl/Cmd-P` opens files; `Shift-Ctrl/Cmd-P` opens app commands; `Ctrl/Cmd-S` saves.

Vim bindings are opt-in from the lower-left status bar. The preference is stored in browser-local storage rather than a user configuration file. With Vim enabled, the editor has three layers: cell navigation, Vim normal, and Vim insert. `Escape` steps back one layer at a time.

## Codex workflow

Codex is launched as an App Server subprocess in the workspace. Zbook supplies a short notebook-tool preamble and exposes cell reads, turn-scoped locks, proposal edits, structural edits, and capability discovery. The bridge uses a private authenticated WebSocket; filesystem or network operations outside Codex's granted scope still follow the CLI approval flow.

Source edits and newly created cells are proposals rather than immediate notebook writes. Codex locks relevant cells for the turn and streams small hunks into a read-only diff. Removed lines are red, inserted lines are green, and the accepted cell and its existing outputs remain unchanged.

When the turn ends, each proposal offers **Apply**, **Apply & Run** for code cells, and **Reject**. **Review next** moves through outstanding proposals in notebook order. Proposals survive a browser or app restart in IndexedDB; if the underlying notebook has changed, they become conflicted instead of overwriting newer content.

Deletion, type changes, and reordering use the atomic structural tool and retain an undo banner. Notebook reads return requested source once as compact numbered text (`1|exact source`) so Codex can address lines without receiving redundant notebook content.

Select one or more lines in a cell to reveal **Ask Codex** in the cell gutter. The selection appears as a removable, immutable quote above the prompt and is bounded before transmission.

## Support and compatibility

Zbook's supported runtime, stable interfaces, security boundary, and intentionally unsupported features are documented in the [support policy](https://github.com/honglu2875/zbook/blob/main/SUPPORT.md). Bugs and focused feature proposals are welcome in [GitHub Issues](https://github.com/honglu2875/zbook/issues).

## Development

Development requires Python 3.11 or newer, `uv`, and Node.js 20.19 or newer. Codex CLI is only needed when testing the assistant integration.

```bash
git clone git@github.com:honglu2875/zbook.git
cd zbook
git switch -c my-change
uv sync --locked --dev
cd frontend
npm ci
npm run build
cd ..
```

The frontend build writes directly to `src/zbook/static/`, which is what the Python package serves. Commit those generated assets whenever frontend source changes. Run the checkout with:

```bash
uv run zbook check
uv run zbook run --workspace-dir /path/to/workspace
```

The local and CI verification commands are:

```bash
uv run ruff check .
uv run pytest -q
cd frontend
npm test
npm run build
npx playwright install chromium  # first browser-test run only
npm run test:e2e
```

The Playwright suite uses one Chromium worker and a disposable workspace with a real Jupyter Server and IPython kernel. CI intentionally keeps one job and no browser or Python matrix so it remains useful on GitHub's free tier.

## Architecture

```text
React + CodeMirror 6
  ├─ Jupyter Contents API
  ├─ per-notebook Jupyter kernel WebSockets ── selected uv environment
  ├─ Zbook package API ── uv
  └─ Zbook Codex WebSocket ── codex app-server (stdio JSONL)
       └─ cell tools ── turn locks + persistent reviewable proposals

Jupyter Server ExtensionApp
  ├─ filesystem boundary: configured workspace
  ├─ kernel executable: selected environment's Python
  └─ bundled production frontend
```

Python owns processes, filesystem boundaries, and Jupyter integration. TypeScript owns notebook interaction state and rendering. The notebook environment is deliberately separate from Zbook's environment so package changes cannot destabilize the server.

## Releasing

Releases are built and published by `.github/workflows/release.yml` through PyPI Trusted Publishing. The PyPI publisher must match the `honglu2875/zbook` repository, the `release.yml` workflow, and the `pypi` GitHub environment.

For a release, move the entries in the [changelog](https://github.com/honglu2875/zbook/blob/main/CHANGELOG.md) under the new version, update the sole package-version source, commit, and push the matching annotated tag:

```bash
uv version 1.0.0rc1
git add pyproject.toml uv.lock CHANGELOG.md
git commit -m "Release 1.0.0rc1"
git tag -a v1.0.0rc1 -m "zbook 1.0.0rc1"
git push origin main v1.0.0rc1
```

The release workflow verifies that tag and package versions match, rebuilds and compares the committed web client, runs tests, smoke-tests both distribution formats in isolated environments, and grants the publishing credential only to the final PyPI job. Published versions cannot be replaced.

## License

Zbook is released under the [MIT License](https://github.com/honglu2875/zbook/blob/main/LICENSE). The bundled Inter and JetBrains Mono fonts remain under the SIL Open Font License 1.1; their [notices](https://github.com/honglu2875/zbook/blob/main/frontend/public/font-licenses.txt) ship with the frontend.
