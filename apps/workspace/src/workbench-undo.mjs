import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { check } from "./store.mjs";
import { readCellRuns } from "./workbench-cell-runs.mjs";

const changed = "这次修改的内容或位置已变化，已保留现有编辑。";
const text = (runs) => runs.map(run => run.text).join("");
const length = (value) => Array.from(value).length;

function sliceRuns(runs, start, end) {
  let at = 0;
  const sliced = [];
  for (const { nodeId: _node, text: value, ...style } of runs) {
    const chars = Array.from(value);
    const part = chars.slice(Math.max(0, start - at), Math.max(0, end - at)).join("");
    if (part) {
      const last = sliced.at(-1);
      if (last && isDeepStrictEqual(last.style, style)) last.text += part;
      else sliced.push({ style, text: part });
    }
    at += chars.length;
    if (at >= end) break;
  }
  return sliced.map(({ style, text }) => ({ ...style, text }));
}

export function textUndo(spans, operations, replacements) {
  return { kind: "text", blocks: spans.map(({ block, span }, i) => {
    const after = operations[i].block.inlines;
    return {
      id: block.blockId, start: span.start, resultingText: text(after),
      before: sliceRuns(block.content.inlines, span.start, span.end),
      after: sliceRuns(after, span.start, span.start + length(replacements[i])),
    };
  }) };
}

function rangeFor(current, edit) {
  const result = Array.from(edit.resultingText);
  const replacement = text(edit.after);
  const size = length(replacement);
  if (current === edit.resultingText) return [edit.start, edit.start + size];
  const prefix = result.slice(Math.max(0, edit.start - 24), edit.start).join("");
  const suffix = result.slice(edit.start + size, edit.start + size + 24).join("");
  const probe = prefix + replacement + suffix;
  const at = current.indexOf(probe);
  check(probe && (prefix || suffix) && at >= 0 && current.indexOf(probe, at + 1) === -1, 409, changed);
  const start = length(current.slice(0, at) + prefix);
  return [start, start + size];
}

function insertionRanges(original, live, start, end) {
  // When the prior text is a subsequence, all shortest alignments preserve every
  // prior character. Earliest/latest matches prove uniqueness in linear time.
  const earliest = new Uint32Array(original.length);
  let cursor = 0;
  for (let i = 0; i < original.length; i++) {
    while (cursor < live.length && original[i] !== live[cursor]) cursor++;
    if (cursor === live.length) return null;
    earliest[i] = cursor++;
  }
  cursor = live.length - 1;
  let right = live.length;
  for (let i = original.length - 1; i >= 0; i--) {
    while (live[cursor] !== original[i]) cursor--;
    if (i >= start && i < end) check(earliest[i] === cursor, 409, changed);
    if (i === start) right = cursor;
    cursor--;
  }
  if (start === end) {
    const left = start ? earliest[start - 1] + 1 : 0;
    check(left === right, 409, changed);
    return [[left, left]];
  }
  const ranges = [];
  for (let i = start; i < end; i++) {
    const position = earliest[i], last = ranges.at(-1);
    if (last && last[1] === position) last[1]++;
    else ranges.push([position, position + 1]);
  }
  return ranges;
}

