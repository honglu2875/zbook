import { appUrl, requestJson } from "./http";

export type CodexEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface UserPreferences {
  schemaVersion: 1;
  editor: {
    vim: boolean;
    codeFontSize: number;
    tabSize: number;
    lineWrapping: boolean;
  };
  notebook: {
    outputMaxHeight: number;
    confirmKernelRestart: boolean;
  };
  codex: {
    model: string;
    effort: CodexEffort;
  };
}

export type PreferenceSource = "file" | "browser";
export type PreferenceStatus = "ready" | "missing" | "invalid" | "unreadable" | "read_only";

export interface PreferenceBackend {
  ok: true;
  source: PreferenceSource;
  status: PreferenceStatus;
  path: string;
  displayPath: string;
  writable: boolean;
  canCreate: boolean;
  settings: UserPreferences;
  ignored: string[];
  warning: string | null;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  schemaVersion: 1,
  editor: {
    vim: false,
    codeFontSize: 13.5,
    tabSize: 4,
    lineWrapping: true,
  },
  notebook: {
    outputMaxHeight: 280,
    confirmKernelRestart: true,
  },
  codex: {
    model: "",
    effort: "medium",
  },
};

export const BROWSER_PREFERENCES_STORAGE = "zbook.preferences.v2";
const LEGACY_PREFERENCES_STORAGE = "zbook.preferences.v1";
const LEGACY_MODEL_STORAGE = "zbook.codex.model.v2";
const LEGACY_EFFORT_STORAGE = "zbook.codex.effort";
const CODEX_EFFORTS = new Set<CodexEffort>(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function isCodexEffort(value: string): value is CodexEffort {
  return CODEX_EFFORTS.has(value as CodexEffort);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberInRange(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

export function normalizeUserPreferences(value: unknown): UserPreferences {
  const root = record(value);
  const editor = record(root.editor);
  const notebook = record(root.notebook);
  const codex = record(root.codex);
  const codeFontSize = numberInRange(editor.codeFontSize, 11, 18);
  const tabSize = numberInRange(editor.tabSize, 2, 8);
  const outputMaxHeight = numberInRange(notebook.outputMaxHeight, 160, 1000);
  const effort = typeof codex.effort === "string" && isCodexEffort(codex.effort)
    ? codex.effort as CodexEffort
    : DEFAULT_USER_PREFERENCES.codex.effort;
  return {
    schemaVersion: 1,
    editor: {
      vim: typeof editor.vim === "boolean" ? editor.vim : DEFAULT_USER_PREFERENCES.editor.vim,
      codeFontSize: codeFontSize ?? DEFAULT_USER_PREFERENCES.editor.codeFontSize,
      tabSize: tabSize !== null && Number.isInteger(tabSize)
        ? tabSize
        : DEFAULT_USER_PREFERENCES.editor.tabSize,
      lineWrapping: typeof editor.lineWrapping === "boolean"
        ? editor.lineWrapping
        : DEFAULT_USER_PREFERENCES.editor.lineWrapping,
    },
    notebook: {
      outputMaxHeight: outputMaxHeight !== null && Number.isInteger(outputMaxHeight)
        ? outputMaxHeight
        : DEFAULT_USER_PREFERENCES.notebook.outputMaxHeight,
      confirmKernelRestart: typeof notebook.confirmKernelRestart === "boolean"
        ? notebook.confirmKernelRestart
        : DEFAULT_USER_PREFERENCES.notebook.confirmKernelRestart,
    },
    codex: {
      model: typeof codex.model === "string" && codex.model.length <= 200
        ? codex.model
        : DEFAULT_USER_PREFERENCES.codex.model,
      effort,
    },
  };
}

function parsedStorage(storage: Storage, key: string): unknown {
  const raw = storage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

export function hasBrowserPreferenceRecord(storage: Storage = window.localStorage): boolean {
  try {
    return storage.getItem(BROWSER_PREFERENCES_STORAGE) !== null
      || storage.getItem(LEGACY_PREFERENCES_STORAGE) !== null;
  } catch {
    return false;
  }
}

export function loadBrowserPreferences(storage: Storage = window.localStorage): UserPreferences {
  try {
    const current = parsedStorage(storage, BROWSER_PREFERENCES_STORAGE);
    if (current !== null) return normalizeUserPreferences(current);

    const legacy = record(parsedStorage(storage, LEGACY_PREFERENCES_STORAGE));
    const model = storage.getItem(LEGACY_MODEL_STORAGE);
    const effort = storage.getItem(LEGACY_EFFORT_STORAGE);
    return normalizeUserPreferences({
      editor: { vim: legacy.vimEnabled },
      codex: { model: model ?? undefined, effort: effort ?? undefined },
    });
  } catch {
    return normalizeUserPreferences(null);
  }
}

export function storeBrowserPreferences(
  preferences: UserPreferences,
  storage: Storage = window.localStorage,
): boolean {
  try {
    storage.setItem(BROWSER_PREFERENCES_STORAGE, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

function normalizeBackend(backend: PreferenceBackend): PreferenceBackend {
  return { ...backend, settings: normalizeUserPreferences(backend.settings) };
}

export async function fetchPreferenceBackend(): Promise<PreferenceBackend> {
  return normalizeBackend(await requestJson<PreferenceBackend>(
    appUrl("api/preferences"),
    { cache: "no-store" },
  ));
}

async function writePreferenceBackend(
  method: "POST" | "PUT",
  settings: UserPreferences,
): Promise<PreferenceBackend> {
  const backend = await requestJson<PreferenceBackend>(appUrl("api/preferences"), {
    method,
    body: JSON.stringify({ settings }),
  });
  return normalizeBackend(backend);
}

export function createSettingsFile(settings: UserPreferences): Promise<PreferenceBackend> {
  return writePreferenceBackend("POST", settings);
}

export function updateSettingsFile(settings: UserPreferences): Promise<PreferenceBackend> {
  return writePreferenceBackend("PUT", settings);
}
