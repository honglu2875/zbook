from __future__ import annotations

import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from zbook.preferences import DEFAULT_SETTINGS, SettingsStoreError, UserSettingsStore


class UserSettingsStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / ".zbook" / "settings.json"
        self.store = UserSettingsStore(self.path)

    def test_missing_file_uses_browser_without_creating_parent(self) -> None:
        snapshot = self.store.snapshot()

        self.assertEqual(snapshot["source"], "browser")
        self.assertEqual(snapshot["status"], "missing")
        self.assertEqual(snapshot["settings"], DEFAULT_SETTINGS)
        self.assertTrue(snapshot["canCreate"])
        self.assertFalse(self.path.parent.exists())

    def test_valid_partial_file_uses_file_and_fills_defaults(self) -> None:
        self.path.parent.mkdir()
        self.path.write_text(
            json.dumps({"schemaVersion": 1, "editor": {"vim": True, "tabSize": 2}}),
            encoding="utf-8",
        )

        snapshot = self.store.snapshot()

        self.assertEqual(snapshot["source"], "file")
        self.assertEqual(snapshot["status"], "ready")
        self.assertTrue(snapshot["settings"]["editor"]["vim"])
        self.assertEqual(snapshot["settings"]["editor"]["tabSize"], 2)
        self.assertEqual(snapshot["settings"]["notebook"]["outputMaxHeight"], 280)

    def test_invalid_field_is_ignored_without_disabling_file(self) -> None:
        self.path.parent.mkdir()
        self.path.write_text(
            json.dumps({"editor": {"vim": True, "tabSize": 100}}), encoding="utf-8"
        )

        snapshot = self.store.snapshot()

        self.assertEqual(snapshot["source"], "file")
        self.assertTrue(snapshot["settings"]["editor"]["vim"])
        self.assertEqual(snapshot["settings"]["editor"]["tabSize"], 4)
        self.assertEqual(snapshot["ignored"], ["editor.tabSize"])
        self.assertIn("editor.tabSize", snapshot["warning"])

    def test_malformed_file_uses_browser_and_is_never_overwritten(self) -> None:
        malformed = "{ definitely not JSON"
        self.path.parent.mkdir()
        self.path.write_text(malformed, encoding="utf-8")

        snapshot = self.store.snapshot()

        self.assertEqual(snapshot["source"], "browser")
        self.assertEqual(snapshot["status"], "invalid")
        self.assertFalse(snapshot["canCreate"])
        with self.assertRaisesRegex(SettingsStoreError, "invalid"):
            self.store.update(DEFAULT_SETTINGS)
        with self.assertRaisesRegex(SettingsStoreError, "already exists"):
            self.store.create(DEFAULT_SETTINGS)
        self.assertEqual(self.path.read_text(encoding="utf-8"), malformed)

    def test_unsupported_schema_uses_browser(self) -> None:
        self.path.parent.mkdir()
        self.path.write_text(json.dumps({"schemaVersion": 2}), encoding="utf-8")

        snapshot = self.store.snapshot()

        self.assertEqual(snapshot["status"], "invalid")
        self.assertIn("Unsupported settings schemaVersion 2", snapshot["warning"])

    def test_create_writes_normalized_private_file(self) -> None:
        snapshot = self.store.create({"editor": {"vim": True}})

        self.assertEqual(snapshot["source"], "file")
        self.assertTrue(snapshot["settings"]["editor"]["vim"])
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(saved["schemaVersion"], 1)
        self.assertEqual(saved["codex"]["effort"], "medium")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_update_replaces_valid_file_and_rejects_invalid_input(self) -> None:
        self.store.create(DEFAULT_SETTINGS)
        updated = {**DEFAULT_SETTINGS, "editor": {**DEFAULT_SETTINGS["editor"], "tabSize": 8}}

        snapshot = self.store.update(updated)

        self.assertEqual(snapshot["settings"]["editor"]["tabSize"], 8)
        with self.assertRaisesRegex(SettingsStoreError, "editor.tabSize"):
            self.store.update({"editor": {"tabSize": 99}})
        self.assertEqual(
            json.loads(self.path.read_text(encoding="utf-8"))["editor"]["tabSize"], 8
        )

    def test_update_requires_explicit_create(self) -> None:
        with self.assertRaisesRegex(SettingsStoreError, "create it explicitly"):
            self.store.update(DEFAULT_SETTINGS)

    def test_read_only_file_remains_the_active_source(self) -> None:
        self.store.create(DEFAULT_SETTINGS)
        with patch("zbook.preferences.os.access", return_value=False):
            snapshot = self.store.snapshot()

        self.assertEqual(snapshot["source"], "file")
        self.assertEqual(snapshot["status"], "read_only")
        self.assertFalse(snapshot["writable"])
        self.assertIn("session", snapshot["warning"])


if __name__ == "__main__":
    unittest.main()
