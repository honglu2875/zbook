import { expect, test, type Page } from "@playwright/test";

async function openNotebook(page: Page, name: string) {
  await page.goto("./?token=zbook-playwright-token");
  await expect(page.getByRole("button", { name: name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: name, exact: true }).click();
  await expect(page.getByRole("tab", { name: new RegExp(name) })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".notebook-cell").first()).toBeVisible();
}

async function replaceCellSource(page: Page, cellIndex: number, source: string) {
  const editor = page.locator(".notebook-cell").nth(cellIndex).locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
}

test("opens, edits, executes, saves, and reloads a real notebook", async ({ page }) => {
  await openNotebook(page, "core.ipynb");
  await replaceCellSource(page, 0, "answer = 6 * 7\nanswer");

  await page.locator(".notebook-cell").first().getByRole("button", { name: "Run cell" }).click();
  await expect(page.locator(".notebook-cell").first().locator(".execution-count")).toHaveText("[1]");
  await expect(page.locator(".notebook-cell").first().locator(".cell-output")).toContainText("42");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".save-state")).toHaveText("Saved");
  await page.reload();
  await expect(page.locator(".notebook-cell").first().locator(".cm-content")).toContainText("answer = 6 * 7");
  await expect(page.locator(".notebook-cell").first().locator(".cell-output")).toContainText("42");
});

test("keeps multiple tabs, renames a tab, and closes it", async ({ page }) => {
  await openNotebook(page, "core.ipynb");
  await page.getByRole("button", { name: "second.ipynb", exact: true }).click();
  await expect(page.locator(".notebook-tab")).toHaveCount(2);

  const secondTab = page.locator(".notebook-tab").filter({ hasText: "second.ipynb" });
  await secondTab.dblclick();
  const rename = page.getByRole("textbox", { name: "Rename second.ipynb" });
  await rename.fill("renamed.ipynb");
  await rename.press("Enter");
  await expect(page.getByRole("tab", { name: /renamed\.ipynb/ })).toBeVisible();

  await page.getByRole("button", { name: "Close renamed.ipynb" }).click();
  await expect(page.locator(".notebook-tab")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /core\.ipynb/ })).toHaveAttribute("aria-selected", "true");

  await page.locator(".tab-add").click();
  await expect(page.getByRole("tab", { name: /Untitled\.ipynb/ })).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("navigation", { name: "File tree" })
      .getByRole("button", { name: "Untitled.ipynb", exact: true }),
  ).toBeVisible();
});

test("Shift+Enter renders markdown and advances to the next cell", async ({ page }) => {
  await openNotebook(page, "markdown.ipynb");
  const first = page.locator(".notebook-cell").first();
  const second = page.locator(".notebook-cell").nth(1);

  await first.locator(".markdown-rendered").click();
  const editor = first.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("## Updated heading");
  await page.keyboard.press("Shift+Enter");

  await expect(first.locator(".markdown-rendered")).toContainText("Updated heading");
  await expect(second).toHaveClass(/is-selected/);
});

test("does not overwrite a notebook changed externally", async ({ page, request }) => {
  await openNotebook(page, "conflict.ipynb");
  await replaceCellSource(page, 0, "local_value = 2");

  const externalNotebook = {
    cells: [{
      cell_type: "code",
      execution_count: null,
      id: "conflict-cell",
      metadata: {},
      outputs: [],
      source: ["external_value = 3"],
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
  const contentsUrl = new URL("/api/contents/conflict.ipynb", page.url());
  contentsUrl.searchParams.set("token", "zbook-playwright-token");
  const response = await request.put(contentsUrl.toString(), {
    data: { type: "notebook", format: "json", content: externalNotebook },
  });
  expect(response.ok()).toBeTruthy();

  await expect(page.locator(".save-state")).toHaveText("Changed on disk", { timeout: 10_000 });
  contentsUrl.searchParams.set("content", "1");
  contentsUrl.searchParams.set("type", "notebook");
  const disk = await request.get(contentsUrl.toString());
  expect(disk.ok()).toBeTruthy();
  const model = await disk.json();
  const source = model.content.cells[0].source;
  expect(Array.isArray(source) ? source.join("") : source).toBe("external_value = 3");
});

test("quotes selected lines into the Codex composer and can remove them", async ({ page }) => {
  await openNotebook(page, "core.ipynb");
  const editor = page.locator(".notebook-cell").first().locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");

  const quoteAction = page.getByRole("button", { name: /Ask Codex about line 1/i });
  await expect(quoteAction).toBeVisible();
  await quoteAction.click();
  await expect(page.locator(".prompt-selection-quote")).toContainText("Line 1");

  await page.getByRole("button", { name: "Remove quoted selection" }).click();
  await expect(page.locator(".prompt-selection-quote")).toHaveCount(0);
});

test("keeps both side panels usable as narrow-screen drawers", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 760 });
  await page.goto("./?token=zbook-playwright-token");

  const codexPanel = page.locator(".codex-panel");
  await expect(codexPanel).toBeVisible();
  const codexBounds = await codexPanel.boundingBox();
  expect(codexBounds).not.toBeNull();
  expect(codexBounds!.x).toBeGreaterThanOrEqual(0);
  expect(codexBounds!.x + codexBounds!.width).toBeLessThanOrEqual(561);

  await page.getByRole("button", { name: "Toggle Codex" }).click();
  await expect(codexPanel).toHaveCount(0);
  await expect(page.locator(".file-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close open side panel" })).toBeVisible();

  await page.getByRole("button", { name: "Close open side panel" }).click();
  await expect(page.locator(".file-panel")).toHaveCount(0);

  await page.getByRole("button", { name: "Toggle files" }).click();
  await expect(page.locator(".file-panel")).toBeVisible();
  await page.getByRole("button", { name: "Toggle Codex" }).click();
  await expect(page.locator(".file-panel")).toHaveCount(0);
  await expect(codexPanel).toBeVisible();
});

test("toggles a scaled image at native size with a single click", async ({ page }) => {
  await openNotebook(page, "image.ipynb");

  const imageFrame = page.locator(".output-image-frame");
  await expect(imageFrame).toBeVisible();
  await expect(imageFrame).toHaveAttribute("aria-label", /Click to view the image at 1200 × 80/);
  await expect(imageFrame).toHaveAttribute("aria-pressed", "false");

  await imageFrame.click();
  await expect(imageFrame).toHaveAttribute("aria-pressed", "true");
  await expect(imageFrame).toHaveAttribute("aria-label", "Click to fit the image to the output");
  expect(await imageFrame.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await imageFrame.click({ position: { x: 10, y: 10 } });
  await expect(imageFrame).toHaveAttribute("aria-pressed", "false");
});