// Track only characters that every shortest insert/delete alignment attributes
// to the AI result. Ambiguous matches are refused rather than deleting a peer's
// identical text. Bound quadratic work when surrounding text was also removed.
function aiRanges(current, edit, budget) {
  const original = Array.from(edit.resultingText), live = Array.from(current);
  const start = edit.start, end = start + length(text(edit.after));
  check(Number.isSafeInteger(start) && start >= 0 && end <= original.length, 409, changed);
  if (current === edit.resultingText) return [[start, end]];
  const inserted = insertionRanges(original, live, start, end);
  if (inserted) return inserted;
  const width = live.length + 1, cells = (original.length + 1) * width;
  if (original.length > 32768 || live.length > 32768 || cells > budget.remaining) return [rangeFor(current, edit)];
  budget.remaining -= cells;

  const forward = new Uint16Array(cells), backward = new Uint16Array(cells);
  for (let i = 1; i <= original.length; i++) {
    for (let j = 1; j <= live.length; j++) {
      const at = i * width + j;
      forward[at] = original[i - 1] === live[j - 1] ? forward[at - width - 1] + 1
        : Math.max(forward[at - width], forward[at - 1]);
    }
  }
  for (let i = original.length - 1; i >= 0; i--) {
    for (let j = live.length - 1; j >= 0; j--) {
      const at = i * width + j;
      backward[at] = original[i] === live[j] ? backward[at + width + 1] + 1
        : Math.max(backward[at + width], backward[at + 1]);
    }
  }
  const best = forward[original.length * width + live.length];
  if (start === end) {
    let position = -1;
    for (let j = 0; j <= live.length; j++) {
      const at = start * width + j;
      if (forward[at] + backward[at] !== best) continue;
      check(position === -1, 409, changed);
      position = j;
    }
    check(position >= 0, 409, changed);
    return [[position, position]];
  }

  const ranges = [];
  for (let i = start; i < end; i++) {
    let position = -1;
    for (let j = 0; j <= live.length; j++) {
      const at = i * width + j;
      // If any optimal alignment can discard this AI character, its identity
      // is uncertain even when another alignment happens to match it.
      check(forward[at] + backward[at + width] !== best, 409, changed);
      if (j < live.length && original[i] === live[j] &&
          forward[at] + 1 + backward[at + width + 1] === best) {
        check(position === -1, 409, changed);
        position = j;
      }
    }
    check(position >= 0 && (!ranges.length || position >= ranges.at(-1)[1]), 409, changed);
    const last = ranges.at(-1);
    if (last && last[1] === position) last[1]++;
    else ranges.push([position, position + 1]);
  }
  return ranges;
}

function joinedRuns(parts) {
  const result = [];
  for (const { text: value, ...style } of parts.flat()) {
    if (!value) continue;
    const last = result.at(-1);
    if (last && isDeepStrictEqual(last.style, style)) last.text += value;
    else result.push({ style, text: value });
  }
  return result.map(({ style, text: value }) => ({ ...style, text: value }));
}

export function reverseText(blocks, undo) {
  const byId = new Map(blocks.map(block => [block.blockId, block]));
  const budget = { remaining: 4_000_000 };
  return undo.blocks.map(edit => reverseBlock(byId.get(edit.id), edit, budget));
}

function reverseBlock(block, edit, budget) {
  check(block && !block.readOnly && block.region === "body", 409, changed);
  const current = block.content.inlines;
  return {
    op: "block.replace", blockId: edit.id, precondition: { blockHash: block.blockHash },
    block: { ...block.content, inlines: restoredRuns(current, edit, budget) },
  };
}

function restoredRuns(current, edit, budget) {
  const ranges = aiRanges(text(current), edit, budget);
  const removed = joinedRuns(ranges.map(([start, end]) => sliceRuns(current, start, end)));
  check(isDeepStrictEqual(removed, joinedRuns([edit.after])), 409, changed);
  const kept = [sliceRuns(current, 0, ranges[0][0]), edit.before];
  for (let i = 1; i < ranges.length; i++) kept.push(sliceRuns(current, ranges[i - 1][1], ranges[i][0]));
  kept.push(sliceRuns(current, ranges.at(-1)[1], Number.MAX_SAFE_INTEGER));
  return joinedRuns(kept);
}

function insertedBlockId(documentId, patchId, index) {
  // Match hcd_core::stable_node_id and StructureOperation::Insert. Verify every
  // derived identity against the author's receipt; never pair by display order.
  const hash = createHash("sha256");
  for (const part of [documentId, patchId, String(index), "block"]) {
    const bytes = Buffer.from(part), size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size); hash.update(bytes);
  }
  return "n_" + hash.digest("hex").slice(0, 32);
}

function canonicalInsertedRuns(runs) {
  // Insert requests can omit serde defaults that the current projection emits.
  return runs.map(({ nodeId: _node, bold = false, italic = false, link, format, ...run }) => {
    const marks = format && Object.fromEntries(Object.entries(format).filter(([, value]) => value !== false && value != null));
    return { ...run, bold, italic, ...(link != null && { link }),
      ...(marks && Object.keys(marks).length && { format: marks }) };
  });
}

