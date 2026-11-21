import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { expect } from "../editor/node_modules/@playwright/test/index.mjs";

const source = resolve(import.meta.dirname, "../../word/pdfToWord.docx");

export async function verifyWordPictures(page, output, checks) {
  const home = page.getByRole("tab", { name: "首页", exact: true });
  const editor = page.locator(".desk-editor.is-visible");
  const frame = editor.locator(".hcd-opaque-preview iframe");
  const dialog = page.getByRole("dialog", { name: "图片版式", exact: true });
  const selector = 'img[data-hcd-drawing-id="29"][data-hcd-picture-action="true"]';
  async function upload(filename, name) {
    await home.click();
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(filename);
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(editor.locator(".tiptap").first()).toHaveAttribute("contenteditable", "true", { timeout: 45000 });
  }
  async function target() {
    let index = -1;
    await expect.poll(async () => {
      index = await frame.evaluateAll((frames, selector) => frames.findIndex(item => item.contentDocument?.querySelector(selector)), selector);
      return index;
    }, { timeout: 25000 }).toBeGreaterThanOrEqual(0);
    return frame.nth(index).contentFrame().locator(selector);
  }
  async function save(action = "应用版式") {
    const response = page.waitForResponse(result => result.request().method() === "POST"
      && new URL(result.url()).pathname.endsWith("/node-patch"));
    await dialog.getByRole("button", { name: action, exact: true }).click();
    const result = await response;
    assert(result.ok(), await result.text());
    await expect(dialog).toHaveCount(0);
  }

  await upload(source, "pdfToWord.docx");
  let image = await target();
  const before = await image.getAttribute("data-hcd-visual-hash");
  const asset = await image.getAttribute("data-hcd-asset-hash");
  assert(before && asset);
  await image.click();
  await dialog.getByLabel("文字环绕", { exact: true }).selectOption("topAndBottom");
  await dialog.getByLabel("水平位置", { exact: true }).selectOption("center");
  await dialog.getByLabel("与文字的间距（磅）", { exact: true }).fill("8");
  await dialog.getByLabel("相对段落的垂直偏移（磅）", { exact: true }).fill("0");
  await page.screenshot({ path: join(output, "word-picture-layout.png") });
  await save();
  image = await target();
  await expect(image).toHaveAttribute("data-hcd-effective-wrap", "topAndBottom");
  await expect(image).toHaveAttribute("data-hcd-docx-picture-layout", /"textDistanceEmu":101600/);
  await expect(image).toHaveAttribute("data-hcd-asset-hash", asset);
  await expect(image).not.toHaveAttribute("data-hcd-visual-hash", before);
  await image.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "word-picture-placed.png") });

  const exports = editor.locator(".export-control");
  await editor.locator('summary[aria-label="文件操作"]').click();
  await exports.locator("summary").click();
  await expect(exports.getByRole("combobox", { name: "导出格式", exact: true })).toHaveValue("docx", { timeout: 45000 });
  await exports.getByRole("combobox", { name: "导出方式", exact: true }).selectOption("source");
  await exports.getByRole("button", { name: "准备下载", exact: true }).click();
  const download = page.waitForEvent("download");
  await exports.getByRole("link", { name: /下载 .*\.docx$/ }).click();
  const reopened = join(output, "word-picture-native-roundtrip.docx");
  await (await download).saveAs(reopened);

  await upload(reopened, "word-picture-native-roundtrip.docx");
  image = await target();
  await expect(image).toHaveAttribute("data-hcd-drawing-layout", "anchor");
  await expect(image).toHaveAttribute("data-hcd-wrap", "top-and-bottom");
  await expect(image).toHaveAttribute("data-hcd-position-h-align", "center");
  await expect(image).toHaveAttribute("data-hcd-distance-left-emu", "101600");
  await expect(image).toHaveAttribute("data-hcd-asset-hash", asset);
  const reopenedHash = await image.getAttribute("data-hcd-visual-hash");
  assert(reopenedHash);
  await image.click();
  await expect(dialog.getByLabel("文字环绕", { exact: true })).toHaveValue("topAndBottom");
  await dialog.getByLabel("文字环绕", { exact: true }).selectOption("inline");
  await save();
  image = await target();
  await expect(image).toHaveAttribute("data-hcd-effective-wrap", "inline");
  await expect(image).toHaveAttribute("data-hcd-asset-hash", asset);
  await image.click();
  await save("恢复原件版式");
  image = await target();
  await expect(image).toHaveAttribute("data-hcd-effective-wrap", "topAndBottom");
  await expect(image).toHaveAttribute("data-hcd-visual-hash", reopenedHash);
  checks.push("An original DOCX drawing can be selected in Word, placed with native top-and-bottom wrapping and spacing, reopened from the download, converted to inline, and restored on its own without replacing its media.");
}
