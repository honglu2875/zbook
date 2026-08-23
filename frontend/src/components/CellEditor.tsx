import { useEffect, useRef } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { getCM, vim } from "@replit/codemirror-vim";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import type { CellKind } from "../model/notebook";
import {
  selectionFromSource,
  type CellTextSelection,
} from "../model/selectionContext";
import { zbookTheme } from "../editor/theme";

export interface CellSelectionAction {
  selection: CellTextSelection;
  top: number;
}

interface CellEditorProps {
  kind: CellKind;
  source: string;
  diffOriginal?: string;
  editing: boolean;
  vimEnabled: boolean;
  readOnly: boolean;
  onChange: (source: string) => void;
  onRun: (advance: boolean, insert: boolean) => void;
  onFocus: () => void;
  onModeChange: (mode: string) => void;
  onSelectionActionChange: (action: CellSelectionAction | null) => void;
}

function currentVimMode(editor: EditorView): string {
  const state = getCM(editor)?.state.vim;
  if (state?.mode) return state.mode.toUpperCase();
  if (state?.visualMode) return "VISUAL";
  return state?.insertMode ? "INSERT" : "NORMAL";
}

export function CellEditor({
  kind,
  source,
  diffOriginal,
  editing,
  vimEnabled,
  readOnly,
  onChange,
  onRun,
  onFocus,
  onModeChange,
  onSelectionActionChange,
}: CellEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const synchronizingSource = useRef(false);
  const callbacks = useRef({ onChange, onRun, onFocus, onModeChange, onSelectionActionChange });
  callbacks.current = { onChange, onRun, onFocus, onModeChange, onSelectionActionChange };

  useEffect(() => {
    if (!host.current) return;

    const notebookKeys = EditorView.domEventHandlers({
      focus: (_event, editor) => {
        callbacks.current.onFocus();
        callbacks.current.onModeChange(vimEnabled ? currentVimMode(editor) : "INSERT");
        return false;
      },
      keydown: (event, editor) => {
        if (event.key === "Escape") {
          const vimState = vimEnabled ? getCM(editor)?.state.vim : null;
          const vimIsEditing = Boolean(
            vimState?.insertMode
            || vimState?.visualMode
            || vimState?.mode === "replace",
          );
          if (vimEnabled && vimIsEditing) return false;
          event.preventDefault();
          editor.contentDOM.blur();
          callbacks.current.onModeChange("NAV");
          return true;
        }
        if (readOnly) {
          const navigationKey = [
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "End",
            "Home",
            "PageDown",
            "PageUp",
          ].includes(event.key);
          const copyCommand = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c";
          if (navigationKey || copyCommand) return false;
          event.preventDefault();
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          callbacks.current.onRun(false, false);
          return true;
        }
        if (event.shiftKey && event.key === "Enter") {
          event.preventDefault();
          callbacks.current.onRun(true, false);
          return true;
        }
        if (event.altKey && event.key === "Enter") {
          event.preventDefault();
          callbacks.current.onRun(true, true);
          return true;
        }
        return false;
      },
    });

    const state = EditorState.create({
      doc: source,
      extensions: [
        notebookKeys,
        ...(vimEnabled && !readOnly ? [vim()] : []),
        basicSetup,
        keymap.of([indentWithTab]),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        ...(diffOriginal !== undefined ? [unifiedMergeView({
          original: diffOriginal,
          highlightChanges: true,
          gutter: true,
          syntaxHighlightDeletions: true,
          allowInlineDiffs: true,
          mergeControls: false,
          diffConfig: { scanLimit: 2_000, timeout: 100 },
        })] : []),
        ...(kind === "code" ? [python()] : kind === "markdown" ? [markdown()] : []),
        zbookTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !synchronizingSource.current) {
            callbacks.current.onChange(update.state.doc.toString());
          }
          if (
            update.selectionSet
            || update.docChanged
            || update.focusChanged
            || update.geometryChanged
          ) {
            const range = update.state.selection.main;
            const selection = update.view.hasFocus
              ? selectionFromSource(update.state.doc.toString(), range.anchor, range.head)
              : null;
            const editorBounds = host.current?.getBoundingClientRect();
            const cursorBounds = selection
              ? update.view.coordsAtPos(range.to, -1)
              : null;
            if (!selection || !editorBounds || !cursorBounds) {
              callbacks.current.onSelectionActionChange(null);
            } else {
              callbacks.current.onSelectionActionChange({
                selection,
                top: Math.max(35, cursorBounds.bottom - editorBounds.top - 9),
              });
            }
          }
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current });
    const editor = view.current;
    const cm = vimEnabled ? getCM(editor) : null;
    const handleVimModeChange = () => callbacks.current.onModeChange(currentVimMode(editor));
    cm?.on("vim-mode-change", handleVimModeChange);
    return () => {
      callbacks.current.onSelectionActionChange(null);
      cm?.off("vim-mode-change", handleVimModeChange);
      view.current?.destroy();
      view.current = null;
    };
  }, [kind, vimEnabled, readOnly, diffOriginal]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (!editing || readOnly) {
      if (editor.hasFocus) editor.contentDOM.blur();
      return;
    }
    const frame = window.requestAnimationFrame(() => view.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [editing, kind, vimEnabled, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== source) {
      synchronizingSource.current = true;
      try {
        editor.dispatch({ changes: { from: 0, to: current.length, insert: source } });
      } finally {
        synchronizingSource.current = false;
      }
    }
  }, [source]);

  return <div className="cell-editor" ref={host} />;
}
