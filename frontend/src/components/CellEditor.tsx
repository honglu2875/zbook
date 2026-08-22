import { useEffect, useRef } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import type { CellKind } from "../model/notebook";
import { zbookTheme } from "../editor/theme";

interface CellEditorProps {
  kind: CellKind;
  source: string;
  vimEnabled: boolean;
  readOnly: boolean;
  onChange: (source: string) => void;
  onRun: (advance: boolean, insert: boolean) => void;
  onModeChange: (mode: string) => void;
}

export function CellEditor({
  kind,
  source,
  vimEnabled,
  readOnly,
  onChange,
  onRun,
  onModeChange,
}: CellEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const synchronizingSource = useRef(false);
  const callbacks = useRef({ onChange, onRun, onModeChange });
  callbacks.current = { onChange, onRun, onModeChange };

  useEffect(() => {
    if (!host.current) return;

    const notebookKeys = EditorView.domEventHandlers({
      focus: () => {
        callbacks.current.onModeChange(vimEnabled ? "NORMAL" : "INSERT");
        return false;
      },
      keydown: (event) => {
        if (event.shiftKey && event.key === "Escape") {
          event.preventDefault();
          (event.currentTarget as HTMLElement).blur();
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
        if (vimEnabled && event.key === "Escape") callbacks.current.onModeChange("NORMAL");
        if (vimEnabled && !event.metaKey && !event.ctrlKey && /^[iIaAoOsScC]$/.test(event.key)) {
          callbacks.current.onModeChange("INSERT");
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
        ...(kind === "code" ? [python()] : kind === "markdown" ? [markdown()] : []),
        zbookTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !synchronizingSource.current) {
            callbacks.current.onChange(update.state.doc.toString());
          }
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, [kind, vimEnabled, readOnly]);

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
