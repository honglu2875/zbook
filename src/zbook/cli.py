"""Small command-line interface for launching and diagnosing Zbook."""

from __future__ import annotations

import argparse
import importlib.metadata
import ipaddress
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


def _codex_check() -> RequirementCheck:
    hint = (
        "Install or update Codex CLI and sign in to enable the assistant panel; "
        "notebooks remain available without it."
    )
    command = _command_check("codex", "Codex CLI", critical=False, hint=hint)
    if not command.available:
        return command

    path = shutil.which("codex")
    assert path is not None
    try:
        result = subprocess.run(
            (path, "app-server", "--help"),
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return RequirementCheck(
            "Codex CLI",
            False,
            f"{command.detail} · App Server check failed: {error}",
            False,
            hint,
        )
    if result.returncode:
        output = result.stderr.strip() or result.stdout.strip()
        reason = output.splitlines()[0] if output else f"exited with status {result.returncode}"
        return RequirementCheck(
            "Codex CLI",
            False,
            f"{command.detail} · App Server unavailable: {reason}",
            False,
            hint,
        )
    return RequirementCheck("Codex CLI", True, f"{command.detail} · App Server available", False)


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
    checks.append(_codex_check())
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


def _port_number(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be an integer") from error
    if not 0 <= port <= 65_535:
        raise argparse.ArgumentTypeError("port must be between 0 and 65535")
    return port


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
        epilog=(
            "Common network options are first class: zbook run --ip 0.0.0.0 --port 8890\n"
            "Pass other Jupyter options after `--`: zbook run -- --ServerApp.log_level=DEBUG"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    run_parser.add_argument(
        "-w",
        "--workspace-dir",
        type=Path,
        metavar="PATH",
        help="directory shown in the workspace tree (default: current directory)",
    )
    run_parser.add_argument(
        "--ip",
        metavar="ADDRESS",
        help="address to listen on (Jupyter default: localhost)",
    )
    run_parser.add_argument(
        "--port",
        type=_port_number,
        metavar="PORT",
        help="port to listen on (0 selects an available port)",
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


def _configured_ip(arguments: Sequence[str]) -> str | None:
    configured: str | None = None
    names = ("--ip", "--ServerApp.ip")
    for index, argument in enumerate(arguments):
        for name in names:
            if argument.startswith(f"{name}="):
                configured = argument.partition("=")[2]
            elif argument == name and index + 1 < len(arguments):
                candidate = arguments[index + 1]
                if not candidate.startswith("--"):
                    configured = candidate
    return configured


def _remote_bind_description(address: str | None) -> str | None:
    if address is None:
        return None
    normalized = address.strip().lower()
    if normalized in {"localhost", "localhost."}:
        return None
    candidate = normalized.removeprefix("[").removesuffix("]")
    try:
        parsed = ipaddress.ip_address(candidate)
    except ValueError:
        if candidate in {"", "*"}:
            return "all network interfaces"
        return f"the non-loopback address {address!r}"
    if parsed.is_loopback:
        return None
    if parsed.is_unspecified:
        return "all network interfaces"
    return f"the non-loopback address {address!r}"


def _warn_remote_bind(arguments: Sequence[str], stderr: TextIO | None = None) -> None:
    stream = stderr or sys.stderr
    description = _remote_bind_description(_configured_ip(arguments))
    if description is None:
        return
    _notice(
        "WARNING",
        f"Zbook will listen on {description}. Remote clients that authenticate can execute "
        "notebook code and access the workspace and Codex; keep Jupyter authentication enabled.",
        stream,
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
    launch_arguments = list(jupyter_arguments)
    if not (workspace_option is None and _uses_legacy_workspace(jupyter_arguments)):
        workspace = (workspace_option or Path.cwd()).expanduser().resolve()
        if not workspace.is_dir():
            _notice("ERROR", f"workspace is not a directory: {workspace}", sys.stderr)
            return 2
        launch_arguments.append(f"--ZbookApp.workspace={workspace}")

    if options.ip is not None:
        launch_arguments.append(f"--ServerApp.ip={options.ip}")
    if options.port is not None:
        launch_arguments.append(f"--ServerApp.port={options.port}")

    if not _preflight_run():
        return 1
    _warn_remote_bind(launch_arguments)
    _launch(launch_arguments)
    return 0
