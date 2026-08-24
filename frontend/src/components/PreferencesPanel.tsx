import { useEffect, useRef } from "react";
import type {
  CodexEffort,
  PreferenceBackend,
  UserPreferences,
} from "../services/preferences";
import { CloseIcon, RefreshIcon } from "./icons";

export type PreferenceSaveState = "loading" | "saved" | "saving" | "error" | "session";

interface PreferencesPanelProps {
  preferences: UserPreferences;
  backend: PreferenceBackend | null;
  saveState: PreferenceSaveState;
  error: string | null;
  onChange: (preferences: UserPreferences) => void;
  onCreateFile: () => void;
  onReload: () => void;
  onCopyPath: () => void;
  onClose: () => void;
}

const EFFORTS: CodexEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

export function PreferencesPanel({
  preferences,
  backend,
  saveState,
  error,
  onChange,
  onCreateFile,
  onReload,
  onCopyPath,
  onClose,
}: PreferencesPanelProps) {
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);

  function updateEditor<Key extends keyof UserPreferences["editor"]>(
    key: Key,
    value: UserPreferences["editor"][Key],
  ) {
    onChange({ ...preferences, editor: { ...preferences.editor, [key]: value } });
  }

  function updateNotebook<Key extends keyof UserPreferences["notebook"]>(
    key: Key,
    value: UserPreferences["notebook"][Key],
  ) {
    onChange({ ...preferences, notebook: { ...preferences.notebook, [key]: value } });
  }

  function updateCodex<Key extends keyof UserPreferences["codex"]>(
    key: Key,
    value: UserPreferences["codex"][Key],
  ) {
    onChange({ ...preferences, codex: { ...preferences.codex, [key]: value } });
  }

  const fileActive = backend?.source === "file";
  const storageLabel = fileActive
    ? backend.status === "read_only"
      ? "Read-only settings file"
      : "Settings file on this Zbook host"
    : "Saved in this browser";
  const stateLabel = saveState === "loading"
    ? "Loading…"
    : saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Save failed"
        : saveState === "session"
          ? "Session only"
          : "Saved";

  return (
    <div
      className="preferences-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        className="preferences-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
        }}
      >
        <header className="preferences-header">
          <div><span>PREFERENCES</span><strong>Personalize Zbook</strong></div>
          <button type="button" onClick={onClose} aria-label="Close preferences" title="Close"><CloseIcon /></button>
        </header>

        <div className="preferences-content">
          <section className="preferences-section">
            <h2>Editor</h2>
            <label className="preference-row is-toggle">
              <span><strong>Vim bindings</strong><small>Use Vim modes inside code and raw cells.</small></span>
              <input
                type="checkbox"
                checked={preferences.editor.vim}
                onChange={(event) => updateEditor("vim", event.target.checked)}
              />
            </label>
            <label className="preference-row">
              <span><strong>Code font size</strong><small>JetBrains Mono, in pixels.</small></span>
              <input
                className="preference-number"
                type="number"
                min="11"
                max="18"
                step="0.5"
                value={preferences.editor.codeFontSize}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value >= 11 && value <= 18) updateEditor("codeFontSize", value);
                }}
              />
            </label>
            <label className="preference-row">
              <span><strong>Tab size</strong><small>Indent width for notebook editors.</small></span>
              <select
                value={preferences.editor.tabSize}
                onChange={(event) => updateEditor("tabSize", Number(event.target.value))}
              >
                {[2, 3, 4, 5, 6, 7, 8].map((size) => <option value={size} key={size}>{size} spaces</option>)}
              </select>
            </label>
            <label className="preference-row is-toggle">
              <span><strong>Wrap long lines</strong><small>Keep code within the visible cell width.</small></span>
              <input
                type="checkbox"
                checked={preferences.editor.lineWrapping}
                onChange={(event) => updateEditor("lineWrapping", event.target.checked)}
              />
            </label>
          </section>

          <section className="preferences-section">
            <h2>Notebook</h2>
            <label className="preference-row">
              <span><strong>Limited output height</strong><small>Height before a long output scrolls.</small></span>
              <div className="preference-with-unit">
                <input
                  className="preference-number"
                  type="number"
                  min="160"
                  max="1000"
                  step="20"
                  value={preferences.notebook.outputMaxHeight}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 160 && value <= 1000) updateNotebook("outputMaxHeight", value);
                  }}
                />
                <span>px</span>
              </div>
            </label>
            <label className="preference-row is-toggle">
              <span><strong>Confirm kernel restart</strong><small>Ask before clearing an active kernel.</small></span>
              <input
                type="checkbox"
                checked={preferences.notebook.confirmKernelRestart}
                onChange={(event) => updateNotebook("confirmKernelRestart", event.target.checked)}
              />
            </label>
          </section>

          <section className="preferences-section">
            <h2>Codex</h2>
            <label className="preference-row">
              <span><strong>Model override</strong><small>Leave empty to use the current Zbook default.</small></span>
              <input
                className="preference-model"
                type="text"
                value={preferences.codex.model}
                maxLength={200}
                placeholder="Default (Luna)"
                onChange={(event) => updateCodex("model", event.target.value)}
              />
            </label>
            <label className="preference-row">
              <span><strong>Reasoning effort</strong><small>Used when the selected model supports it.</small></span>
              <select
                value={preferences.codex.effort}
                onChange={(event) => updateCodex("effort", event.target.value as CodexEffort)}
              >
                {EFFORTS.map((effort) => <option value={effort} key={effort}>{effort}</option>)}
              </select>
            </label>
          </section>
        </div>

        <footer className="preferences-storage">
          {(backend?.warning || error) && (
            <p className="preferences-warning" role="status">{error ?? backend?.warning}</p>
          )}
          <div className="preferences-storage-summary">
            <span><strong>{storageLabel}</strong><small>{fileActive ? backend.displayPath : "This device only"}</small></span>
            <em className={`is-${saveState}`}>{stateLabel}</em>
          </div>
          <div className="preferences-storage-actions">
            {backend?.source === "browser" && backend.status === "missing" && (
              <button type="button" onClick={onCreateFile} disabled={!backend.canCreate || saveState === "saving"}>
                Create settings file…
              </button>
            )}
            {backend && <button type="button" onClick={onCopyPath}>Copy host path</button>}
            <button type="button" onClick={onReload} disabled={saveState === "loading" || saveState === "saving"}>
              <RefreshIcon />Reload
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
