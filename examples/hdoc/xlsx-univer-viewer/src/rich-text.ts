import type { ICellData, IDocumentData, IStyleData, ITextStyle } from '@univerjs/presets';

export interface XlsxInlineRun {
  text: string;
  properties: Record<string, Record<string, string>>;
}

type TextStyle = ITextStyle | undefined;
type Scalar = { text: string; style: TextStyle; properties: XlsxInlineRun['properties'] };
const key = (properties: XlsxInlineRun['properties']) => JSON.stringify(Object.entries(properties)
  .sort(([a], [b]) => a.localeCompare(b)).map(([name, attributes]) => [name, Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))]));

export function mergeInlineRuns(runs: XlsxInlineRun[]): XlsxInlineRun[] {
  const result: XlsxInlineRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const previous = result.at(-1);
    if (previous && key(previous.properties) === key(run.properties)) previous.text += run.text;
    else result.push(structuredClone(run));
  }
  return result.length ? result : [{ text: '', properties: {} }];
}

export function validateInlineRuns(value: unknown, text: string): asserts value is XlsxInlineRun[] {
  if (!Array.isArray(value) || !value.length || value.length > 4096 || text.length > 32767) throw new Error('富文本输入超过单元格范围');
  for (const run of value) {
    if (!run || typeof run.text !== 'string' || !run.properties || typeof run.properties !== 'object'
      || Array.isArray(run.properties) || Object.values(run.properties).some(attributes => !attributes
        || typeof attributes !== 'object' || Array.isArray(attributes) || Object.values(attributes).some(v => typeof v !== 'string' || v.length > 256))) {
      throw new Error('富文本输入格式损坏');
    }
  }
  if (value.map(run => run.text).join('') !== text) throw new Error('富文本与单元格内容不一致');
}

export function documentFromInlineRuns(runs: XlsxInlineRun[], nodeId: string, base: IStyleData = {}): IDocumentData {
  let text = '';
  const textRuns = runs.map(run => {
    const st = text.length, p = run.properties, value = (name: string) => p[name]?.val;
    text += run.text.replaceAll('\n', '\r');
    const ts: ITextStyle = { ff: base.ff, fs: base.fs, cl: base.cl, bl: base.bl, it: base.it, ul: base.ul, st: base.st, va: base.va };
    if (p.rFont) ts.ff = value('rFont');
    if (p.sz) ts.fs = Number(value('sz'));
    if (p.color?.rgb) ts.cl = { rgb: `#${p.color.rgb.slice(-6)}` };
    for (const [property, field] of [['b', 'bl'], ['i', 'it']] as const) {
      if (p[property]) ts[field] = ['0', 'false', 'off'].includes(value(property) ?? '') ? 0 : 1;
    }
    if (p.u) ts.ul = { s: value('u') === 'none' ? 0 : 1 };
    if (p.strike) ts.st = { s: ['0', 'false', 'off'].includes(value('strike') ?? '') ? 0 : 1 };
    if (p.vertAlign) ts.va = value('vertAlign') === 'superscript' ? 3 : value('vertAlign') === 'subscript' ? 2 : 1;
    return { st, ed: text.length, ts };
  });
  const paragraphs = [...text.matchAll(/\r/g)].map(match => ({ startIndex: match.index }));
  paragraphs.push({ startIndex: text.length });
  return { id: `hcd-rich-${nodeId}`, documentStyle: {}, body: { dataStream: `${text}\r\n`, textRuns,
    paragraphs, sectionBreaks: [{ startIndex: text.length + 1 }] } };
}

export function inheritInlineRuns(runs: XlsxInlineRun[], text: string): XlsxInlineRun[] {
  const oldText = runs.map(run => run.text).join('');
  return mergeInlineRuns(inheritEditedScalars(scalars(oldText, undefined, {}, runs), text)
    .map(scalar => ({ text: scalar.text, properties: scalar.properties })));
}

function scalars(text: string, doc: ICellData['p'], base: IStyleData, native: XlsxInlineRun[]): Scalar[] {
  const source = native.flatMap(run => [...run.text].map(() => run.properties));
  const runs = [...(doc?.body?.textRuns ?? [])].sort((a, b) => a.st - b.st);
  const result: Scalar[] = [];
  let offset = 0, cursor = 0;
  for (const character of text) {
    while (cursor < runs.length && runs[cursor].ed <= offset) cursor++;
    const run = runs[cursor];
    if (run && run.st < offset + character.length && run.ed > offset
      && (run.st > offset || run.ed < offset + character.length)) throw new Error('富文本范围不能截断 Unicode 字符');
    result.push({ text: character, properties: source[result.length] ?? {},
      style: { ...base, ...(run && run.st <= offset && run.ed > offset ? run.ts : {}) } });
    offset += character.length;
  }
  return result;
}

