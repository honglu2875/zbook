from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from zbook.config import AppConfig
from zbook.uv_env import UvEnvironment


def make_config(project: bool) -> tuple[tempfile.TemporaryDirectory[str], AppConfig]:
    temporary = tempfile.TemporaryDirectory()
    workspace = Path(temporary.name) / "workspace"
    venv = workspace / ".venv"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.touch()
    (venv / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
    if project:
        (workspace / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    return temporary, AppConfig.resolve(workspace, venv)


class UvEnvironmentTests(unittest.TestCase):
    def test_project_install_updates_pyproject_environment(self) -> None:
        temporary, config = make_config(project=True)
        self.addCleanup(temporary.cleanup)

        operation = UvEnvironment(config).install("polars>=1")

        self.assertEqual(operation.argv[:4], ("uv", "add", "--project", str(config.project_root)))
        self.assertEqual(operation.argv[-1], "polars>=1")
        self.assertEqual(operation.env["UV_PROJECT_ENVIRONMENT"], str(config.venv))

    def test_plain_venv_install_targets_exact_interpreter(self) -> None:
        temporary, config = make_config(project=False)
        self.addCleanup(temporary.cleanup)

        operation = UvEnvironment(config).install("numpy")

        self.assertEqual(operation.argv[:3], ("uv", "pip", "install"))
        self.assertIn(str(config.python), operation.argv)
        self.assertNotIn("UV_PROJECT_ENVIRONMENT", operation.env)

    def test_rejects_option_injection_and_invalid_uninstall_name(self) -> None:
        temporary, config = make_config(project=False)
        self.addCleanup(temporary.cleanup)
        environment = UvEnvironment(config)

        with self.assertRaises(ValueError):
            environment.install("--target=/tmp/example")
        with self.assertRaises(ValueError):
            environment.uninstall("numpy; touch nope")


if __name__ == "__main__":
    unittest.main()
