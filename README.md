# Zbook

Zbook is an intentionally small, keyboard-first notebook application. It keeps the useful core of Jupyter—real `.ipynb` files, IPython kernels, markdown, rich outputs, and a workspace tree—then adds a first-class local Codex panel and a focused `uv` environment workflow.

The design target is closer to Zed than JupyterLab: flat surfaces, restrained color, minimal persistent chrome, fast keyboard navigation, and no extension ecosystem to carry.

## Working checkpoint

The main notebook loop is functional:

- the file tree is served by Jupyter's Contents API and is rooted at the configured workspace;
- notebooks can be created, opened in closable tabs, renamed inline by double-clicking a tab, deleted, uploaded, autosaved, and exported as `.ipynb`;
- open tabs, the active notebook, selected cell, and panel visibility are restored per workspace, while personal editor preferences persist across workspaces in the browser;
- `Ctrl/Cmd-P` opens a workspace file picker and `Ctrl/Cmd-Shift-P` opens the command palette;
- the workspace and Codex panes are draggable, keyboard-resizable, and remember their widths across reloads;
- refreshing the workspace also reloads the active notebook from disk (after confirming before discarding local unsaved changes);
- folders can be selected and created, and arbitrary files can be uploaded;
- code cells execute on a real IPython kernel with streamed text, errors, HTML, and PNG output;
- Markdown cells render in place; code and Markdown editors have syntax highlighting, bundled JetBrains Mono typography, and optional Vim bindings; the UI and prose use bundled Inter;
- long outputs can be height-limited from the gutter without shrinking their code, scaled images expand to their native resolution on double-click with two-axis scrolling, and `#@title …` gives a code cell a dedicated title row above its execution gutter and a whole-cell collapse toggle; these view preferences persist per workspace without changing the notebook file;
- **Run all**, execution counts, interrupt, and keyboard execution commands work;
- the environment panel lists packages and installs or uninstalls them through serialized `uv` operations;
- a fresh launch defaults to a scratch uv environment under `/tmp`, prepares `ipykernel`, and removes the scratch environment on shutdown;
- workspace `.venv` folders are detected and can be selected live; a project folder or uv-venv path can also be entered manually;
- the Codex panel uses the locally signed-in Codex CLI and ChatGPT subscription—no application API key—and streams turns through Codex App Server;
- Codex receives optional notebook/cell context and exposes live command/file activity plus any required approvals;
- Codex gets dedicated read/lock/apply cell tools: the read response advertises the current action inventory, relevant cells become visibly read-only across the full reasoning-and-editing turn, remaining locks release automatically at turn end, and edits are revision-checked, atomic, undoable, and saved without a shell/edit/refresh round trip; source-light reads plus `move_after` and `swap` operations make reordering inexpensive;
- each Codex cell edit gets an in-notebook review marker and a safe one-step undo until the notebook changes again;
- the Codex pane reads the installed CLI's model catalog and subscription rate limits, defaults to GPT-5.6-Luna with medium reasoning when available, and provides model/effort pickers, quota refresh, sign-in, and sign-out.
- Zbook-created Codex threads persist through App Server, are remembered per workspace, and can be resumed from the compact thread switcher with command/file/notebook activity restored and Zbook's private context augmentation kept out of the visible transcript.

This is still a focused checkpoint, not a JupyterLab replacement. Tabs share one workspace kernel and save before switching; non-notebook files are managed but not edited; and Jupyter widgets and arbitrary JavaScript outputs are not supported.

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

## Install and launch

Build the web client once, then install the local package as a uv tool:

```bash
uv sync --dev
cd frontend && npm install && npm run build && cd ..
uv tool install .
```

The installed command has a small preflight check and a dedicated launch command:

```bash
zbook check
zbook run
zbook run --workspace-dir /absolute/path/to/workspace
zbook run --ip 0.0.0.0 --port 8888
```

`zbook run` uses the current directory as its workspace and listens only on Jupyter's `localhost` default. Binding a wildcard or non-loopback address prints a highlighted security warning: remote clients that obtain access can execute notebook code and reach the selected workspace and Codex. `0.0.0.0` listens on every network interface, though actual reachability still depends on the host firewall and network configuration. Keep Jupyter authentication enabled.

The default kernel environment is a disposable uv venv under `/tmp`; a persistent uv environment can be selected from the environment panel while the app is running.

Jupyter Server options go after a `--` passthrough boundary:

```bash
zbook run --workspace-dir /absolute/path/to/workspace --port 8890 -- \
  --ServerApp.open_browser=False
```

Startup environment traits can be passed the same way when needed:

```bash
zbook run --workspace-dir /absolute/path/to/workspace -- \
  --ZbookApp.venv=/absolute/path/to/project/.venv
```

For compatibility, Jupyter flags supplied without `--` are still forwarded, but Zbook prints a highlighted warning showing the preferred form. The old direct form (`zbook --ZbookApp.workspace=…`) also remains available with a migration warning. During development, prefix these commands with `uv run`, such as `uv run zbook check`.

## Releasing

Releases are built and published by `.github/workflows/release.yml` through PyPI Trusted Publishing. The PyPI publisher must match the `honglu2875/zbook` repository, the `release.yml` workflow, and the `pypi` GitHub environment.

For the first release, tag the current `0.1.0` commit after configuring the `pypi` environment and pending PyPI publisher:

```bash
git tag -a v0.1.0 -m "zbook 0.1.0"
git push origin v0.1.0
```

For subsequent releases, update the sole package-version source in `pyproject.toml`, review the lockfile, commit, and push the matching tag:

```bash
uv version 0.1.1
git add pyproject.toml uv.lock
git commit -m "Release 0.1.1"
git tag -a v0.1.1 -m "zbook 0.1.1"
git push origin main v0.1.1
```

The workflow rejects a tag that does not match the package version, rebuilds and verifies the committed web client, tests both distribution formats in isolated environments, and grants the publishing credential only to the final PyPI job. Published PyPI versions cannot be replaced; use a new version for every changed release.

## Notebook key model

- `Shift-Escape` leaves an editor and enters notebook navigation mode.
- `j` / `k` or the arrow keys move between cells in navigation mode.
- `Enter` or `i` edits the selected cell.
- `a` inserts a code cell above; `b` or `o` inserts one below. Hover or keyboard-focus the space between cells to choose Code or Markdown explicitly.
- `Ctrl-Enter` runs in place, `Shift-Enter` runs and advances, and `Alt-Enter` runs and inserts.
- Vim bindings are opt-in and can be toggled from the status bar. The preference persists across workspaces, and Vim receives its keymap before the standard CodeMirror keymaps.

This two-level model avoids the classic conflict between Vim's modes and notebook-level commands: notebook navigation is a separate outer mode, and Vim operates only inside the active editor.

## License

Zbook is released under the [MIT License](LICENSE). The bundled Inter and JetBrains Mono fonts remain under the SIL Open Font License 1.1; their [notices](frontend/public/font-licenses.txt) ship with the frontend.
