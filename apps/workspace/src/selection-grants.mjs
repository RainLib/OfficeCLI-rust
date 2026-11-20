import { randomUUID } from "node:crypto";
import { check, hash, now, random, uuid } from "./store.mjs";
import { documentId } from "./provider.mjs";
import { sheetTarget, selectedCells, relocateSheetSelection, sheetEdit } from "./workbench-targets.mjs";
import { textUndo, sheetUndo } from "./workbench-undo.mjs";
import { readCellRuns } from "./workbench-cell-runs.mjs";

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const stale = "选区或文件版本已改变，请在编辑器里重新选择。";
const textFormats = new Set(["docx", "md", "txt", "html"]);
const sheetFormats = new Set(["xlsx", "csv", "tsv"]);
export const supportsSelectionFormat = (format) =>
  format === "excalidraw" || sheetFormats.has(format) || textFormats.has(format);

function specLines(element) {
  const tag = element.customData?.officeBoard;
  if (
    element.type !== "text" ||
    tag?.kind !== "spec" ||
    !["body", "title"].includes(tag.part)
  )
    return;
  const text = element.originalText ?? element.text ?? "";
  return (
    element.customData.officeSpec?.blocks ??
    (text === " " ? "" : text).split("\n")
  );
}

function describeElement(element) {
  const { id, type, x, y, width, height, text, strokeColor, backgroundColor } =
    element;
  const lines = specLines(element);
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    text,
    strokeColor,
    backgroundColor,
    ...(lines && { specBlocks: lines.map((text, block) => ({ block, text })) }),
  };
}

function validateTarget(file, value) {
  const target = value?.target;
  check(
    integer(value?.revision) && integer(value?.collaborationEpoch),
    400,
    "选区需要修订和协作版本。",
  );
  if (sheetFormats.has(file.format) && target?.kind === "sheet")
    return sheetTarget(target);
  if (
    target?.kind === "append" &&
    (textFormats.has(file.format) || file.format === "excalidraw")
  )
    return { kind: "append" };
  if (file.format === "excalidraw" && target?.kind === "spec") {
    const {id,block,start,end,expected,anchor,head}=target;
    check(typeof id==="string" && id.length>0 && id.length<=256 && integer(block) && integer(start) && integer(end) && end>start && end-start<=8000 && typeof expected==="string" && Array.from(expected).length===end-start && [anchor,head].every(s=>typeof s==="string" && s.length<=128 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)),400,"请选择同一段中的一句话。");
    return {kind:"spec",id,block,start,end,expected,anchor,head};
  }
  if (file.format === "excalidraw") {
    const ids = target?.elementIds;
    check(
      target?.kind === "canvas" &&
        Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= 128 &&
        ids.every(
          (id) => typeof id === "string" && id.length > 0 && id.length <= 256,
        ) &&
        new Set(ids).size === ids.length,
      400,
      "请选择 1 至 128 个白板对象。",
    );
    return { kind: "canvas", elementIds: ids };
  }
  const spans = target?.spans;
  check(
    textFormats.has(file.format) &&
      target?.kind === "document" &&
      Array.isArray(spans) &&
      spans.length > 0 &&
      spans.length <= 64 &&
      spans.every(
        (s) =>
          typeof s?.blockId === "string" &&
          s.blockId.length > 0 &&
          s.blockId.length <= 256 &&
          integer(s.start) &&
          integer(s.end) &&
          s.start < s.end &&
          typeof s.textHash === "string" &&
          /^[a-f0-9]{64}$/.test(s.textHash),
      ) &&
      new Set(spans.map((s) => s.blockId)).size === spans.length,
    400,
    "请选择已保存的正文文字。",
  );
  return { kind: "document", spans };
}

