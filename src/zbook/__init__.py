"""Zbook Jupyter server extension."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version

try:
    __version__ = distribution_version("zbook")
except PackageNotFoundError:
    __version__ = "0+unknown"


def _jupyter_server_extension_points() -> list[dict[str, object]]:
    from .app import ZbookApp

    return [{"module": "zbook", "app": ZbookApp}]


def _load_jupyter_server_extension(server_app: object) -> None:
    """Compatibility hook for Jupyter Server's legacy extension loader."""
    from .app import ZbookApp

    ZbookApp.load_classic_server_extension(server_app)
