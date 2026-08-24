import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_PREFERENCES,
  type PreferenceBackend,
} from "../services/preferences";
import { PreferencesPanel } from "./PreferencesPanel";

function renderPreferences(backend: PreferenceBackend, saveState: "saved" | "session" = "saved") {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <PreferencesPanel
      preferences={DEFAULT_USER_PREFERENCES}
      backend={backend}
      saveState={saveState}
      error={null}
      onChange={noop}
      onCreateFile={noop}
      onReload={noop}
      onCopyPath={noop}
      onClose={noop}
    />,
  );
}

describe("PreferencesPanel", () => {
  it("offers explicit file creation while browser storage is active", () => {
    const markup = renderPreferences({
      ok: true,
      source: "browser",
      status: "missing",
      path: "/home/example/.zbook/settings.json",
      displayPath: "~/.zbook/settings.json",
      writable: false,
      canCreate: true,
      settings: DEFAULT_USER_PREFERENCES,
      ignored: [],
      warning: null,
    });

    expect(markup).toContain("Saved in this browser");
    expect(markup).toContain("Create settings file");
    expect(markup).toContain("This device only");
  });

  it("makes read-only host settings and session-only changes explicit", () => {
    const markup = renderPreferences({
      ok: true,
      source: "file",
      status: "read_only",
      path: "/home/example/.zbook/settings.json",
      displayPath: "~/.zbook/settings.json",
      writable: false,
      canCreate: false,
      settings: DEFAULT_USER_PREFERENCES,
      ignored: [],
      warning: "The settings file is read-only; changes last for this session.",
    }, "session");

    expect(markup).toContain("Read-only settings file");
    expect(markup).toContain("Session only");
    expect(markup).toContain("changes last for this session");
  });
});
