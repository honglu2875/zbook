"""Build an ephemeral kernelspec pinned to the selected virtual environment."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from .config import AppConfig


def build_kernel_spec(config: AppConfig) -> dict[str, Any]:
    env = {"VIRTUAL_ENV": str(config.venv)}
    if os.name != "nt":
        env["PATH"] = f"{config.venv / 'bin'}:{os.environ.get('PATH', '')}"

    return {
        "argv": [
            str(config.python),
            "-m",
            "ipykernel_launcher",
            "-f",
            "{connection_file}",
        ],
        "display_name": f"Python ({config.venv.name})",
        "language": "python",
        "env": env,
        "metadata": {"debugger": True, "quick_notebook": True},
    }


def install_runtime_kernel_spec(config: AppConfig, runtime_dir: str | Path) -> Path:
    """Write a process-local kernelspec and return its kernel search root."""
    kernel_root = Path(runtime_dir) / "quick-notebook-kernels"
    resource_dir = kernel_root / "quick-notebook"
    resource_dir.mkdir(parents=True, exist_ok=True)
    (resource_dir / "kernel.json").write_text(
        json.dumps(build_kernel_spec(config), indent=2),
        encoding="utf-8",
    )
    return kernel_root


async def inspect_ipykernel(config: AppConfig) -> dict[str, Any]:
    """Check the selected interpreter without importing its packages in the server."""
    process = await asyncio.create_subprocess_exec(
        str(config.python),
        "-c",
        (
            "import platform; print(platform.python_version(), flush=True); "
            "import ipykernel; print(ipykernel.__version__)"
        ),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=5)
    except TimeoutError:
        process.kill()
        await process.wait()
        return {
            "ready": False,
            "version": None,
            "python_version": None,
            "error": "ipykernel check timed out",
        }
    output = stdout.decode(errors="replace").strip().splitlines()
    python_version = output[0] if output else None
    if process.returncode:
        detail = stderr.decode(errors="replace").strip().splitlines()
        return {
            "ready": False,
            "version": None,
            "python_version": python_version,
            "error": detail[-1] if detail else "ipykernel is not installed",
        }
    return {
        "ready": True,
        "version": output[1] if len(output) > 1 else None,
        "python_version": python_version,
        "error": None,
    }
