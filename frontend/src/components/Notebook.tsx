import ReactMarkdown from "react-markdown";
import type { CellKind, NotebookCell } from "../model/notebook";
import { CellEditor } from "./CellEditor";
import { DownloadIcon, PlayIcon, RefreshIcon, SaveIcon, TrashIcon } from "./icons";

export type SaveState = "saved" | "dirty" | "saving" | "error";

interface NotebookProps {
  path: string;
  cells: NotebookCell[];
  selectedId: string;
  editingId: string | null;
  vimEnabled: boolean;
  saveState: SaveState;
  canRun: boolean;
  locked: boolean;
  codexChangedCellIds: string[];
  codexUndoAvailable: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onChange: (id: string, source: string) => void;
  onChangeKind: (id: string, kind: CellKind) => void;
  onDelete: (id: string) => void;
  onRun: (id: string, advance: boolean, insert: boolean) => void;
  onAddAfter: (id: string, kind: CellKind) => void;
  onReviewCodexChange: () => void;
  onUndoCodexChange: () => void;
  onSave: () => void;
  onExport: () => void;
  onReload: () => void;
  onModeChange: (mode: string) => void;
  onStopEdit: (id: string) => void;
}

function RichOutput({ cellId, index, type, text, data }: {
  cellId: string;
  index: number;
  type: "text" | "error" | "html" | "image";
  text: string;
  data?: string;
}) {
  if (type === "image" && data) {
    return <img className="output-image" src={`data:image/png;base64,${data}`} alt={text || "Cell output"} />;
  }
  if (type === "html" && data) {
    return (
      <iframe
        className="output-html"
        key={`${cellId}-${index}`}
        sandbox=""
        srcDoc={`<!doctype html><style>body{margin:0;color:#aeb3b7;background:transparent;font:13px system-ui}pre{white-space:pre-wrap}</style>${data}`}
        title={`Rich output ${index + 1}`}
      />
    );
  }
  return <pre className={type === "error" ? "is-error" : ""}>{text}</pre>;
}

export function Notebook({
  path,
  cells,
  selectedId,
  editingId,
  vimEnabled,
  saveState,
  canRun,
  locked,
  codexChangedCellIds,
  codexUndoAvailable,
  onSelect,
  onEdit,
  onChange,
  onChangeKind,
  onDelete,
  onRun,
  onAddAfter,
  onReviewCodexChange,
  onUndoCodexChange,
  onSave,
  onExport,
  onReload,
  onModeChange,
  onStopEdit,
}: NotebookProps) {
  const filename = path.split("/").at(-1) ?? path;
  const title = filename.endsWith(".ipynb") ? filename.slice(0, -6) : filename;
  const saveLabel = {
    saved: "Saved",
    dirty: "Unsaved changes",
    saving: "Saving…",
    error: "Save failed",
  }[saveState];

  return (
    <main className="notebook-scroll" aria-busy={locked}>
      <div className="notebook-canvas">
        <div className="notebook-title-row">
          <div className="notebook-title"><h1>{title}</h1><span>.ipynb</span></div>
          <div className="notebook-document-actions">
            <span className={`save-state save-${saveState}`}>{saveLabel}</span>
            <button onClick={onSave} disabled={saveState === "saving" || locked} title="Save notebook (Ctrl/Cmd-S)"><SaveIcon />Save</button>
            <button onClick={onReload} disabled={saveState === "saving" || locked} title="Reload notebook from disk"><RefreshIcon />Reload</button>
            <button onClick={onExport} title="Export .ipynb"><DownloadIcon />Export</button>
          </div>
        </div>
        {codexChangedCellIds.length > 0 && (
          <section className="codex-edit-review" aria-live="polite">
            <div><span>✦</span><strong>Codex changed {codexChangedCellIds.length} cell{codexChangedCellIds.length === 1 ? "" : "s"}</strong></div>
            <div>
              <button type="button" onClick={onReviewCodexChange}>Review</button>
              <button type="button" onClick={onUndoCodexChange} disabled={!codexUndoAvailable}>Undo</button>
            </div>
          </section>
        )}
        {cells.map((cell) => {
          const selected = selectedId === cell.id;
          const editing = editingId === cell.id;
          const changedByCodex = codexChangedCellIds.includes(cell.id);
          return (
            <div className="notebook-cell-group" key={cell.id}>
            <article
              data-cell-id={cell.id}
              className={`notebook-cell ${selected ? "is-selected" : ""} ${editing ? "is-editing" : ""} ${locked ? "is-locked" : ""} ${changedByCodex ? "is-codex-changed" : ""}`}
              tabIndex={0}
              onFocus={() => onSelect(cell.id)}
              onClick={() => onSelect(cell.id)}
              onDoubleClick={() => onEdit(cell.id)}
              aria-label={`${cell.kind} cell`}
            >
              <div className="cell-rail" />
              <div className="cell-gutter">
                {cell.kind === "code" ? (
                  <>
                    <button
                      className="run-button"
                      disabled={locked || !canRun || cell.state === "running"}
                      onClick={(event) => { event.stopPropagation(); onRun(cell.id, false, false); }}
                      aria-label="Run cell"
                      title={canRun ? "Run cell" : "Prepare the Python kernel from the environment panel"}
                    >
                      <PlayIcon />
                    </button>
                    <span className="execution-count">
                      {cell.state === "running" ? "[…]" : cell.executionCount === null ? "[ ]" : `[${cell.executionCount}]`}
                    </span>
                  </>
                ) : <span className="markdown-mark">{cell.kind === "markdown" ? "M" : "R"}</span>}
              </div>
              <div className="cell-body">
                <div className="cell-actions">
                  <select
                    value={cell.kind}
                    disabled={locked}
                    onChange={(event) => onChangeKind(cell.id, event.target.value as CellKind)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label="Cell type"
                  >
                    <option value="code">Code</option>
                    <option value="markdown">Markdown</option>
                    <option value="raw">Raw</option>
                  </select>
                  <button disabled={locked} onClick={(event) => { event.stopPropagation(); onDelete(cell.id); }} aria-label="Delete cell" title="Delete cell"><TrashIcon /></button>
                </div>
                {cell.kind === "markdown" && !editing ? (
                  <div className="markdown-rendered" onClick={() => onEdit(cell.id)}>
                    <ReactMarkdown>{cell.source}</ReactMarkdown>
                  </div>
                ) : (
                  <CellEditor
                    kind={cell.kind}
                    source={cell.source}
                    vimEnabled={vimEnabled}
                    readOnly={locked}
                    onChange={(source) => onChange(cell.id, source)}
                    onRun={(advance, insert) => onRun(cell.id, advance, insert)}
                    onModeChange={(nextMode) => {
                      onModeChange(nextMode);
                      if (nextMode === "NAV") onStopEdit(cell.id);
                    }}
                  />
                )}
                {cell.outputs.length > 0 && (
                  <div className="cell-output">
                    {cell.outputs.map((output, index) => (
                      <RichOutput key={`${cell.id}-${index}`} cellId={cell.id} index={index} {...output} />
                    ))}
                  </div>
                )}
              </div>
            </article>
            <div className="cell-insert-controls" role="group" aria-label={`Insert a cell after this ${cell.kind} cell`}>
              <button disabled={locked} onClick={() => onAddAfter(cell.id, "code")}><span>+</span> Code</button>
              <button disabled={locked} onClick={() => onAddAfter(cell.id, "markdown")}><span>+</span> Markdown</button>
            </div>
            </div>
          );
        })}
        <div className="notebook-spacer" />
      </div>
    </main>
  );
}
