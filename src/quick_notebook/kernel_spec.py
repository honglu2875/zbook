"""Build an ephemeral kernelspec pinned to the selected virtual environment."""

from __future__ import annotations

import os
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
