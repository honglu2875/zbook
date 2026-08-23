import { defineConfig } from "@playwright/test";

// Some managed development hosts inject an allocator through LD_PRELOAD.
// Chromium provides its own allocator and aborts if both try to own a pointer.
delete process.env.LD_PRELOAD;

const port = Number(process.env.ZBOOK_E2E_PORT ?? "18997");
const token = "zbook-playwright-token";
const baseURL = `http://127.0.0.1:${port}/zbook/?token=${token}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    browserName: "chromium",
    channel: "chromium",
    viewport: { width: 1_440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `uv run --no-sync python ../tests/e2e_server.py --port ${port} --token ${token}`,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
