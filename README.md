# Zbook

[![PyPI release](https://img.shields.io/pypi/v/zbook?label=release)](https://pypi.org/project/zbook/)

Zbook is a tiny personal project to create a different jupyter notebook frontend. In this AI age it is hard not to have a plugin on the side of your notebook to assist those boilerplate code.

[demo.webm](https://github.com/user-attachments/assets/97e3538c-51c9-48e7-a42a-bf471219a79e)

It still uses a Jupyter Server backend, but the whole point of this project is a custom and minimal React frontend that embeds AI into our notebook workflow and a uv-based environment management. 

I would like to keep features minimal to my own taste. I do not even know if other people would want to use it or contribute, but contribution is welcomed. As long as it is just myself making changes, I will keep pushing to `main` without setting up contribution guidelines. But once this changes, a standard PR and reviewing process will be used.

For Claude users: Claude is good at frontend and just build one yourself. Personally I do not see a reason to use Claude until they genuinely start to care about their B2C business and each individual user rather than doing marketing stunts.

## Quick start

The Python dependencies are installed automatically and the compiled React assets are included in the package. The only required external tool is [uv](https://docs.astral.sh/uv/getting-started/installation/). [Codex CLI](https://learn.chatgpt.com/docs/codex/cli#getting-started) is optional, but required for the assistant panel.

Install Zbook as an isolated uv tool:

```bash
uv tool install zbook
```

You can run
```bash
zbook check
```
to see if your environment satisfies the requirements.

To run, it is the typical notebook experience: try
```bash
zbook run
```
and it will serve the frontend on `localhost`, normally on port `8888` or the next available port. It uses Jupyter's token mechanism and you end up visiting a URL such as `http://localhost:8888/zbook/?token=......`.

One can customize the address and the port it listens to, such as
```bash
zbook run --ip 0.0.0.0 --port 8890
```

> [!WARNING]
> Think twice when using `--ip 0.0.0.0` unless you know what you are doing. Typically what you really need is ssh port-forwarding.

## Environment management

Kernel environments and packages are managed by `uv`, because it is fast and does not make copies everywhere in your computer. Jupyter Server launches the actual IPython kernel from the selected environment. The default environment is determined in the following ways:

- An explicitly supplied `--ZbookApp.venv` has priority.
- Otherwise, if your workspace directory (defaulting to your current CWD unless you set `--workspace-dir`) has a usable uv-managed `.venv` folder, Zbook will use it.
- Otherwise, an ephemeral environment inside your `/tmp` folder is created and removed when Zbook exits. You should not rely on it for persistent packages.

An environment can be selected explicitly at startup through the Jupyter passthrough:

```bash
zbook run -- --ZbookApp.venv=/path/to/project/.venv
```

At the bottom of the workspace sidebar, you can click the environment control and get a popup with more details. You can:

- Switch to a detected uv environment or supply a path.
- Install or uninstall libraries live while working on a notebook.

## Notebook navigation mode

You can navigate the cells using keyboard.

- Without Vim bindings, `Escape` leaves an editor and enters notebook navigation mode. With Vim enabled, it steps back one layer at a time as described below.
- `j` / `k` or the arrow keys move between cells in navigation mode.
- `Enter` or `i` edits the selected cell.
- `a` or `o` inserts a code cell after the selected cell; `Shift-O` inserts one before it. Hover or keyboard-focus the space between cells to choose Code or Markdown explicitly.
- `dd`, completed within 500 ms, deletes the selected cell. `u` undoes a cell insertion or deletion, and Vim's `Ctrl-R` redoes it. This structural history is separate from text undo inside an editor.
- `c` focuses the Codex prompt. `Escape` from that prompt returns focus to the selected notebook cell; an open Codex popup is dismissed first.
- `Ctrl-Enter` runs in place, `Shift-Enter` runs and advances, and `Alt-Enter` runs and inserts.

Vim bindings are opt-in and can be toggled from the status bar on the lower left. The preference persists across workspaces in browser storage. The navigation resembles Vim, but there are three layers: `[Cell Navigation] -> [Vim Normal] -> [Vim Insert]`. `Enter` or `i` moves from cell navigation into Vim normal mode, and another `i` enters Vim insert mode. `Escape` reverses one layer at a time: insert to normal, then normal to cell navigation. Cell-level operations only happen in Cell Navigation mode.

The keybindings are not customizable so far, but if I get other users at all, we can consider making it customizable.

## Reviewing Codex cell edits

Codex source edits and newly created cells are proposals, not immediate notebook writes. Zbook asks Codex to lock the relevant cells, then streams small source hunks into a read-only diff: removed lines are red and inserted lines are green. A proposed new cell appears at its intended position with an all-green diff. The accepted notebook and its existing outputs remain untouched while the turn is running.

When the turn finishes, each changed cell offers **Apply**, **Apply & Run** (for code cells), and **Reject** above its output. The notebook banner reports how many proposals remain and **Review next** moves through them in notebook order. Applying saves the proposed source atomically; rejecting restores the unchanged accepted view. Unresolved proposals survive a browser or app restart in the browser's IndexedDB. If the notebook changed on disk in the meantime, Zbook marks the proposal as conflicted instead of applying it over newer work.

Deletion, type changes, and reordering still use the atomic structural notebook tool and save immediately. Those operations retain the existing review/undo banner. Notebook reads are source-light by default; Codex requests source only for relevant cell IDs, returned once as a compact `numberedSource` string (`1|exact source`) so it can address hunks without counting wrapped or blank lines itself.

## Development

Development requires Python 3.11 or newer, uv, and Node.js 20.19 or newer. Codex CLI is only needed when testing the assistant integration.

Clone the repository, create a branch, and install the locked Python and frontend dependencies:

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

The frontend build is written directly to `src/zbook/static/`, which is also what the Python package serves. Launch the local checkout with:

```bash
uv run zbook check
uv run zbook run --workspace-dir /path/to/workspace
```

Before committing, run the same core checks used by the release workflow:

```bash
uv run ruff check .
uv run pytest -q
cd frontend
npm run build
```

Commit changes under `src/zbook/static/` whenever the frontend source changes. Ordinary PyPI users receive these compiled assets and do not need Node.js.

## Architecture

```text
React + CodeMirror 6
  ├─ Jupyter Contents / Kernel WebSocket APIs
  ├─ Zbook package-management API ── uv ── selected .venv
  └─ Zbook Codex WebSocket ── codex app-server (stdio JSONL)
       └─ dynamic cell tools ── locks + persistent reviewable proposal overlays

Jupyter Server ExtensionApp
  ├─ file boundary: configured workspace
  ├─ kernel: exact <venv>/bin/python
  └─ static production frontend
```

Python owns processes, filesystem boundaries, and Jupyter integration. TypeScript owns interaction state and rendering. The selected notebook environment is deliberately separate from the app's own environment so installing a package cannot destabilize the server. Codex runs with workspace-write scope, while commands that need broader filesystem or network access still use the CLI's approval flow. The bridge follows the official [Codex App Server](https://developers.openai.com/codex/app-server) protocol over a private authenticated WebSocket.

## Releasing

Releases are built and published by `.github/workflows/release.yml` through PyPI Trusted Publishing. The PyPI publisher must match the `honglu2875/zbook` repository, the `release.yml` workflow, and the `pypi` GitHub environment.

For a new release, update the sole package-version source in `pyproject.toml`, review the lockfile, commit, and push the matching tag:

```bash
uv version 0.1.1
git add pyproject.toml uv.lock
git commit -m "Release 0.1.1"
git tag -a v0.1.1 -m "zbook 0.1.1"
git push origin main v0.1.1
```

The workflow rejects a tag that does not match the package version, rebuilds and verifies the committed web client, tests both distribution formats in isolated environments, and grants the publishing credential only to the final PyPI job. Published PyPI versions cannot be replaced; use a new version for every changed release.

## License

Zbook is released under the [MIT License](LICENSE). The bundled Inter and JetBrains Mono fonts remain under the SIL Open Font License 1.1; their [notices](frontend/public/font-licenses.txt) ship with the frontend.
