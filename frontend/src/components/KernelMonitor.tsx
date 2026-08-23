import { useEffect, useMemo, useState } from "react";
import type { KernelMetrics, KernelState } from "../services/kernel";
import { CloseIcon, RefreshIcon, StopIcon } from "./icons";

const SAMPLE_INTERVAL_MS = 2_000;
const HISTORY_LIMIT = 45;

interface MetricHistory {
  pid: number | null;
  memory: number[];
  cpu: number[];
}

interface KernelMonitorProps {
  state: KernelState;
  notebookName: string;
  environmentName: string;
  restartDisabled: boolean;
  onSample: () => Promise<KernelMetrics | null>;
  onInterrupt: () => Promise<void>;
  onRestart: () => Promise<void>;
  onClose: () => void;
}

function appendSample(values: number[], value: number | null): number[] {
  if (value === null || !Number.isFinite(value)) return values;
  return [...values, value].slice(-HISTORY_LIMIT);
}

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  const mib = value / 1024 / 1024;
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GB` : `${Math.round(mib)} MB`;
}

function formatUptime(value: number | null): string {
  if (value === null) return "—";
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function sparklinePoints(values: number[], fixedRange?: [number, number]): string {
  if (!values.length) return "";
  const width = 112;
  const height = 30;
  let lower = fixedRange?.[0] ?? Math.min(...values);
  let upper = fixedRange?.[1] ?? Math.max(...values);
  if (!fixedRange) {
    const span = upper - lower;
    const padding = span > 0 ? span * .25 : Math.max(1, upper * .08);
    lower = Math.max(0, lower - padding);
    upper += padding;
  }
  if (upper <= lower) upper = lower + 1;
  return values.map((value, index) => {
    const x = values.length === 1 ? width : index / (values.length - 1) * width;
    const y = height - (value - lower) / (upper - lower) * height;
    return `${x.toFixed(1)},${Math.min(height, Math.max(0, y)).toFixed(1)}`;
  }).join(" ");
}

function Sparkline({ values, kind }: { values: number[]; kind: "memory" | "cpu" }) {
  const points = useMemo(
    () => sparklinePoints(values, kind === "cpu" ? [0, 100] : undefined),
    [kind, values],
  );
  return (
    <svg className={`kernel-sparkline is-${kind}`} viewBox="0 0 112 30" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 29.5H112" />
      {points && <polyline points={points} />}
    </svg>
  );
}

export function KernelMonitor({
  state,
  notebookName,
  environmentName,
  restartDisabled,
  onSample,
  onInterrupt,
  onRestart,
  onClose,
}: KernelMonitorProps) {
  const [metrics, setMetrics] = useState<KernelMetrics | null>(null);
  const [history, setHistory] = useState<MetricHistory>({ pid: null, memory: [], cpu: [] });
  const [problem, setProblem] = useState<string | null>(null);
  const [action, setAction] = useState<"interrupt" | "restart" | null>(null);

  useEffect(() => {
    let active = true;
    let timer = 0;
    async function sample() {
      try {
        const next = await onSample();
        if (!active) return;
        setMetrics(next);
        setProblem(null);
        if (next?.available && next.pid !== null) {
          setHistory((current) => {
            const previous = current.pid === next.pid
              ? current
              : { pid: next.pid, memory: [], cpu: [] };
            return {
              pid: next.pid,
              memory: appendSample(previous.memory, next.rssBytes),
              cpu: appendSample(previous.cpu, next.cpuPercent),
            };
          });
        }
      } catch (error) {
        if (active) setProblem(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) timer = window.setTimeout(() => void sample(), SAMPLE_INTERVAL_MS);
      }
    }
    void sample();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [onSample]);

  async function runAction(kind: "interrupt" | "restart", operation: () => Promise<void>) {
    setAction(kind);
    try {
      await operation();
    } finally {
      setAction(null);
    }
  }

  const canInterrupt = state === "busy" && action === null;
  const startLabel = state === "disconnected" || state === "dead" || state === "error";
  const detail = problem ?? metrics?.reason;

  return (
    <section className="kernel-monitor" role="dialog" aria-label="Active kernel monitor">
      <header>
        <div>
          <i className={`kernel-state-dot is-${state}`} aria-hidden="true" />
          <span><strong>Active kernel</strong><em>{state}</em></span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close kernel monitor"><CloseIcon /></button>
      </header>
      <div className="kernel-monitor-context">
        <strong title={notebookName}>{notebookName}</strong>
        <span title={environmentName}>{environmentName}</span>
      </div>
      <div className="kernel-monitor-metrics">
        <section>
          <header><span>Memory</span><strong>{formatBytes(metrics?.rssBytes ?? null)}</strong></header>
          <Sparkline values={history.memory} kind="memory" />
        </section>
        <section>
          <header><span>CPU</span><strong>{metrics?.cpuPercent === null || metrics?.cpuPercent === undefined ? "—" : `${metrics.cpuPercent.toFixed(1)}%`}</strong></header>
          <Sparkline values={history.cpu} kind="cpu" />
        </section>
      </div>
      {metrics?.available ? (
        <div className="kernel-monitor-facts">
          <span>up {formatUptime(metrics.uptimeSeconds)}</span>
          <span>PID {metrics.pid}</span>
          <span>{metrics.processes} {metrics.processes === 1 ? "process" : "processes"}</span>
        </div>
      ) : (
        <p className={detail ? "is-error" : ""}>{detail ?? (state === "disconnected" ? "Start the kernel to collect resource history." : "Waiting for the first sample…")}</p>
      )}
      <footer>
        <span>90 s · sampled while open</span>
        <div>
          {state === "busy" && (
            <button
              type="button"
              className="kernel-interrupt"
              disabled={!canInterrupt}
              onClick={() => void runAction("interrupt", onInterrupt)}
            ><StopIcon />{action === "interrupt" ? "Stopping…" : "Interrupt"}</button>
          )}
          <button
            type="button"
            disabled={restartDisabled || state === "busy" || state === "starting" || action !== null}
            onClick={() => void runAction("restart", onRestart)}
          ><RefreshIcon />{action === "restart" ? "Working…" : startLabel ? "Start" : "Restart"}</button>
        </div>
      </footer>
    </section>
  );
}
