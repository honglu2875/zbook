export interface AnsiTextStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: 700;
  fontStyle?: "italic";
  opacity?: number;
  visibility?: "hidden";
  textDecorationLine?: string;
  textDecorationStyle?: "double";
  textDecorationColor?: string;
}

export interface AnsiTextRun {
  text: string;
  style: AnsiTextStyle;
}

export interface ParsedAnsiText {
  runs: AnsiTextRun[];
  hasAnsi: boolean;
}

type UnderlineStyle = "single" | "double" | null;

interface AnsiState {
  foreground: string | null;
  background: string | null;
  underlineColor: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  inverse: boolean;
  hidden: boolean;
  strikethrough: boolean;
  overline: boolean;
}

interface CsiSequence {
  next: number;
  sgrParameters?: string;
}

const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const MAX_SGR_PARAMETER_LENGTH = 512;
const MAX_SGR_PARAMETERS = 64;

// The first 16 xterm colors are tuned for Zbook's dark output surface. The
// remaining 240 colors use the deterministic xterm color cube and grey ramp.
const BASIC_COLORS = [
  "#596168", "#d4777a", "#87b193", "#c6a15b",
  "#7aaed0", "#bd94d2", "#82b5c2", "#c7cbd0",
  "#7c858d", "#ec9093", "#9bc7a7", "#ddba72",
  "#92c2df", "#d0aae2", "#9bcbd3", "#eef0f2",
] as const;

const DEFAULT_STATE: Readonly<AnsiState> = {
  foreground: null,
  background: null,
  underlineColor: null,
  bold: false,
  dim: false,
  italic: false,
  underline: null,
  inverse: false,
  hidden: false,
  strikethrough: false,
  overline: false,
};

function resetState(state: AnsiState): void {
  Object.assign(state, DEFAULT_STATE);
}

function colorForIndex(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < BASIC_COLORS.length) return BASIC_COLORS[index];
  if (index < 232) {
    const offset = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(offset / 36)];
    const green = levels[Math.floor((offset % 36) / 6)];
    const blue = levels[offset % 6];
    return `rgb(${red}, ${green}, ${blue})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey}, ${grey}, ${grey})`;
}

function byteValue(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 255 ? parsed : null;
}

