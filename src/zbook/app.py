"""Jupyter Server application for Zbook."""

from __future__ import annotations

import asyncio
import atexit
import os
import shutil
from pathlib import Path

from jupyter_server.extension.application import ExtensionApp
from tornado.web import StaticFileHandler
from traitlets import Unicode

from .codex import CodexAppServer
from .codex_handler import CodexWebSocketHandler
from .config import AppConfig, ConfigurationError
from .environments import (
    bootstrap_ipykernel,
    create_temporary_uv_environment,
    discover_uv_environments,
    environment_path,
    is_uv_environment,
)
from .handlers import (
    CanonicalUrlHandler,
    EnvironmentsHandler,
    IndexHandler,
    KernelPrepareHandler,
    PackageHandler,
    PackagesHandler,
    StatusHandler,
)
from .kernel_spec import install_runtime_kernel_spec
from .uv_env import UvEnvironment, UvRunner


class ZbookApp(ExtensionApp):
    name = "zbook"
    extension_url = "/zbook"
    default_url = "/zbook/"
    load_other_extensions = False

    workspace = Unicode(
        default_value="",
        help="Directory exposed by the notebook file browser.",
        config=True,
    )
    venv = Unicode(
        default_value="",
        help=(
            "Optional uv-managed virtual environment, absolute or relative to the workspace. "
            "When omitted, Zbook creates a temporary environment under /tmp."
        ),
        config=True,
    )

    app_config: AppConfig
    uv_environment: UvEnvironment
    uv_runner: UvRunner
    codex: CodexAppServer | None = None
    temporary_environment_root: Path | None = None
    environment_lock: asyncio.Lock
    codex_lock: asyncio.Lock

    @property
    def static_root(self) -> Path:
        return Path(__file__).parent / "static"

    def initialize_settings(self) -> None:
        workspace = Path(self.workspace or os.getcwd()).expanduser().resolve()
        if not workspace.is_dir():
            raise ConfigurationError(f"Workspace is not a directory: {workspace}")
        selected_venv: str | Path
        if self.venv:
            selected_venv = self.venv
        else:
            self.temporary_environment_root, selected_venv = create_temporary_uv_environment()
            atexit.register(self._cleanup_temporary_environment)
            bootstrap_error = bootstrap_ipykernel(Path(selected_venv))
            if bootstrap_error:
                self.log.warning(
                    "The temporary environment was created, but ipykernel setup failed: %s",
                    bootstrap_error,
                )

        self.app_config = AppConfig.resolve(workspace, selected_venv)
        self.uv_environment = UvEnvironment(self.app_config)
        self.uv_runner = UvRunner()
        self.environment_lock = asyncio.Lock()
        self.codex_lock = asyncio.Lock()
        root_dir = str(self.app_config.workspace)

        # Extension applications load after Jupyter creates these managers, so
        # updating ServerApp alone would leave contents and kernels rooted at the
        # process working directory. Keep every existing boundary in lockstep.
        self.serverapp.root_dir = root_dir
        self.serverapp.contents_manager.root_dir = root_dir
        self.serverapp.kernel_manager.root_dir = root_dir
        kernel_root = install_runtime_kernel_spec(self.app_config, self.serverapp.runtime_dir)
        kernel_dirs = [str(kernel_root), *self.serverapp.kernel_spec_manager.kernel_dirs]
        self.serverapp.kernel_spec_manager.kernel_dirs = list(dict.fromkeys(kernel_dirs))
        self.serverapp.web_app.settings.update(
            zbook_app=self,
            zbook_config=self.app_config,
            zbook_environment=self.uv_environment,
            zbook_static_root=str(self.static_root),
            zbook_uv_runner=self.uv_runner,
            server_root_dir=root_dir,
        )

    def environment_candidates(self) -> list[dict[str, str | bool | None]]:
        candidates = [
            candidate.as_dict()
            for candidate in discover_uv_environments(self.app_config.workspace)
        ]
        active = str(self.app_config.venv)
        if all(candidate["path"] != active for candidate in candidates):
            candidates.insert(
                0,
                {
                    "path": active,
                    "project": (
                        str(self.app_config.project_root) if self.app_config.project_root else None
                    ),
                    "label": (
                        "Temporary environment"
                        if self.is_temporary_environment
                        else "Selected environment"
                    ),
                },
            )
        for candidate in candidates:
            candidate["active"] = candidate["path"] == active
            candidate["temporary"] = bool(
                self.temporary_environment_root
                and Path(str(candidate["path"])).is_relative_to(self.temporary_environment_root)
            )
        return candidates

    @property
    def is_temporary_environment(self) -> bool:
        return bool(
            self.temporary_environment_root
            and self.app_config.venv.is_relative_to(self.temporary_environment_root)
        )

    async def select_environment(self, value: str) -> AppConfig:
        async with self.environment_lock:
            selected = environment_path(value, self.app_config.workspace)
            if not is_uv_environment(selected):
                raise ConfigurationError(f"Not a uv virtual environment: {selected}")
            config = AppConfig.resolve(self.app_config.workspace, selected)
            self.app_config = config
            self.uv_environment = UvEnvironment(config)
            install_runtime_kernel_spec(config, self.serverapp.runtime_dir)
            self.serverapp.web_app.settings.update(
                zbook_config=config,
                zbook_environment=self.uv_environment,
            )
            return config

    def initialize_handlers(self) -> None:
        self.handlers.extend(
            [
                (r"/zbook", CanonicalUrlHandler),
                (r"/zbook/", IndexHandler),
                (r"/zbook/api/status", StatusHandler),
                (r"/zbook/api/environments", EnvironmentsHandler),
                (r"/zbook/api/packages", PackagesHandler),
                (r"/zbook/api/packages/([^/]+)", PackageHandler),
                (r"/zbook/api/kernel/prepare", KernelPrepareHandler),
                (r"/zbook/api/codex", CodexWebSocketHandler),
                (
                    r"/zbook/assets/(.*)",
                    StaticFileHandler,
                    {"path": str(self.static_root / "assets")},
                ),
            ]
        )

    async def get_codex(self) -> CodexAppServer:
        async with self.codex_lock:
            if self.codex is not None and self.codex.running:
                return self.codex
            if self.codex is not None:
                await self.codex.close()
            client = CodexAppServer(self.app_config.workspace)
            try:
                await client.start()
            except Exception:
                await client.close()
                raise
            self.codex = client
            return client

    async def stop_extension(self) -> None:
        if self.codex is not None:
            await self.codex.close()
        self._cleanup_temporary_environment()

    def _cleanup_temporary_environment(self) -> None:
        root = self.temporary_environment_root
        self.temporary_environment_root = None
        if root is not None:
            shutil.rmtree(root, ignore_errors=True)


def main() -> None:
    ZbookApp.launch_instance()
