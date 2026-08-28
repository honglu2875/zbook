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

test("monitors and restarts the active notebook kernel", async ({ page }) => {
  test.setTimeout(45_000);
  await openNotebook(page, "core.ipynb");
  const first = page.locator(".notebook-cell").first();
  await first.getByRole("button", { name: "Run cell" }).click();
  await expect(page.getByRole("button", { name: "Restart kernel" })).toBeVisible();

  const status = page.getByRole("button", { name: /kernel: idle/i });
  await expect(status).toBeVisible();
  await status.click();

  const monitor = page.getByRole("dialog", { name: "Active kernel monitor" });
  await expect(monitor).toBeVisible();
  await expect(monitor).toContainText("core.ipynb");
  const monitorBounds = await monitor.boundingBox();
  expect(monitorBounds).not.toBeNull();
  expect(monitorBounds!.x).toBeGreaterThanOrEqual(0);
  expect(monitorBounds!.x + monitorBounds!.width).toBeLessThanOrEqual(1_441);
  await expect(monitor.locator(".kernel-monitor-metrics section").first().locator("strong"))
    .toHaveText(/\d+ (MB|GB)/);
  await expect(monitor.locator(".kernel-sparkline.is-memory polyline")).toHaveCount(1);
  await expect(monitor.locator(".kernel-monitor-metrics section").nth(1).locator("strong"))
    .toHaveText(/^(—|\d+\.\d%)$/);
  await expect(monitor.locator(".kernel-monitor-facts")).toContainText(/PID \d+/);

  await monitor.getByRole("button", { name: "Restart" }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm kernel restart" });
  await expect(confirmation).toContainText("Variables will be cleared; notebook outputs remain");
  await confirmation.getByRole("button", { name: "Restart" }).click();
  await expect(page.locator(".notice")).toContainText("Restarted the kernel for core.ipynb");
  const idleStatus = page.getByRole("button", { name: /kernel: idle/i });
  await expect(idleStatus).toBeVisible();
  await idleStatus.click();
  await expect(monitor).toBeVisible();

  await page.setViewportSize({ width: 360, height: 760 });
  const narrowBounds = await monitor.boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds!.x).toBeGreaterThanOrEqual(0);
  expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(361);
  await page.keyboard.press("Escape");
  await expect(monitor).toHaveCount(0);
});

test("queues cells locally, cancels a suffix, and pauses after errors", async ({ page }) => {
  test.setTimeout(45_000);
  await openNotebook(page, "queue.ipynb");
  const first = page.locator(".notebook-cell").nth(0);
  const second = page.locator(".notebook-cell").nth(1);
  const third = page.locator(".notebook-cell").nth(2);

  await first.getByRole("button", { name: "Run cell" }).click();
  await expect(first).toHaveClass(/is-running/);
  await expect(first.locator(".cell-run-spinner")).toBeVisible();

  await second.getByRole("button", { name: "Run cell" }).click();
  await third.getByRole("button", { name: "Run cell" }).click();
  await expect(second).toHaveClass(/is-queued/);
  await expect(second.locator(".execution-count")).toHaveText("Q1");
  await expect(third.locator(".execution-count")).toHaveText("Q2");
  await expect(page.getByRole("button", { name: /running · cell 1 · 2 queued/i })).toBeVisible();

  await second.getByRole("button", { name: /Cancel queued cell Q1 and all later queued cells/ }).click();
  await expect(second).not.toHaveClass(/is-queued/);
  await expect(third).not.toHaveClass(/is-queued/);
  await expect(first).toHaveClass(/is-running/);
  await expect(first.locator(".cell-output")).toContainText("slow finished");

  await second.getByRole("button", { name: "Run cell" }).click();
  await third.getByRole("button", { name: "Run cell" }).click();
  await expect(third.locator(".execution-count")).toHaveText("Q1");
  await expect(second.locator(".cell-output")).toContainText("queue boom");
  await expect(page.getByRole("button", { name: /queue paused · 1/i })).toBeVisible();

  await page.getByRole("button", { name: /queue paused · 1/i }).click();
  const monitor = page.getByRole("dialog", { name: "Active kernel monitor" });
  await expect(monitor).toContainText("Execution queue");
  await monitor.getByRole("button", { name: "Resume" }).click();
  await expect(third.locator(".cell-output")).toContainText("queue resumed");
  await expect(third).not.toHaveClass(/is-queued/);

  await first.getByRole("button", { name: "Run cell" }).click();
  await second.getByRole("button", { name: "Run cell" }).click();
  await third.getByRole("button", { name: "Run cell" }).click();
  await page.getByRole("button", { name: "Restart kernel" }).click();
  const restart = page.getByRole("dialog", { name: "Confirm kernel restart" });
  await expect(restart).toContainText("The running cell will stop");
  await expect(restart).toContainText("2 queued runs will be cleared");
  await restart.getByRole("button", { name: "Restart" }).click();
  await expect(page.locator(".notice")).toContainText("Restarted the kernel for queue.ipynb");
  await expect(page.locator(".notebook-cell.is-running, .notebook-cell.is-queued")).toHaveCount(0);
});