function parameterValue(value: string | undefined, emptyValue = 0): number | null {
  if (value === "" || value === undefined) return emptyValue;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function setExtendedColor(
  state: AnsiState,
  target: "foreground" | "background" | "underlineColor",
  mode: number | null,
  values: Array<string | undefined>,
): void {
  let color: string | null = null;
  if (mode === 5) {
    const index = byteValue(values[0]);
    if (index !== null) color = colorForIndex(index);
  } else if (mode === 2) {
    const channels = values.length >= 4 ? values.slice(-3) : values.slice(0, 3);
    if (channels.length === 3) {
      const [red, green, blue] = channels.map(byteValue);
      if (red !== null && green !== null && blue !== null) {
        color = `rgb(${red}, ${green}, ${blue})`;
      }
    }
  }
  if (color !== null) state[target] = color;
}

function applySimpleSgr(state: AnsiState, code: number, subparameters: string[] = []): void {
  if (code === 0) {
    resetState(state);
  } else if (code === 1) {
    state.bold = true;
  } else if (code === 2) {
    state.dim = true;
  } else if (code === 3) {
    state.italic = true;
  } else if (code === 4) {
    const variant = parameterValue(subparameters[0], 1);
    state.underline = variant === 0 ? null : variant === 2 ? "double" : "single";
  } else if (code === 7) {
    state.inverse = true;
  } else if (code === 8) {
    state.hidden = true;
  } else if (code === 9) {
    state.strikethrough = true;
  } else if (code === 21) {
    state.underline = "double";
  } else if (code === 22) {
    state.bold = false;
    state.dim = false;
  } else if (code === 23) {
    state.italic = false;
  } else if (code === 24) {
    state.underline = null;
  } else if (code === 27) {
    state.inverse = false;
  } else if (code === 28) {
    state.hidden = false;
  } else if (code === 29) {
    state.strikethrough = false;
  } else if (code >= 30 && code <= 37) {
    state.foreground = colorForIndex(code - 30);
  } else if (code === 39) {
    state.foreground = null;
  } else if (code >= 40 && code <= 47) {
    state.background = colorForIndex(code - 40);
  } else if (code === 49) {
    state.background = null;
  } else if (code === 53) {
    state.overline = true;
  } else if (code === 55) {
    state.overline = false;
  } else if (code === 59) {
    state.underlineColor = null;
  } else if (code >= 90 && code <= 97) {
    state.foreground = colorForIndex(code - 90 + 8);
  } else if (code >= 100 && code <= 107) {
    state.background = colorForIndex(code - 100 + 8);
  }
  // Blink, fonts, framing, and ideogram attributes are intentionally inert:
  // notebook output should remain legible without motion or layout surprises.
}

function applyColonSgr(state: AnsiState, parameter: string): void {
  const parts = parameter.split(":");
  const code = parameterValue(parts.shift());
  if (code === null) return;
  if (code === 38 || code === 48 || code === 58) {
    const mode = parameterValue(parts.shift());
    const target = code === 38 ? "foreground" : code === 48 ? "background" : "underlineColor";
    setExtendedColor(state, target, mode, parts);
    return;
  }
  applySimpleSgr(state, code, parts);
}

function consumeSemicolonColor(state: AnsiState, parameters: string[], index: number): number {
  const code = parameterValue(parameters[index]);
  const mode = parameterValue(parameters[index + 1]);
  const target = code === 38 ? "foreground" : code === 48 ? "background" : "underlineColor";
  if (mode === 5) {
    setExtendedColor(state, target, mode, [parameters[index + 2]]);
    return Math.min(2, parameters.length - index - 1);
  }
  if (mode === 2) {
    setExtendedColor(state, target, mode, parameters.slice(index + 2, index + 5));
    return Math.min(4, parameters.length - index - 1);
  }
  return Math.min(1, parameters.length - index - 1);
}

function applySgr(state: AnsiState, parameterText: string): boolean {
  if (
    parameterText.length > MAX_SGR_PARAMETER_LENGTH
    || !/^[\d;:]*$/.test(parameterText)
  ) return false;

  const parameters = parameterText === "" ? [""] : parameterText.split(";");
  if (parameters.length > MAX_SGR_PARAMETERS) return false;
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    if (parameter.includes(":")) {
      applyColonSgr(state, parameter);
      continue;
    }
    const code = parameterValue(parameter);
    if (code === null) continue;
    if (code === 38 || code === 48 || code === 58) {
      index += consumeSemicolonColor(state, parameters, index);
    } else {
      applySimpleSgr(state, code);
    }
  }
  return true;
}

function styleForState(state: AnsiState): AnsiTextStyle {
  const style: AnsiTextStyle = {};
  if (state.inverse) {
    style.color = state.background ?? "var(--ansi-output-background)";
    style.backgroundColor = state.foreground ?? "var(--ansi-output-foreground)";
  } else {
    if (state.foreground !== null) style.color = state.foreground;
    if (state.background !== null) style.backgroundColor = state.background;
  }
  if (state.bold) style.fontWeight = 700;
  if (state.dim) style.opacity = 0.68;
  if (state.italic) style.fontStyle = "italic";
  if (state.hidden) style.visibility = "hidden";

  const decorations: string[] = [];
  if (state.underline !== null) decorations.push("underline");
  if (state.strikethrough) decorations.push("line-through");
  if (state.overline) decorations.push("overline");
  if (decorations.length > 0) style.textDecorationLine = decorations.join(" ");
  if (state.underline === "double") style.textDecorationStyle = "double";
  if (state.underlineColor !== null) style.textDecorationColor = state.underlineColor;
  return style;
}

function stylesEqual(left: AnsiTextStyle, right: AnsiTextStyle): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right[key as keyof AnsiTextStyle] === value);
}

function appendRun(runs: AnsiTextRun[], text: string, state: AnsiState): void {
  if (!text) return;
  const style = styleForState(state);
  const previous = runs[runs.length - 1];
  if (previous && stylesEqual(previous.style, style)) {
    previous.text += text;
  } else {
    runs.push({ text, style });
  }
}

