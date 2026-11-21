import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { expect } from "../editor/node_modules/@playwright/test/index.mjs";

const source = resolve(import.meta.dirname, "../../excel/charts/charts-demo.xlsx");

export async function verifySheetCharts(page, output, checks) {
  const home = page.getByRole("tab", { name: "首页", exact: true });
  const editor = page.locator(".desk-editor.is-visible");
  const fileInput = page.locator('.desk-home-main input[type="file"]');
  const button = (name) => editor.getByRole("button", { name, exact: true });
  const canvas = editor.locator('canvas[id^="univer-sheet-main-canvas_"]').first();
  const activeCell = editor.getByLabel("选中单元格", { exact: true });
  const dialog = page.getByRole("dialog", { name: "工作表图表", exact: true });
  const overlay = editor.locator(".worksheet-chart-preview");
  const title = "季度营收";
  let workbookName;
  async function upload(filename, tabName) {
    await home.click();
    await fileInput.setInputFiles(filename);
    await expect(page.getByRole("tab", { name: tabName, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(activeCell).toHaveText("A1", { timeout: 45000 });
    workbookName = tabName;
  }
  async function selectA1() {
    await canvas.click({ position: { x: 58, y: 31 } });
    await expect(activeCell).toHaveText("A1");
  }
  async function editCell(address, value) {
    await selectA1();
    await page.keyboard.press("ArrowRight");
    for (let row = 1; row < Number(address.slice(1)); row++) await page.keyboard.press("ArrowDown");
    await expect(activeCell).toHaveText(address);
    const response = page.waitForResponse(res => new URL(res.url()).pathname.endsWith("/node-patch")
      && res.request().method() === "POST");
    await editor.getByRole("textbox", { name: "单元格内容或公式", exact: true }).fill(value);
    await button("应用内容").click();
    const saved = await response;
    assert(saved.ok(), await saved.text());
  }
  async function readCharts() {
    return page.evaluate(async name => {
      const files = (await (await fetch("/workspace/api/files")).json()).files;
      const file = files.find(item => item.name === name);
      const { csrf } = await (await fetch("/workspace/api/session")).json();
      const launch = await (await fetch(`/workspace/api/files/${file.id}/editor-session`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Workspace-CSRF": csrf },
        body: JSON.stringify({ sessionId: crypto.randomUUID() }),
      })).json();
      const documents = `/v1/documents/${file.resourceDocumentId}`;
      const headers = { Authorization: `Bearer ${launch.token}` };
      const { sheetId } = await (await fetch(documents + "/sheets/0", { headers })).json();
      const response = await fetch(documents + "/sheet-charts/" + encodeURIComponent(sheetId), { headers });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }, workbookName);
  }

  await upload(source, "charts-demo.xlsx");
  await selectA1();
  await page.keyboard.press("Shift+ArrowRight");
  for (let row = 0; row < 3; row++) await page.keyboard.press("Shift+ArrowDown");
  await button("插入").click();
  await button("图表").click();
  await expect(dialog).toBeVisible();
  const newChart = dialog.getByRole("button", { name: "新建图表", exact: true });
  if (await newChart.isVisible()) await newChart.click();
  await expect(dialog.getByLabel("数据范围", { exact: true })).toHaveValue("A1:B4");
  await dialog.getByLabel("图表标题", { exact: true }).fill(title);
  await dialog.getByLabel("放置位置", { exact: true }).fill("D7");
  await dialog.getByRole("button", { name: "插入图表", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(overlay.getByRole("img", { name: title })).toBeVisible();
  const before = await overlay.locator("img").getAttribute("src");
  await editCell("B3", "=B2+15");
  await editCell("B2", "150");
  await expect.poll(async () => (await readCharts()).charts[0]?.data.series[0].values).toEqual([150, 165, 148]);
  await expect.poll(async () => {
    const image = overlay.locator("img");
    if (await image.count() !== 1) return false;
    return (await image.getAttribute("src")) !== before;
  }).toBe(true);
  await overlay.dblclick();
  await expect(dialog.getByLabel("数据范围", { exact: true })).toHaveValue("A1:B4");
  await dialog.getByLabel("图表类型", { exact: true }).selectOption("line");
  await dialog.getByRole("button", { name: "保存图表", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await readCharts()).charts[0]?.config.kind).toBe("line");
  await expect(overlay.getByRole("img", { name: title })).toBeVisible();
  await page.screenshot({ path: join(output, "xlsx-native-chart.png") });

  const exports = editor.locator(".export-control");
  await editor.locator('summary[aria-label="文件操作"]').click();
  await exports.locator("summary").click();
  await expect(exports.getByRole("combobox", { name: "导出格式", exact: true })).toHaveValue("xlsx");
  await exports.getByRole("combobox", { name: "导出方式", exact: true }).selectOption("source");
  await exports.getByRole("button", { name: "准备下载", exact: true }).click();
  const saved = join(output, "charts-native-roundtrip.xlsx");
  const download = page.waitForEvent("download");
  await exports.getByRole("link", { name: /下载 .*\.xlsx$/ }).click();
  await (await download).saveAs(saved);

  await upload(saved, "charts-native-roundtrip.xlsx");
  await expect(overlay.getByRole("img", { name: title })).toBeVisible();
  await overlay.dblclick();
  await expect(dialog.getByLabel("图表类型", { exact: true })).toHaveValue("line");
  await expect(dialog.getByLabel("放置位置", { exact: true })).toHaveValue("D7");
  await expect.poll(async () => (await readCharts()).charts[0]?.data.series[0].values).toEqual([150, 165, 148]);
  await dialog.getByRole("button", { name: "移除图表", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(overlay).toHaveCount(0);
  await expect.poll(async () => (await readCharts()).charts).toEqual([]);
  await button("开始").click();
  await button("撤销").click();
  await expect(overlay.getByRole("img", { name: title })).toBeVisible();
  checks.push("The XLSX workbench creates a native chart from the actual grid selection, reflects a changed literal and dependent formula, exports and reopens the editable chart, and supports deletion and undo.");
}
