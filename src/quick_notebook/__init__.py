"""Quick Notebook Jupyter server extension."""

from __future__ import annotations

__version__ = "0.1.0"


def _jupyter_server_extension_points() -> list[dict[str, object]]:
    from .app import QuickNotebookApp

    return [{"module": "quick_notebook", "app": QuickNotebookApp}]


def _load_jupyter_server_extension(server_app: object) -> None:
    """Compatibility hook for Jupyter Server's legacy extension loader."""
    from .app import QuickNotebookApp

    QuickNotebookApp.load_classic_server_extension(server_app)
