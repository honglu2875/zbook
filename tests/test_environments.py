from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from zbook.config import AppConfig
from zbook.environments import (
    bootstrap_ipykernel,
    discover_uv_environments,
    environment_path,
    is_uv_environment,
)


def make_environment(project: Path, *, uv: bool = True) -> Path:
    venv = project / ".venv"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.touch()
    marker = "uv = 0.12.0\n" if uv else ""
    (venv / "pyvenv.cfg").write_text(f"home = test\n{marker}", encoding="utf-8")
    return venv


class EnvironmentDiscoveryTests(unittest.TestCase):
    def test_discovers_nested_uv_projects_and_not_plain_venvs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            uv_project = workspace / "packages" / "demo"
            plain_project = workspace / "packages" / "plain"
            uv_project.mkdir(parents=True)
            plain_project.mkdir(parents=True)
            (uv_project / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
            expected = make_environment(uv_project)
            make_environment(plain_project, uv=False)

            candidates = discover_uv_environments(workspace)

            self.assertEqual([candidate.path for candidate in candidates], [expected.resolve()])
            self.assertEqual(candidates[0].label, "packages/demo/.venv")
            self.assertEqual(candidates[0].project, uv_project)

    def test_project_folder_resolves_to_its_dot_venv(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            project = workspace / "demo"
            project.mkdir()
            (project / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
            venv = make_environment(project)

            config = AppConfig.resolve(workspace, project)

            self.assertEqual(environment_path(project), venv.resolve())
            self.assertEqual(environment_path("demo", workspace), venv.resolve())
            self.assertTrue(is_uv_environment(project))
            self.assertEqual(config.venv, venv.resolve())
            self.assertEqual(config.project_root, project)

    @patch("zbook.environments.subprocess.run")
    @patch("zbook.environments.shutil.which", return_value="/usr/bin/uv")
    def test_bootstrap_targets_temporary_environment(
        self,
        _which: MagicMock,
        run: MagicMock,
    ) -> None:
        run.return_value.returncode = 0

        error = bootstrap_ipykernel(Path("/tmp/scratch/.venv"))

        self.assertIsNone(error)
        argv = run.call_args.args[0]
        self.assertEqual(argv[:3], ("/usr/bin/uv", "pip", "install"))
        self.assertIn("/tmp/scratch/.venv", argv)
        self.assertEqual(argv[-1], "ipykernel")


if __name__ == "__main__":
    unittest.main()
