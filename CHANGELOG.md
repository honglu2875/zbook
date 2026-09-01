# Changelog

Notable user-facing changes are recorded here. This project follows [Semantic Versioning](https://semver.org/) beginning with the 1.0 release line.

## [Unreleased]

### Fixed

- IPython tracebacks and terminal-style text outputs now render safe ANSI colors and emphasis instead of exposing raw escape characters.
- Native model, reasoning-effort, environment, cell-type, and preference menus now use dark popup colors consistent with the rest of Zbook.

## [1.0.0rc3] - 2026-08-29

### Added

- A frontend-owned execution queue with visible cell positions, dependency-safe suffix cancellation, automatic cancellation after errors or interruption, and controls in the kernel monitor.
- A top-bar kernel restart control with a compact confirmation that accounts for active and queued work.

### Changed

- Running cells now use a persistent spinner, warm rail, and subtle boundary treatment, while queued cells use quieter numbered indicators.
- Code cells disable JetBrains Mono programming ligatures so repeated operators render character-for-character.
- Cell type and delete controls sit on the upper cell boundary instead of covering long first lines.

### Fixed

- Pandas DataFrame outputs receive low-specificity dark-theme defaults that blend with the notebook while preserving custom table styles.

## [1.0.0rc2] - 2026-08-28

### Added

- A compact active-kernel monitor with on-demand CPU and memory history, uptime, process statistics, and explicit interrupt or restart controls.
- Compact Preferences UI with an optional validated `~/.zbook/settings.json`, browser fallback, atomic host-side writes, and documented schema and precedence rules.

### Changed

- README positioning now centers on native, structured Codex interaction with live notebook cells and explicitly selects the release candidate during installation.
- The secondary navigation bar uses tighter vertical spacing across the workspace, notebook tabs, and Codex panel.
- Browser CI retries only a failed journey once and retains short-lived diagnostics only when a failure occurs.

### Fixed

- Large workspace trees scroll within the file pane instead of overlapping the environment control.
- Zbook renders over plain HTTP on remote interfaces such as Tailscale, where the secure-context-only `crypto.randomUUID()` API may be unavailable.

## [1.0.0rc1] - 2026-08-23

### Added

- Reviewable, persistent Codex source proposals with streamed diffs, turn-scoped cell locks, Apply, Apply & Run, Reject, conflict detection, and review navigation.
- Direct Codex tools for capability discovery, focused notebook reads, source proposals, structural edits, and cell reordering.
- Selected-line context that appears as a bounded, removable quote in the Codex composer.
- One independently managed IPython kernel per open notebook.
- Live core Jupyter widgets and interactive Matplotlib figures through `ipympl`.
- Dirty-document recovery snapshots and external-write conflict protection.
- Bounded Codex bridge reconnection with explicit retry controls and App Server compatibility checks in `zbook check`.
- A lean Chromium Playwright suite covering real editing, execution, persistence, tabs, Markdown navigation, external conflicts, selected context, and responsive panels.
- Responsive workspace and Codex drawers, a Zbook favicon, and improved small-label legibility.

### Changed

- Notebook tool reads are source-light and return requested source as a single compact, line-numbered representation.
- The Codex panel shows a persistent working-stage indicator, and scaled images toggle between fitted and native resolution with one click.
- Codex uses a neutral CLI prompt mark instead of an ambiguous sparkle.
- Codex protocol reading accepts large JSONL frames without asyncio's line-length failure mode.
- Notebook tabs now own their execution state instead of sharing one kernel across documents.
- CI uses one bounded verification job with Python, frontend, bundled-asset, and real-browser coverage.

### Fixed

- Codex send and stop controls are optically centered, typographic chrome symbols use a consistent SVG grid, and the browser tab and title bar share one pixel-centered Zbook mark.
- The new-notebook tab control is borderless at rest and shares the tab-close hover treatment.
- Narrow notebook layouts keep document status controls separate from the title and preserve the full execution-count gutter.
- Inline code in rendered Markdown headings scales with its surrounding heading instead of retaining body-code size.
- Native-size images retain horizontal overflow while vertical wheel input scrolls the notebook document.
- Invalid `execution_count` properties are removed from `display_data` outputs before saving.
- Immediate workspace navigation and pane toggles are no longer overwritten by delayed session restoration.
- Unsaved edits are not silently written over a notebook that changed on disk.
- Codex startup failures no longer create repeated assistant messages or an unbounded reconnect loop.

## [0.1.1] - 2026-08-23

### Added

- Workspace `.venv` detection with a temporary `uv` environment fallback.
- Opt-in, persistent Vim bindings and a compact three-layer keybinding guide.
- Keyboard cell insertion, deletion, undo, redo, execution, and Codex focus commands.

### Fixed

- Cell focus, navigation highlighting, scrolling, and modified-Enter execution behavior.

## [0.1.0] - 2026-08-22

- Initial PyPI release with the workspace tree, notebook editor, IPython execution, `uv` environment management, and Codex CLI panel.

[Unreleased]: https://github.com/honglu2875/zbook/compare/v1.0.0rc3...HEAD
[1.0.0rc3]: https://github.com/honglu2875/zbook/compare/v1.0.0rc2...v1.0.0rc3
[1.0.0rc2]: https://github.com/honglu2875/zbook/compare/v1.0.0rc1...v1.0.0rc2
[1.0.0rc1]: https://github.com/honglu2875/zbook/compare/v0.1.1...v1.0.0rc1
[0.1.1]: https://github.com/honglu2875/zbook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/honglu2875/zbook/releases/tag/v0.1.0
