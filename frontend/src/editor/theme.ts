import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "#c7a0dc" },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: "#d7d9dc" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#83b7d7" },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: "#d6b36a" },
  { tag: [tags.definition(tags.name), tags.separator], color: "#94c0a8" },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation], color: "#e0a477" },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp], color: "#91b9c9" },
  { tag: [tags.meta, tags.comment], color: "#747b82", fontStyle: "italic" },
  { tag: [tags.string, tags.inserted], color: "#9fbd82" },
  { tag: tags.heading, color: "#d7d9dc", fontWeight: "650" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.invalid, color: "#e78284" },
]);

export const quickNotebookTheme = [
  EditorView.theme(
    {
      "&": {
        color: "#d7d9dc",
        backgroundColor: "transparent",
        fontSize: "13.5px",
      },
      ".cm-content": {
        caretColor: "#e9c77e",
        fontFamily: "var(--font-mono)",
        lineHeight: "1.65",
        padding: "13px 0 14px",
      },
      ".cm-line": { padding: "0 18px" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#e9c77e" },
      "&.cm-focused": { outline: "none" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "#34414b !important",
      },
      ".cm-activeLine": { backgroundColor: "#ffffff05" },
      ".cm-gutters": {
        display: "none",
        backgroundColor: "transparent",
        color: "#5f666d",
        border: "none",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "#2a2e31",
        border: "none",
        color: "#899097",
      },
      ".cm-tooltip": {
        backgroundColor: "#222528",
        border: "1px solid #3a3e42",
        color: "#d7d9dc",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "#343a3f",
        color: "#f0f1f2",
      },
    },
    { dark: true },
  ),
  syntaxHighlighting(highlightStyle),
];
