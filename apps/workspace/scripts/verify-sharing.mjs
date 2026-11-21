import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** Runs against the real SQLite Provider, engine and collaboration sidecar.
 * Every visitor uses a fresh browser context, without an account login. */
export async function verifySharing({ call, admin, fileId, base, browser, ownerPage, artifacts, checks, restrictNetwork }) {
  const { expect } = await import("../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs");
  const settings = (data) => call(`/workspace/api/files/${fileId}/sharing`, { account: admin, method: "PUT", data });
  const open = (url, account, sessionId = randomUUID(), extra = {}) => {
    const link = new URL(url);
    return call(`/workspace/api/shared/${fileId}/open`, {
      account, method: "POST", data: { sessionId, ...extra },
      headers: { ...(link.hash ? { "X-Workspace-Share": link.hash.slice(1) } : {}) },
    });
  };
  const privateUrl = `${base}/s/${fileId}`;
  assert.equal((await open(privateUrl)).status, 401);
  const first = await settings({ visibility: "link", permission: "read", expiresAt: null });
  assert.equal(first.status, 200, JSON.stringify(first.value));
  let shareUrl = first.value.sharing.url;
  assert.equal((await call("/workspace/api/public/files")).value.files.some(file => file.id === fileId), false);
  assert.equal((await open(shareUrl, undefined, randomUUID(), { userId: admin.user.id })).status, 400);
  const invalid = new URL(shareUrl); invalid.hash = "invalid";
  assert.equal((await open(invalid.href)).status, 404);
  const guest = await open(shareUrl);
  assert.equal(guest.status, 200, JSON.stringify(guest.value));
  assert.equal(guest.value.actor.isGuest, true);
  assert.match(guest.value.actor.id, /^[a-f0-9-]{36}$/);
  assert.match(guest.setCookie, /HttpOnly/);
  const guestAccount = { cookie: guest.cookie, csrf: "" };
  const auth = await call(`/v1/documents/${guest.value.documentId}/auth`, { account: guestAccount, token: guest.value.token });
  assert.equal(auth.value.scope, "read");
  assert.match(auth.value.userId, /^host-[a-f0-9]+$/);
  assert.equal(auth.value.displayName, guest.value.actor.displayName);
  assert.deepEqual(auth.value.operations.sort(), ["document.copy", "document.view"]);
  assert.equal((await open(shareUrl, guestAccount)).value.actor.id, guest.value.actor.id);
  assert.equal((await call("/workspace/api/files", { account: guestAccount })).status, 403);
  assert.equal((await call("/v1/admin/service", { account: guestAccount })).status, 403);
  assert.equal((await call(`/v1/documents/${guest.value.documentId}/revisions`, { account: guestAccount, token: guest.value.token })).status, 403);
  for (const action of ["/checkpoints", "/publications", "/restore/0"])
    assert.equal((await call(`/v1/documents/${guest.value.documentId}${action}`, { account: guestAccount, token: guest.value.token, method: "POST", data: {} })).status, 403);
  checks.push("anonymous link exchange assigns a stable server-generated identity; identity spoofing, private files, administration and history remain denied");

  const readContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const writeContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await Promise.all([readContext, writeContext, secondContext].map(restrictNetwork));
  const reader = await readContext.newPage(), writer = await writeContext.newPage(), second = await secondContext.newPage();
  const owner = await ownerPage.context().newPage();
  try {
    await reader.goto(shareUrl);
    await expect(reader.locator("[data-document-scope]")).toHaveAttribute("data-document-scope", "read", { timeout: 60000 });
    assert.equal(await reader.locator('.tiptap[contenteditable="true"]').count(), 0);
    assert.equal(await reader.getByRole("button", { name: "编辑", exact: true }).count(), 0);
    assert.equal(await reader.getByRole("button", { name: "预览", exact: true }).count(), 0);
    await expect(reader.locator(".editor-header .document-access-badge, .editor-header .sidebar-toggle")).toHaveCount(0);
    await expect(reader.locator(".editor-header")).not.toContainText(/可编辑|可查看/);
    await reader.screenshot({ path: join(artifacts, "sharing-guest-read.png"), fullPage: true });

    await owner.goto(`${base}/editor/?workspaceFile=${fileId}&share=1`);
    await expect(owner.getByRole("dialog", { name: "分享文档" })).toBeVisible({ timeout: 60000 });
    await owner.getByLabel("访客权限", { exact: true }).selectOption("write");
    await owner.getByRole("button", { name: "保存并复制链接", exact: true }).click();
    await expect(owner.getByLabel("分享链接", { exact: true })).toHaveValue(shareUrl);
    await expect.poll(async () => (await call(`/workspace/api/files/${fileId}/sharing`, { account: admin })).value.sharing.permission).toBe("write");
    await owner.screenshot({ path: join(artifacts, "sharing-owner-dialog.png"), fullPage: true });
    await owner.getByRole("button", { name: "关闭分享", exact: true }).click();

    // The existing reader automatically receives the changed permission.
    await expect(reader.locator("[data-document-scope]")).toHaveAttribute("data-document-scope", "write", { timeout: 30000 });
    await writer.goto(shareUrl);
    await expect(writer.locator('.tiptap[contenteditable="true"]')).toBeVisible({ timeout: 60000 });
    await second.goto(shareUrl);
    await expect(second.locator("[data-document-scope]")).toHaveAttribute("data-document-scope", "write", { timeout: 60000 });
    const identity = async (page) => (await page.request.get(`${base}/workspace/api/session`)).json();
    const writerIdentity = (await identity(writer)).user;
    const secondIdentity = (await identity(second)).user;
    assert(writerIdentity.isGuest && secondIdentity.isGuest);
    assert.notEqual(writerIdentity.id, secondIdentity.id);
    await expect(second.locator(".document-visitor-identity")).toContainText(secondIdentity.displayName);
    assert.equal(await writer.locator(".host-publication").count(), 0);
    // Establish a clean checkpoint after all clients join; the following edit
    // has exactly one author rather than mixing an earlier owner's draft.
    await owner.getByRole("button", { name: "保存点", exact: true }).click();
    await expect(owner.locator(".editor-statusbar")).toContainText("已保存");
    const editable = writer.locator('.tiptap[contenteditable="true"]');
    const added = "Anonymous collaborator accepted edit.";
    await editable.click();
    await writer.keyboard.press("ControlOrMeta+End");
    await writer.keyboard.press("Enter");
    await writer.keyboard.insertText(added);
    await expect(second.locator(".tiptap")).toContainText(added, { timeout: 30000 });
    await writer.screenshot({ path: join(artifacts, "sharing-guest-edit.png"), fullPage: true });
    assert.equal(await second.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await second.screenshot({ path: join(artifacts, "sharing-guest-phone.png"), fullPage: true });
    await writer.getByRole("button", { name: "保存点", exact: true }).click();
    await expect.poll(async () => {
      const cookie = (await writeContext.cookies(base)).find(cookie => cookie.name === "officecli_workspace_guest");
      const launched = await open(shareUrl, { cookie: `${cookie.name}=${cookie.value}`, csrf: "" });
      if (launched.status !== 200) return false;
      const content = await call(`/v1/documents/${launched.value.documentId}/editor`, { account: { cookie: `${cookie.name}=${cookie.value}` }, token: launched.value.token });
      return JSON.stringify(content.value).includes(added);
    }, { timeout: 30000 }).toBe(true);
    const ownerSession = await call(`/workspace/api/files/${fileId}/editor-session`, { account: admin, method: "POST", data: { sessionId: randomUUID() } });
    assert.equal(ownerSession.status, 200);
    const revisions = await call(`/v1/documents/${ownerSession.value.documentId}/revisions`, { account: admin, token: ownerSession.value.token });
    assert.equal(revisions.status, 200);
    assert.equal(revisions.value.revisions.at(-1).authorName, writerIdentity.displayName);
    await second.locator('.tiptap[contenteditable="true"]').click();
    await second.keyboard.press("ControlOrMeta+End");
    await second.keyboard.insertText(" Anonymous peer second edit.");
    await expect(editable).toContainText("Anonymous peer second edit.");
    await editable.click();
    await writer.keyboard.press("ControlOrMeta+End");
    await writer.keyboard.insertText(" Shared checkpoint.");
    await expect(second.locator(".tiptap")).toContainText("Shared checkpoint.");
    await writer.getByRole("button", { name: "保存点", exact: true }).click();
    await expect.poll(async () => {
      const result = await call(`/v1/documents/${ownerSession.value.documentId}/revisions`, { account: admin, token: ownerSession.value.token });
      return result.value.revisions.at(-1).authorId;
    }).toBe("hcd-collaboration");
    await writer.reload();
    await expect(writer.locator('.tiptap[contenteditable="true"]')).toContainText(added, { timeout: 60000 });
    assert.equal((await identity(writer)).user.id, writerIdentity.id);
    checks.push("real anonymous browsers read without login, receive distinct temporary identities, collaborate on edits, save durably and retain their identity on reload; no edit/preview switch");

    const downgraded = await settings({ visibility: "link", permission: "read", expiresAt: null });
    assert.equal(downgraded.status, 200);
    assert.equal((await call(`/v1/documents/${guest.value.documentId}/auth`, { account: guestAccount, token: guest.value.token })).status, 403);
    await expect(writer.locator("[data-document-scope]")).toHaveAttribute("data-document-scope", "read", { timeout: 30000 });
    assert.equal(await writer.locator('.tiptap[contenteditable="true"]').count(), 0);
    const rotated = await settings({ visibility: "link", permission: "read", expiresAt: null, resetLink: true });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.value.sharing.url, shareUrl);
    assert.equal((await open(shareUrl)).status, 404);
    await expect(writer.getByRole("heading", { name: "暂时无法访问这份文档" })).toBeVisible({ timeout: 30000 });
    await writer.screenshot({ path: join(artifacts, "sharing-revoked.png"), fullPage: true });
    shareUrl = rotated.value.sharing.url;
    checks.push("permission downgrade makes open visitors read-only; rotating the link rejects old signed sessions and removes the editor from old-link browsers");

    const published = await settings({ visibility: "public", permission: "read", expiresAt: null });
    assert.equal(published.status, 200);
    await second.goto(`${base}/public`);
    await expect(second.getByRole("heading", { name: "公开文件库", exact: true })).toBeVisible();
    await expect(second.getByRole("link", { name: /打开文档/ })).toHaveCount(1);
    await second.screenshot({ path: join(artifacts, "sharing-public-phone.png"), fullPage: true });
    await reader.goto(`${base}/public`);
    await reader.screenshot({ path: join(artifacts, "sharing-public-library.png"), fullPage: true });
    await second.getByRole("link", { name: /打开文档/ }).click();
    await expect(second.locator("[data-document-scope]")).toHaveAttribute("data-document-scope", "read", { timeout: 60000 });
    assert.equal((await open(published.value.sharing.url)).status, 200);
    const closed = await settings({ visibility: "private", permission: "read", expiresAt: null });
    assert.equal(closed.status, 200);
    assert.equal((await call("/workspace/api/public/files")).value.files.length, 0);
    assert.equal((await open(published.value.sharing.url)).status, 401);
    checks.push("public directory and phone layout work without login; link-only files stay unlisted and stopping sharing removes public access");

    const image = await call("/workspace/api/files?filename=shared-image.jpg", {
      account: admin, method: "POST", headers: { "Content-Type": "image/jpeg" },
      bytes: readFileSync(new URL("../../../docs/design/officecli-image-workspace/assets/ceramic-portrait.jpg", import.meta.url)),
    });
    assert.equal(image.status, 201);
    const imageId = image.value.file.id;
    const imageShare = await call(`/workspace/api/files/${imageId}/sharing`, { account: admin, method: "PUT", data: { visibility: "link", permission: "write", expiresAt: null } });
    assert.equal(imageShare.status, 200);
    await writer.goto(imageShare.value.sharing.url);
    await expect(writer.getByRole("region", { name: "图片画布，滚轮缩放，空格拖动" })).toBeVisible();
    await expect(writer.locator("[data-document-scope]")).toHaveAttribute("data-document-scope", "write");
    for (const action of ["转换格式", "调整大小与画质", "AI 修图", "版本记录"])
      await expect(writer.getByRole("button", { name: action, exact: true })).toHaveCount(0);
    await writer.getByRole("navigation", { name: "图片工具", exact: true }).getByRole("button", { name: "裁剪与旋转", exact: true }).click();
    await writer.getByRole("button", { name: "顺时针旋转", exact: true }).click();
    const committed = writer.waitForResponse(response => response.url().endsWith("/image/commit") && response.request().method() === "POST");
    await writer.getByRole("button", { name: "应用编辑", exact: true }).click();
    assert.equal((await committed).status(), 200);
    await writer.screenshot({ path: join(artifacts, "sharing-guest-image.png"), fullPage: true });
    checks.push("an anonymous image editor can save an actual rotation while conversion, AI, history and business publication controls remain absent");
  } finally {
    await owner.close();
    await Promise.all([readContext.close(), writeContext.close(), secondContext.close()]);
  }
}
