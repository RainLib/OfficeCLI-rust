// The local example can exercise the same paragraph operation as a connected model.
// Only a single literal occurrence identifies a target without guessing.
export function planSpecPhrase(prompt, elements) {
  if (!elements.some((e) => e.specBlocks)) return;
  const match =
    /^(?:请)?(?:把|将)\s*[「“]([^」”\n]+)[」”]\s*(?:改为|改成|替换为|替换成)\s*[「“]([^」”\n]*)[」”][。！!]?$/u.exec(
      prompt.trim(),
    );
  if (!match) return;
  const [, expected, insert] = match;
  const hits = [];
  for (const { id, specBlocks = [] } of elements) {
    for (const { block, text } of specBlocks) {
      const offset = text.indexOf(expected);
      if (offset < 0) continue;
      if (hits.length || text.indexOf(expected, offset + 1) !== -1)
        return { reply: "这段原文出现多次，请多选几个相邻字来定位。" };
      const start = Array.from(text.slice(0, offset)).length;
      hits.push({
        id,
        specSplice: {
          block,
          start,
          end: start + Array.from(expected).length,
          expected,
          insert,
        },
      });
    }
  }
  return hits.length
    ? { edits: hits }
    : { reply: "当前 Spec 没有找到这段原文。" };
}
