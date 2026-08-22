# Zbook

Zbook is an intentionally small, keyboard-first notebook application. It keeps the useful core of Jupyter—real `.ipynb` files, IPython kernels, markdown, rich outputs, and a workspace tree—then adds a first-class local Codex panel and a focused `uv` environment workflow.

The design target is closer to Zed than JupyterLab: flat surfaces, restrained color, minimal persistent chrome, fast keyboard navigation, and no extension ecosystem to carry.

## Working checkpoint

The main notebook loop is functional:

- the file tree is served by Jupyter's Contents API and is rooted at the configured workspace;
- notebooks can be created, opened in closable tabs, renamed inline by double-clicking a tab, deleted, uploaded, autosaved, and exported as `.ipynb`;
- the workspace and Codex panes are draggable, keyboard-resizable, and remember their widths across reloads;
- refreshing the workspace also reloads the active notebook from disk (after confirming before discarding local unsaved changes);
- folders can be selected and created, and arbitrary files can be uploaded;
- code cells execute on a real IPython kernel with streamed text, errors, HTML, and PNG output;
- Markdown cells render in place; code and Markdown editors have syntax highlighting, bundled JetBrains Mono typography, and optional Vim bindings; the UI and prose use bundled Inter;
- **Run all**, execution counts, interrupt, and keyboard execution commands work;
- the environment panel lists packages and installs or uninstalls them through serialized `uv` operations;
- a fresh launch defaults to a scratch uv environment under `/tmp`, prepares `ipykernel`, and removes the scratch environment on shutdown;
- workspace `.venv` folders are detected and can be selected live; a project folder or uv-venv path can also be entered manually;
- the Codex panel uses the locally signed-in Codex CLI and ChatGPT subscription—no application API key—and streams turns through Codex App Server;
- Codex receives optional notebook/cell context and exposes live command/file activity plus any required approvals;
- Codex gets dedicated read/apply cell tools: notebook edits go directly through React, are revision-checked, briefly lock the editor, apply atomically, and save without a shell/edit/refresh round trip;
- the Codex pane reads the installed CLI's model catalog and subscription rate limits, defaults to GPT-5.6-Luna with medium reasoning when available, and provides model/effort pickers, quota refresh, sign-in, and sign-out.

This is still a focused checkpoint, not a JupyterLab replacement. Tabs share one workspace kernel and save before switching; non-notebook files are managed but not edited; Jupyter widgets and arbitrary JavaScript outputs are not supported; and Codex threads are currently ephemeral.

## Architecture

```text
React + CodeMirror 6
  ├─ Jupyter Contents / Kernel WebSocket APIs
  ├─ Zbook package-management API ── uv ── selected .venv
  └─ Zbook Codex WebSocket ── codex app-server (stdio JSONL)
       └─ dynamic cell tools ── revision-locked React notebook state

Jupyter Server ExtensionApp
  ├─ file boundary: configured workspace
  ├─ kernel: exact <venv>/bin/python
  └─ static production frontend
```

Python owns processes, filesystem boundaries, and Jupyter integration. TypeScript owns interaction state and rendering. The selected notebook environment is deliberately separate from the app's own environment so installing a package cannot destabilize the server. Codex runs with workspace-write scope, while commands that need broader filesystem or network access still use the CLI's approval flow. The bridge follows the official [Codex App Server](https://developers.openai.com/codex/app-server) protocol over a private authenticated WebSocket.

## Run the checks

```bash
uv run ruff check src tests
uv run pytest -q
cd frontend && npm run build
```

## Build the web client

Use Node.js 20.19 or newer:

```bash
cd frontend
npm install
npm run build
```

The Vite build is emitted into `src/zbook/static/`, where the Python application serves it.

## Launch

Build once, then point the application at the directory that should be visible in the file tree:

```bash
uv sync --dev
cd frontend && npm install && npm run build && cd ..
uv run zbook --ZbookApp.workspace=/absolute/path/to/workspace
```

The default kernel environment is a disposable uv venv under `/tmp`. To start with a persistent environment instead, pass either its path or a project folder containing `.venv`:

```bash
uv run zbook \
  --ZbookApp.workspace=/absolute/path/to/workspace \
  --ZbookApp.venv=/absolute/path/to/project/.venv
```

The same choice can be changed from the environment panel while the app is running. A manually selected environment must be a uv-created virtual environment.

## Notebook key model

- `Shift-Escape` leaves an editor and enters notebook navigation mode.
- `j` / `k` or the arrow keys move between cells in navigation mode.
- `Enter` or `i` edits the selected cell.
- `o` inserts a code cell below.
- `Ctrl-Enter` runs in place, `Shift-Enter` runs and advances, and `Alt-Enter` runs and inserts.
- Vim bindings can be toggled from the status bar. Vim receives its keymap before the standard CodeMirror keymaps.

This two-level model avoids the classic conflict between Vim's modes and notebook-level commands: notebook navigation is a separate outer mode, and Vim operates only inside the active editor.
