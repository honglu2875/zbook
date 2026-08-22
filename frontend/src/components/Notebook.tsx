import ReactMarkdown from "react-markdown";
import type { CellKind, NotebookCell } from "../model/notebook";
import { CellEditor } from "./CellEditor";
import {
  ChevronIcon,
  CodeIcon,
  DownloadIcon,
  HeightIcon,
  LockIcon,
  OutputIcon,
  PlayIcon,
  RefreshIcon,
  SaveIcon,
  TrashIcon,
} from "./icons";

export type SaveState = "saved" | "dirty" | "saving" | "error";
export interface CellViewState {
  scrollLimited?: boolean;
  sourceCollapsed?: boolean;
  outputCollapsed?: boolean;
}
export type CellViewOption = keyof CellViewState;

interface NotebookProps {
  path: string;
  cells: NotebookCell[];
  selectedId: string;
  editingId: string | null;
  vimEnabled: boolean;
  saveState: SaveState;
  canRun: boolean;
  locked: boolean;
  lockedCellIds: string[];
  codexChangedCellIds: string[];
  codexUndoAvailable: boolean;
  cellViews: Record<string, CellViewState>;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onChange: (id: string, source: string) => void;
  onChangeKind: (id: string, kind: CellKind) => void;
  onDelete: (id: string) => void;
  onRun: (id: string, advance: boolean, insert: boolean) => void;
  onAddAfter: (id: string, kind: CellKind) => void;
  onReviewCodexChange: () => void;
  onUndoCodexChange: () => void;
  onToggleCellView: (id: string, option: CellViewOption) => void;
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
  lockedCellIds,
  codexChangedCellIds,
  codexUndoAvailable,
  cellViews,
  onSelect,
  onEdit,
  onChange,
  onChangeKind,
  onDelete,
  onRun,
  onAddAfter,
  onReviewCodexChange,
  onUndoCodexChange,
  onToggleCellView,
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
            <button onClick={onReload} disabled={saveState === "saving" || locked || lockedCellIds.length > 0} title="Reload notebook from disk"><RefreshIcon />Reload</button>
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
          const codexLocked = lockedCellIds.includes(cell.id);
          const cellLocked = locked || codexLocked;
          const view = cellViews[cell.id] ?? {};
          const sourceLineCount = cell.source
            ? cell.source.replace(/\n$/, "").split("\n").length
            : 0;
          const sourceLabel = cell.kind === "markdown" ? "Markdown" : cell.kind === "raw" ? "Raw source" : "Code";
          return (
            <div className="notebook-cell-group" key={cell.id}>
            <article
              data-cell-id={cell.id}
              className={`notebook-cell ${selected ? "is-selected" : ""} ${editing ? "is-editing" : ""} ${cellLocked ? "is-locked" : ""} ${codexLocked ? "is-codex-locked" : ""} ${changedByCodex ? "is-codex-changed" : ""} ${view.scrollLimited ? "is-scroll-limited" : ""} ${view.sourceCollapsed ? "has-collapsed-source" : ""} ${view.outputCollapsed ? "has-collapsed-output" : ""}`}
              tabIndex={0}
              onFocus={() => onSelect(cell.id)}
              onClick={() => onSelect(cell.id)}
              onDoubleClick={() => { if (!cellLocked) onEdit(cell.id); }}
              aria-label={`${cell.kind} cell${codexLocked ? ", locked by Codex" : ""}`}
            >
              <div
                className="cell-rail"
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleCellView(cell.id, "scrollLimited");
                }}
              />
              <div
                className="cell-gutter"
                title={view.scrollLimited ? "Double-click to show the full cell" : "Double-click to limit cell height and scroll"}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if ((event.target as HTMLElement).closest("button")) return;
                  event.preventDefault();
                  onToggleCellView(cell.id, "scrollLimited");
                }}
              >
                {cell.kind === "code" ? (
                  <>
                    <button
                      className="run-button"
                      disabled={cellLocked || !canRun || cell.state === "running"}
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
                {codexLocked && <span className="cell-codex-lock" title="Locked by Codex for this turn"><LockIcon /></span>}
                {view.scrollLimited && <span className="cell-scroll-state" aria-hidden="true">↕</span>}
              </div>
              <div className="cell-body">
                <div className="cell-actions" onDoubleClick={(event) => event.stopPropagation()}>
                  <button
                    className={view.scrollLimited ? "is-active" : ""}
                    disabled={locked}
                    onClick={(event) => { event.stopPropagation(); onToggleCellView(cell.id, "scrollLimited"); }}
                    aria-label={view.scrollLimited ? "Show full cell height" : "Limit cell height with scrolling"}
                    aria-pressed={Boolean(view.scrollLimited)}
                    title={view.scrollLimited ? "Show full cell height" : "Limit cell height with scrolling"}
                  ><HeightIcon /></button>
                  <button
                    className={view.sourceCollapsed ? "is-active" : ""}
                    disabled={locked}
                    onClick={(event) => { event.stopPropagation(); onToggleCellView(cell.id, "sourceCollapsed"); }}
                    aria-label={view.sourceCollapsed ? `Show ${sourceLabel.toLowerCase()}` : `Collapse ${sourceLabel.toLowerCase()}`}
                    aria-pressed={Boolean(view.sourceCollapsed)}
                    title={view.sourceCollapsed ? `Show ${sourceLabel.toLowerCase()}` : `Collapse ${sourceLabel.toLowerCase()}`}
                  ><CodeIcon /></button>
                  {cell.outputs.length > 0 && (
                    <button
                      className={view.outputCollapsed ? "is-active" : ""}
                      disabled={locked}
                      onClick={(event) => { event.stopPropagation(); onToggleCellView(cell.id, "outputCollapsed"); }}
                      aria-label={view.outputCollapsed ? "Show cell output" : "Collapse cell output"}
                      aria-pressed={Boolean(view.outputCollapsed)}
                      title={view.outputCollapsed ? "Show cell output" : "Collapse cell output"}
                    ><OutputIcon /></button>
                  )}
                  <select
                    value={cell.kind}
                    disabled={cellLocked}
                    onChange={(event) => onChangeKind(cell.id, event.target.value as CellKind)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label="Cell type"
                  >
                    <option value="code">Code</option>
                    <option value="markdown">Markdown</option>
                    <option value="raw">Raw</option>
                  </select>
                  <button className="cell-delete" disabled={cellLocked} onClick={(event) => { event.stopPropagation(); onDelete(cell.id); }} aria-label="Delete cell" title="Delete cell"><TrashIcon /></button>
                </div>
                {view.sourceCollapsed ? (
                  <button
                    type="button"
                    className="cell-collapsed-summary source-collapsed-summary"
                    onClick={(event) => { event.stopPropagation(); onToggleCellView(cell.id, "sourceCollapsed"); }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    disabled={locked}
                    title={`Show ${sourceLabel.toLowerCase()}`}
                  >
                    <CodeIcon /><strong>{sourceLabel} hidden</strong><span>{sourceLineCount} line{sourceLineCount === 1 ? "" : "s"}</span><ChevronIcon />
                  </button>
                ) : (
                  <div className="cell-source">
                    {cell.kind === "markdown" && !editing ? (
                      <div
                        className="markdown-rendered"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!cellLocked) onEdit(cell.id);
                        }}
                      >
                        <ReactMarkdown>{cell.source}</ReactMarkdown>
                      </div>
                    ) : (
                      <CellEditor
                        kind={cell.kind}
                        source={cell.source}
                        vimEnabled={vimEnabled}
                        readOnly={cellLocked}
                        onChange={(source) => onChange(cell.id, source)}
                        onRun={(advance, insert) => onRun(cell.id, advance, insert)}
                        onModeChange={(nextMode) => {
                          onModeChange(nextMode);
                          if (nextMode === "NAV") onStopEdit(cell.id);
                        }}
                      />
                    )}
                  </div>
                )}
                {cell.outputs.length > 0 && (view.outputCollapsed ? (
                  <button
                    type="button"
                    className="cell-collapsed-summary output-collapsed-summary"
                    onClick={(event) => { event.stopPropagation(); onToggleCellView(cell.id, "outputCollapsed"); }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    disabled={locked}
                    title="Show cell output"
                  >
                    <OutputIcon /><strong>Output hidden</strong><span>{cell.outputs.length} item{cell.outputs.length === 1 ? "" : "s"}</span><ChevronIcon />
                  </button>
                ) : (
                  <div className="cell-output">
                    {cell.outputs.map((output, index) => (
                      <RichOutput key={`${cell.id}-${index}`} cellId={cell.id} index={index} {...output} />
                    ))}
                  </div>
                ))}
              </div>
            </article>
            <div className="cell-insert-controls" role="group" aria-label={`Insert a cell after this ${cell.kind} cell`}>
              <button disabled={cellLocked} onClick={() => onAddAfter(cell.id, "code")}><span>+</span> Code</button>
              <button disabled={cellLocked} onClick={() => onAddAfter(cell.id, "markdown")}><span>+</span> Markdown</button>
            </div>
            </div>
          );
        })}
        <div className="notebook-spacer" />
      </div>
    </main>
  );
}
