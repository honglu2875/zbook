import { describe, expect, it } from "vitest";
import { primaryShortcut, usesCommandKey } from "./shortcuts";

describe("platform shortcut labels", () => {
  it("recognizes Apple platforms", () => {
    expect(usesCommandKey("MacIntel")).toBe(true);
    expect(usesCommandKey("iPad")).toBe(true);
    expect(usesCommandKey("Linux x86_64")).toBe(false);
    expect(usesCommandKey("Win32")).toBe(false);
  });

  it("formats labels for the active modifier", () => {
    expect(primaryShortcut("S", { platform: "Linux x86_64" })).toBe("Ctrl+S");
    expect(primaryShortcut("P", { shift: true, platform: "Win32" })).toBe("Ctrl+Shift+P");
    expect(primaryShortcut("S", { platform: "MacIntel" })).toBe("⌘S");
    expect(primaryShortcut("P", { shift: true, platform: "MacIntel" })).toBe("⇧⌘P");
  });
});