export function sheetUndo(target, cells, edits, format) {
  const selected = new Map(cells.map(entry => [entry.address, entry]));
  return { kind: "sheet", sheetId: target.sheetId, ...(format && { format }), edits: edits.map(({ address, value }) => {
    const { cell, row, column } = selected.get(address);
    if (!cell) return { created: { row, column }, after: value, mergeText: true,
      ...(format === "xlsx" && { beforeRuns: [], afterRuns: [{ text: value, properties: {} }] }) };
    const number = cell.numberEditable && cell.valueType === "number";
    let rich;
    if (!number && format === "xlsx") {
      check(Array.isArray(cell.xlsxRuns) && cell.xlsxRuns.length && text(cell.xlsxRuns) === cell.text, 409,
        "无法核对单元格的原始文字格式。");
      const inherited = value ? cell.xlsxRuns.find(run => run.text) ?? cell.xlsxRuns[0] : cell.xlsxRuns[0];
      rich = { beforeRuns: structuredClone(cell.xlsxRuns), afterRuns: [{ text: value, properties: structuredClone(inherited.properties) }] };
    }
    return { nodeId: cell.nodeId, before: number ? cell.numberValue : cell.text, after: value, number,
      ...(!number && { mergeText: true }), ...rich };
  }) };
}

export function reverseCells(sheet, undo, receipt) {
  check(sheet.sheetId === undo.sheetId, 409, changed);
  const byId = new Map(sheet.cells.map(cell => [cell.nodeId, cell]));
  const budget = { remaining: 4_000_000 };
  return undo.edits.map(({ nodeId, before, after, number, created, mergeText, beforeRuns, afterRuns }) => {
    let cell, original;
    if (created) {
      original = receipt?.added?.find(entry => entry.sheetId === undo.sheetId &&
        entry.row === created.row && entry.column === created.column);
      cell = original && byId.get(original.id);
    } else cell = byId.get(nodeId);
    check(cell && !cell.formula, 409, changed);
    const precondition = { nodeHash: cell.nodeHash };
    if (number) {
      check(cell.numberEditable && cell.valueType === "number" && cell.numberValue === after && typeof before === "string", 409, changed);
      return { op: "xlsx.number.set", nodeId, sheetId: undo.sheetId, value: before, precondition };
    }
    check(cell.textEditable && (created || typeof before === "string"), 409, changed);
    if (mergeText) check(cell.valueType === "string", 409, changed);
    if (!mergeText) check(cell.text === after, 409, changed);
    const rich = undo.format === "xlsx" && mergeText;
    if (rich) check(cell.valueType === "string" && Array.isArray(cell.xlsxRuns) && afterRuns && beforeRuns, 409, changed);
    const current = rich ? cell.xlsxRuns : [{ text: cell.text }];
    const restored = mergeText ? restoredRuns(current, {
      start: 0, resultingText: after,
      before: rich ? beforeRuns : created ? [] : [{ text: before }],
      after: rich ? afterRuns : [{ text: after }],
    }, budget) : [{ text: before }];
    if (created && cell.text === after && cell.nodeHash === original.hash) {
      return { op: "xlsx.cell.clear", nodeId: cell.nodeId, sheetId: undo.sheetId, createdRevision: receipt.revision,
        precondition: { nodeHash: original.hash } };
    }
    if (rich) return { op: "xlsx.richText.set", nodeId: cell.nodeId, precondition,
      runs: restored.length ? restored : [{ text: "", properties: beforeRuns[0]?.properties ?? current[0]?.properties ?? {} }] };
    return { op: "text.splice", nodeId: cell.nodeId, start: 0, deleteCount: length(cell.text), insertText: text(restored), precondition };
  });
}

export function undoIntent(prepared) {
  if (prepared?.undo) return prepared.undo;
  const operations = prepared?.data.operations;
  if (!operations?.length) return;
  // Persisted jobs from before append undo also carry the exact approved patch.
  if (prepared.route === "/patch" && operations.every(item => item.op === "block.insert")) return { kind: "text-append" };
  if (prepared.route === "/canvas/patch" && operations.every(item => item.op === "element.add")) return { kind: "canvas-append" };
  const sheetId = operations[0].sheetId;
  if (prepared.route === "/node-patch" && sheetId &&
    operations.every(op => op.op === "xlsx.cell.set" && op.sheetId === sheetId)) {
    return { kind: "sheet", sheetId, edits: operations.map(op => ({
      created: { row: op.row, column: op.column }, after: op.text,
    })) };
  }
}

