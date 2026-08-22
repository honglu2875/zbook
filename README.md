# Quick Notebook

Quick Notebook is an intentionally small, keyboard-first notebook application. It keeps the useful core of Jupyter—real `.ipynb` files, IPython kernels, markdown, rich outputs, and a workspace tree—then adds a first-class local Codex panel and a focused `uv` environment workflow.

The design target is closer to Zed than JupyterLab: flat surfaces, restrained color, minimal persistent chrome, fast keyboard navigation, and no extension ecosystem to carry.

## Current milestone

This repository is an early vertical slice, not a finished notebook application. It currently contains:

- a Jupyter `ExtensionApp` shell rooted to one validated workspace;
- exact virtual-environment interpreter selection and ephemeral kernelspec generation;
- serialized, shell-free `uv add` / `uv remove` / `uv pip` operations;
- an asynchronous Codex App Server client that uses the locally signed-in Codex CLI (no API key);
- a responsive React prototype with a file tree, notebook cells, syntax highlighting, markdown rendering, Vim bindings, and the Codex conversation surface;
- dependency-independent unit tests for path boundaries, `uv` command construction, and Codex JSONL framing.

Kernel execution, notebook persistence, live package APIs, and browser-to-Codex event streaming are the next integration milestone. The prototype labels its simulated output accordingly.

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

Python owns processes, filesystem boundaries, and Jupyter integration. TypeScript owns interaction state and rendering. The selected project environment is deliberately separate from the app's own environment so installing a notebook package cannot destabilize the server.

## Run the checks

The current tests need only Python 3.11 or newer:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
python -m compileall -q src tests
```

## Build the web client

Use Node.js 20.19 or newer:

```bash
cd frontend
npm install
npm run build
```

The Vite build is emitted into `src/quick_notebook/static/`, where the Python application serves it.

## Launch the Python shell

Create the application environment separately from the workspace environment:

```bash
uv sync --dev
uv run quick-notebook \
  --QuickNotebookApp.workspace=/absolute/path/to/workspace \
  --QuickNotebookApp.venv=/absolute/path/to/workspace/.venv
```

The selected environment must already contain `pyvenv.cfg` and a Python interpreter. Installing `ipykernel` automatically will be exposed through the package-management UI in the next milestone.

## Notebook key model

- `Shift-Escape` leaves an editor and enters notebook navigation mode.
- `j` / `k` or the arrow keys move between cells in navigation mode.
- `Enter` or `i` edits the selected cell.
- `o` inserts a code cell below.
- `Ctrl-Enter` runs in place, `Shift-Enter` runs and advances, and `Alt-Enter` runs and inserts.
- Vim bindings can be toggled from the status bar. Vim receives its keymap before the standard CodeMirror keymaps.

This two-level model avoids the classic conflict between Vim's modes and notebook-level commands: notebook navigation is a separate outer mode, and Vim operates only inside the active editor.
