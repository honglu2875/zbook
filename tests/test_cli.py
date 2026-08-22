from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from zbook.cli import RequirementCheck, _preflight_run, main, run_checks


class CliTests(unittest.TestCase):
    def make_workspace(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        return temporary, Path(temporary.name).resolve()

    @patch("zbook.cli._launch")
    @patch("zbook.cli._preflight_run", return_value=True)
    def test_run_uses_workspace_and_explicit_jupyter_passthrough(
        self,
        _preflight: object,
        launch: object,
    ) -> None:
        temporary, workspace = self.make_workspace()
        self.addCleanup(temporary.cleanup)

        status = main(
            [
                "run",
                "--workspace-dir",
                str(workspace),
                "--",
                "--ServerApp.port=8890",
                "--ServerApp.open_browser=False",
            ]
        )

        self.assertEqual(status, 0)
        launch.assert_called_once_with(
            [
                "--ServerApp.port=8890",
                "--ServerApp.open_browser=False",
                f"--ZbookApp.workspace={workspace}",
            ]
        )

    @patch("zbook.cli._launch")
    @patch("zbook.cli._preflight_run", return_value=True)
    def test_run_defaults_to_current_directory(
        self,
        _preflight: object,
        launch: object,
    ) -> None:
        status = main(["run"])

        self.assertEqual(status, 0)
        launch.assert_called_once_with([f"--ZbookApp.workspace={Path.cwd().resolve()}"])

    @patch("zbook.cli._launch")
    @patch("zbook.cli._preflight_run", return_value=True)
    def test_run_accepts_first_class_network_options_and_warns_for_remote_bind(
        self,
        _preflight: object,
        launch: object,
    ) -> None:
        temporary, workspace = self.make_workspace()
        self.addCleanup(temporary.cleanup)
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            status = main(
                [
                    "run",
                    "--workspace-dir",
                    str(workspace),
                    "--ip",
                    "0.0.0.0",
                    "--port",
                    "8890",
                ]
            )

        self.assertEqual(status, 0)
        launch.assert_called_once_with(
            [
                f"--ZbookApp.workspace={workspace}",
                "--ServerApp.ip=0.0.0.0",
                "--ServerApp.port=8890",
            ]
        )
        self.assertIn("listen on all network interfaces", stderr.getvalue())
        self.assertIn("keep Jupyter authentication enabled", stderr.getvalue())

    @patch("zbook.cli._launch")
    @patch("zbook.cli._preflight_run", return_value=True)
    def test_run_does_not_warn_for_loopback_bind(
        self,
        _preflight: object,
        launch: object,
    ) -> None:
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            status = main(["run", "--ip", "::1"])

        self.assertEqual(status, 0)
        self.assertNotIn("Remote clients", stderr.getvalue())
        launch.assert_called_once_with(
            [f"--ZbookApp.workspace={Path.cwd().resolve()}", "--ServerApp.ip=::1"]
        )

    @patch("zbook.cli._launch")
    @patch("zbook.cli._preflight_run", return_value=True)
    def test_remote_bind_warning_also_covers_jupyter_passthrough(
        self,
        _preflight: object,
        launch: object,
    ) -> None:
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            status = main(["run", "--", "--ServerApp.ip=0.0.0.0"])

        self.assertEqual(status, 0)
        self.assertIn("listen on all network interfaces", stderr.getvalue())
        launch.assert_called_once_with(
            ["--ServerApp.ip=0.0.0.0", f"--ZbookApp.workspace={Path.cwd().resolve()}"]
        )

    @patch("zbook.cli._launch")
    def test_run_rejects_out_of_range_port(self, launch: object) -> None:
        stderr = io.StringIO()

        with redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
            main(["run", "--port", "70000"])

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("port must be between 0 and 65535", stderr.getvalue())
        launch.assert_not_called()

    @patch("zbook.cli._launch")
    @patch("zbook.cli._preflight_run", return_value=True)
    def test_run_warns_and_accepts_forgotten_passthrough(
        self,
        _preflight: object,
        launch: object,
    ) -> None:
        temporary, workspace = self.make_workspace()
        self.addCleanup(temporary.cleanup)
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            status = main(
                [
                    "run",
                    "-w",
                    str(workspace),
                    "--ServerApp.port",
                    "8890",
                ]
            )

        self.assertEqual(status, 0)
        self.assertIn("Jupyter arguments should follow `--`", stderr.getvalue())
        launch.assert_called_once_with(
            ["--ServerApp.port", "8890", f"--ZbookApp.workspace={workspace}"]
        )

    @patch("zbook.cli._launch")
    @patch("zbook.cli._preflight_run", return_value=True)
    def test_legacy_launch_remains_compatible(
        self,
        _preflight: object,
        launch: object,
    ) -> None:
        temporary, workspace = self.make_workspace()
        self.addCleanup(temporary.cleanup)
        stderr = io.StringIO()
        workspace_argument = f"--ZbookApp.workspace={workspace}"

        with redirect_stderr(stderr):
            status = main([workspace_argument, "--ServerApp.port=8890"])

        self.assertEqual(status, 0)
        self.assertIn("CLI now uses subcommands", stderr.getvalue())
        launch.assert_called_once_with([workspace_argument, "--ServerApp.port=8890"])

    @patch("zbook.cli._launch")
    @patch("zbook.cli._preflight_run", return_value=True)
    def test_run_rejects_missing_workspace(
        self,
        _preflight: object,
        launch: object,
    ) -> None:
        temporary, workspace = self.make_workspace()
        temporary.cleanup()
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            status = main(["run", "--workspace-dir", str(workspace)])

        self.assertEqual(status, 2)
        self.assertIn("workspace is not a directory", stderr.getvalue())
        launch.assert_not_called()

    @patch("zbook.cli.collect_checks")
    def test_check_reports_optional_warning_without_failing(self, collect: object) -> None:
        collect.return_value = [
            RequirementCheck("uv", True, "uv 1.0"),
            RequirementCheck(
                "Codex CLI",
                False,
                "not found on PATH",
                critical=False,
                hint="Install Codex CLI.",
            ),
        ]
        output = io.StringIO()

        status = run_checks(output)

        self.assertEqual(status, 0)
        self.assertIn("⚠ Codex CLI", output.getvalue())
        self.assertIn("WARNING: Zbook can run", output.getvalue())

    @patch("zbook.cli.collect_checks")
    def test_check_fails_when_a_required_component_is_missing(self, collect: object) -> None:
        collect.return_value = [
            RequirementCheck(
                "uv",
                False,
                "not found on PATH",
                hint="Install uv.",
            )
        ]
        output = io.StringIO()

        status = run_checks(output)

        self.assertEqual(status, 1)
        self.assertIn("✗ uv", output.getvalue())
        self.assertIn("ERROR: Zbook is missing 1 required component", output.getvalue())

    @patch("zbook.cli.shutil.which")
    def test_run_preflight_warns_when_only_codex_is_missing(self, which: object) -> None:
        which.side_effect = lambda executable: "/usr/bin/uv" if executable == "uv" else None
        stderr = io.StringIO()

        ready = _preflight_run(stderr)

        self.assertTrue(ready)
        self.assertIn("WARNING: Codex CLI was not found", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
