import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { expect } from "../editor/node_modules/@playwright/test/index.mjs";

const source = resolve(import.meta.dirname, "../../ppt/pictures/pictures-basic.pptx");
const picture = resolve(import.meta.dirname, "../../../assets/showcase/project-proposal.png");
const notesChart = resolve(import.meta.dirname, "fixtures/notes-chart.pptx");

export async function verifySlideObjects(page, output, checks, { notesOnly = false } = {}) {
  const home = page.getByRole("tab", { name: "首页", exact: true });
  const editor = page.locator(".desk-editor.is-visible");
  const button = (name) => editor.getByRole("button", { name, exact: true });
  const ribbon = editor.getByRole("navigation", { name: "编辑工具栏", exact: true });
  const fileInput = page.locator('.desk-home-main input[type="file"]');
  const pageFrame = (n) => editor.locator(".fixed-page").nth(n).frameLocator("iframe");
  const onSlide = (n, selector) => pageFrame(n).locator(selector);
  async function upload(filename, tabName) {
    await home.click();
    await fileInput.setInputFiles(filename);
    await expect(page.getByRole("tab", { name: tabName, exact: true })).toHaveAttribute("aria-selected", "true");
  }
  async function command(name) {
    const action = button(name);
    if (!(await action.isVisible())) {
      const more = button("展开功能区");
      if (await more.isVisible()) await more.click();
    }
    await action.click();
  }
  async function drag(name, x, y) {
    const handle = button(name);
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    assert(box);
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + x, start.y + y, { steps: 9 });
    await page.mouse.up();
  }
  async function pick(node, additional = false, position) {
    const id = await node.getAttribute("data-hcd-id");
    assert(id);
    const target = editor.locator(`[data-pptx-object="${id}"]`);
    await target.click({ modifiers: additional ? ["Shift"] : [], position });
    await expect(target).toHaveAttribute("aria-pressed", "true");
  }
  async function downloadNative(name) {
    const menu = editor.locator('summary[aria-label="文件操作"]');
    const exports = editor.locator(".export-control");
    if (!(await menu.evaluate(node => node.parentElement.open))) await menu.click();
    if (!(await exports.evaluate(node => node.open))) await exports.locator("summary").click();
    await expect(exports.getByRole("combobox", { name: "导出格式", exact: true })).toHaveValue("pptx");
    await exports.getByRole("combobox", { name: "导出方式", exact: true }).selectOption("source");
    await exports.getByRole("button", { name: "准备下载", exact: true }).click();
    const pending = page.waitForEvent("download");
    await exports.getByRole("link", { name: /下载 .*\.pptx$/ }).click();
    const saved = join(output, name);
    await (await pending).saveAs(saved);
    await menu.click();
    return saved;
  }

  if (!notesOnly) {
  await upload(source, "pictures-basic.pptx");
  const original = onSlide(0, '[data-hcd-picture-id="10001"]');
  await expect(original).toBeVisible();
  const sourceX = await original.getAttribute("data-hcd-x");
  await pick(original);
  await drag("移动所选对象", 24, 21);
  await expect(original).not.toHaveAttribute("data-hcd-x", sourceX);
  const updatedOriginalX = await original.getAttribute("data-hcd-x");
  await command("新增幻灯片");
  await expect(editor.locator(".fixed-page")).toHaveCount(6);
  await expect(editor.locator(".fixed-page").nth(5)).toBeInViewport({ ratio: .3 });
  const shape = onSlide(5, '[data-hcd-created-preset="ellipse"]');
  await button("插入").click();
  await ribbon.getByRole("combobox", { name: "插入形状", exact: true }).selectOption("ellipse");
  await expect(shape).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await command("插入图片");
  await (await chooser).setFiles(picture);
  const inserted = onSlide(5, "[data-hcd-created-image]");
  await expect(inserted.locator('img[alt="project-proposal.png"]')).toBeVisible();
  const x = await inserted.getAttribute("data-hcd-x");
  await pick(inserted);
  await drag("移动所选对象", 76, -95);
  await expect(inserted).not.toHaveAttribute("data-hcd-x", x);
  const oldWidth = await inserted.getAttribute("data-hcd-width");
  await drag("调整对象大小", -44, -25);
  await expect(inserted).not.toHaveAttribute("data-hcd-width", oldWidth);
  await pick(shape, true);
  const ellipseY = await shape.getAttribute("data-hcd-y-emu");
  const pictureY = await inserted.getAttribute("data-hcd-y");
  await drag("移动所选对象", 17, 11);
  await expect(shape).not.toHaveAttribute("data-hcd-y-emu", ellipseY);
  await expect(inserted).not.toHaveAttribute("data-hcd-y", pictureY);
  await button("开始").click();
  const align = ribbon.getByRole("combobox", { name: "对象对齐", exact: true });
  await expect(align).toBeVisible();
  await align.selectOption("left");
  await expect.poll(async () => {
    const left = await shape.getAttribute("data-hcd-x-emu");
    return (await inserted.getAttribute("data-hcd-x")) === left;
  }).toBe(true);
  const alignedX = await inserted.getAttribute("data-hcd-x");
  const finalY = await inserted.getAttribute("data-hcd-y");
  const finalWidth = await inserted.getAttribute("data-hcd-width");
  await page.screenshot({ path: join(output, "pptx-object-alignment.png") });
  await button("插入").click();
  await ribbon.getByRole("combobox", { name: "插入形状", exact: true }).selectOption("roundRect");
  await expect(onSlide(5, '[data-hcd-created-preset="roundRect"]')).toBeVisible();

  const saved = await downloadNative("pictures-native-roundtrip.pptx");

  await upload(saved, "pictures-native-roundtrip.pptx");
  await expect(onSlide(0, '[data-hcd-picture-id="10001"]')).toHaveAttribute("data-hcd-x", updatedOriginalX);
  const reopenShape = onSlide(5, '.hcd-slide-shape[style*="border-radius:50%"]');
  const reopenImage = onSlide(5, '.hcd-slide-picture[data-hcd-picture-name^="HCD image "]');
  await editor.locator(".fixed-page").nth(5).scrollIntoViewIfNeeded();
  await expect(reopenShape).toHaveAttribute("data-hcd-x-emu", alignedX);
  await expect(reopenImage).toHaveAttribute("data-hcd-x", alignedX);
  await expect(reopenImage).toHaveAttribute("data-hcd-y", finalY);
  await expect(reopenImage).toHaveAttribute("data-hcd-width", finalWidth);
  const order = await onSlide(5, '.hcd-slide > :is(.hcd-slide-shape,.hcd-slide-picture)').evaluateAll(objects =>
    objects.map(object => object.classList.contains("hcd-slide-picture") ? "image" : object.style.borderRadius));
  assert.deepEqual(order, ["50%", "image", "12px"]);
  const shapeBox = await reopenShape.boundingBox();
  assert(shapeBox);
  await pick(reopenShape, false, { x: 9, y: shapeBox.height / 2 });
  await expect(button("移动所选对象")).toBeVisible();
  checks.push("The workbench moves an original picture in a real PPTX, inserts a native ellipse and uploaded picture, resizes, jointly moves and aligns them, and reopens the source-backed download with the positions, stack order and editable objects intact.");

  await page.getByRole("tab", { name: "pictures-basic.pptx", exact: true }).click();
  await editor.locator(".fixed-page").nth(5).scrollIntoViewIfNeeded();
  await button("开始").click();
  const selectObjects = button("选择对象");
  if ((await selectObjects.getAttribute("aria-pressed")) !== "true") await selectObjects.click();
  const initialBox = await shape.boundingBox();
  assert(initialBox);
  await pick(shape, false, { x: 9, y: initialBox.height / 2 });
  await pick(inserted, true);
  await command("组合");
  const group = onSlide(5, ".hcd-slide > .hcd-slide-group");
  await expect(group.locator(":scope > [data-hcd-created-image]")).toBeVisible();
  await expect(group.locator(":scope > [data-hcd-created-preset]")).toHaveCount(1);
  const before = await group.getAttribute("data-hcd-pptx-transform");
  await drag("移动所选对象", 26, 17);
  await expect(group).not.toHaveAttribute("data-hcd-pptx-transform", before);
  const moved = await group.getAttribute("data-hcd-pptx-transform");
  await command("复制本页");
  await expect(editor.locator(".fixed-page")).toHaveCount(7);
  await editor.locator(".fixed-page").nth(6).scrollIntoViewIfNeeded();
  const copiedGroup = onSlide(6, ".hcd-slide > .hcd-slide-group");
  await expect(copiedGroup).toHaveAttribute("data-hcd-pptx-transform", moved);
  await expect(copiedGroup.locator(":scope > [data-hcd-created-image]")).toBeVisible();
  const copiedBox = await copiedGroup.boundingBox();
  assert(copiedBox);
  await pick(copiedGroup, false, { x: 9, y: copiedBox.height / 2 });
  await drag("移动所选对象", 35, 22);
  await expect(copiedGroup).not.toHaveAttribute("data-hcd-pptx-transform", moved);
  const copiedMoved = await copiedGroup.getAttribute("data-hcd-pptx-transform");
  await editor.locator(".fixed-page").nth(5).scrollIntoViewIfNeeded();
  await expect(group).toHaveAttribute("data-hcd-pptx-transform", moved);
  const groupedDownload = await downloadNative("authored-media-group.pptx");
  await upload(groupedDownload, "authored-media-group.pptx");
  await editor.locator(".fixed-page").nth(5).scrollIntoViewIfNeeded();
  await expect(group).toHaveAttribute("data-hcd-pptx-transform", moved);
  await expect(group.locator(":scope > .hcd-slide-picture img")).toBeVisible();
  await expect(group.locator(":scope > .hcd-slide-shape")).toHaveCount(1);
  await editor.locator(".fixed-page").nth(6).scrollIntoViewIfNeeded();
  await expect(copiedGroup).toHaveAttribute("data-hcd-pptx-transform", copiedMoved);
  await expect(copiedGroup.locator(":scope > .hcd-slide-picture img")).toBeVisible();
  await expect(copiedGroup.locator(":scope > .hcd-slide-shape")).toHaveCount(1);
  checks.push("A newly inserted ellipse and uploaded picture form one editable native group. Copying the edited slide and moving its group leave the original unchanged; both independent groups reopen in the downloaded PPTX.");
  }

  await upload(notesChart, "notes-chart.pptx");
  const slidePages = editor.locator(".fixed-pages > .fixed-page");
  await expect(slidePages).toHaveCount(2);
  await expect(onSlide(0, ".hcd-slide-chart")).toBeVisible();
  await button("视图").click();
  await command("演讲者备注");
  const notes = editor.getByRole("complementary", { name: "演讲者备注", exact: true });
  await expect(notes.getByRole("button", { name: /编辑备注：Presenter notes/ })).toBeVisible();
  const notesBox = await notes.boundingBox(), slideBox = await slidePages.first().boundingBox();
  assert(notesBox && slideBox && notesBox.width >= slideBox.width * .8, "备注面板应该占用编辑区宽度");
  async function editNotes(value) {
    await notes.getByRole("button", { name: /编辑备注：/ }).first().click();
    await notes.getByRole("textbox", { name: "编辑文字", exact: true }).fill(value);
    await notes.getByRole("button", { name: "保存", exact: true }).click();
    await expect(notes.getByRole("button", { name: /编辑备注：/ }).first()).toHaveText(value);
  }
  await editNotes("原页的演讲备注");
  await button("开始").click();
  await command("复制本页");
  await expect(slidePages).toHaveCount(3);
  await button("视图").click();
  await editor.getByRole("checkbox", { name: "幻灯片列表", exact: true }).check();
  await editor.getByRole("button", { name: "幻灯片 2", exact: true }).click();
  await expect(onSlide(1, ".hcd-slide-chart")).toBeVisible();
  await expect(notes.getByRole("button", { name: /编辑备注：/ }).first()).toHaveText("原页的演讲备注");
  await editNotes("副本的独立备注");
  await editor.getByRole("button", { name: "幻灯片 1", exact: true }).click();
  await expect(notes.getByRole("button", { name: /编辑备注：/ }).first()).toHaveText("原页的演讲备注");
  await editor.getByRole("button", { name: "幻灯片 2", exact: true }).click();
  await expect(notes.getByRole("button", { name: /编辑备注：/ }).first()).toHaveText("副本的独立备注");
  await page.screenshot({ path: join(output, "pptx-independent-notes.png") });
  await page.reload();
  await expect(slidePages).toHaveCount(3, { timeout: 45000 });
  await button("视图").click();
  await command("演讲者备注");
  if (!(await editor.getByRole("checkbox", { name: "幻灯片列表", exact: true }).isChecked()))
    await editor.getByRole("checkbox", { name: "幻灯片列表", exact: true }).check();
  await editor.getByRole("button", { name: "幻灯片 2", exact: true }).click();
  await expect(notes.getByRole("button", { name: /编辑备注：/ }).first()).toHaveText("副本的独立备注");
  const copiedNotesChart = await downloadNative("notes-chart-copy.pptx");
  await upload(copiedNotesChart, "notes-chart-copy.pptx");
  await expect(slidePages).toHaveCount(3);
  await slidePages.nth(0).scrollIntoViewIfNeeded();
  await expect(onSlide(0, ".hcd-slide-chart")).toBeVisible();
  await slidePages.nth(1).scrollIntoViewIfNeeded();
  await expect(onSlide(1, ".hcd-slide-chart")).toBeVisible();
  await button("视图").click();
  await command("演讲者备注");
  if (!(await editor.getByRole("checkbox", { name: "幻灯片列表", exact: true }).isChecked()))
    await editor.getByRole("checkbox", { name: "幻灯片列表", exact: true }).check();
  await editor.getByRole("button", { name: "幻灯片 1", exact: true }).click();
  await expect(notes.getByRole("button", { name: /编辑备注：/ }).first()).toHaveText("原页的演讲备注");
  await editor.getByRole("button", { name: "幻灯片 2", exact: true }).click();
  await expect(notes.getByRole("button", { name: /编辑备注：/ }).first()).toHaveText("副本的独立备注");
  await page.screenshot({ path: join(output, "pptx-chart-copy.png") });
  checks.push("The workbench copies a real slide with notes and an editable native chart, edits the original and copy's notes independently before export, and preserves both after reload and source-format reopening.");
}
