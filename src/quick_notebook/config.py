"""Validated local paths shared by the HTTP, kernel, uv, and Codex layers."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ConfigurationError(ValueError):
    """Raised when the requested workspace or virtual environment is unsafe."""


def _python_in(venv: Path) -> Path:
    if os.name == "nt":
        candidates = (venv / "Scripts" / "python.exe", venv / "Scripts" / "python")
    else:
        candidates = (venv / "bin" / "python",)

    for candidate in candidates:
        if candidate.is_file():
            # Keep the venv-facing path. Dereferencing the interpreter symlink would
            # make Python start as the base installation and skip pyvenv.cfg.
            return candidate
    raise ConfigurationError(f"No Python interpreter found in virtual environment: {venv}")


@dataclass(frozen=True, slots=True)
class AppConfig:
    workspace: Path
    venv: Path
    python: Path
    project_root: Path | None

    @classmethod
    def resolve(cls, workspace: str | Path, venv: str | Path) -> AppConfig:
        workspace_path = Path(workspace).expanduser().resolve()
        if not workspace_path.is_dir():
            raise ConfigurationError(f"Workspace is not a directory: {workspace_path}")

        raw_venv = Path(venv).expanduser()
        if not raw_venv.is_absolute():
            raw_venv = workspace_path / raw_venv
        venv_path = raw_venv.resolve()
        nested_venv = venv_path / ".venv"
        if not (venv_path / "pyvenv.cfg").is_file() and (nested_venv / "pyvenv.cfg").is_file():
            venv_path = nested_venv.resolve()
        if not (venv_path / "pyvenv.cfg").is_file():
            raise ConfigurationError(f"Not a Python virtual environment: {venv_path}")

        project_root = venv_path.parent if (venv_path.parent / "pyproject.toml").is_file() else None
        return cls(
            workspace=workspace_path,
            venv=venv_path,
            python=_python_in(venv_path),
            project_root=project_root,
        )

    def workspace_path(self, relative: str | Path) -> Path:
        requested = Path(relative)
        if requested.is_absolute():
            raise ConfigurationError("Workspace paths must be relative")

        resolved = (self.workspace / requested).resolve(strict=False)
        try:
            resolved.relative_to(self.workspace)
        except ValueError as error:
            raise ConfigurationError(f"Path escapes the workspace: {relative}") from error
        return resolved

    def as_public_dict(self) -> dict[str, Any]:
        return {
            "workspace": str(self.workspace),
            "venv": str(self.venv),
            "python": str(self.python),
            "project_root": str(self.project_root) if self.project_root else None,
            "environment_mode": "project" if self.project_root else "virtualenv",
        }
