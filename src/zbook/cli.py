"""Small command-line interface for launching and diagnosing Zbook."""

from __future__ import annotations

import argparse
import importlib.metadata
import os
import shlex
import shutil
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from . import __version__

MINIMUM_PYTHON = (3, 11)
STATIC_INDEX = Path(__file__).parent / "static" / "index.html"


@dataclass(frozen=True)
class RequirementCheck:
    """One item reported by ``zbook check``."""

    label: str
    available: bool
    detail: str
    critical: bool = True
    hint: str | None = None


def _supports_color(stream: TextIO) -> bool:
    return bool(not os.environ.get("NO_COLOR") and hasattr(stream, "isatty") and stream.isatty())


def _styled(text: str, code: str, stream: TextIO) -> str:
    if not _supports_color(stream):
        return text
    return f"\033[{code}m{text}\033[0m"


def _notice(kind: str, message: str, stream: TextIO) -> None:
    styles = {"WARNING": "1;33", "ERROR": "1;31", "OK": "1;32"}
    prefix = _styled(kind, styles[kind], stream)
    print(f"{prefix}: {message}", file=stream)


def _command_check(
    executable: str,
    label: str,
    *,
    critical: bool,
    hint: str,
) -> RequirementCheck:
    path = shutil.which(executable)
    if path is None:
        return RequirementCheck(label, False, "not found on PATH", critical, hint)

    try:
        result = subprocess.run(
            (path, "--version"),
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return RequirementCheck(label, False, f"could not run: {error}", critical, hint)

    output = result.stdout.strip() or result.stderr.strip()
    version = output.splitlines()[0] if output else f"exited with status {result.returncode}"
    if result.returncode:
        return RequirementCheck(label, False, f"{version} · {path}", critical, hint)
    return RequirementCheck(label, True, f"{version} · {path}", critical)


def collect_checks() -> list[RequirementCheck]:
    """Inspect the local runtime without changing it."""

    python_version = ".".join(str(part) for part in sys.version_info[:3])
    python_ready = sys.version_info >= MINIMUM_PYTHON
    checks = [
        RequirementCheck(
            "Python",
            python_ready,
            python_version,
            hint="Install Python 3.11 or newer.",
        )
    ]

    try:
        jupyter_version = importlib.metadata.version("jupyter-server")
    except importlib.metadata.PackageNotFoundError:
        checks.append(
            RequirementCheck(
                "Jupyter Server",
                False,
                "package is not installed",
                hint="Reinstall Zbook so its Python dependencies are included.",
            )
        )
    else:
        checks.append(RequirementCheck("Jupyter Server", True, jupyter_version))

    checks.append(
        RequirementCheck(
            "Web client",
            STATIC_INDEX.is_file(),
            "bundled" if STATIC_INDEX.is_file() else "built assets are missing",
            hint="Reinstall Zbook from a complete wheel or rebuild the frontend.",
        )
    )
    checks.append(
        _command_check(
            "uv",
            "uv",
            critical=True,
            hint="Install uv and ensure its executable is on PATH.",
        )
    )
    checks.append(
        _command_check(
            "codex",
            "Codex CLI",
            critical=False,
            hint=(
                "Install and sign in to Codex CLI to enable the assistant panel; "
                "notebooks remain available without it."
            ),
        )
    )
    return checks


def run_checks(stdout: TextIO | None = None) -> int:
    """Print a compact environment report and return a shell status."""

    stream = stdout or sys.stdout
    checks = collect_checks()
    for check in checks:
        if check.available:
            marker = _styled("✓", "1;32", stream)
        elif check.critical:
            marker = _styled("✗", "1;31", stream)
        else:
            marker = _styled("⚠", "1;33", stream)
        print(f"{marker} {check.label:<15} {check.detail}", file=stream)
        if not check.available and check.hint:
            print(f"  {check.hint}", file=stream)

    errors = sum(not check.available and check.critical for check in checks)
    warnings = sum(not check.available and not check.critical for check in checks)
    if errors:
        print(file=stream)
        _notice("ERROR", f"Zbook is missing {errors} required component(s).", stream)
        return 1
    if warnings:
        print(file=stream)
        _notice("WARNING", "Zbook can run, but optional features are unavailable.", stream)
    else:
        print(file=stream)
        _notice("OK", "Zbook is ready.", stream)
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="zbook",
        description="A small, keyboard-first notebook with local Codex integration.",
        allow_abbrev=False,
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")

    commands.add_parser(
        "check",
        help="check Python, Jupyter, uv, Codex CLI, and bundled web assets",
        allow_abbrev=False,
    )
    run_parser = commands.add_parser(
        "run",
        help="start Zbook",
        description="Start Zbook with the current directory as its default workspace.",
        epilog="Pass Jupyter options after `--`, for example: zbook run -- --ServerApp.port=8890",
        allow_abbrev=False,
    )
    run_parser.add_argument(
        "-w",
        "--workspace-dir",
        type=Path,
        metavar="PATH",
        help="directory shown in the workspace tree (default: current directory)",
    )
    return parser


def _partition_passthrough(arguments: Sequence[str]) -> tuple[list[str], list[str]]:
    values = list(arguments)
    try:
        boundary = values.index("--")
    except ValueError:
        return values, []
    return values[:boundary], values[boundary + 1 :]


def _uses_legacy_workspace(arguments: Sequence[str]) -> bool:
    return any(
        argument == "--ZbookApp.workspace" or argument.startswith("--ZbookApp.workspace=")
        for argument in arguments
    )


def _preflight_run(stderr: TextIO | None = None) -> bool:
    stream = stderr or sys.stderr
    ready = True
    if shutil.which("uv") is None:
        _notice(
            "ERROR",
            "uv was not found on PATH. Zbook needs uv for kernel environments; "
            "run `zbook check` for details.",
            stream,
        )
        ready = False
    if not STATIC_INDEX.is_file():
        _notice(
            "ERROR",
            "the bundled web client is missing. Reinstall Zbook or rebuild the frontend.",
            stream,
        )
        ready = False
    if shutil.which("codex") is None:
        _notice(
            "WARNING",
            "Codex CLI was not found on PATH. Zbook will start, but its Codex panel "
            "will be unavailable.",
            stream,
        )
    return ready


def _launch(arguments: Sequence[str]) -> None:
    from .app import ZbookApp

    ZbookApp.launch_instance(argv=list(arguments))


def main(argv: Sequence[str] | None = None) -> int:
    raw_arguments = list(sys.argv[1:] if argv is None else argv)
    parser = _build_parser()

    implicit_legacy_run = bool(
        raw_arguments
        and raw_arguments[0].startswith("-")
        and raw_arguments[0] not in {"-h", "--help", "--version"}
    )
    if implicit_legacy_run:
        raw_arguments.insert(0, "run")

    zbook_arguments, explicit_passthrough = _partition_passthrough(raw_arguments)
    options, forgotten_passthrough = parser.parse_known_args(zbook_arguments)

    if options.command is None:
        if forgotten_passthrough or explicit_passthrough:
            parser.error("choose `check` or `run` before passing additional arguments")
        parser.print_help()
        return 0

    if options.command == "check":
        if forgotten_passthrough or explicit_passthrough:
            parser.error("`zbook check` does not accept Jupyter arguments")
        return run_checks()

    if implicit_legacy_run:
        _notice(
            "WARNING",
            "the CLI now uses subcommands. This launch is being treated as `zbook run`; "
            "prefer `zbook run -- <Jupyter arguments>`.",
            sys.stderr,
        )
    elif forgotten_passthrough:
        rendered = shlex.join(forgotten_passthrough)
        _notice(
            "WARNING",
            "Jupyter arguments should follow `--`. Treating "
            f"{rendered} as passthrough for this launch.",
            sys.stderr,
        )

    jupyter_arguments = [*forgotten_passthrough, *explicit_passthrough]
    workspace_option: Path | None = options.workspace_dir
    if workspace_option is None and _uses_legacy_workspace(jupyter_arguments):
        launch_arguments = jupyter_arguments
    else:
        workspace = (workspace_option or Path.cwd()).expanduser().resolve()
        if not workspace.is_dir():
            _notice("ERROR", f"workspace is not a directory: {workspace}", sys.stderr)
            return 2
        launch_arguments = [
            *jupyter_arguments,
            f"--ZbookApp.workspace={workspace}",
        ]

    if not _preflight_run():
        return 1
    _launch(launch_arguments)
    return 0
