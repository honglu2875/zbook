import ReactMarkdown from "react-markdown";
import type { NotebookCell } from "../model/notebook";
import { CellEditor } from "./CellEditor";
import { PlayIcon } from "./icons";

interface NotebookProps {
  cells: NotebookCell[];
  selectedId: string;
  editingId: string | null;
  vimEnabled: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onChange: (id: string, source: string) => void;
  onRun: (id: string, advance: boolean, insert: boolean) => void;
  onAdd: () => void;
  onModeChange: (mode: string) => void;
}

export function Notebook({
  cells,
  selectedId,
  editingId,
  vimEnabled,
  onSelect,
  onEdit,
  onChange,
  onRun,
  onAdd,
  onModeChange,
}: NotebookProps) {
  return (
    <main className="notebook-scroll">
      <div className="notebook-canvas">
        <div className="notebook-title-row">
          <div><h1>analysis</h1><span>.ipynb</span></div>
          <span className="save-state">Saved just now</span>
        </div>
        {cells.map((cell) => {
          const selected = selectedId === cell.id;
          const editing = editingId === cell.id;
          return (
            <article
              key={cell.id}
              className={`notebook-cell ${selected ? "is-selected" : ""} ${editing ? "is-editing" : ""}`}
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
                    <button className="run-button" onClick={(event) => { event.stopPropagation(); onRun(cell.id, false, false); }} aria-label="Run cell">
                      <PlayIcon />
                    </button>
                    <span className="execution-count">{cell.state === "running" ? "…" : cell.executionCount ?? " "}</span>
                  </>
                ) : <span className="markdown-mark">M</span>}
              </div>
              <div className="cell-body">
                {cell.kind === "markdown" && !editing ? (
                  <div className="markdown-rendered" onClick={() => onEdit(cell.id)}>
                    <ReactMarkdown>{cell.source}</ReactMarkdown>
                  </div>
                ) : (
                  <CellEditor
                    kind={cell.kind}
                    source={cell.source}
                    vimEnabled={vimEnabled}
                    onChange={(source) => onChange(cell.id, source)}
                    onRun={(advance, insert) => onRun(cell.id, advance, insert)}
                    onModeChange={onModeChange}
                  />
                )}
                {cell.outputs.length > 0 && (
                  <div className="cell-output">
                    {cell.outputs.map((output, index) => (
                      <pre className={output.type === "error" ? "is-error" : ""} key={`${cell.id}-${index}`}>{output.text}</pre>
                    ))}
                  </div>
                )}
              </div>
            </article>
          );
        })}
        <button className="add-cell-line" onClick={onAdd} aria-label="Add code cell"><span>+</span></button>
        <div className="notebook-spacer" />
      </div>
    </main>
  );
}
