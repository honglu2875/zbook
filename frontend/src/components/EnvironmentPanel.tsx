import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  installPackage,
  listEnvironments,
  listPackages,
  prepareKernel,
  uninstallPackage,
  type InstalledPackage,
  type KernelReadiness,
  type EnvironmentCandidate,
} from "../services/environment";
import { CloseIcon, RefreshIcon, TrashIcon } from "./icons";

interface EnvironmentPanelProps {
  venv: string;
  python: string;
  mode: string;
  kernel: KernelReadiness;
  onClose: () => void;
  onChanged: () => void;
  onSelect: (path: string) => Promise<void>;
}

export function EnvironmentPanel({
  venv,
  python,
  mode,
  kernel,
  onClose,
  onChanged,
  onSelect,
}: EnvironmentPanelProps) {
  const [packages, setPackages] = useState<InstalledPackage[]>([]);
  const [requirement, setRequirement] = useState("");
  const [filter, setFilter] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentCandidate[]>([]);
  const [selectedEnvironment, setSelectedEnvironment] = useState(venv);
  const [manualPath, setManualPath] = useState("");

  const visiblePackages = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? packages.filter((item) => item.name.toLowerCase().includes(query)) : packages;
  }, [filter, packages]);

  async function refresh() {
    setWorking("Loading packages");
    setMessage(null);
    try {
      setPackages(await listPackages());
    } catch (error) {
      setMessage(String(error));
    } finally {
      setWorking(null);
    }
  }

  async function refreshEnvironments() {
    try {
      const response = await listEnvironments();
      setEnvironments(response.candidates);
      setSelectedEnvironment(response.active);
    } catch (error) {
      setMessage(String(error));
    }
  }

  useEffect(() => {
    void refresh();
    void refreshEnvironments();
  }, []);

  async function chooseEnvironment(path: string) {
    if (!path || path === venv) return;
    setWorking("Switching environment");
    setMessage(null);
    try {
      await onSelect(path);
      setManualPath("");
      await Promise.all([refresh(), refreshEnvironments()]);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setWorking(null);
    }
  }

  async function install(event: FormEvent) {
    event.preventDefault();
    const value = requirement.trim();
    if (!value) return;
    setWorking(`Installing ${value}`);
    setMessage(null);
    try {
      const result = await installPackage(value);
      setLines(result.lines ?? []);
      setRequirement("");
      setPackages(await listPackages());
      onChanged();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setWorking(null);
    }
  }

  async function uninstall(item: InstalledPackage) {
    if (!window.confirm(`Uninstall ${item.name} from this environment?`)) return;
    setWorking(`Uninstalling ${item.name}`);
    setMessage(null);
    try {
      const result = await uninstallPackage(item.name);
      setLines(result.lines ?? []);
      setPackages((current) => current.filter((candidate) => candidate.name !== item.name));
      onChanged();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setWorking(null);
    }
  }

  async function setupKernel() {
    setWorking("Preparing the Python kernel");
    setMessage(null);
    try {
      const result = await prepareKernel();
      setLines(result.lines ?? []);
      setPackages(await listPackages());
      onChanged();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="environment-overlay" role="presentation" onMouseDown={onClose}>
      <section className="environment-panel" role="dialog" aria-modal="true" aria-label="Python environment" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>PYTHON ENVIRONMENT</span><strong>{venv.split(/[\\/]/).at(-1)}</strong></div>
          <button onClick={onClose} aria-label="Close environment panel" title="Close"><CloseIcon /></button>
        </header>
        <div className="environment-paths">
          <span>{mode === "project" ? "uv project" : "uv virtual environment"}</span>
          <code title={venv}>{venv}</code>
          <code title={python}>{python}</code>
        </div>
        <div className="environment-picker">
          <label htmlFor="environment-choice">ACTIVE ENVIRONMENT</label>
          <div>
            <select id="environment-choice" value={selectedEnvironment} onChange={(event) => setSelectedEnvironment(event.target.value)}>
              {environments.map((item) => (
                <option value={item.path} key={item.path}>{item.label}{item.temporary ? " · temporary" : ""}</option>
              ))}
            </select>
            <button onClick={() => void chooseEnvironment(selectedEnvironment)} disabled={working !== null || selectedEnvironment === venv}>Use</button>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void chooseEnvironment(manualPath.trim()); }}>
            <input value={manualPath} onChange={(event) => setManualPath(event.target.value)} placeholder="Or enter a project folder / path to a uv venv" />
            <button type="submit" disabled={working !== null || !manualPath.trim()}>Select</button>
          </form>
        </div>
        <div className={`kernel-card ${kernel.ready ? "is-ready" : ""}`}>
          <i />
          <div>
            <strong>{kernel.ready ? "Kernel ready" : "Kernel setup required"}</strong>
            <span>{kernel.ready ? `ipykernel ${kernel.version}` : kernel.error ?? "ipykernel is missing"}</span>
          </div>
          {!kernel.ready && <button onClick={() => void setupKernel()} disabled={working !== null}>Prepare</button>}
        </div>
        <form className="package-install" onSubmit={install}>
          <input
            value={requirement}
            onChange={(event) => setRequirement(event.target.value)}
            placeholder="Package or requirement, e.g. polars>=1"
            disabled={working !== null}
          />
          <button type="submit" disabled={!requirement.trim() || working !== null}>Install</button>
        </form>
        <div className="package-heading">
          <span>INSTALLED · {packages.length}</span>
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter" />
          <button onClick={() => void refresh()} disabled={working !== null} aria-label="Refresh packages" title="Refresh packages"><RefreshIcon /></button>
        </div>
        <div className="package-list">
          {visiblePackages.map((item) => (
            <div className="package-row" key={item.name}>
              <strong>{item.name}</strong><span>{item.version}</span>
              <button onClick={() => void uninstall(item)} disabled={working !== null} aria-label={`Uninstall ${item.name}`} title={`Uninstall ${item.name}`}><TrashIcon /></button>
            </div>
          ))}
          {!working && visiblePackages.length === 0 && <div className="package-empty">No matching packages</div>}
        </div>
        <footer>
          {working && <span className="environment-working"><i />{working}…</span>}
          {message && <span className="environment-error">{message}</span>}
          {lines.length > 0 && <details><summary>Last uv output</summary><pre>{lines.join("\n")}</pre></details>}
        </footer>
      </section>
    </div>
  );
}
