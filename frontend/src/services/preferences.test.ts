import { describe, expect, it, vi } from "vitest";

vi.mock("./http", () => ({
  appUrl: (path: string) => new URL(path, "http://zbook.test/"),
  requestJson: vi.fn(),
}));
import {
  BROWSER_PREFERENCES_STORAGE,
  DEFAULT_USER_PREFERENCES,
  loadBrowserPreferences,
  normalizeUserPreferences,
  storeBrowserPreferences,
} from "./preferences";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("user preferences", () => {
  it("normalizes invalid fields independently", () => {
    const preferences = normalizeUserPreferences({
      editor: { vim: true, codeFontSize: 99, tabSize: 2, lineWrapping: false },
      notebook: { outputMaxHeight: 420.5, confirmKernelRestart: false },
      codex: { model: "gpt-5.6-luna", effort: "impossible" },
    });

    expect(preferences.editor).toEqual({
      vim: true,
      codeFontSize: 13.5,
      tabSize: 2,
      lineWrapping: false,
    });
    expect(preferences.notebook).toEqual({ outputMaxHeight: 280, confirmKernelRestart: false });
    expect(preferences.codex).toEqual({ model: "gpt-5.6-luna", effort: "medium" });
  });

  it("migrates the former browser keys", () => {
    const storage = new MemoryStorage();
    storage.setItem("zbook.preferences.v1", JSON.stringify({ vimEnabled: true }));
    storage.setItem("zbook.codex.model.v2", "gpt-5.6-luna");
    storage.setItem("zbook.codex.effort", "low");

    const preferences = loadBrowserPreferences(storage);

    expect(preferences.editor.vim).toBe(true);
    expect(preferences.codex).toEqual({ model: "gpt-5.6-luna", effort: "low" });
  });

  it("round trips the complete browser schema", () => {
    const storage = new MemoryStorage();
    const preferences = {
      ...DEFAULT_USER_PREFERENCES,
      editor: { ...DEFAULT_USER_PREFERENCES.editor, codeFontSize: 15 },
    };

    expect(storeBrowserPreferences(preferences, storage)).toBe(true);
    expect(storage.getItem(BROWSER_PREFERENCES_STORAGE)).not.toBeNull();
    expect(loadBrowserPreferences(storage)).toEqual(preferences);
  });
});