export function reverseAppend(current, prepared, added) {
  const { operations } = prepared.data;
  check(Array.isArray(added) && added.length === operations.length &&
    new Set(added.map(item => item.id)).size === added.length, 409, "无法核对本次新增的完整内容。");
  if (prepared.route === "/canvas/patch") {
    const ids = new Set(operations.map(item => item.element.id));
    return added.map(({ id, hash }) => {
      check(ids.has(id) && Object.hasOwn(current.hashes, id) && current.hashes[id] === hash, 409, changed);
      return { op: "element.remove", id, expectedHash: hash };
    });
  }
  const byId = new Map(current.blocks.map(block => [block.blockId, block]));
  const originals = new Map(operations.map((operation, index) =>
    [insertedBlockId(prepared.data.documentId, prepared.data.patchId, index), operation.block]));
  const budget = { remaining: 4_000_000 };
  return added.map(({ id, hash }) => {
    const block = byId.get(id), original = originals.get(id);
    check(block && original && !block.readOnly && block.region === "body", 409, changed);
    if (block.blockHash === hash) return { op: "block.delete", blockId: id, precondition: { blockHash: hash } };
    return reverseBlock(block, { id, start: 0, resultingText: text(original.inlines), before: [],
      after: canonicalInsertedRuns(original.inlines) }, budget);
  });
}

export async function prepareUndo(engine, token, prepared, receipt) {
  const { documentId, operations: forward } = prepared.data;
  const undo = undoIntent(prepared);
  const path = `/v1/documents/${documentId}`;
  const endpoint = prepared.route === "/canvas/patch" ? "/canvas" : undo.kind === "sheet" ? `/sheets/${undo.sheetId}` : "/editor";
  const [current, auth] = await Promise.all([engine(path + endpoint, { token }), engine(path + "/auth", { token })]);
  check(auth.documentId === documentId && Number.isSafeInteger(auth.collaborationEpoch), 409, "当前文件版本不可确认。");
  let operations, schemaVersion;
  if (undo.kind.endsWith("-append")) {
    operations = reverseAppend(current, prepared, receipt?.added);
    schemaVersion = prepared.data.schemaVersion;
  } else if (undo.kind === "canvas") {
    const live = new Map(current.scene.elements.map(element => [element.id, element]));
    check(forward.every(edit => {
      const element = live.get(edit.id);
      return element && !element.isDeleted && !element.locked && Object.entries(edit.changes).every(([field, value]) => isDeepStrictEqual(element[field] ?? null, value));
    }), 409, changed);
    operations = forward.map(({ id, op, before, changes }) => ({ id, op, before: changes, changes: before }));
    schemaVersion = "officecli-canvas/1";
  } else if (undo.kind === "sheet") {
    if (undo.format === "xlsx") {
      const ids = new Set(undo.edits.filter(edit => !edit.number).map(edit => edit.nodeId ?? receipt?.added?.find(entry =>
        entry.sheetId === undo.sheetId && entry.row === edit.created?.row && entry.column === edit.created?.column)?.id));
      const runs = await readCellRuns(engine, token, documentId, current.revision, current.cells.filter(cell => ids.has(cell.nodeId)));
      current.cells = current.cells.map(cell => ({ ...cell, ...(runs.has(cell.nodeId) && { xlsxRuns: runs.get(cell.nodeId) }) }));
    }
    operations = reverseCells(current, undo, receipt);
    schemaVersion = operations.some(op => op.op === "xlsx.richText.set") ? "hcd-patch/65"
      : operations.some(op => op.op === "xlsx.cell.clear") ? "hcd-patch/54"
      : operations.some(op => op.op === "xlsx.number.set") ? "hcd-patch/29" : "hcd-patch/1";
    if (schemaVersion === "hcd-patch/65") {
      const capabilities = await engine(path + "/capabilities", { token });
      check(capabilities.patchSchemas?.[schemaVersion]?.route === "/node-patch" &&
        ["xlsx.richText.set", "xlsx.number.set", "xlsx.cell.clear"].every(op => capabilities.patchSchemas[schemaVersion].operations?.includes(op)),
      409, "文档服务尚不支持保留文字格式的整批撤销，请更新服务后重试。");
    }
  } else {
    operations = reverseText(current.blocks, undo);
    schemaVersion = "hcd-patch/4";
  }
  // Ordinary host edits also replace the collaboration room. Selective undo
  // checks the actual edited content and uses the current room's epoch.
  return { route: prepared.route, epoch: auth.collaborationEpoch, strict: undo.kind !== "canvas",
    preserveReferences: undo.kind === "canvas-append",
    data: { schemaVersion, documentId, patchId: randomUUID(), baseRevision: current.revision, operations } };
}
