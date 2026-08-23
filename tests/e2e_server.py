#!/usr/bin/env python3
"""Launch an isolated real Zbook server for Playwright's Chromium smoke tests."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path

from zbook.cli import main


def notebook(*cells: tuple[str, str, str]) -> dict[str, object]:
    models: list[dict[str, object]] = []
    for cell_id, cell_type, source in cells:
        cell: dict[str, object] = {
            "cell_type": cell_type,
            "id": cell_id,
            "metadata": {},
            "source": source.splitlines(keepends=True),
        }
        if cell_type == "code":
            cell.update({"execution_count": None, "outputs": []})
        models.append(cell)
    return {
        "cells": models,
        "metadata": {},
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def seed_workspace(workspace: Path) -> None:
    fixtures = {
        "core.ipynb": notebook(
            ("core-first", "code", "value = 6 * 7\nvalue"),
            ("core-second", "code", "value + 1"),
        ),
        "second.ipynb": notebook(("second-cell", "code", "'second notebook'")),
        "markdown.ipynb": notebook(
            ("markdown-first", "markdown", "# Existing heading"),
            ("markdown-second", "code", "print('next cell')"),
        ),
        "conflict.ipynb": notebook(("conflict-cell", "code", "original_value = 1")),
    }
    for name, content in fixtures.items():
        (workspace / name).write_text(json.dumps(content), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    options = parse_args()
    project_root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="zbook-playwright-") as temporary:
        workspace = Path(temporary)
        seed_workspace(workspace)
        runtime_dir = workspace / ".jupyter-runtime"
        runtime_dir.mkdir()
        os.environ["JUPYTER_RUNTIME_DIR"] = str(runtime_dir)
        # Never couple browser tests to a developer's real Codex account. The
        # notebook and kernel paths remain fully real; Codex protocol behavior
        # is covered by the subprocess integration tests.
        uv = shutil.which("uv")
        test_bin = workspace / ".test-bin"
        test_bin.mkdir()
        if uv:
            (test_bin / "uv").symlink_to(uv)
        sanitized_path = [
            part
            for part in os.environ.get("PATH", "").split(os.pathsep)
            if not (Path(part) / "codex").exists()
        ]
        os.environ["PATH"] = os.pathsep.join([str(test_bin), *sanitized_path])
        raise SystemExit(
            main(
                [
                    "run",
                    "--workspace-dir",
                    str(workspace),
                    "--ip",
                    "127.0.0.1",
                    "--port",
                    str(options.port),
                    "--",
                    f"--ZbookApp.venv={project_root / '.venv'}",
                    "--ServerApp.open_browser=False",
                    "--ServerApp.port_retries=0",
                    f"--IdentityProvider.token={options.token}",
                ]
            )
        )
