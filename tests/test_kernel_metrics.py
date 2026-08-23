from __future__ import annotations

import os
import unittest
from unittest.mock import patch

import psutil

from zbook.kernel_metrics import KernelMetricsSampler


class KernelMetricsSamplerTests(unittest.TestCase):
    def test_samples_current_process_and_resets_cpu_baseline(self) -> None:
        sampler = KernelMetricsSampler(logical_cpu_count=1)

        first = sampler.sample("kernel-one", os.getpid())
        second = sampler.sample("kernel-one", os.getpid())

        self.assertTrue(first["available"])
        self.assertEqual(first["pid"], os.getpid())
        self.assertGreater(first["rssBytes"], 0)
        self.assertGreaterEqual(first["uptimeSeconds"], 0)
        self.assertGreaterEqual(first["processes"], 1)
        self.assertIsNone(first["cpuPercent"])
        self.assertGreaterEqual(second["cpuPercent"], 0)
        self.assertLessEqual(second["cpuPercent"], 100)

        sampler.forget("kernel-one")
        reset = sampler.sample("kernel-one", os.getpid())
        self.assertIsNone(reset["cpuPercent"])

    def test_reports_a_process_that_disappears_as_unavailable(self) -> None:
        sampler = KernelMetricsSampler()
        with patch(
            "zbook.kernel_metrics.psutil.Process",
            side_effect=psutil.NoSuchProcess(12345),
        ):
            metrics = sampler.sample("missing", 12345)

        self.assertFalse(metrics["available"])
        self.assertIn("no longer available", metrics["reason"])
        self.assertIsNone(metrics["rssBytes"])

    def test_discards_stale_cpu_baselines(self) -> None:
        sampler = KernelMetricsSampler(logical_cpu_count=1, snapshot_ttl_seconds=5)
        with patch(
            "zbook.kernel_metrics.time.monotonic",
            side_effect=[10.0, 20.0, 30.0],
        ):
            sampler.sample("stale-kernel", os.getpid())
            sampler.sample("current-kernel", os.getpid())
            restarted = sampler.sample("stale-kernel", os.getpid())

        self.assertIsNone(restarted["cpuPercent"])


if __name__ == "__main__":
    unittest.main()
