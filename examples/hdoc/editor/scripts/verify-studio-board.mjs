// Run with node examples/hdoc/editor/scripts/verify-studio-board.mjs.
// HCD_BROWSER_PATH may point to an installed Chromium browser.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const entry = new URL(
  "../../../../docs/design/officecli-canvas-journal-v1/figjam-board.html",
  import.meta.url,
);
const browser = await chromium.launch(
  process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const scene = () => page.evaluate(() => window.OfficeCLIWhiteboard.getContext());
const findObject = async (id) => (await scene()).objects.find((o) => o.id === id);
const hit = (id) => page.locator('#world [data-object="' + id + '"] > .hit');
const open = async (route) => {
  await page.goto(entry.href + "#" + route);
};
const action = (cmd) => page.locator('[data-ws="' + cmd + '"]:visible');
const drag = async (selector, dx, dy) => {
  const box = await selector.boundingBox();
  assert(box);
  const x = box.x + Math.min(34, box.width / 2),
    y = box.y + Math.min(15, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 9 });
  await page.mouse.up();
};
try {
  // Version one stored only notes and drawn objects. Loading must preserve their edits.
  await open("/home");
  await page.evaluate(() => {
    localStorage.setItem(
      "officecli-figjam-sketch-v1",
      JSON.stringify({
        objects: [
          {
            id: "legacy",
            type: "note",
            x: 125,
            y: 344,
            w: 204,
            h: 197,
            fill: "#FFE691",
            label: "旧便签",
            text: "保留旧内容",
            author: "我",
          },
        ],
        marks: [],
        edges: [],
      }),
    );
  });
  await page.reload();
  await open("/board");
  assert.equal((await findObject("legacy")).text, "保留旧内容");
  const title = await findObject("journal-title");
  await drag(hit(title.id), 72, 38);
  assert.deepEqual(
    [(await findObject(title.id)).x, (await findObject(title.id)).y],
    [title.x + 72, title.y + 38],
  );
  await page.keyboard.press("Control+z");
  assert.equal((await findObject(title.id)).x, title.x);
  await page.keyboard.press("Control+Shift+z");
  assert.equal((await findObject(title.id)).x, title.x + 72);
  await hit(title.id).dblclick({ position: { x: 25, y: 15 } });
  await expect(page.locator("#editor")).toBeVisible();
  await page.locator("#editor").fill("可以移动的标题");
  await page.locator("#editor").press("Control+Enter");
  await page.reload();
  assert.equal((await findObject(title.id)).text, "可以移动的标题");
  assert.equal((await findObject(title.id)).x, title.x + 72);
  const child = await findObject("legacy");
  await drag(hit("area-observe"), 43, 27);
  assert.deepEqual(
    [(await findObject("legacy")).x, (await findObject("legacy")).y],
    [child.x + 43, child.y + 27],
  );
  const card = await findObject("doc");
  await drag(hit("doc"), -31, 44);
  assert.equal((await findObject("doc")).y, card.y + 44);
  await expect(page.locator("#overlay [data-panel=preview-doc]")).toHaveCount(0);
  await hit("doc").click({ position: { x: 69, y: 25 } });
  await expect(page.locator("#overlay [data-panel=preview-doc]")).toBeVisible();
  await page.locator("#overlay [data-action=edit-doc]").click();
  assert.equal((await scene()).source.anchor, "第 3 段");
  await open("/board");
  await hit(title.id).click({ position: { x: 25, y: 15 } });
  await page.keyboard.press("Delete");
  await page.reload();
  assert.equal(await findObject(title.id), undefined);
  console.log(
    "PASS editable sample text, section with children, citation clicks versus drags, undo and reload",
  );

  await open("/home");
  await action("new-board").click();
  await page.locator("#ws-name-form input").fill("独立白板");
  await page.locator("#ws-name-form button").click();
  const id = (await scene()).boardId;
  assert(id.startsWith("board-"));
  assert.equal((await scene()).objects.length, 0);
  await page.keyboard.press("t");
  await page.mouse.click(400, 300);
  await page.locator("#editor").fill("独立内容");
  await page.locator("#editor").press("Control+Enter");
  const label = (await scene()).objects.find((o) => o.text === "独立内容");
  assert(label);
  await drag(hit(label.id), 85, 61);
  const moved = await findObject(label.id);
  await page.reload();
  assert.deepEqual(await findObject(label.id), moved);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.studioSharedUrl = text;
        },
      },
    });
  });
  const world = page.locator("#world");
  const originalCamera = await world.getAttribute("transform");
  await page.mouse.move(700, 420);
  await page.mouse.wheel(98, 80);
  await expect(world).not.toHaveAttribute("transform", originalCamera);
  const camera = await world.getAttribute("transform");
  await page.locator("#chrome [data-action=share]").click();
  await page.getByRole("menuitem", { name: "复制画布视图链接" }).click();
  const shared = await page.evaluate(() => window.studioSharedUrl);
  assert.equal(new URL(shared).hash.split("?")[0], "#/board/" + id);
  await open("/board");
  await page.goto(shared);
  assert.equal((await scene()).boardId, id);
  await expect(world).toHaveAttribute("transform", camera);
  await open("/board");
  assert.equal(await findObject(label.id), undefined);
  await open("/library/boards");
  await expect(page.locator("#ws-rows tbody tr")).toHaveCount(2);
  await page.locator('[data-ws=select-file][data-file="' + id + '"]').click();
  assert.equal((await scene()).boardId, id);
  assert.equal((await scene()).scope, "board");
  await open("/library/documents");
  await expect(page.locator("#ws-rows tbody tr")).toHaveCount(3);
  console.log(
    "PASS independent blank board, text persistence, scoped view links and file libraries",
  );

  await open("/document/campus-observations/p3");
  await action("choose-board").click();
  await page.locator('#ws-dialog [data-board="' + id + '"]').click();
  assert.equal((await scene()).boardId, id);
  await open("/library/documents");
  await expect(page.locator("#ws-detail [data-ws=backlink][data-anchor=p3]")).toHaveCount(2);
  await open("/board/" + id);
  await page.evaluate(() =>
    window.OfficeCLIWhiteboard.connectAgent({
      name: "本地验收",
      respond: () =>
        new Promise(
          (resolve) =>
            (window.finishStudioRequest = () =>
              resolve({ cards: [{ text: "异步白板卡" }], reply: "已追加" })),
        ),
    }),
  );
  await page.locator("#chrome [data-action=ai]").click();
  await page.locator("#draft").fill("做一张卡");
  await page.locator("#compose-send").click();
  await open("/board");
  await page.evaluate(() => window.finishStudioRequest());
  await page.waitForFunction(
    (owner) =>
      JSON.parse(localStorage.getItem("officecli-figjam-board/" + owner)).objects.some(
        (o) => o.text === "异步白板卡",
      ),
    id,
  );
  assert(!(await scene()).objects.some((o) => o.text === "异步白板卡"));
  await open("/integrations");
  await page.locator("[data-ws=embed-kind][data-kind=board]").click();
  const frame = page.frameLocator(".ws-embed-preview iframe");
  await expect(frame.locator("#board")).toBeVisible();
  await expect(frame.locator("[data-action=workspace-home]")).toBeHidden();
  await page.locator("[data-ws=embed-mode][data-mode=react]").click();
  await expect(page.locator("#ws-embed-code")).toContainText("EmbeddedHcdEditor");
  console.log(
    "PASS explicit target board, backlinks, delayed AI result ownership and standalone embedding",
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
