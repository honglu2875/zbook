"""Small HTTP surface owned by the Zbook extension."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from typing import Any

from jupyter_server.base.handlers import APIHandler, JupyterHandler
from tornado import web

from .config import AppConfig
from .kernel_spec import inspect_ipykernel
from .uv_env import UvEnvironment, UvError, UvOperation, UvRunner


def _config(handler: JupyterHandler) -> AppConfig:
    return handler.settings["zbook_app"].app_config


def _app(handler: JupyterHandler) -> Any:
    return handler.settings["zbook_app"]


def _environment(handler: JupyterHandler) -> UvEnvironment:
    return handler.settings["zbook_app"].uv_environment


def _uv_runner(handler: JupyterHandler) -> UvRunner:
    return handler.settings["zbook_app"].uv_runner


def _finish_json(handler: JupyterHandler, payload: dict[str, Any], status: int = 200) -> None:
    handler.set_status(status)
    handler.set_header("Content-Type", "application/json")
    handler.finish(json.dumps(payload))


async def _run_uv(handler: JupyterHandler, operation: UvOperation) -> tuple[int, list[str]]:
    lines: list[str] = []
    size = 0

    def capture(line: str) -> None:
        nonlocal size
        if size >= 200_000:
            return
        remaining = 200_000 - size
        value = line[:remaining]
        lines.append(value)
        size += len(value)

    return await _uv_runner(handler).run(operation, capture), lines


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
        # index.html names content-hashed assets.  Never cache the shell so a
        # rebuilt frontend cannot strand a running Zbook server on an old hash.
        self.set_header("Cache-Control", "no-store, max-age=0")
        self.set_header("Pragma", "no-cache")
        static_root = Path(self.settings["zbook_static_root"])
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
<title>Zbook</title>
<style>
  body{margin:0;background:#161819;color:#d7d9dc;font:15px ui-sans-serif,system-ui}
  main{max-width:680px;margin:14vh auto;padding:32px;border-left:2px solid #d3a65c}
  code{color:#9fc5e8;background:#202326;padding:2px 5px} p{line-height:1.6;color:#9da2a8}
</style>
<main><h1>Zbook</h1><p>The Python server is healthy, but the web client has not
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
            "kernel": {
                "name": "zbook",
                **await inspect_ipykernel(config),
            },
        }
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class PackagesHandler(APIHandler):
    """Inspect and mutate the configured environment while the server stays running."""

    @web.authenticated
    async def get(self) -> None:
        try:
            async with _app(self).environment_lock:
                packages = await _uv_runner(self).list_packages(_environment(self).list())
        except (OSError, ValueError, UvError) as error:
            _finish_json(self, {"ok": False, "message": str(error)}, 500)
            return
        _finish_json(self, {"ok": True, "packages": packages})

    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        requirement = body.get("requirement")
        if not isinstance(requirement, str):
            _finish_json(self, {"ok": False, "message": "A requirement string is required"}, 400)
            return
        try:
            async with _app(self).environment_lock:
                operation = _environment(self).install(requirement)
                return_code, lines = await _run_uv(self, operation)
        except (OSError, ValueError) as error:
            _finish_json(self, {"ok": False, "message": str(error)}, 400)
            return
        if return_code:
            _finish_json(
                self,
                {"ok": False, "message": f"uv exited with status {return_code}", "lines": lines},
                400,
            )
            return
        _finish_json(self, {"ok": True, "lines": lines})


class PackageHandler(APIHandler):
    @web.authenticated
    async def delete(self, package: str) -> None:
        try:
            async with _app(self).environment_lock:
                operation = _environment(self).uninstall(package)
                return_code, lines = await _run_uv(self, operation)
        except (OSError, ValueError) as error:
            _finish_json(self, {"ok": False, "message": str(error)}, 400)
            return
        if return_code:
            _finish_json(
                self,
                {"ok": False, "message": f"uv exited with status {return_code}", "lines": lines},
                400,
            )
            return
        _finish_json(self, {"ok": True, "lines": lines})


class KernelPrepareHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        try:
            async with _app(self).environment_lock:
                operation = _environment(self).ensure_ipykernel()
                return_code, lines = await _run_uv(self, operation)
                kernel = await inspect_ipykernel(_config(self))
        except (OSError, ValueError) as error:
            _finish_json(self, {"ok": False, "message": str(error)}, 400)
            return
        if return_code or not kernel["ready"]:
            message = kernel["error"] or f"uv exited with status {return_code}"
            _finish_json(self, {"ok": False, "message": message, "lines": lines}, 400)
            return
        _finish_json(self, {"ok": True, "kernel": kernel, "lines": lines})


class EnvironmentsHandler(APIHandler):
    @web.authenticated
    async def get(self) -> None:
        app = _app(self)
        candidates = await asyncio.to_thread(app.environment_candidates)
        _finish_json(
            self,
            {
                "ok": True,
                "active": str(app.app_config.venv),
                "candidates": candidates,
            },
        )

    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        path = body.get("path")
        if not isinstance(path, str) or not path.strip():
            _finish_json(self, {"ok": False, "message": "An environment path is required"}, 400)
            return
        app = _app(self)
        try:
            config = await app.select_environment(path)
        except (OSError, ValueError) as error:
            _finish_json(self, {"ok": False, "message": str(error)}, 400)
            return
        _finish_json(
            self,
            {
                "ok": True,
                "config": config.as_public_dict(),
                "kernel": await inspect_ipykernel(config),
            },
        )
