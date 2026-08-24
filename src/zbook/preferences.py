"""Validated, narrowly scoped persistence for Zbook user preferences."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
DEFAULT_SETTINGS: dict[str, Any] = {
    "schemaVersion": SCHEMA_VERSION,
    "editor": {
        "vim": False,
        "codeFontSize": 13.5,
        "tabSize": 4,
        "lineWrapping": True,
    },
    "notebook": {
        "outputMaxHeight": 280,
        "confirmKernelRestart": True,
    },
    "codex": {
        "model": "",
        "effort": "medium",
    },
}

CODEX_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh"}


class SettingsStoreError(ValueError):
    """An expected settings operation failure suitable for an HTTP response."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def normalize_settings(value: object, *, strict: bool = False) -> tuple[dict[str, Any], list[str]]:
    """Return a complete schema, replacing invalid fields with defaults.

    Unknown fields are deliberately ignored for forward compatibility. In strict
    mode, invalid known fields are rejected instead of being normalized.
    """

    if not isinstance(value, dict):
        raise SettingsStoreError("Settings must be a JSON object")

    version = value.get("schemaVersion", SCHEMA_VERSION)
    if not isinstance(version, int) or isinstance(version, bool):
        raise SettingsStoreError("schemaVersion must be an integer")
    if version != SCHEMA_VERSION:
        raise SettingsStoreError(
            f"Unsupported settings schemaVersion {version}; expected {SCHEMA_VERSION}"
        )

    settings = copy.deepcopy(DEFAULT_SETTINGS)
    invalid: list[str] = []

    def group(name: str) -> dict[str, Any]:
        candidate = value.get(name, {})
        if isinstance(candidate, dict):
            return candidate
        invalid.append(name)
        return {}

    editor = group("editor")
    notebook = group("notebook")
    codex = group("codex")

    validators: tuple[tuple[str, dict[str, Any], str, Any], ...] = (
        ("editor.vim", editor, "vim", lambda item: isinstance(item, bool)),
        (
            "editor.codeFontSize",
            editor,
            "codeFontSize",
            lambda item: _is_number(item) and 11 <= item <= 18,
        ),
        (
            "editor.tabSize",
            editor,
            "tabSize",
            lambda item: isinstance(item, int)
            and not isinstance(item, bool)
            and 2 <= item <= 8,
        ),
        (
            "editor.lineWrapping",
            editor,
            "lineWrapping",
            lambda item: isinstance(item, bool),
        ),
        (
            "notebook.outputMaxHeight",
            notebook,
            "outputMaxHeight",
            lambda item: isinstance(item, int)
            and not isinstance(item, bool)
            and 160 <= item <= 1000,
        ),
        (
            "notebook.confirmKernelRestart",
            notebook,
            "confirmKernelRestart",
            lambda item: isinstance(item, bool),
        ),
        (
            "codex.model",
            codex,
            "model",
            lambda item: isinstance(item, str) and len(item) <= 200,
        ),
        (
            "codex.effort",
            codex,
            "effort",
            lambda item: isinstance(item, str) and item in CODEX_EFFORTS,
        ),
    )

    for path, source, key, validator in validators:
        if key not in source:
            continue
        candidate = source[key]
        if not validator(candidate):
            invalid.append(path)
            continue
        section, field = path.split(".", 1)
        settings[section][field] = candidate

    if strict and invalid:
        fields = ", ".join(invalid)
        raise SettingsStoreError(f"Invalid settings fields: {fields}")
    return settings, invalid


def _nearest_existing_parent(path: Path) -> Path:
    candidate = path
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate


class UserSettingsStore:
    """Read and atomically write the one supported settings document."""

    def __init__(self, path: Path) -> None:
        self.path = path.expanduser().resolve()
        self._lock = threading.Lock()

    @property
    def display_path(self) -> str:
        try:
            return f"~/{self.path.relative_to(Path.home().resolve())}"
        except ValueError:
            return str(self.path)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot()

    def _snapshot(self) -> dict[str, Any]:
        base: dict[str, Any] = {
            "ok": True,
            "path": str(self.path),
            "displayPath": self.display_path,
            "settings": copy.deepcopy(DEFAULT_SETTINGS),
            "ignored": [],
            "warning": None,
        }
        try:
            exists = self.path.exists()
        except OSError as error:
            return {
                **base,
                "source": "browser",
                "status": "unreadable",
                "writable": False,
                "canCreate": False,
                "warning": f"Could not inspect the settings file: {error}",
            }

        if not exists:
            parent = _nearest_existing_parent(self.path.parent)
            return {
                **base,
                "source": "browser",
                "status": "missing",
                "writable": False,
                "canCreate": parent.is_dir() and os.access(parent, os.W_OK),
            }

        try:
            raw = self.path.read_text(encoding="utf-8")
            parsed = json.loads(raw)
            settings, invalid = normalize_settings(parsed)
        except (OSError, UnicodeError, json.JSONDecodeError, SettingsStoreError) as error:
            status = "unreadable" if isinstance(error, (OSError, UnicodeError)) else "invalid"
            return {
                **base,
                "source": "browser",
                "status": status,
                "writable": False,
                "canCreate": False,
                "warning": f"The settings file was not loaded: {error}",
            }

        writable = os.access(self.path, os.W_OK)
        warning_parts: list[str] = []
        if invalid:
            warning_parts.append(f"Ignored invalid fields: {', '.join(invalid)}")
        if not writable:
            warning_parts.append("The settings file is read-only; changes last for this session.")
        return {
            **base,
            "source": "file",
            "status": "ready" if writable else "read_only",
            "writable": writable,
            "canCreate": False,
            "settings": settings,
            "ignored": invalid,
            "warning": " ".join(warning_parts) or None,
        }

    def create(self, value: object) -> dict[str, Any]:
        settings, _ = normalize_settings(value, strict=True)
        with self._lock:
            if self.path.exists():
                raise SettingsStoreError(
                    "The settings file already exists; reload it before making changes", 409
                )
            try:
                self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                self._write(settings, replace=False)
            except SettingsStoreError:
                raise
            except OSError as error:
                raise SettingsStoreError(f"Could not create the settings file: {error}") from error
            return self._snapshot()

    def update(self, value: object) -> dict[str, Any]:
        settings, _ = normalize_settings(value, strict=True)
        with self._lock:
            current = self._snapshot()
            if current["source"] != "file":
                message = (
                    "The settings file is invalid and was left unchanged"
                    if current["status"] == "invalid"
                    else "The settings file does not exist; create it explicitly first"
                )
                raise SettingsStoreError(message, 409)
            if not current["writable"]:
                raise SettingsStoreError("The settings file is read-only", 403)
            try:
                self._write(settings, replace=True)
            except OSError as error:
                raise SettingsStoreError(f"Could not update the settings file: {error}") from error
            return self._snapshot()

    def _write(self, settings: dict[str, Any], *, replace: bool) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".settings-", suffix=".tmp", dir=self.path.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(settings, handle, indent=2, ensure_ascii=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            if replace:
                os.replace(temporary, self.path)
            else:
                try:
                    os.link(temporary, self.path)
                except FileExistsError as error:
                    raise SettingsStoreError(
                        "The settings file was created by another process; reload it first", 409
                    ) from error
                temporary.unlink()
            try:
                directory = os.open(self.path.parent, os.O_RDONLY)
            except OSError:
                return
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
