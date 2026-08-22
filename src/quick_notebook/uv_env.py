"""Safe, serialized uv operations for the selected Python environment."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .config import AppConfig

LineCallback = Callable[[str], None | Awaitable[None]]
_PACKAGE_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


class UvError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class UvOperation:
    argv: tuple[str, ...]
    env: dict[str, str]


def _requirement(value: str) -> str:
    clean = value.strip()
    if not clean or "\n" in clean or "\r" in clean or "\x00" in clean:
        raise ValueError("Requirement must be a single non-empty line")
    if clean.startswith("-"):
        raise ValueError("Requirement cannot be a command-line option")
    return clean


def _package_name(value: str) -> str:
    clean = value.strip()
    if not _PACKAGE_NAME.fullmatch(clean):
        raise ValueError(f"Invalid package name: {value!r}")
    return clean


class UvEnvironment:
    def __init__(self, config: AppConfig, executable: str = "uv") -> None:
        self.config = config
        self.executable = executable

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self.config.project_root:
            env["UV_PROJECT_ENVIRONMENT"] = str(self.config.venv)
        return env

    def install(self, requirement: str) -> UvOperation:
        package = _requirement(requirement)
        if self.config.project_root:
            argv = (
                self.executable,
                "add",
                "--project",
                str(self.config.project_root),
                "--no-progress",
                "--",
                package,
            )
        else:
            argv = (
                self.executable,
                "pip",
                "install",
                "--python",
                str(self.config.python),
                "--no-progress",
                "--",
                package,
            )
        return UvOperation(argv, self._env())

    def uninstall(self, package: str) -> UvOperation:
        name = _package_name(package)
        if self.config.project_root:
            argv = (
                self.executable,
                "remove",
                "--project",
                str(self.config.project_root),
                "--no-progress",
                "--",
                name,
            )
        else:
            argv = (
                self.executable,
                "pip",
                "uninstall",
                "--python",
                str(self.config.python),
                "--no-progress",
                "--",
                name,
            )
        return UvOperation(argv, self._env())

    def list(self) -> UvOperation:
        argv = (
            self.executable,
            "pip",
            "list",
            "--python",
            str(self.config.python),
            "--format",
            "json",
        )
        return UvOperation(argv, self._env())

    def ensure_ipykernel(self) -> UvOperation:
        if self.config.project_root:
            argv = (
                self.executable,
                "add",
                "--project",
                str(self.config.project_root),
                "--dev",
                "--no-progress",
                "--",
                "ipykernel",
            )
        else:
            argv = (
                self.executable,
                "pip",
                "install",
                "--python",
                str(self.config.python),
                "--no-progress",
                "--",
                "ipykernel",
            )
        return UvOperation(argv, self._env())


class UvRunner:
    """Run one package mutation at a time and stream merged output."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    async def run(self, operation: UvOperation, on_line: LineCallback | None = None) -> int:
        async with self._lock:
            process = await asyncio.create_subprocess_exec(
                *operation.argv,
                env=operation.env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            assert process.stdout is not None
            async for raw_line in process.stdout:
                if on_line is not None:
                    result = on_line(raw_line.decode(errors="replace").rstrip())
                    if inspect.isawaitable(result):
                        await result
            return await process.wait()

    async def list_packages(self, operation: UvOperation) -> list[dict[str, str]]:
        chunks: list[bytes] = []

        async with self._lock:
            process = await asyncio.create_subprocess_exec(
                *operation.argv,
                env=operation.env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            chunks.append(stdout)
            if process.returncode:
                message = stderr.decode(errors="replace").strip()
                raise UvError(message or f"uv exited with status {process.returncode}")

        value = json.loads(b"".join(chunks))
        if not isinstance(value, list):
            raise UvError("uv returned an unexpected package list")
        return value
