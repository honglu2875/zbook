"""Lightweight, on-demand resource sampling for local notebook kernels."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

import psutil


@dataclass(frozen=True)
class _CpuSnapshot:
    pid: int
    cpu_seconds: float
    observed_at: float


class KernelMetricsSampler:
    """Measure a kernel process tree without running code inside the kernel."""

    def __init__(
        self,
        logical_cpu_count: int | None = None,
        snapshot_ttl_seconds: float = 600,
    ) -> None:
        self._logical_cpu_count = max(1, logical_cpu_count or psutil.cpu_count() or 1)
        self._snapshot_ttl_seconds = snapshot_ttl_seconds
        self._previous: dict[str, _CpuSnapshot] = {}
        self._lock = threading.Lock()

    def forget(self, kernel_id: str) -> None:
        with self._lock:
            self._previous.pop(kernel_id, None)

    def clear(self) -> None:
        with self._lock:
            self._previous.clear()

    def sample(self, kernel_id: str, pid: int) -> dict[str, object]:
        """Return one normalized CPU/RSS sample for a local process tree."""

        try:
            root = psutil.Process(pid)
            created_at = root.create_time()
            processes = [root, *root.children(recursive=True)]
        except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
            self.forget(kernel_id)
            return self.unavailable("The kernel process is no longer available.")

        rss_bytes = 0
        cpu_seconds = 0.0
        sampled_processes = 0
        for process in processes:
            try:
                with process.oneshot():
                    memory = process.memory_info()
                    cpu = process.cpu_times()
                rss_bytes += memory.rss
                cpu_seconds += cpu.user + cpu.system
                sampled_processes += 1
            except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
                if process.pid == pid:
                    self.forget(kernel_id)
                    return self.unavailable("The kernel process is no longer available.")

        observed_at = time.monotonic()
        cpu_percent: float | None = None
        with self._lock:
            stale_kernel_ids = [
                existing_kernel_id
                for existing_kernel_id, snapshot in self._previous.items()
                if observed_at - snapshot.observed_at > self._snapshot_ttl_seconds
            ]
            for stale_kernel_id in stale_kernel_ids:
                self._previous.pop(stale_kernel_id, None)
            previous = self._previous.get(kernel_id)
            if previous is not None and previous.pid == pid:
                elapsed = observed_at - previous.observed_at
                consumed = cpu_seconds - previous.cpu_seconds
                if elapsed > 0 and consumed >= 0:
                    cpu_percent = min(
                        100.0,
                        max(0.0, consumed / elapsed / self._logical_cpu_count * 100.0),
                    )
            self._previous[kernel_id] = _CpuSnapshot(pid, cpu_seconds, observed_at)

        return {
            "available": True,
            "reason": None,
            "pid": pid,
            "rssBytes": rss_bytes,
            "cpuPercent": round(cpu_percent, 1) if cpu_percent is not None else None,
            "uptimeSeconds": max(0, int(time.time() - created_at)),
            "processes": sampled_processes,
        }

    @staticmethod
    def unavailable(reason: str) -> dict[str, object]:
        return {
            "available": False,
            "reason": reason,
            "pid": None,
            "rssBytes": None,
            "cpuPercent": None,
            "uptimeSeconds": None,
            "processes": None,
        }