function inheritEditedScalars(before: Scalar[], text: string): Scalar[] {
  const after = [...text];
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix].text === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1].text === after[after.length - suffix - 1]) suffix++;
  const deleting = before.length - prefix - suffix;
  const inherited = before[deleting ? prefix : Math.max(0, prefix - 1)] ?? before.at(-1)
    ?? { text: '', style: {}, properties: {} };
  return [...before.slice(0, prefix), ...after.slice(prefix, after.length - suffix).map(character => ({ ...inherited, text: character })),
    ...before.slice(before.length - suffix)];
}

function color(value: TextStyle): string {
  const rgb = value?.cl?.rgb;
  if (typeof rgb !== 'string') return '000000';
  const source = rgb.trim();
  if (/^#?[\da-f]{6}$/i.test(source)) return source.replace(/^#/, '').toUpperCase();
  if (/^#[\da-f]{3}$/i.test(source)) return [...source.slice(1)].map(v => v + v).join('').toUpperCase();
  // Native HTML clipboard import uses CSS rgb()/rgba(), while the sheet
  // renderer and native XLSX use hexadecimal colours.
  const css = /^rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(source);
  if (css) {
    const channels = css.slice(1, 4).map(v => Number.parseFloat(v) * (v.endsWith('%') ? 255 / 100 : 1));
    const alpha = css[4] === undefined ? 1 : Number.parseFloat(css[4]) / (css[4].endsWith('%') ? 100 : 1);
    if (alpha === 1 && channels.every(v => Number.isFinite(v) && v >= 0 && v <= 255)) {
      return channels.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    }
  }
  throw new Error('请选择不透明的 RGB 文字颜色');
}

/** Compare the native editor with its original painted styles. Only changed
 * properties overwrite native metadata; theme/charset/scheme survive edits. */
export function editedInlineRuns(text: string, doc: ICellData['p'], original: {
  text: string; richText?: ICellData['p']; inlineRuns?: XlsxInlineRun[]; baseStyle?: IStyleData;
}): XlsxInlineRun[] | null {
  if (!doc?.body) return null;
  if (text.length > 32767 || (doc.body.textRuns?.length ?? 0) > 4096) throw new Error('富文本输入超过单元格范围');
  const body = doc.body;
  const stream = body.dataStream.endsWith('\r\n') ? body.dataStream.slice(0, -2) : body.dataStream;
  if (stream.replaceAll('\r', '\n') !== text) {
    // Plain-text formula-bar writes can leave the former document attached
    // until the local acknowledgement. They are handled by text.splice.
    if (stream.replaceAll('\r', '\n') === original.text && text !== original.text) return null;
    throw new Error('富文本与单元格内容不一致，已保留原单元格');
  }
  if (body.customBlocks?.length || body.customRanges?.length || body.tables?.length) {
    throw new Error('单元格暂不支持嵌入对象或链接，请粘贴纯文字');
  }
  const base = original.baseStyle ?? {};
  const inherited = inheritEditedScalars(scalars(original.text, original.richText, base,
    original.inlineRuns?.length ? original.inlineRuns : [{ text: original.text, properties: {} }]), text);
  const actual = scalars(text, doc, base, []);
  let changed = false;
  const output: XlsxInlineRun[] = [];
  for (let i = 0; i < actual.length; i++) {
    const old = inherited[i], next = actual[i];
    const previous = old.style ?? {}, style = next.style ?? {};
    const properties = structuredClone(old.properties);
    const set = (name: string, attributes: Record<string, string>) => { properties[name] = attributes; changed = true; };
    for (const [field, property] of [['bl', 'b'], ['it', 'i']] as const) {
      if (Number(style[field] ?? 0) !== Number(previous[field] ?? 0)) set(property, { val: style[field] ? '1' : '0' });
    }
    for (const [field, property] of [['ul', 'u'], ['st', 'strike']] as const) {
      if (Number(style[field]?.s ?? 0) !== Number(previous[field]?.s ?? 0)) {
        set(property, { val: property === 'u' ? style[field]?.s ? 'single' : 'none' : style[field]?.s ? '1' : '0' });
      }
    }
    if ((style.ff ?? 'Arial') !== (previous.ff ?? 'Arial')) {
      set('rFont', { val: style.ff ?? 'Arial' });
      delete properties.scheme;
    }
    if ((style.fs ?? 11) !== (previous.fs ?? 11)) set('sz', { val: String(style.fs ?? 11) });
    if (color(style) !== color(previous)) {
      const rgb = color(style);
      if (!/^[\dA-F]{6}$/.test(rgb)) throw new Error('请选择不透明的 RGB 文字颜色');
      set('color', { rgb: `FF${rgb}` });
    }
    if ((style.va ?? 1) !== (previous.va ?? 1)) {
      set('vertAlign', { val: style.va === 2 ? 'subscript' : style.va === 3 ? 'superscript' : 'baseline' });
    }
    if (JSON.stringify(style.bg ?? null) !== JSON.stringify(previous.bg ?? null)) throw new Error('暂不支持单元格内局部背景色，请使用文字颜色或整格填充');
    output.push({ text: next.text, properties });
  }
  return changed ? mergeInlineRuns(output) : null;
}
