# Quick Notebook

Quick Notebook is an intentionally small, keyboard-first notebook application. It keeps the useful core of Jupyter—real `.ipynb` files, IPython kernels, markdown, rich outputs, and a workspace tree—then adds a first-class local Codex panel and a focused `uv` environment workflow.

The design target is closer to Zed than JupyterLab: flat surfaces, restrained color, minimal persistent chrome, fast keyboard navigation, and no extension ecosystem to carry.

## Working checkpoint

The main notebook loop is functional:

- the file tree is served by Jupyter's Contents API and is rooted at the configured workspace;
- notebooks can be created, opened, renamed, deleted, uploaded, autosaved, and exported as `.ipynb`;
- folders can be selected and created, and arbitrary files can be uploaded;
- code cells execute on a real IPython kernel with streamed text, errors, HTML, and PNG output;
- Markdown cells render in place; code and Markdown editors have syntax highlighting and optional Vim bindings;
- **Run all**, execution counts, interrupt, and keyboard execution commands work;
- the environment panel lists packages and installs or uninstalls them through serialized `uv` operations;
- a fresh launch defaults to a scratch uv environment under `/tmp`, prepares `ipykernel`, and removes the scratch environment on shutdown;
- workspace `.venv` folders are detected and can be selected live; a project folder or uv-venv path can also be entered manually;
- the Codex panel uses the locally signed-in Codex CLI and ChatGPT subscription—no application API key—and streams turns through Codex App Server;
- Codex receives optional notebook/cell context and exposes command/file approvals, interruption, and ChatGPT sign-in. Threads start read-only; workspace writes require an explicit approval.

This is still a focused checkpoint, not a JupyterLab replacement. Only one notebook is open at a time; non-notebook files are managed but not edited; Jupyter widgets and arbitrary JavaScript outputs are not supported; and Codex threads are currently ephemeral.

## Architecture

```text
React + CodeMirror 6
  ├─ Jupyter Contents / Kernel WebSocket APIs
  ├─ Quick Notebook package-management API ── uv ── selected .venv
  └─ Quick Notebook Codex WebSocket ── codex app-server (stdio JSONL)

Jupyter Server ExtensionApp
  ├─ file boundary: configured workspace
  ├─ kernel: exact <venv>/bin/python
  └─ static production frontend
```

Python owns processes, filesystem boundaries, and Jupyter integration. TypeScript owns interaction state and rendering. The selected notebook environment is deliberately separate from the app's own environment so installing a package cannot destabilize the server. The Codex bridge follows the official [Codex App Server](https://developers.openai.com/codex/app-server) protocol over a private authenticated WebSocket.

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

The Vite build is emitted into `src/quick_notebook/static/`, where the Python application serves it.

## Launch

Build once, then point the application at the directory that should be visible in the file tree:

```bash
uv sync --dev
cd frontend && npm install && npm run build && cd ..
uv run quick-notebook --QuickNotebookApp.workspace=/absolute/path/to/workspace
```

The default kernel environment is a disposable uv venv under `/tmp`. To start with a persistent environment instead, pass either its path or a project folder containing `.venv`:

```bash
uv run quick-notebook \
  --QuickNotebookApp.workspace=/absolute/path/to/workspace \
  --QuickNotebookApp.venv=/absolute/path/to/project/.venv
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
