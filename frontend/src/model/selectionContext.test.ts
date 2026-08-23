import { describe, expect, it } from "vitest";
import {
  MAX_QUOTED_SELECTION_CHARACTERS,
  MAX_QUOTED_SELECTION_LINES,
  selectionFromSource,
  selectionLineLabel,
  selectionPreview,
} from "./selectionContext";

describe("selected notebook context", () => {
  it("captures an immutable selection with one-based source lines", () => {
    const source = "import numpy as np\n\nvalues = np.arange(10)\nvalues.mean()";
    const from = source.indexOf("values =");
    const to = source.length;

    const selection = selectionFromSource(source, to, from);

    expect(selection).toEqual({
      text: "values = np.arange(10)\nvalues.mean()",
      startLine: 3,
      endLine: 4,
      tooLarge: false,
    });
    expect(selectionLineLabel(selection!)).toBe("Lines 3–4");
  });

  it("does not count the next line when a selection ends on its boundary", () => {
    const source = "first\nsecond";
    const selection = selectionFromSource(source, 0, source.indexOf("second"));

    expect(selection?.text).toBe("first\n");
    expect(selection?.startLine).toBe(1);
    expect(selection?.endLine).toBe(1);
    expect(selectionLineLabel(selection!)).toBe("Line 1");
  });

  it("rejects empty selections and marks oversized excerpts", () => {
    expect(selectionFromSource("alpha", 2, 2)).toBeNull();
    expect(selectionFromSource(
      "x".repeat(MAX_QUOTED_SELECTION_CHARACTERS + 1),
      0,
      MAX_QUOTED_SELECTION_CHARACTERS + 1,
    )?.tooLarge).toBe(true);
    const tooManyLines = Array.from(
      { length: MAX_QUOTED_SELECTION_LINES + 1 },
      () => "x",
    ).join("\n");
    expect(selectionFromSource(tooManyLines, 0, tooManyLines.length)?.tooLarge).toBe(true);
  });

  it("creates a compact one-line composer preview without changing the quote", () => {
    const source = "values = np.arange(10)\n    values.mean()";

    expect(selectionPreview(source)).toBe("values = np.arange(10) values.mean()");
    expect(selectionPreview(source, 18)).toBe("values = np.arang…");
    expect(source).toContain("\n    ");
  });
});
