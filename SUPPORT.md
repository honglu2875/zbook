# Zbook support policy

This document defines the compatibility and security boundary Zbook intends to carry into the 1.x release line. The `1.0.0rc*` releases are validation candidates for that contract; incompatible changes may still be made between release candidates when testing reveals that they are necessary.

## Supported runtime

| Component | Supported baseline | Verification level |
| --- | --- | --- |
| Python | 3.11 or newer | Package metadata and automated tests |
| Jupyter Server | 2.15 through the current 2.x line | Locked integration tests |
| Notebook format | nbformat 4 | Read, edit, execute, and export tests |
| Interactive output | ipywidgets 8 and current `ipympl` | Real widget protocol test and manual Matplotlib verification |
| uv | A current CLI available on `PATH` | Startup diagnostics and environment tests |
| Browser | Current Chromium-based desktop browser | Automated Playwright journeys |
| Codex | A Codex CLI with `app-server` support | Protocol tests and startup diagnostics |
| Operating system | Linux | CI and release verification |

macOS, Windows, Firefox, and Safari are expected to work where their Python, Jupyter, `uv`, and Codex dependencies work, but they are best-effort until they are represented in automated testing. Reports with reproduction details are welcome.

Run `zbook check` before filing a startup issue. It reports the Python and Jupyter runtime, bundled frontend, `uv`, and whether the installed Codex CLI exposes App Server. Codex is optional; notebook editing and execution remain available when it is absent.

## 1.x compatibility contract

After the stable 1.0 release, Zbook will follow semantic versioning for these user-facing interfaces:

- The `zbook check` and `zbook run` command structure and documented options.
- Reading and writing standard `.ipynb` notebooks without a Zbook-specific conversion step.
- The configured workspace as the filesystem access boundary.
- The review contract for proposed Codex source edits: accepted content is unchanged until Apply or Apply & Run, and Reject restores the accepted view.
- Persistent user preferences and recoverable proposal state, subject to normal browser-storage availability.

The following are implementation details and are not independent public APIs in 1.x:

- Python modules beneath `zbook`, except the documented console command and Jupyter extension entry point.
- Internal HTTP and WebSocket routes, Codex tool schemas, DOM structure, CSS class names, and browser-storage formats.
- Compatibility with arbitrary JupyterLab extensions, kernelspec customization, or third-party frontend plugins.

Those internals may change in a minor release when the bundled Python backend and frontend change together. Notebook files remain the portable source of truth.

## Product boundary

Zbook is supported as a local, single-user notebook application. Its narrow scope is intentional. It is not a hosted notebook service, a multi-user Jupyter deployment, a collaborative editor, or a complete JupyterLab replacement. Terminals, debuggers, dashboards, arbitrary server extensions, and an extension marketplace are outside the 1.x scope.

Large notebooks and rich outputs are supported within the practical memory limits of the browser and kernel process, but Zbook does not currently virtualize thousands of rendered cells. A report about poor performance should include notebook size, cell count, output types, browser, and operating system; remove private data before attaching a notebook.

Core `ipywidgets` controls and `ipympl` are bundled frontend integrations. Arbitrary third-party widget modules are outside the 1.x compatibility contract; Zbook reports them as unsupported instead of downloading executable frontend code at runtime.

## Security boundary

Zbook binds to Jupyter's loopback default unless configured otherwise and uses Jupyter token authentication. Anyone who can authenticate can execute code in the selected environment, read or modify files inside the workspace, manage packages, and invoke the user's Codex CLI.

- Do not expose Zbook directly to an untrusted network.
- Keep authentication enabled when using `--ip 0.0.0.0` or another non-loopback address.
- Prefer SSH port forwarding for remote access.
- Treat notebook output HTML as untrusted. Zbook renders it in a sandboxed iframe, but notebooks can execute arbitrary Python when a cell is run.
- Review Codex proposals before applying or running them. Workspace-write and CLI approval boundaries reduce accidental access; they do not make generated code inherently safe.

For a suspected security vulnerability, avoid posting secrets, tokens, private notebooks, or exploit details in a public issue. Contact the repository owner privately through their GitHub profile until a dedicated security-reporting channel is published.

## Getting help

Use [GitHub Issues](https://github.com/honglu2875/zbook/issues) for reproducible bugs and focused feature requests. Include:

- `zbook --version` and the non-sensitive output of `zbook check`.
- Operating system and browser version.
- The launch command with tokens and private paths removed.
- Minimal reproduction steps and relevant backend logs.

Issues outside the product boundary may be closed without implementation so Zbook can remain small and notebook-focused.
