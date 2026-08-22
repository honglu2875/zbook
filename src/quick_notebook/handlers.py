"""Small HTTP surface owned by the Quick Notebook extension."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from jupyter_server.base.handlers import APIHandler, JupyterHandler
from tornado import web

from .config import AppConfig


def _config(handler: JupyterHandler) -> AppConfig:
    return handler.settings["quick_notebook_config"]


def canonical_notebook_url(path: str, query: str) -> str:
    target = f"{path}/"
    return f"{target}?{query}" if query else target


class CanonicalUrlHandler(web.RequestHandler):
    """Add the slash required for document-relative frontend asset URLs."""

    def get(self) -> None:
        self.redirect(canonical_notebook_url(self.request.path, self.request.query))


class IndexHandler(JupyterHandler):
    @web.authenticated
    async def get(self) -> None:
        static_root = Path(self.settings["quick_notebook_static_root"])
        index = static_root / "index.html"
        if index.is_file():
            self.set_header("Content-Type", "text/html; charset=UTF-8")
            self.finish(index.read_text(encoding="utf-8"))
            return

        self.set_status(503)
        self.set_header("Content-Type", "text/html; charset=UTF-8")
        self.finish(
            """<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Quick Notebook</title>
<style>
  body{margin:0;background:#161819;color:#d7d9dc;font:15px ui-sans-serif,system-ui}
  main{max-width:680px;margin:14vh auto;padding:32px;border-left:2px solid #d3a65c}
  code{color:#9fc5e8;background:#202326;padding:2px 5px} p{line-height:1.6;color:#9da2a8}
</style>
<main><h1>Quick Notebook</h1><p>The Python server is healthy, but the web client has not
been built yet. Install a current Node.js release, then run <code>npm install</code> and
<code>npm run build</code> inside <code>frontend/</code>.</p></main></html>"""
        )


class StatusHandler(APIHandler):
    @web.authenticated
    async def get(self) -> None:
        config = _config(self)
        payload: dict[str, Any] = {
            "ok": True,
            "config": config.as_public_dict(),
            "tools": {
                "uv": shutil.which("uv"),
                "codex": shutil.which("codex"),
            },
        }
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))
