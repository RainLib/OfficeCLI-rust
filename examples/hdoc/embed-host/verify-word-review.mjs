import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "../editor/node_modules/@playwright/test/index.mjs";

const source = resolve(import.meta.dirname, "../../word/numbering-showcase.docx");
const quote = "List Showcase";

export async function verifyWordReview(page, output, checks) {
  const editor = page.locator(".desk-editor.is-visible");
  const content = editor.locator(".tiptap").first();
  const comments = editor.getByRole("complementary", { name: "Word 审阅" });
  const button = (name, host = editor) => host.getByRole("button", { name, exact: true });
  const revisionEpochs = new Map();
  async function upload(filename, name) {
    await page.getByRole("tab", { name: "首页", exact: true }).click();
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(filename);
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(content).toHaveAttribute("contenteditable", "true", { timeout: 45000 });
    await button("审阅").click();
    await expect(comments.getByRole("heading", { name: "批注" })).toBeVisible();
  }
  async function choose(target, start, end) {
    await target.evaluate((paragraph, { start, end }) => {
      const doc = paragraph.ownerDocument;
      const selection = doc.getSelection();
      const walker = doc.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      const range = doc.createRange();
      let at = 0, started = false;
      paragraph.closest(".tiptap").focus();
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const next = at + node.textContent.length;
        if (!started && start <= next) { range.setStart(node, start - at); started = true; }
        if (end <= next) { range.setEnd(node, end - at); break; }
        at = next;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      doc.dispatchEvent(new Event("selectionchange"));
    }, { start, end });
  }
  async function write(name) {
    const result = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/word-review"));
    await button(name, comments).click();
    const saved = await result;
    assert(saved.ok(), await saved.text());
    const path = new URL(saved.url()).pathname;
    const epoch = saved.request().headers()["x-hcd-collaboration-epoch"];
    assert(epoch);
    if (revisionEpochs.has(path)) assert.equal(epoch, revisionEpochs.get(path), "review keeps the same collaboration room");
    else revisionEpochs.set(path, epoch);
    await expect(content).toHaveAttribute("contenteditable", "true");
  }
  await upload(source, "numbering-showcase.docx");
  await expect(comments.getByText("暂无批注")).toBeVisible();
  const paragraph = content.getByText("Numbering & List Showcase", { exact: true });
  await choose(paragraph, 12, 25);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(quote);
  await button("新建批注").click();
  await expect(comments.locator("blockquote")).toHaveText(quote);
  await comments.getByRole("textbox", { name: "批注内容" }).fill("标题示例保留原名。");
  await write("发布批注");
  await expect(comments.getByText("标题示例保留原名。", { exact: true })).toBeVisible();
  await button(quote, comments).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(quote);
  await button("查找全文").click();
  const search = editor.getByRole("region", { name: "文档内容搜索" });
  await search.getByRole("searchbox").fill("Numbering &");
  await search.getByLabel("替换为").fill("Workshop: Numbering &");
  await button("全部替换", search).click();
  await button("关闭搜索", search).click();
  await expect(content.getByText("Workshop: Numbering & List Showcase", { exact: true })).toBeVisible();
  await button("保存点").click();
  await expect(editor.locator(".editor-statusbar")).toContainText("已保存", { timeout: 25000 });
  await page.reload();
  await expect(content).toHaveAttribute("contenteditable", "true", { timeout: 45000 });
  await button("审阅").click();
  await button(quote, comments).click();
  try {
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(quote);
  } catch (error) {
    console.error('Word locate state', await content.evaluate(element => ({
      focus: document.activeElement?.outerHTML.slice(0, 200),
      pm: element.editor?.state.selection.toJSON(), hasFocus: element.editor?.view.hasFocus(),
      dom: { text: window.getSelection()?.toString(), anchor: window.getSelection()?.anchorNode?.parentElement?.outerHTML.slice(0, 200) },
    })));
    throw error;
  }
  await button("回复", comments).click();
  await comments.getByRole("textbox", { name: "回复内容" }).fill("标题已核对。");
  await write("发送回复");
  await expect(comments.getByText("标题已核对。", { exact: true })).toBeVisible();
  await write("解决批注");
  await expect(comments.getByText("已解决", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, "word-review.png") });

  const exports = editor.locator(".export-control");
  await editor.locator('summary[aria-label="文件操作"]').click();
  await exports.locator("summary").click();
  await exports.getByRole("combobox", { name: "导出方式", exact: true }).selectOption("source");
  await exports.getByRole("button", { name: "准备下载", exact: true }).click();
  const download = page.waitForEvent("download");
  await exports.getByRole("link", { name: /下载 .*\.docx$/ }).click();
  const file = join(output, "word-review-native-roundtrip.docx");
  await (await download).saveAs(file);
  await upload(file, "word-review-native-roundtrip.docx");
  await expect(content.getByText("Workshop: Numbering & List Showcase", { exact: true })).toBeVisible();
  await expect(comments.getByText("标题示例保留原名。", { exact: true })).toBeVisible();
  await expect(comments.getByText("标题已核对。", { exact: true })).toBeVisible();
  await expect(comments.getByText("已解决", { exact: true })).toBeVisible();
  await button(quote, comments).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(quote);
  await write("重新打开批注");
  await expect(button("回复", comments)).toBeEnabled();
  checks.push("Word review anchors a real text selection, follows it past a separate paragraph edit, preserves the reply and resolved status in a native DOCX, and can reopen the thread after re-import.");
}

