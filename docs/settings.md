# User settings

Zbook can keep durable personal preferences in an optional JSON file on the machine that runs the Zbook server. Use the cog in the top-right title bar or choose **Preferences** from the command palette (`Ctrl+Shift+P`; `Cmd+Shift+P` on macOS) to inspect the active storage source and create or reload the file.

The default host path is:

```text
~/.zbook/settings.json
```

This is a host path, not necessarily a path on the browser's machine. That distinction matters when Zbook is reached through SSH forwarding or is bound to a remote interface.

## Resolution and persistence

Zbook uses one durable source at a time; it never silently merges file and browser values for the same preference.

The Preferences dialog and compact controls elsewhere in Zbook share one live preference state. Changing Vim bindings from the status bar or changing model and reasoning defaults from the Codex account panel updates the same values shown in Preferences; changes made in Preferences immediately update those controls and their consumers.

1. A valid, readable settings file is authoritative.
2. If the file is missing, unreadable, malformed, or uses an unsupported schema version, Zbook uses browser-local storage.
3. If browser storage is unavailable, Zbook uses the defaults in memory for that session.

A valid read-only file remains authoritative. UI changes then last only until reload; Zbook does not create a competing browser copy. A malformed file is never automatically replaced. Fix it outside Zbook and choose **Reload**, or move it aside before explicitly creating a new file.

Zbook does not create `~/.zbook` during startup. **Create settings file** copies the current durable preferences into a new file, creates the parent directory if needed, and switches the active source to that file. Writes use a same-directory temporary file and an atomic replacement; newly created settings files use mode `0600` on platforms that support POSIX permissions.

The file location can be overridden by the server operator:

```bash
zbook run -- --ZbookApp.settings_file=/path/to/settings.json
```

## Schema version 1

A complete version 1 document looks like this:

```json
{
  "schemaVersion": 1,
  "editor": {
    "vim": false,
    "codeFontSize": 13.5,
    "tabSize": 4,
    "lineWrapping": true
  },
  "notebook": {
    "outputMaxHeight": 280,
    "confirmKernelRestart": true
  },
  "codex": {
    "model": "",
    "effort": "medium"
  }
}
```

`schemaVersion` may be omitted in a manually written file and currently defaults to `1`. Sections and individual settings may also be omitted; omitted values use the defaults below.

| Setting | Type and accepted values | Default | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | integer `1` | `1` | File-format version. An unsupported explicit version disables the file without modifying it. |
| `editor.vim` | boolean | `false` | Enable Vim modes in code and raw-cell editors. |
| `editor.codeFontSize` | number, `11`–`18` | `13.5` | CodeMirror font size in CSS pixels. |
| `editor.tabSize` | integer, `2`–`8` | `4` | Tab and indentation width. |
| `editor.lineWrapping` | boolean | `true` | Wrap long source lines within the cell editor. |
| `notebook.outputMaxHeight` | integer, `160`–`1000` | `280` | Height in CSS pixels for an output placed in limited-height mode. |
| `notebook.confirmKernelRestart` | boolean | `true` | Confirm before restarting an idle, active notebook kernel. |
| `codex.model` | string, at most 200 characters | `""` | Codex model identifier. Empty means Zbook's current default, presently Luna when available. An unavailable identifier falls back in the live model picker. |
| `codex.effort` | `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, or `"xhigh"` | `"medium"` | Preferred reasoning effort when supported by the selected model. |

Unknown fields are ignored for forward compatibility. Invalid known fields are reported in Preferences and independently replaced with their defaults; other valid fields in the file remain active. A non-object root, malformed JSON, invalid `schemaVersion`, or unsupported schema version disables the whole file and activates browser fallback.

When Zbook writes the file, it writes the complete normalized known schema. Comments and trailing commas are not valid JSON.

## What belongs elsewhere

The settings file is for portable, durable preferences. It intentionally does not contain:

- passwords, API keys, Codex login data, or other secrets;
- Codex messages or thread contents;
- workspace paths or selected Python environments;
- open tabs, selected cells, pane widths, collapse state, or other device/workspace layout;
- notebook contents or staged Codex proposals.

Those values either belong to the server/CLI configuration, the notebook itself, or browser-scoped session storage. Avoid putting secrets in unknown fields: Zbook ignores them, but the file is still ordinary host data that other software may read.

## API boundary

The Preferences UI talks to the authenticated `/zbook/api/preferences` endpoint. That endpoint can only read, create, or update the one configured settings path, and it accepts only the schema above. It is not a general filesystem API. Jupyter authentication and cross-site request protections apply in the same way as Zbook's other private APIs.
