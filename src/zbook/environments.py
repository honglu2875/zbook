"""Discovery and creation helpers for selectable uv environments."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from .config import AppConfig, ConfigurationError

_SKIPPED_DIRECTORIES = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "node_modules",
}


def environment_path(value: str | Path, relative_to: Path | None = None) -> Path:
    """Accept either a virtual environment or a project folder containing `.venv`."""
    path = Path(value).expanduser()
    if relative_to is not None and not path.is_absolute():
        path = relative_to / path
    path = path.resolve()
    nested = path / ".venv"
    if not (path / "pyvenv.cfg").is_file() and (nested / "pyvenv.cfg").is_file():
        return nested.resolve()
    return path


def is_uv_environment(path: str | Path) -> bool:
    config = environment_path(path) / "pyvenv.cfg"
    if not config.is_file():
        return False
    try:
        lines = config.read_text().splitlines()
        return any(line.partition("=")[0].strip() == "uv" for line in lines)
    except OSError:
        return False


def workspace_uv_environment(workspace: str | Path) -> Path | None:
    """Return a usable uv-managed ``workspace/.venv`` without traversing the tree."""
    root = Path(workspace).expanduser().resolve()
    candidate = root / ".venv"
    if candidate.is_symlink() or not candidate.is_dir() or not is_uv_environment(candidate):
        return None
    try:
        return AppConfig.resolve(root, candidate).venv
    except (OSError, ConfigurationError):
        return None


@dataclass(frozen=True, slots=True)
class EnvironmentCandidate:
    path: Path
    project: Path | None
    label: str

    def as_dict(self) -> dict[str, str | None]:
        return {
            "path": str(self.path),
            "project": str(self.project) if self.project else None,
            "label": self.label,
        }


def discover_uv_environments(
    workspace: Path,
    *,
    max_depth: int = 5,
    max_directories: int = 5_000,
) -> list[EnvironmentCandidate]:
    """Find project `.venv` folders without following links outside the workspace."""
    root = workspace.resolve()
    queue: deque[tuple[Path, int]] = deque([(root, 0)])
    candidates: list[EnvironmentCandidate] = []
    visited = 0

    while queue and visited < max_directories:
        directory, depth = queue.popleft()
        visited += 1
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue

        for entry in entries:
            if (
                entry.name == ".venv"
                and entry.is_dir()
                and not entry.is_symlink()
                and is_uv_environment(entry)
            ):
                project = directory if (directory / "pyproject.toml").is_file() else None
                relative = directory.relative_to(root)
                label = "workspace/.venv" if not relative.parts else f"{relative.as_posix()}/.venv"
                candidates.append(EnvironmentCandidate(entry.resolve(), project, label))
                continue
            if depth >= max_depth or entry.name in _SKIPPED_DIRECTORIES:
                continue
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_dir() and not entry.is_symlink():
                    queue.append((entry, depth + 1))
            except OSError:
                continue

    return sorted(candidates, key=lambda candidate: candidate.label.casefold())


def create_temporary_uv_environment(executable: str = "uv") -> tuple[Path, Path]:
    """Create an ephemeral uv environment under the platform temporary directory."""
    resolved_executable = shutil.which(executable)
    if resolved_executable is None:
        raise ConfigurationError("uv is required to create the default temporary environment")
    root = Path(tempfile.mkdtemp(prefix="zbook-"))
    venv = root / ".venv"
    try:
        result = subprocess.run(
            (resolved_executable, "venv", str(venv)),
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        shutil.rmtree(root, ignore_errors=True)
        message = f"Could not create the temporary uv environment: {error}"
        raise ConfigurationError(message) from error
    if result.returncode:
        shutil.rmtree(root, ignore_errors=True)
        detail = result.stderr.strip() or result.stdout.strip()
        raise ConfigurationError(detail or f"uv venv exited with status {result.returncode}")
    return root, venv


def bootstrap_ipykernel(venv: Path, executable: str = "uv") -> str | None:
    """Make a fresh scratch environment runnable, returning a non-fatal error if offline."""
    resolved_executable = shutil.which(executable)
    if resolved_executable is None:
        return "uv was not found on PATH"
    try:
        result = subprocess.run(
            (
                resolved_executable,
                "pip",
                "install",
                "--python",
                str(venv),
                "--no-progress",
                "--",
                "ipykernel",
            ),
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return str(error)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        return detail or f"uv exited with {result.returncode}"
    return None