export async function verifyWordTracked(page, output, checks) {
  const sourceFile = join(output, "word-tracked-source.docx");
  copyFileSync(join(output, "word-review-native-roundtrip.docx"), sourceFile);
  const office = process.env.OFFICECLI_BIN || resolve(import.meta.dirname, "../../../apps/workspace/dist/officecli");
  const xml = [
    '<w:p><w:r><w:t>第一项。 </w:t></w:r>',
    '<w:ins w:id="50" w:author="周评审" w:date="2025-11-10T09:00:00Z"><w:r><w:t>通过的新条款</w:t></w:r></w:ins>',
    '<w:del w:id="51" w:author="陈评审" w:date="2025-11-10T10:00:00Z"><w:r><w:rPr><w:b/></w:rPr><w:delText>此前的条款</w:delText></w:r></w:del>',
    '</w:p><w:p>',
    '<w:r><w:t>第二项。 </w:t></w:r>',
    '<w:ins w:id="52" w:author="陈评审"><w:r><w:t>需要撤回的草案</w:t></w:r></w:ins>',
    '</w:p><w:p><w:ins w:id="53" w:author="周评审"><w:r><w:t>等候复核的文字</w:t></w:r></w:ins></w:p>',
    '<w:p><w:r><w:rPr><w:i/><w:rPrChange w:id="54" w:author="周评审"><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>格式修订样本</w:t></w:r></w:p>',
  ].join("");
  execFileSync(office, ["raw-set", sourceFile, "/document", "--xpath", "/w:document/w:body/w:sectPr",
    "--action", "insert", "--xml", xml], { stdio: "pipe" });

  const editor = page.locator(".desk-editor.is-visible");
  const content = editor.locator(".tiptap").first();
  const review = editor.getByRole("complementary", { name: "Word 审阅" });
  const cards = review.locator(".word-review-revision");
  const formatChange = cards.and(review.locator('[data-kind="format"]'));
  const button = (name, host = editor) => host.getByRole("button", { name, exact: true });
  const card = text => cards.filter({ has: page.getByText(text, { exact: true }) });
  const upload = async (path, name) => {
    await page.getByRole("tab", { name: "首页", exact: true }).click();
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(path);
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(content).toHaveAttribute("contenteditable", "true", { timeout: 45000 });
    await button("审阅").click();
    await button("原生修订", review).click();
  };
  let epoch;
  async function decide(text, verb) {
    const target = card(text);
    const request = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/word-review"));
    await button(verb, target).click();
    const response = await request;
    assert(response.ok(), await response.text());
    const tagged = Number(response.request().headers()["x-hcd-collaboration-epoch"]);
    if (epoch !== undefined) assert(tagged > epoch, "each body decision refreshes the room");
    epoch = tagged;
    await expect(target).toHaveCount(0);
    await expect(content).toHaveAttribute("contenteditable", "true", { timeout: 45000 });
  }
  await upload(sourceFile, "word-tracked-source.docx");
  await expect(cards).toHaveCount(5);
  await expect(formatChange.getByText("此类型暂不可在工作台处理", { exact: true })).toBeVisible();
  await expect(button("接受修订", formatChange)).toHaveCount(0);
  await expect(content.getByText("此前的条款", { exact: true })).toHaveCount(0);
  await expect(card("通过的新条款").getByText("周评审", { exact: true })).toBeVisible();
  await button("定位修订", card("通过的新条款")).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("通过的新条款");
  await page.screenshot({ path: join(output, "word-tracked-review.png") });
  await decide("通过的新条款", "接受修订");
  await expect(content).toContainText("通过的新条款");
  await decide("此前的条款", "拒绝修订");
  await expect(content.locator("strong").getByText("此前的条款", { exact: true })).toBeVisible();
  await decide("需要撤回的草案", "拒绝修订");
  await expect(content).not.toContainText("需要撤回的草案");
  await expect(cards).toHaveCount(2);

  await button("查找全文").click();
  const search = editor.getByRole("region", { name: "文档内容搜索" });
  await search.getByRole("searchbox").fill("此前的条款");
  await search.getByLabel("替换为").fill("已复核的旧条款");
  await button("全部替换", search).click();
  await button("关闭搜索", search).click();
  await expect(content).toContainText("已复核的旧条款");
  await button("保存点").click();
  await expect(editor.locator(".editor-statusbar")).toContainText("已保存", { timeout: 25000 });

  const exports = editor.locator(".export-control");
  await editor.locator('summary[aria-label="文件操作"]').click();
  await exports.locator("summary").click();
  await exports.getByRole("combobox", { name: "导出方式", exact: true }).selectOption("source");
  await button("准备下载", exports).click();
  const download = page.waitForEvent("download");
  await exports.getByRole("link", { name: /下载 .*\.docx$/ }).click();
  const target = join(output, "word-tracked-native-roundtrip.docx");
  await (await download).saveAs(target);
  await upload(target, "word-tracked-native-roundtrip.docx");
  await expect(cards).toHaveCount(2);
  await expect(card("等候复核的文字")).toBeVisible();
  await expect(formatChange).toBeVisible();
  await expect(content).toContainText("通过的新条款");
  await expect(content.locator("strong").getByText("已复核的旧条款", { exact: true })).toBeVisible();
  await expect(content).not.toContainText("需要撤回的草案");
  await button("批注", review).click();
  await expect(review.getByText("标题已核对。", { exact: true })).toBeVisible();
  await expect(review.getByText("已解决", { exact: true })).toBeVisible();
  checks.push("Word accepts or rejects individual native tracked runs, synchronizes the body, preserves a later edit to restored bold text and an unrelated pending revision, and reopens the original comment thread in the exported DOCX.");
}
