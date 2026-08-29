#!/usr/bin/env python3
"""Launch an isolated real Zbook server for Playwright's Chromium smoke tests."""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import struct
import tempfile
import zlib
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


def solid_png(width: int, height: int) -> str:
    """Return a small encoded file with deliberately wide natural dimensions."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", checksum)

    scanline = b"\0" + (b"\xd1\xa6\x5e" * width)
    payload = b"".join(scanline for _ in range(height))
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(payload, level=9))
    png += chunk(b"IEND", b"")
    return base64.b64encode(png).decode("ascii")


def seed_workspace(workspace: Path) -> None:
    image_output = notebook(("image-cell", "code", "# A stored wide image output"))
    image_cell = image_output["cells"][0]
    image_cell["execution_count"] = 1
    image_cell["outputs"] = [{
        "output_type": "display_data",
        "data": {
            "image/png": solid_png(1_200, 900),
            "text/plain": "<wide test image>",
        },
        "metadata": {},
    }]
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
        "queue.ipynb": notebook(
            (
                "queue-slow",
                "code",
                "import time\ntime.sleep(1.5)\nprint('slow finished')",
            ),
            (
                "queue-error",
                "code",
                "import time\ntime.sleep(0.4)\nraise RuntimeError('queue boom')",
            ),
            ("queue-final", "code", "print('queue resumed')"),
        ),
        "image.ipynb": image_output,
        "widgets.ipynb": notebook(
            (
                "widget-cell",
                "code",
                "import ipywidgets as widgets\n"
                "slider = widgets.IntSlider(value=4, min=0, max=10, description='Live')\n"
                "slider",
            ),
            ("widget-value", "code", "slider.value"),
        ),
        "matplotlib-widget.ipynb": notebook(
            (
                "matplotlib-widget-cell",
                "code",
                "%matplotlib widget\n"
                "import numpy as np\n"
                "import matplotlib.pyplot as plt\n"
                "from matplotlib.widgets import Slider\n"
                "\n"
                "run_ids = ['run-0', 'run-1', 'run-2', 'run-3']\n"
                "x = np.linspace(0, 2 * np.pi, 300)\n"
                "fig, lines_ax = plt.subplots(figsize=(6, 4))\n"
                "fig.subplots_adjust(bottom=0.24)\n"
                "line, = lines_ax.plot(x, np.sin(x))\n"
                "slider_ax = fig.add_axes([0.18, 0.08, 0.68, 0.04])\n"
                "seed_slider = Slider(\n"
                "    slider_ax, 'seed/run', 0, len(run_ids) - 1,\n"
                "    valinit=0, valstep=1, valfmt='%0.0f'\n"
                ")\n"
                "\n"
                "def update(value):\n"
                "    selected_index = int(value)\n"
                "    selected_run_id = run_ids[selected_index]\n"
                "    line.set_ydata(np.sin(x + selected_index * 0.5))\n"
                "    lines_ax.set_title(\n"
                "        f'Expert load — {selected_run_id}, block 4'\n"
                "    )\n"
                "    lines_ax.relim()\n"
                "    lines_ax.autoscale_view()\n"
                "    fig.canvas.draw_idle()\n"
                "\n"
                "seed_slider.on_changed(update)\n"
                "update(seed_slider.val)\n"
                "plt.show()",
            ),
            (
                "matplotlib-widget-value",
                "code",
                "int(seed_slider.val), lines_ax.get_title()",
            ),
        ),
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
                    f"--ZbookApp.settings_file={workspace / '.zbook-settings.json'}",
                    "--ServerApp.open_browser=False",
                    "--ServerApp.port_retries=0",
                    f"--IdentityProvider.token={options.token}",
                ]
            )
        )
