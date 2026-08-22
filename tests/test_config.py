from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from quick_notebook.config import AppConfig, ConfigurationError
from quick_notebook.kernel_spec import build_kernel_spec


class ConfigTests(unittest.TestCase):
    def make_environment(self) -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
        temporary = tempfile.TemporaryDirectory()
        workspace = Path(temporary.name) / "workspace"
        venv = workspace / ".venv"
        python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        python.parent.mkdir(parents=True)
        python.touch()
        (venv / "pyvenv.cfg").write_text("home = test\n", encoding="utf-8")
        return temporary, workspace, venv

    def test_resolves_relative_venv_and_project(self) -> None:
        temporary, workspace, venv = self.make_environment()
        self.addCleanup(temporary.cleanup)
        (workspace / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")

        config = AppConfig.resolve(workspace, ".venv")

        self.assertEqual(config.venv, venv.resolve())
        expected_python = config.venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        self.assertEqual(config.python, expected_python)
        self.assertEqual(config.project_root, workspace.resolve())
        self.assertEqual(config.as_public_dict()["environment_mode"], "project")

    def test_rejects_workspace_escape(self) -> None:
        temporary, workspace, _ = self.make_environment()
        self.addCleanup(temporary.cleanup)
        config = AppConfig.resolve(workspace, ".venv")

        with self.assertRaises(ConfigurationError):
            config.workspace_path("../private.txt")

    def test_kernel_uses_exact_environment_python(self) -> None:
        temporary, workspace, _ = self.make_environment()
        self.addCleanup(temporary.cleanup)
        config = AppConfig.resolve(workspace, ".venv")

        spec = build_kernel_spec(config)

        self.assertEqual(spec["argv"][0], str(config.python))
        self.assertEqual(spec["env"]["VIRTUAL_ENV"], str(config.venv))


if __name__ == "__main__":
    unittest.main()
