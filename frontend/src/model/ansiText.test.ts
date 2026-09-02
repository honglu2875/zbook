import { describe, expect, it } from "vitest";
import { parseAnsiText, type AnsiTextRun } from "./ansiText";

function plainText(runs: AnsiTextRun[]): string {
  return runs.map((run) => run.text).join("");
}

function runContaining(runs: AnsiTextRun[], text: string): AnsiTextRun {
  const run = runs.find((candidate) => candidate.text.includes(text));
  if (!run) throw new Error(`No ANSI text run contains ${JSON.stringify(text)}`);
  return run;
}

describe("parseAnsiText", () => {
  it("renders the SGR forms emitted by IPython tracebacks", () => {
    const input = [
      "\x1b[0;31m---------------------------------------------------------------------------\x1b[0m",
      "\x1b[0;31mImportError\x1b[0m Traceback (most recent call last)",
      "Cell \x1b[0;32mIn[3], line 64\x1b[0m",
      "\x1b[1;32m     64\x1b[0m \x1b[38;5;66;03m# Load one day first.\x1b[39;00m",
    ].join("\n");

    const parsed = parseAnsiText(input);

    expect(parsed.hasAnsi).toBe(true);
    expect(plainText(parsed.runs)).toBe([
      "---------------------------------------------------------------------------",
      "ImportError Traceback (most recent call last)",
      "Cell In[3], line 64",
      "     64 # Load one day first.",
    ].join("\n"));
    expect(runContaining(parsed.runs, "ImportError").style.color).toBe("#d4777a");
    expect(runContaining(parsed.runs, "In[3]").style.color).toBe("#87b193");
    expect(runContaining(parsed.runs, "     64").style).toMatchObject({
      color: "#87b193",
      fontWeight: 700,
    });
    expect(runContaining(parsed.runs, "# Load").style).toMatchObject({
      color: "rgb(95, 135, 135)",
      fontStyle: "italic",
    });
  });

  it("supports standard, bright, indexed, true-color, and default colors", () => {
    const parsed = parseAnsiText(
      "\x1b[31;104mstandard\x1b[38;5;196m indexed"
      + "\x1b[48;2;12;34;56m true\x1b[39;49m default",
    );

    expect(runContaining(parsed.runs, "standard").style).toMatchObject({
      color: "#d4777a",
      backgroundColor: "#92c2df",
    });
    expect(runContaining(parsed.runs, " indexed").style.color).toBe("rgb(255, 0, 0)");
    expect(runContaining(parsed.runs, " true").style).toMatchObject({
      color: "rgb(255, 0, 0)",
      backgroundColor: "rgb(12, 34, 56)",
    });
    expect(runContaining(parsed.runs, " default").style).toEqual({});
  });

  it("darkens IPython yellow backgrounds without changing yellow foregrounds", () => {
    const parsed = parseAnsiText(
      "\x1b[30;43mouter \x1b[38;5;255mhighlighted\x1b[39;49m "
      + "\x1b[48;5;11mindexed\x1b[49m "
      + "\x1b[33mforeground\x1b[39m",
    );

    expect(runContaining(parsed.runs, "outer ").style).toMatchObject({
      color: "#596168",
      backgroundColor: "#55431f",
    });
    expect(runContaining(parsed.runs, "highlighted").style).toMatchObject({
      color: "rgb(238, 238, 238)",
      backgroundColor: "#55431f",
    });
    expect(runContaining(parsed.runs, "indexed").style).toEqual({
      backgroundColor: "#55431f",
    });
    expect(runContaining(parsed.runs, "foreground").style).toEqual({
      color: "#c6a15b",
    });
  });

  it("supports colon-form true color, inverse defaults, and independent resets", () => {
    const parsed = parseAnsiText(
      "\x1b[38:2::10:20:30;4:2;7mstyled"
      + "\x1b[24;27;39m plain",
    );

    expect(runContaining(parsed.runs, "styled").style).toMatchObject({
      color: "var(--ansi-output-background)",
      backgroundColor: "rgb(10, 20, 30)",
      textDecorationLine: "underline",
      textDecorationStyle: "double",
    });
    expect(runContaining(parsed.runs, " plain").style).toEqual({});
  });

  it("accepts the single-byte C1 form of CSI", () => {
    const parsed = parseAnsiText("\u009b1;94mC1 blue\u009b0m plain");

    expect(plainText(parsed.runs)).toBe("C1 blue plain");
    expect(runContaining(parsed.runs, "C1 blue").style).toMatchObject({
      color: "#92c2df",
      fontWeight: 700,
    });
    expect(runContaining(parsed.runs, " plain").style).toEqual({});
  });

  it("strips OSC, string controls, unsupported CSI, and unsafe C0/C1 controls", () => {
    const parsed = parseAnsiText(
      "before"
      + "\x1b]8;;https://example.invalid\x07link\x1b]8;;\x1b\\"
      + "\x1bPprivate payload\x1b\\"
      + "\x1b[?25l"
      + "\u0090more private\u009c"
      + "\u0000after\u007f",
    );

    expect(plainText(parsed.runs)).toBe("beforelinkafter");
    expect(parsed.hasAnsi).toBe(false);
  });

  it("preserves useful whitespace around malformed or cancelled controls", () => {
    const parsed = parseAnsiText(
      "first\x1b[31\nsecond\tvalue\rreplace"
      + "\x1b[32\x18last"
      + "\x1b[",
    );

    expect(plainText(parsed.runs)).toBe("first\nsecond\tvalue\rreplacelast");
    expect(parsed.hasAnsi).toBe(false);
  });

  it("treats unterminated control strings as control payload, not visible text", () => {
    const parsed = parseAnsiText("visible\x1b]0;private window title");
    expect(plainText(parsed.runs)).toBe("visible");
  });

  it("bounds pathological SGR parameters and merges adjacent equivalent runs", () => {
    const oversized = "1;".repeat(80);
    const parsed = parseAnsiText(`a\x1b[${oversized}mb\x1b[999mc`);

    expect(plainText(parsed.runs)).toBe("abc");
    expect(parsed.runs).toEqual([{ text: "abc", style: {} }]);
    expect(parsed.hasAnsi).toBe(true);
  });

  it("leaves ordinary Unicode text untouched", () => {
    const text = "λ = '␛ is a visible control-picture glyph' 🧪";
    expect(parseAnsiText(text)).toEqual({
      runs: [{ text, style: {} }],
      hasAnsi: false,
    });
  });
});