function consumeControlString(text: string, start: number, bellTerminates: boolean): number {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((bellTerminates && code === 0x07) || code === 0x18 || code === 0x1a || code === 0x9c) {
      return index + 1;
    }
    if (code === 0x1b && text[index + 1] === "\\") return index + 2;
  }
  return text.length;
}

function consumeCsi(text: string, start: number): CsiSequence {
  let parameterEnd = start;
  let inIntermediateBytes = false;
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x18 || code === 0x1a) return { next: index + 1 };
    if (code === 0x1b || code === 0x9b) return { next: index };
    if (!inIntermediateBytes && code >= 0x30 && code <= 0x3f) {
      parameterEnd = index + 1;
      continue;
    }
    if (code >= 0x20 && code <= 0x2f) {
      inIntermediateBytes = true;
      continue;
    }
    if (code >= 0x40 && code <= 0x7e) {
      return {
        next: index + 1,
        sgrParameters: !inIntermediateBytes && text[index] === "m"
          ? text.slice(start, parameterEnd)
          : undefined,
      };
    }
    // Preserve an invalid byte (notably a newline) as normal text. Everything
    // up to it was still an incomplete control sequence and remains hidden.
    return { next: index };
  }
  return { next: text.length };
}

function consumeEscape(text: string, index: number): CsiSequence {
  const next = text[index + 1];
  if (next === undefined) return { next: text.length };
  if (next === "[") return consumeCsi(text, index + 2);
  if (next === "]") return { next: consumeControlString(text, index + 2, true) };
  if (next === "P" || next === "X" || next === "^" || next === "_") {
    return { next: consumeControlString(text, index + 2, false) };
  }

  let cursor = index + 1;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code >= 0x20 && code <= 0x2f) {
      cursor += 1;
      continue;
    }
    if (code >= 0x30 && code <= 0x7e) return { next: cursor + 1 };
    if (code === 0x18 || code === 0x1a) return { next: cursor + 1 };
    return { next: cursor };
  }
  return { next: text.length };
}

function consumeC1(text: string, index: number): CsiSequence {
  const code = text.charCodeAt(index);
  if (code === 0x9b) return consumeCsi(text, index + 1);
  if (code === 0x9d) return { next: consumeControlString(text, index + 1, true) };
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return { next: consumeControlString(text, index + 1, false) };
  }
  return { next: index + 1 };
}

/**
 * Convert terminal control text into immutable, React-safe presentation runs.
 *
 * SGR attributes are interpreted; other complete ECMA-48 controls are
 * consumed. Tabs, newlines, and carriage returns are preserved. The parser is
 * linear, non-recursive, bounded when splitting SGR parameters, and never
 * creates HTML or accepts CSS values from the input.
 */
export function parseAnsiText(text: string): ParsedAnsiText {
  if (!CONTROL_CHARACTER.test(text)) {
    return { runs: text ? [{ text, style: {} }] : [], hasAnsi: false };
  }

  const state: AnsiState = { ...DEFAULT_STATE };
  const runs: AnsiTextRun[] = [];
  let hasAnsi = false;
  let segmentStart = 0;
  let index = 0;

  while (index < text.length) {
    const code = text.charCodeAt(index);
    const removableControl = (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || (code >= 0x7f && code <= 0x9f)
    );
    if (!removableControl) {
      index += 1;
      continue;
    }

    appendRun(runs, text.slice(segmentStart, index), state);
    let sequence: CsiSequence;
    if (code === 0x1b) {
      sequence = consumeEscape(text, index);
    } else if (code >= 0x80 && code <= 0x9f) {
      sequence = consumeC1(text, index);
    } else {
      sequence = { next: index + 1 };
    }
    if (sequence.sgrParameters !== undefined) {
      hasAnsi = applySgr(state, sequence.sgrParameters) || hasAnsi;
    }
    index = Math.max(sequence.next, index + 1);
    segmentStart = index;
  }

  appendRun(runs, text.slice(segmentStart), state);
  return { runs, hasAnsi };
}