test("renders repeated operators without programming ligatures", async ({ page }) => {
  await openNotebook(page, "core.ipynb");
  await replaceCellSource(page, 0, "left === right");

  const features = await page.locator(".notebook-cell").first().locator(".cm-content")
    .evaluate((element) => ({
      ligatures: getComputedStyle(element).fontVariantLigatures,
      features: getComputedStyle(element).fontFeatureSettings,
    }));
  expect(features.ligatures).toBe("none");
  expect(features.features).toContain('"liga" 0');
  expect(features.features).toContain('"calt" 0');
});

test("keeps multiple tabs, renames a tab, and closes it", async ({ page }) => {
  await openNotebook(page, "core.ipynb");
  const secondaryBarHeights = await page.locator(".panel-heading, .tabbar, .codex-heading")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(secondaryBarHeights).toEqual([32, 32, 32]);

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
  await page.keyboard.insertText(
    "## Updated `heading`\n\nAmbient paragraph.\n\n- First point\n- Second point",
  );
  await page.keyboard.press("Shift+Enter");

  await expect(first.locator(".markdown-rendered")).toContainText("Updated heading");
  const heading = first.locator(".markdown-rendered h2");
  const inlineCode = heading.locator("code");
  await expect(inlineCode).toHaveText("heading");
  const fontSizes = await heading.evaluate((element) => ({
    heading: Number.parseFloat(getComputedStyle(element).fontSize),
    code: Number.parseFloat(getComputedStyle(element.querySelector("code")!).fontSize),
  }));
  expect(fontSizes.code / fontSizes.heading).toBeGreaterThanOrEqual(.84);
  const typography = await first.locator(".markdown-rendered").evaluate((element) => {
    const paragraph = element.querySelector("p");
    const items = element.querySelectorAll("li");
    if (!paragraph || items.length < 2) throw new Error("Markdown list did not render");
    return {
      paragraphSize: Number.parseFloat(getComputedStyle(paragraph).fontSize),
      listSize: Number.parseFloat(getComputedStyle(items[0]).fontSize),
      listLineHeight: Number.parseFloat(getComputedStyle(items[0]).lineHeight),
      itemGap: Number.parseFloat(getComputedStyle(items[1]).marginTop),
    };
  });
  expect(typography.listSize).toBe(typography.paragraphSize);
  expect(typography.listLineHeight / typography.listSize).toBeCloseTo(1.6, 1);
  expect(typography.itemGap).toBe(3);
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

test("keeps an overflowing file tree above the environment control", async ({ page }) => {
  await page.setViewportSize({ width: 1_000, height: 260 });
  await page.goto("./?token=zbook-playwright-token");

  const tree = page.getByRole("navigation", { name: "File tree" });
  const environment = page.locator(".environment-block");
  await expect(tree).toBeVisible();
  await expect(environment).toBeVisible();

  const geometry = await page.evaluate(() => {
    const treeElement = document.querySelector<HTMLElement>(".tree");
    const environmentElement = document.querySelector<HTMLElement>(".environment-block");
    if (!treeElement || !environmentElement) throw new Error("Workspace controls are missing");
    return {
      treeBottom: treeElement.getBoundingClientRect().bottom,
      environmentTop: environmentElement.getBoundingClientRect().top,
      treeClientHeight: treeElement.clientHeight,
      treeScrollHeight: treeElement.scrollHeight,
    };
  });

  expect(geometry.treeBottom).toBeLessThanOrEqual(geometry.environmentTop);
  expect(geometry.treeScrollHeight).toBeGreaterThan(geometry.treeClientHeight);
  await tree.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("starts when randomUUID is unavailable on a plain HTTP origin", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto("./?token=zbook-playwright-token");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByText("zbook", { exact: true })).toBeVisible();
});

test("keeps notebook chrome clear at very narrow widths", async ({ page }) => {
  await openNotebook(page, "core.ipynb");
  for (const label of ["Toggle files", "Toggle Codex"]) {
    const toggle = page.getByRole("button", { name: label });
    if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
  }

  const firstCell = page.locator(".notebook-cell").first();
  await firstCell.getByRole("button", { name: "Run cell" }).click();
  await expect(firstCell.locator(".execution-count")).toHaveText("[1]");
  await page.setViewportSize({ width: 320, height: 760 });

  const geometry = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing responsive-test element: ${selector}`);
      const box = element.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left };
    };
    const scroll = document.querySelector(".notebook-scroll");
    if (!scroll) throw new Error("Missing notebook scroll container");
    return {
      title: bounds(".notebook-title"),
      actions: bounds(".notebook-document-actions"),
      count: bounds(".execution-count"),
      cellBody: bounds(".cell-body"),
      scrollWidth: scroll.scrollWidth,
      clientWidth: scroll.clientWidth,
    };
  });

  expect(geometry.title.bottom).toBeLessThanOrEqual(geometry.actions.top);
  expect(geometry.count.right).toBeLessThanOrEqual(geometry.cellBody.left);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test("toggles a scaled image at native size with a single click", async ({ page }) => {
  await openNotebook(page, "image.ipynb");

  const imageFrame = page.locator(".output-image-frame");
  await expect(imageFrame).toBeVisible();
  await expect(imageFrame).toHaveAttribute("aria-label", /Click to view the image at 1200 × 900/);
  await expect(imageFrame).toHaveAttribute("aria-pressed", "false");

  await imageFrame.click();
  await expect(imageFrame).toHaveAttribute("aria-pressed", "true");
  await expect(imageFrame).toHaveAttribute("aria-label", "Click to fit the image to the output");
  expect(await imageFrame.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await imageFrame.evaluate((element) => element.scrollHeight === element.clientHeight)).toBe(true);

  const notebookScroll = page.locator(".notebook-scroll");
  const scrollBeforeWheel = await notebookScroll.evaluate((element) => element.scrollTop);
  await imageFrame.hover({ position: { x: 20, y: 100 } });
  await page.mouse.wheel(0, 300);
  await expect.poll(() => notebookScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(scrollBeforeWheel);

  await imageFrame.click({ position: { x: 10, y: 10 } });
  await expect(imageFrame).toHaveAttribute("aria-pressed", "false");
});

test("renders a live Jupyter widget and sends interaction back to Python", async ({ page }) => {
  await openNotebook(page, "widgets.ipynb");
  const first = page.locator(".notebook-cell").first();
  const second = page.locator(".notebook-cell").nth(1);

  await first.getByRole("button", { name: "Run cell" }).click();
  const handle = first.locator(".noUi-handle").first();
  await expect(handle).toBeVisible();
  await handle.focus();
  await handle.press("ArrowRight");

  await second.getByRole("button", { name: "Run cell" }).click();
  await expect(second.locator(".cell-output")).toContainText("5");
});

test("drags a Matplotlib Slider and redraws its live figure", async ({ page }) => {
  await openNotebook(page, "matplotlib-widget.ipynb");
  const first = page.locator(".notebook-cell").first();
  const second = page.locator(".notebook-cell").nth(1);

  await page.getByRole("button", { name: "Run all" }).click();
  // ipympl layers an off-screen rendering canvas beneath its event canvas.
  // Exercise the foreground canvas that receives the user's pointer input.
  const canvas = first.locator(".jupyter-matplotlib-canvas-container canvas").last();
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect(second.locator(".cell-output")).toContainText("run-0");

  const initialBounds = await canvas.boundingBox();
  expect(initialBounds).not.toBeNull();
  await canvas.hover({
    position: {
      x: initialBounds!.width * .19,
      y: initialBounds!.height * .895,
    },
  });
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const sliderY = bounds!.y + bounds!.height * .895;
  const sliderStartX = bounds!.x + bounds!.width * .19;
  const sliderEndX = bounds!.x + bounds!.width * .64;
  await page.mouse.move(sliderStartX, sliderY);
  await page.mouse.down();
  await page.waitForTimeout(120);
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      sliderStartX + (sliderEndX - sliderStartX) * (step / 8),
      sliderY,
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  await second.getByRole("button", { name: "Run cell" }).click();
  await expect(second.locator(".cell-output")).toContainText("2");
  await expect(second.locator(".cell-output")).toContainText("Expert load — run-2, block 4");
});

test("creates and reloads durable host preferences", async ({ page, request }) => {
  await openNotebook(page, "core.ipynb");
  const preferencesButton = page.getByRole("button", { name: "Open preferences" });
  await expect(preferencesButton).toHaveAttribute("title", "Preferences");
  await preferencesButton.click();

  let dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Saved in this browser");

  const vimStatus = page.locator(".status-vim-controls > button").first();
  await dialog.getByRole("checkbox", { name: /Vim bindings/ }).check();
  await dialog.getByRole("button", { name: "Close preferences" }).click();
  await expect(vimStatus).toContainText("VIM");
  await vimStatus.click();
  await preferencesButton.click();
  dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog.getByRole("checkbox", { name: /Vim bindings/ })).not.toBeChecked();

  await dialog.getByRole("spinbutton", { name: /Code font size/ }).fill("15.5");
  await dialog.getByRole("checkbox", { name: /Wrap long lines/ }).uncheck();
  await dialog.getByRole("button", { name: /Create settings file/ }).click();
  await expect(dialog).toContainText("Settings file on this Zbook host");
  await expect(dialog.locator(".preferences-storage-summary")).toContainText("Saved");

  await dialog.getByRole("spinbutton", { name: /Limited output height/ }).fill("340");

  const preferencesUrl = new URL("/zbook/api/preferences", page.url());
  preferencesUrl.searchParams.set("token", "zbook-playwright-token");
  await expect.poll(async () => {
    const current = await request.get(preferencesUrl.toString());
    return (await current.json()).settings.notebook.outputMaxHeight;
  }).toBe(340);
  const response = await request.get(preferencesUrl.toString());
  expect(response.ok()).toBeTruthy();
  const snapshot = await response.json();
  expect(snapshot.source).toBe("file");
  expect(snapshot.settings.editor.codeFontSize).toBe(15.5);
  expect(snapshot.settings.editor.lineWrapping).toBe(false);

  await dialog.getByRole("button", { name: "Close preferences" }).click();
  await page.reload();
  await expect(page.locator(".notebook-cell").first()).toBeVisible();
  await expect.poll(() => page.locator(".cm-editor").first().evaluate(
    (element) => getComputedStyle(element).fontSize,
  )).toBe("15.5px");
  await expect.poll(() => page.locator(".cm-content").first().evaluate(
    (element) => getComputedStyle(element).whiteSpace,
  )).toBe("pre");

  await preferencesButton.click();
  dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog).toContainText("Settings file on this Zbook host");
  await expect(dialog.getByRole("spinbutton", { name: /Code font size/ })).toHaveValue("15.5");
  await expect(dialog.getByRole("spinbutton", { name: /Limited output height/ })).toHaveValue("340");
  await expect(dialog.getByRole("checkbox", { name: /Wrap long lines/ })).not.toBeChecked();
});
