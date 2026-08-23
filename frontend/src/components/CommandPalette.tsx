import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronIcon, FileIcon, NotebookIcon, SearchIcon } from "./icons";

export interface PaletteFile {
  path: string;
  type: "directory" | "file" | "notebook";
}

export interface PaletteCommand {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

interface CommandPaletteProps {
  mode: "files" | "commands";
  files: PaletteFile[];
  commands: PaletteCommand[];
  loading?: boolean;
  onOpenFile: (file: PaletteFile) => void;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  detail: string;
  shortcut?: string;
  disabled?: boolean;
  activate: () => void;
  kind: "notebook" | "file" | "command";
}

function matches(query: string, label: string, detail: string): boolean {
  if (!query) return true;
  const haystack = `${label} ${detail}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).every((part) => haystack.includes(part));
}

export function CommandPalette({
  mode,
  files,
  commands,
  loading = false,
  onOpenFile,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const source: PaletteItem[] = mode === "files"
      ? files.map((file) => ({
        id: file.path,
        label: file.path.split("/").at(-1) ?? file.path,
        detail: file.path,
        kind: file.type === "notebook" ? "notebook" : "file",
        activate: () => onOpenFile(file),
      }))
      : commands.map((command) => ({
        id: command.id,
        label: command.label,
        detail: command.detail ?? "",
        shortcut: command.shortcut,
        disabled: command.disabled,
        kind: "command",
        activate: command.run,
      }));
    return source.filter((item) => matches(query.trim(), item.label, item.detail)).slice(0, 100);
  }, [commands, files, mode, onOpenFile, query]);

  useEffect(() => setSelected(0), [query, mode]);

  function activate(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    item.activate();
    onClose();
  }

  return (
    <div className="palette-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? "Quick open" : "Command palette"}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
              'input, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
            )];
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first && last) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last && first) {
              event.preventDefault();
              first.focus();
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((value) => Math.min(value + 1, Math.max(items.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((value) => Math.max(value - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            activate(selected);
          }
        }}
      >
        <div className="palette-search">
          <SearchIcon />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode === "files" ? "Search workspace files…" : "Type a command…"}
            aria-label={mode === "files" ? "Search workspace files" : "Search commands"}
            aria-controls="palette-results"
            aria-activedescendant={items[selected] ? `palette-option-${selected}` : undefined}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-results" id="palette-results" role="listbox">
          {items.map((item, index) => (
            <button
              id={`palette-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === selected}
              className={index === selected ? "is-selected" : ""}
              key={item.id}
              disabled={item.disabled}
              onMouseEnter={() => setSelected(index)}
              onClick={() => activate(index)}
            >
              <i>{item.kind === "notebook"
                ? <NotebookIcon />
                : item.kind === "file"
                  ? <FileIcon />
                  : <ChevronIcon />}</i>
              <span><strong>{item.label}</strong>{item.detail && <em>{item.detail}</em>}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          ))}
          {!items.length && <p>{loading ? "Indexing workspace…" : "No matching results"}</p>}
        </div>
        <footer><span>↑↓ navigate</span><span>↵ open</span><em>{loading ? "Indexing…" : `${items.length} result${items.length === 1 ? "" : "s"}`}</em></footer>
      </section>
    </div>
  );
}
