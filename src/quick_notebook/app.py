"""Jupyter Server application for Quick Notebook."""

from __future__ import annotations

import os
from pathlib import Path

from jupyter_server.extension.application import ExtensionApp
from tornado.web import StaticFileHandler
from traitlets import Unicode

from .codex import CodexAppServer
from .config import AppConfig
from .handlers import IndexHandler, StatusHandler
from .uv_env import UvEnvironment, UvRunner


class QuickNotebookApp(ExtensionApp):
    name = "quick-notebook"
    extension_url = "/quick-notebook"
    default_url = "/quick-notebook"
    load_other_extensions = False

    workspace = Unicode(
        default_value="",
        help="Directory exposed by the notebook file browser.",
        config=True,
    )
    venv = Unicode(
        default_value=".venv",
        help="uv-managed virtual environment, absolute or relative to the workspace.",
        config=True,
    )

    app_config: AppConfig
    uv_environment: UvEnvironment
    uv_runner: UvRunner
    codex: CodexAppServer | None = None

    @property
    def static_root(self) -> Path:
        return Path(__file__).parent / "static"

    def initialize_settings(self) -> None:
        workspace = self.workspace or os.getcwd()
        self.app_config = AppConfig.resolve(workspace, self.venv)
        self.uv_environment = UvEnvironment(self.app_config)
        self.uv_runner = UvRunner()
        self.serverapp.web_app.settings.update(
            quick_notebook_config=self.app_config,
            quick_notebook_static_root=str(self.static_root),
        )

        # The ContentsManager and kernels inherit the same boundary as the UI.
        self.serverapp.root_dir = str(self.app_config.workspace)

    def initialize_handlers(self) -> None:
        self.handlers.extend(
            [
                (r"/quick-notebook/?", IndexHandler),
                (r"/quick-notebook/api/status", StatusHandler),
                (
                    r"/quick-notebook/assets/(.*)",
                    StaticFileHandler,
                    {"path": str(self.static_root / "assets")},
                ),
            ]
        )

    async def get_codex(self) -> CodexAppServer:
        if self.codex is None:
            self.codex = CodexAppServer(self.app_config.workspace)
            await self.codex.start()
        return self.codex

    async def stop_extension(self) -> None:
        if self.codex is not None:
            await self.codex.close()


def main() -> None:
    QuickNotebookApp.launch_instance()
