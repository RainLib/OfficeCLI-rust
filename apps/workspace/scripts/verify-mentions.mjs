import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect } from "../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs";

export async function verifyMentions({ call, launch, admin, reader, base, browser, ownerPage, artifacts, checks, restrictNetwork, restart }) {
  const create = async name => {
    const result = await call("/workspace/api/files", { account: admin, method: "POST", data: { name } });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    const file = result.value.file;
    assert.equal((await call(`/workspace/api/files/${file.id}/acl`, { account: admin, method: "PUT",
      data: { userId: reader.user.id, profile: "viewer", operations: ["document.view"] } })).status, 204);
    return file;
  };
  const [discussion, notes] = await Promise.all([create("会前讨论.excalidraw"), create("交付计划.excalidraw")]);
  const recipient = await browser.newContext({ viewport: { width: 1250, height: 900 }, reducedMotion: "reduce" });
  await restrictNetwork(recipient);
  const cookie = reader.cookie.indexOf("=");
  await recipient.addCookies([{ name: reader.cookie.slice(0, cookie), value: reader.cookie.slice(cookie + 1), url: base, httpOnly: true, sameSite: "Strict" }]);
  const inboxPage = await recipient.newPage();
  const author = await ownerPage.context().newPage();
  await author.setViewportSize({ width: 1440, height: 960 });
  const errors = [];
  for (const page of [inboxPage, author]) page.on("pageerror", error => errors.push(error.message));
  const openBoard = async file => {
    await author.goto(`${base}/workbench/?file=${file.id}&ai=0`);
    await expect(author.getByRole("toolbar", { name: "白板工具栏" })).toBeVisible({ timeout: 45000 });
  };
  const dock = author.getByRole("toolbar", { name: "白板工具栏" });
  const form = author.getByRole("form", { name: "评论线程" });
  const room = inboxPage.getByRole("form", { name: "评论线程" });
  const toggle = inboxPage.getByRole("button", { name: "@我", exact: true });
  const badge = toggle.locator(".desk-mention-count");
  const dialog = inboxPage.getByRole("dialog", { name: "@我" });
  const inbox = async (account = reader) => {
    const result = await call("/workspace/api/mentions", { account });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  };
  async function mention(field, suffix, comment = false) {
    // The emoji counts as two UTF-16 units in the persisted textarea range.
    await field.fill("🟢 ");
    if (comment) await form.getByRole("button", { name: "提及协作者" }).click();
    else await author.keyboard.insertText("@");
    await author.getByRole("option").filter({ hasText: reader.user.displayName }).click();
    await author.keyboard.insertText(suffix);
  }
  async function patchNote(note, operation) {
    const session = await launch(admin, note.fileId);
    const path = `/v1/documents/${session.documentId}/canvas`;
    const credentials = { account: admin, token: session.token };
    const current = await call(path, credentials);
    assert.equal(current.status, 200, JSON.stringify(current.value));
    const element = current.value.scene.elements.find(item => item.id === note.elementId);
    assert(element);
    const result = await call(path + "/patch", { ...credentials, method: "POST",
      headers: { "X-HCD-Collaboration-Epoch": String(current.value.collaborationEpoch) }, data: {
        schemaVersion: "officecli-canvas/1", documentId: session.documentId, patchId: randomUUID(),
        baseRevision: current.value.revision, operations: [operation(element)],
      } });
    assert.equal(result.status, 200, JSON.stringify(result.value));
  }
  try {
    await inboxPage.goto(base + "/workbench/?ai=0");
    await expect(toggle).toBeVisible();
    await expect(badge).toHaveCount(0);
    await openBoard(discussion);
    await dock.getByRole("button", { name: "评论", exact: true }).click();
    await author.getByLabel("画布放置区").click({ position: { x: 420, y: 330 } });
    await mention(form.getByRole("textbox", { name: "评论内容" }), "核对讨论议题", true);
    await form.getByRole("button", { name: "发送", exact: true }).click();
    const pin = author.getByRole("button", { name: /^打开.+的评论$/ });
    await pin.click();
    await mention(form.getByRole("textbox", { name: "评论内容" }), "核对回复里的验收状态", true);
    await form.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(async () => (await inbox()).items.length, { timeout: 20000 }).toBe(2);

    await openBoard(notes);
    await dock.getByRole("button", { name: "便利贴", exact: true }).click();
    await author.getByLabel("画布放置区").click({ position: { x: 450, y: 350 } });
    const paper = author.locator("[data-note-id]");
    await expect(paper).toBeVisible();
    const bounds = await paper.boundingBox();
    assert(bounds);
    await author.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const sticky = author.getByRole("textbox", { name: "便利贴内容" });
    await mention(sticky, "更新交付计划");
    await sticky.press("Escape");
    await inboxPage.bringToFront();
    await expect(badge).toHaveText("3", { timeout: 26000 });
    await expect(inboxPage.getByRole("tab", { name: "首页", exact: true })).toHaveAttribute("aria-selected", "true");
    const initial = await inbox();
    assert.deepEqual(initial.items.map(item => item.kind).sort(), ["comment", "reply", "sticky"]);
    assert.equal((await inbox(admin)).unread, 0);
    const reply = initial.items.find(item => item.kind === "reply");
    assert.equal((await call(`/workspace/api/mentions/${reply.id}/read`, { account: admin, method: "POST", data: {} })).status, 404);
    await toggle.click();
    await expect(dialog.getByRole("button", { name: /核对回复里的验收状态/ })).toBeVisible();
    await inboxPage.screenshot({ path: join(artifacts, "mention-inbox.png") });
    await dialog.getByRole("button", { name: /核对回复里的验收状态/ }).click();
    await expect(room.locator("article[data-mentioned]")).toContainText("核对回复里的验收状态");
    assert.equal(new URL(inboxPage.url()).searchParams.get("node-id"), reply.elementId);
    await expect(room.getByRole("textbox")).toHaveCount(0);
    await expect(badge).toHaveText("2");
    await inboxPage.screenshot({ path: join(artifacts, "mention-reply.png") });

    const note = initial.items.find(item => item.kind === "sticky");
    await toggle.click();
    await dialog.getByRole("button", { name: /更新交付计划/ }).click();
    // The persisted sticky and its bound text are selected as one group.
    await expect(inboxPage.locator(".desk-editor.is-visible .canvas-selection-actions")).toContainText("已选中 2 个对象");
    await expect(inboxPage.locator(`.desk-editor.is-visible [data-note-id="${note.elementId}"]`)).toBeInViewport();
    assert.equal(new URL(inboxPage.url()).searchParams.get("node-id"), note.elementId);
    await inboxPage.screenshot({ path: join(artifacts, "mention-sticky.png") });

    await patchNote(note, element => ({ op: "element.update", id: element.id,
      before: { x: element.x }, changes: { x: element.x + 100 } }));
    await restart();
    await inboxPage.reload();
    await expect(badge).toHaveText("1", { timeout: 20000 });
    const after = await inbox();
    assert.equal(after.items.find(item => item.id === note.id).read, true);
    assert.equal(after.items.find(item => item.id === reply.id).read, true);
    assert.equal(after.items.length, 3);
    await toggle.click();
    await dialog.getByRole("button", { name: "全部已读", exact: true }).click();
    await expect(badge).toHaveCount(0);
    assert.equal((await inbox()).unread, 0);
    const denied = await call(`/workspace/api/files/${discussion.id}/acl/${reader.user.id}`, { account: admin, method: "DELETE" });
    assert.equal(denied.status, 204);
    assert.deepEqual((await inbox()).items.map(item => item.fileId), [notes.id]);
    assert.equal((await call(`/workspace/api/mentions/${reply.id}/read`, { account: reader, method: "POST", data: {} })).status, 404);
    await dialog.getByRole("button", { name: "刷新提醒", exact: true }).click();
    await expect(dialog.getByText(discussion.name, { exact: true })).toHaveCount(0);
    await patchNote(note, element => ({ op: "element.update", id: element.id,
      before: { customData: element.customData }, changes: { customData: { ...element.customData, mentions: [] } } }));
    await expect.poll(async () => (await inbox()).items.length, { timeout: 16000 }).toBe(0);
    assert.deepEqual(errors, []);
    checks.push("Two authenticated browsers delivered real comment, reply and sticky mentions across boards without opening them first. A reader opened the exact reply and sticky, read receipts survived a service restart and movement, and access revocation and removing a mention cleared the appropriate entries.");
  } catch (error) {
    await author.screenshot({ path: join(artifacts, "mention-author-failure.png") }).catch(() => {});
    await inboxPage.screenshot({ path: join(artifacts, "mention-inbox-failure.png") }).catch(() => {});
    throw error;
  } finally {
    await author.close();
    await recipient.close();
  }
}
