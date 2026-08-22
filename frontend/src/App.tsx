import { useEffect, useState } from "react";
import { CodexPanel } from "./components/CodexPanel";
import { FileTree } from "./components/FileTree";
import { BranchIcon, PanelIcon, PlayIcon, PlusIcon } from "./components/icons";
import { Notebook } from "./components/Notebook";
import { initialCells, newCell, type NotebookCell } from "./model/notebook";

interface ServerStatus {
  ok: boolean;
  config: { workspace: string; venv: string; python: string; environment_mode: string };
  tools: { uv: string | null; codex: string | null };
}

export default function App() {
  const [cells, setCells] = useState<NotebookCell[]>(initialCells);
  const [selectedId, setSelectedId] = useState(initialCells[1].id);
  const [editingId, setEditingId] = useState<string | null>(initialCells[1].id);
  const [mode, setMode] = useState("NORMAL");
  const [vimEnabled, setVimEnabled] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [status, setStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    fetch("./api/status")
      .then((response) => response.ok ? response.json() as Promise<ServerStatus> : Promise.reject(response))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    function handleNavigation(event: KeyboardEvent) {
      if (mode !== "NAV") return;
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, .cm-editor")) return;
      const index = cells.findIndex((cell) => cell.id === selectedId);
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedId(cells[Math.min(index + 1, cells.length - 1)].id);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedId(cells[Math.max(index - 1, 0)].id);
      } else if (event.key === "Enter" || event.key === "i") {
        event.preventDefault();
        setEditingId(selectedId);
        setMode(vimEnabled ? "NORMAL" : "INSERT");
      } else if (event.key === "o") {
        event.preventDefault();
        insertAfter(selectedId);
      }
    }
    window.addEventListener("keydown", handleNavigation);
    return () => window.removeEventListener("keydown", handleNavigation);
  }, [cells, mode, selectedId, vimEnabled]);

  function updateCell(id: string, source: string) {
    setCells((current) => current.map((cell) => cell.id === id ? { ...cell, source } : cell));
  }

  function insertAfter(id: string) {
    const cell = newCell("code");
    setCells((current) => {
      const index = current.findIndex((item) => item.id === id);
      const next = [...current];
      next.splice(index + 1, 0, cell);
      return next;
    });
    setSelectedId(cell.id);
    setEditingId(cell.id);
  }

  function runCell(id: string, advance: boolean, insert: boolean) {
    setCells((current) => current.map((cell) => cell.id === id ? { ...cell, state: "queued" } : cell));
    window.setTimeout(() => {
      setCells((current) => current.map((cell) => cell.id === id ? {
        ...cell,
        state: "idle",
        outputs: cell.outputs.length ? cell.outputs : [
          { type: "text" as const, text: "Kernel bridge is not connected in this preview." },
        ],
      } : cell));
    }, 220);

    const index = cells.findIndex((cell) => cell.id === id);
    if (insert) {
      insertAfter(id);
    } else if (advance && index < cells.length - 1) {
      setSelectedId(cells[index + 1].id);
      setEditingId(cells[index + 1].id);
    }
  }

  return (
    <div className={`app-shell ${leftOpen ? "has-left" : ""} ${rightOpen ? "has-right" : ""}`}>
      <header className="titlebar">
        <div className="window-mark"><span /><span /><span /></div>
        <div className="brand"><i>Q</i><span>quick-notebook</span></div>
        <div className="title-actions">
          <button className={leftOpen ? "is-active" : ""} onClick={() => setLeftOpen((value) => !value)} aria-label="Toggle files"><PanelIcon /></button>
          <button className="run-all"><PlayIcon />Run all</button>
          <button className={rightOpen ? "is-active" : ""} onClick={() => setRightOpen((value) => !value)} aria-label="Toggle Codex"><PanelIcon /></button>
        </div>
      </header>
      {leftOpen && <FileTree />}
      <section className="notebook-area">
        <div className="tabbar">
          <div className="active-tab"><span className="notebook-icon">▦</span>analysis.ipynb<i /></div>
          <button aria-label="New tab"><PlusIcon /></button>
        </div>
        <Notebook
          cells={cells}
          selectedId={selectedId}
          editingId={editingId}
          vimEnabled={vimEnabled}
          onSelect={setSelectedId}
          onEdit={(id) => { setSelectedId(id); setEditingId(id); setMode(vimEnabled ? "NORMAL" : "INSERT"); }}
          onChange={updateCell}
          onRun={runCell}
          onAdd={() => insertAfter(cells.at(-1)?.id ?? selectedId)}
          onModeChange={setMode}
        />
      </section>
      {rightOpen && <CodexPanel available={status ? Boolean(status.tools.codex) : null} />}
      <footer className="statusbar">
        <div><BranchIcon />main</div>
        <button onClick={() => setVimEnabled((value) => !value)} className={vimEnabled ? "status-enabled" : ""}>
          {vimEnabled ? `VIM · ${mode}` : mode}
        </button>
        <div className="status-spacer" />
        <span>{status?.config.environment_mode === "project" ? "uv project" : "uv environment"}</span>
        <span>Python 3.12</span>
        <span>Ln 3, Col 18</span>
      </footer>
    </div>
  );
}