// Replace only the selected Unicode scalars. Retain all surrounding text and its
// inline marks, and apply the first selected run's marks to the replacement.
export function replaceSpan(block, span, replacement) {
  const inlines = [];
  let at = 0,
    inserted = false;
  for (const { nodeId: _id, text, ...marks } of block.content.inlines) {
    const chars = Array.from(text),
      end = at + chars.length;
    if (end <= span.start || at >= span.end) inlines.push({ ...marks, text });
    else {
      const left = chars.slice(0, Math.max(0, span.start - at)).join("");
      const right = chars.slice(Math.max(0, span.end - at)).join("");
      const part = left + (inserted ? "" : replacement) + right;
      inserted = true;
      if (part) inlines.push({ ...marks, text: part });
    }
    at = end;
  }
  check(inserted, 409, stale);
  return {
    op: "block.replace",
    blockId: block.blockId,
    block: { ...block.content, inlines },
    precondition: { blockHash: block.blockHash },
  };
}

export function createSelectionGrants({ store, config, engine }) {
  const instances = new Map(),
    bearers = new Map();
  const activity = new Map(),
    watchers = new Map();
  function subscribe(userId, listener) {
    let listeners = watchers.get(userId);
    if (!listeners) watchers.set(userId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) watchers.delete(userId);
    };
  }
  function publish(userId) {
    for (const listener of watchers.get(userId) || []) listener();
  }
  function startActivity(userId, fileId, requestId, agentName) {
    for (const [key, old] of activity) if (old.until < now()) activity.delete(key);
    const event = { userId, fileId, requestId, agentName, phase: "editing", at: Date.now(), until: now() + 180 };
    activity.set(`${userId}:${fileId}:${requestId}`, event);
    publish(userId);
    return (revision) => {
      Object.assign(event, { phase: revision === undefined ? "failed" : "complete", revision, at: Date.now(), until: now() + 45 });
      publish(userId);
    };
  }
  function recentActivity(account) {
    const visible = [];
    for (const [key, event] of activity) {
      if (event.until < now()) {
        activity.delete(key);
        continue;
      }
      if (
        event.userId === account.user.id &&
        store
          .permissions(account.user, store.file(event.fileId))
          .includes("document.view")
      )
        visible.push({
          fileId: event.fileId,
          requestId: event.requestId,
          agentName: event.agentName,
          phase: event.phase,
          revision: event.revision,
          at: event.at,
        });
    }
    return visible;
  }

  function discard(slot) {
    if (slot?.grant) {
      bearers.delete(slot.grant.digest);
      slot.grant = null;
    }
  }
  function prune() {
    const time = now();
    for (const [key, slot] of instances) {
      if (slot.grant?.expiresAt <= time) discard(slot);
      if (slot.until <= time) instances.delete(key);
    }
  }
  function access(grant) {
    check(config.selectionMcp === true, 403, "此工作区未启用外部 Agent。");
    check(
      bearers.get(grant.digest) === grant && grant.expiresAt > now(),
      401,
      "选区授权已失效。",
    );
    const record = store.get(
      "SELECT l.response,l.expires,l.closed,s.expires AS browser_expires FROM launches l JOIN sessions s ON s.hash=l.browser_hash WHERE l.id=? AND l.user_id=? AND l.file_id=? AND s.hash=?",
      grant.launchId,
      grant.userId,
      grant.fileId,
      grant.browser,
    );
    check(
      record?.response &&
        !record.closed &&
        Math.min(record.expires, record.browser_expires) > now(),
      403,
      "编辑会话已结束。",
    );
    const user = store.user(grant.userId),
      file = store.file(grant.fileId);
    check(!user.is_guest, 403, "外部 Agent 需要成员授权。");
    store.permit(user, file, "document.view", "document.edit", "document.ai");
    const launch = JSON.parse(record.response);
    check(
      launch.documentId === grant.documentId &&
        typeof launch.token === "string" &&
        launch.token.length > 0 &&
        launch.expiresAt > now(),
      401,
      "请重新连接编辑器。",
    );
    grant.expiresAt = Math.min(
      grant.expiresAt,
      launch.expiresAt,
      record.expires,
      record.browser_expires,
    );
    return launch.token;
  }
  async function inspect(grant, specOnly = false) {
    const token = access(grant),
      path = "/v1/documents/" + grant.documentId;
    const board = grant.format === "excalidraw",
      sheet = grant.target.kind === "sheet";
    const [data, auth] = await Promise.all([
      engine(
        path +
          (sheet
            ? "/sheets/" + grant.target.sheetIndex
            : board
              ? "/canvas"
              : "/editor"),
        { token },
      ),
      engine(path + "/auth", { token }),
    ]);
    access(grant);
    check(
      (data.revision === grant.revision ||
        (grant.target.kind === "spec" && grant.sentenceVerified && data.revision >= grant.revision && data.revision-grant.revision<=10000) ||
        (specOnly && board && grant.specSources?.size)) &&
        auth.collaborationEpoch === grant.epoch,
      409,
      stale,
    );
    if (grant.target.kind === "spec") {
      const t=grant.target;
      const body=data.scene.elements.find(e=>e.id===t.id);
      const paper=body && data.scene.elements.find(e=>e.id===body.customData?.officeBoard?.root);
      check(body && specLines(body) && !body.locked && !body.isDeleted && paper?.customData?.officeBoard?.kind==="spec" && !paper.locked && !paper.isDeleted,409,stale);
      if (!grant.sentenceVerified) {
        const source=body;
        const line=source && specLines(source)?.[t.block];
        check(source?.customData?.officeBoard?.root===paper.id && typeof line==="string" && Array.from(line).slice(t.start,t.end).join("")===t.expected,409,stale);
        access(grant);
        grant.sentenceVerified=true;
      }
      return {};
    }
    if (sheet) {
      const cells = selectedCells(grant.target, data);
      grant.cellNodes = cells.map(({ cell }) => cell?.nodeId ?? null);
      return {
        cells,
        sheetName: data.sheetName,
      };
    }
    if (grant.target.kind === "append")
      return {
        afterBlockId: board
          ? null
          : (data.blocks.filter((b) => b.region === "body").at(-1)?.blockId ??
            null),
      };
    if (board) {
      const byId = new Map(data.scene.elements.map((e) => [e.id, e]));
      const elements = grant.target.elementIds.map((id) => byId.get(id));
      check(
        elements.every((e) => e && !e.isDeleted && !e.locked),
        409,
        "所选对象已删除或锁定。",
      );
      if (specOnly) {
        for (const el of elements.filter((e) => grant.specSources.has(e.id))) {
          const paper = byId.get(el.customData?.officeBoard?.root);
          check(
            specLines(el) &&
              paper?.customData?.officeBoard?.kind === "spec" &&
              !paper.isDeleted &&
              !paper.locked,
            409,
            stale,
          );
        }
      }
      return { elements, sceneRevision: data.revision };
    }
    const byId = new Map(data.blocks.map((b) => [b.blockId, b]));
    const spans = grant.target.spans.map((span) => {
      const block = byId.get(span.blockId);
      check(
        block &&
          !block.readOnly &&
          block.region === "body" &&
          block.content.kind !== "opaque",
        409,
        stale,
      );
      const chars = Array.from(
        block.content.inlines.map((run) => run.text).join(""),
      );
      const text = chars.slice(span.start, span.end).join("");
      check(
        span.end <= chars.length && hash(text) === span.textHash,
        409,
        stale,
      );
      return { block, span, text };
    });
    grant.spanSources = spans.map(({ block, text }) => {
      const value = block.content.inlines.map(run => run.text).join("");
      return { blockHash: block.blockHash, text, unique: value.indexOf(text) === value.lastIndexOf(text) };
    });
    return { spans };
  }
  async function set(account, value) {
    prune();
    check(config.selectionMcp === true, 403, "此工作区未启用外部 Agent。");
    check(
      value &&
        uuid(value.instanceId) &&
        integer(value.generation) &&
        value.generation > 0,
      400,
      "无效的嵌入实例或选区序号。",
    );
    const key = account.hash + ":" + value.instanceId;
    const previous = instances.get(key);
    check(!previous || previous.generation < value.generation, 409, stale);
    discard(previous);
    const slot = {
      generation: value.generation,
      until: account.expires,
      grant: null,
    };
    instances.set(key, slot);
    if (value.selection === null) return { revoked: true };
    const file = store.file(value.fileId);
    const id = documentId(config, file.id);
    check(
      uuid(value.launchId) && value.selection?.documentId === id,
      403,
      "选区与当前文件不匹配。",
    );
    const target = validateTarget(file, value.selection);
    const secret = random();
    const grant = {
      target,
      documentId: id,
      fileId: file.id,
      format: file.format,
      name: file.name,
      launchId: value.launchId,
      userId: account.user.id,
      browser: account.hash,
      digest: hash(secret),
      revision: value.selection.revision,
      epoch: value.selection.collaborationEpoch,
      expiresAt: Math.min(now() + 300, account.expires),
      busy: false,
    };
    slot.grant = grant;
    bearers.set(grant.digest, grant);
    try {
      const { elements } = await inspect(grant);
      if (elements) {
        grant.specSources = new Map(
          elements.flatMap((e) => {
            const lines = specLines(e);
            return lines ? [[e.id, lines]] : [];
          }),
        );
        if (
          grant.specSources.size &&
          elements.every((e) => e.customData?.officeBoard?.kind === "spec")
        ) {
          grant.specRead = elements.map(describeElement);
        }
      }
      check(instances.get(key) === slot, 409, stale);
      return {
        endpoint: new URL("/workspace/mcp/selection", config.publicUrl).href,
        token: secret,
        documentId: id,
        expiresAt: grant.expiresAt,
      };
    } catch (e) {
      discard(slot);
      throw e;
    }
  }

  function authenticate(header) {
    prune();
    const secret = /^Bearer ([\w-]{43})$/.exec(header || "")?.[1];
    const grant = secret && bearers.get(hash(secret));
    check(grant, 401, "需要有效的选区凭据。");
    access(grant);
    return grant;
  }

  function snapshot(grant) {
    access(grant);
    return { documentId: grant.documentId, revision: grant.revision, collaborationEpoch: grant.epoch,
      target: grant.target, cellNodes: grant.cellNodes, spanSources: grant.spanSources };
  }

  async function withWorkbenchSelection(account, file, launchId, launch, saved, use) {
    check(saved && saved.documentId === launch.documentId, 409, "请打开此文件并重新确认选区。");
    const base = "/v1/documents/" + saved.documentId;
    const original = saved.target;
    const [data, auth] = await Promise.all([
      engine(base + (original.kind === "sheet" ? "/sheets/" + original.sheetId : file.format === "excalidraw" ? "/canvas" : "/editor"),
        { token: launch.token }),
      engine(base + "/auth", { token: launch.token }),
    ]);
    check(auth.documentId === saved.documentId && integer(data.revision) && integer(auth.collaborationEpoch), 409, stale);
    let target = original;
    if (original.kind === "sheet") {
      target = data.revision === saved.revision
        ? { ...original, sheetIndex: data.sheetIndex }
        : relocateSheetSelection(original, data, saved.cellNodes);
    } else if (original.kind === "document" && data.revision !== saved.revision) {
      const blocks = new Map(data.blocks.map(block => [block.blockId, block]));
      const spans = original.spans.map((span, index) => {
        const block = blocks.get(span.blockId);
        const source = saved.spanSources?.[index];
        check(block && !block.readOnly && block.region === "body" && block.content.kind !== "opaque" && source, 409, stale);
        if (block.blockHash === source.blockHash) return span;
        const current = block.content.inlines.map(run => run.text).join("");
        const offset = current.indexOf(source.text);
        check(source.unique && offset >= 0 && current.lastIndexOf(source.text) === offset, 409, stale);
        const start = [...current.slice(0, offset)].length;
        return { ...span, start, end: start + span.end - span.start };
      });
      target = { ...original, spans };
    } else if (original.kind === "spec") {
      check(auth.collaborationEpoch === saved.collaborationEpoch, 409, stale);
    }
    const instanceId = randomUUID();
    const key = account.hash + ":" + instanceId;
    try {
      const authorization = await set(account, {
        instanceId, generation: 1, fileId: file.id, launchId,
        selection: { documentId: saved.documentId, revision: data.revision, collaborationEpoch: auth.collaborationEpoch, target },
      });
      return await use(authenticate("Bearer " + authorization.token));
    } finally {
      discard(instances.get(key));
      instances.delete(key);
    }
  }
  // Ephemeral activity is intentionally separate from grants and patches.
  // The same agent identity moves from the source to the committed range.
  function presenceIdentity(grant, actor) {
    grant.hostAgent ??= { id:randomUUID(), name:"墨点" };
    // The workbench planner and its own MCP client represent one participant.
    return !actor || (actor.client==="fold-project-agent" && actor.name===grant.hostAgent.name) ? grant.hostAgent : actor;
  }
  function agentHeaders(actor) {
    return {"X-HCD-Agent-Edit":"true","X-HCD-Agent-Presence-Id":actor.id,"X-HCD-Agent-Name":Buffer.from(actor.name).toString("base64url")};
  }
  function pulse(grant, clear=false, phase="idle", actor=presenceIdentity(grant)) {
    if(grant.target.kind!=="spec" || grant.receipt)return;
    const {id,anchor,head}=grant.target;
    const token=access(grant);

    grant.specSeq=(grant.specSeq||0)+1;
    void engine("/v1/documents/"+grant.documentId+"/canvas/presence",{method:"POST",token,headers:{"X-HCD-Collaboration-Epoch":String(grant.epoch),...agentHeaders(actor)},data:{clientId:actor.id,agentPhase:phase,specSeq:grant.specSeq,specCursor:clear?null:{id,anchor,head}}}).catch(()=>{});
  }
  function planning(grant) {
    if(grant.target.kind!=="spec")return ()=>{};
    pulse(grant);
    const timer=setInterval(()=>{try{pulse(grant)}catch{clearInterval(timer)}},3000);
    timer.unref();
    return (clear)=>{clearInterval(timer);if(clear){try{pulse(grant,true)}catch{}}};
  }
  async function prepareMutation(grant, name, args, captureUndo = false) {
    const expectedRevision = grant.revision;
    const board = grant.format === "excalidraw",
      sheet = grant.target.kind === "sheet",
      append = grant.target.kind === "append";
    check(
      name ===
        (append
          ? "append_to_file"
          : sheet
            ? "edit_selected_cells"
            : board && grant.target.kind !== "spec"
              ? "edit_canvas_selection"
              : "replace_selected_text"),
      400,
      "该工具不适用于当前选区。",
    );
    const specOnly =
      board &&
      !append &&
      Array.isArray(args.edits) &&
      args.edits.length > 0 &&
      args.edits.every(
        (e) =>
          grant.specSources?.has(e.id) &&
          e.specSplice &&
          Object.keys(e).every((k) => k === "id" || k === "specSplice"),
      );
    const { spans, elements, cells, afterBlockId } = await inspect(
      grant,
      specOnly,
    );
    const appended = append ? (captureUndo && args.items || [{ text: args.text, title: args.title }]) : [];
    let operations, textEdits;
    let batch,
      schemaVersion = board ? "officecli-canvas/1" : "hcd-patch/4";
    if(grant.target.kind==="spec") {
      const {id,block,start,end,expected}=grant.target;
      check(Array.isArray(args.replacements) && args.replacements.length===1 && typeof args.replacements[0]==="string" && args.replacements[0].length<=16000 && !/[\r\n]/.test(args.replacements[0]),400,"选句改写需要一段替换文字。");
      operations=[{op:"spec.splice",id,block,start,end,expected,insert:args.replacements[0]}];
    } else if (sheet)
      ({ operations, schemaVersion } = sheetEdit(
        grant.target,
        cells,
        args.edits,
      ));
    else if (append && board) {
      const planned = await engine(
        "/v1/documents/" + grant.documentId + "/canvas/layout",
        {
          token: access(grant),
          method: "POST",
          data: {
            expectedRevision: grant.revision,
            patchId: args.requestId,
            composition: {
              title: args.title || "工作笔记",
              layout: "grid",
              items: appended.map(({ text, title }) => ({ kind: "note", title: title || "笔记", body: text })),
            },
          },
        },
      );
      check(
        planned.collaborationEpoch === grant.epoch &&
          planned.batch?.vacantRegions?.length,
        409,
        stale,
      );
      batch = planned.batch;
      operations = batch.operations;
    } else if (append) {
      // All inserts share the existing anchor. Apply in reverse so the
      // paragraphs appear in the planned order after that anchor.
      operations = [...appended].reverse().map(({ text }) => ({
          op: "block.insert",
          afterBlockId,
          block: { kind: "paragraph", inlines: [{ text }] },
      }));
    } else if (spans) {
      check(
        args.replacements.length === spans.length && args.replacements.some(value => typeof value === "string"),
        400,
        "每个选区都需要一个替换文本。",
      );
      textEdits = spans.flatMap((source, i) => args.replacements[i] === null ? [] : [{ ...source, replacement: args.replacements[i] }]);
      operations = textEdits.map(({ block, span, replacement }) => replaceSpan(block, span, replacement));
    } else {
      const byId = new Map(elements.map((e) => [e.id, e]));
      check(
        new Set(args.edits.map((e) => e.id)).size === args.edits.length,
        400,
        "同一对象只能修改一次。",
      );
      operations = args.edits.map(
        ({ id, text, specSplice, strokeColor, backgroundColor, dx, dy }) => {
          const e = byId.get(id);
          check(e, 403, "对象位于已授权选区之外。");
          if (specSplice) {
            check(
              specOnly,
              400,
              "Spec 局部改写需要单独提交并指向授权的段落。",
            );
            const { block, start, end, expected, insert } = specSplice;
            const source = grant.specSources.get(id)[block];
            check(
              typeof source === "string" &&
                integer(block) &&
                typeof insert === "string" &&
                integer(start) &&
                integer(end) &&
                start <= end &&
                end <= Array.from(source).length &&
                Array.from(source).slice(start, end).join("") === expected,
              409,
              stale,
            );
            return {
              op: "spec.splice",
              id,
              block,
              start,
              end,
              expected,
              insert,
            };
          }
          const changes = {};
          if (text !== undefined) {
            check(e.type === "text", 400, "只有文字对象可以替换文字。");
            changes.text = text;
            changes.originalText = text;
          }
          if (strokeColor !== undefined) changes.strokeColor = strokeColor;
          if (backgroundColor !== undefined)
            changes.backgroundColor = backgroundColor;
          if (dx !== undefined) changes.x = e.x + dx;
          if (dy !== undefined) changes.y = e.y + dy;
          check(
            Object.keys(changes).length > 0,
            400,
            "请选择要修改的对象属性。",
          );
          return {
            op: "element.update",
            id,
            before: Object.fromEntries(
              Object.keys(changes).map((key) => [key, e[key] ?? null]),
            ),
            changes,
          };
        },
      );
    }
    const data = batch ?? {
      schemaVersion, documentId: grant.documentId, patchId: args.requestId, baseRevision: expectedRevision, operations,
    };
    const route = board ? "/canvas/patch" : sheet ? "/node-patch" : "/patch";
    const preview = append ? appended.map(({ title, text }) => ({ label: title || "新增内容", before: "", after: text }))
      : sheet ? args.edits.map(({ address, value }) => ({ label: address,
          before: cells.find(cell => cell.address === address)?.cell?.text ?? "", after: value }))
      : textEdits ? textEdits.map(({ text, replacement }) => ({ label: "选中文字", before: text, after: replacement }))
      : operations.flatMap(operation => operation.op === "spec.splice"
          ? [{ label: "Spec 选句", before: operation.expected, after: operation.insert }]
          : Object.entries(operation.changes).filter(([field]) => field !== "originalText").map(([field, after]) => ({
              label: { text: "白板文字", strokeColor: "描边", backgroundColor: "填充", x: "横向位置", y: "纵向位置" }[field] || field,
              before: operation.before[field], after,
            })));
    let undoCells = cells;
    if (captureUndo && sheet && grant.format === "xlsx") {
      const targets = new Set(args.edits.map(edit => edit.address));
      const runs = await readCellRuns(engine, access(grant), grant.documentId, grant.revision,
        cells.filter(entry => targets.has(entry.address)).map(entry => entry.cell));
      access(grant);
      undoCells = cells.map(entry => ({ ...entry, cell: entry.cell && { ...entry.cell,
        ...(runs.has(entry.cell.nodeId) && { xlsxRuns: runs.get(entry.cell.nodeId) }) } }));
    }
    const undo = !captureUndo ? undefined : textEdits ? textUndo(textEdits, operations, textEdits.map(edit => edit.replacement))
      : sheet ? sheetUndo(grant.target, undoCells, args.edits, grant.format)
      : !append && board && operations.every(operation => operation.op === "element.update") &&
        !operations.some(operation => Object.hasOwn(operation.changes, "text") && specLines(elements.find(element => element.id === operation.id)))
        ? { kind: "canvas" } : undefined;
    return { route, data, epoch: grant.epoch, strict: !specOnly && grant.target.kind !== "spec", preview, undo };
  }

  async function commitPrepared(token, prepared, actor) {
    return engine("/v1/documents/" + prepared.data.documentId + prepared.route, {
      token, method: "POST",
      headers: {
        "X-HCD-Collaboration-Epoch": String(prepared.epoch),
        ...agentHeaders(actor),
        ...(prepared.strict && { "X-HCD-Expected-Revision": String(prepared.data.baseRevision) }),
        ...(prepared.preserveReferences && { "X-HCD-Preserve-References": "true" }),
      },
      data: prepared.data,
    });
  }

  async function prepareReview(grant, jobId, name, args) {
    access(grant);
    check(!grant.receipt && !grant.busy && !grant.review, 409, "选区已用于其他提交，请重新选择。");
    grant.review = jobId;
    try { return await prepareMutation(grant, name, args, true); }
    catch (error) { delete grant.review; throw error; }
  }

  async function call(grant, name, args, identity) {
    const actor = presenceIdentity(grant, identity);
    access(grant);
    if (name === "read_selection") {
      const { elements, spans, cells, sheetName, sceneRevision } =
        await inspect(grant, !!grant.specRead);
      // Before a one-use edit, offsets refer to the consented snapshot. Once
      // committed, return the current projection so the caller can verify its work.
      if (grant.target.kind === "spec") {
        const {id,block,start,end,expected}=grant.target;
        pulse(grant,false,"idle",actor);
        return { documentId:grant.documentId,file:grant.name,revision:grant.revision,kind:"spec",format:grant.format,spans:[{blockId:id,block,start,end,text:expected}],...(grant.receipt && {receipt:grant.receipt}) };
      }
      const pinned = grant.specRead && !grant.receipt;
      return {
        documentId: grant.documentId,
        file: grant.name,
        revision: grant.specRead && !pinned ? sceneRevision : grant.revision,
        kind: grant.target.kind,
        format: grant.format,
        ...(grant.target.kind === "append"
          ? {}
          : cells
            ? {
                sheetName,
                cells: cells.map(({ address, cell }) => ({
                  address,
                  text: cell?.text || "",
                  formula: cell?.formula || null,
                })),
              }
            : spans
              ? {
                  spans: spans.map(({ span, text }) => ({
                    blockId: span.blockId,
                    start: span.start,
                    end: span.end,
                    text,
                  })),
                }
              : {
                  elements: pinned
                    ? grant.specRead
                    : elements.map(describeElement),
                }),
      };
    }
    const intent = JSON.stringify([name, args]);
    if (grant.receipt && grant.intent === intent) return grant.receipt;
    check(
      !grant.receipt && !grant.busy && !grant.review,
      409,
      "当前授权正在提交或已经使用，请重新选择。",
    );
    grant.busy = true;
    const finish = startActivity(grant.userId, grant.fileId, args.requestId, actor.name);
    try {
      const prepared = await prepareMutation(grant, name, args);
      pulse(grant, false, "writing", actor);
      const result = await commitPrepared(access(grant), prepared, actor);
      const receipt = {
        documentId: grant.documentId,
        requestId: args.requestId,
        revision: result.revision ?? result.newRevision,
        changed: prepared.data.operations.length,
        ...(grant.target.kind==="spec" && {specUndo:{id:grant.target.id,revision:result.revision,epoch:grant.epoch}}),
      };
      grant.receipt = receipt;
      grant.intent = intent;
      store.audit(grant.userId, "embed.selection.edited", grant.fileId);
      return receipt;
    } finally {
      grant.busy = false;
      finish(grant.receipt?.revision);
    }
  }
  return { set, authenticate, call, recentActivity, subscribe, planning, snapshot, withWorkbenchSelection,
    prepareReview, commitPrepared, startActivity };
}
