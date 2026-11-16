import { type ImageEdits } from './imageRender.ts'

export type ImageStroke = { points: [number, number][]; size: number; erase: boolean }
export type ImageInput = {
  schemaVersion: 'hcd-image-input/1'; baseRevision: number; width: number; height: number
  edits: ImageEdits; strokes: ImageStroke[]; cropSelection: [number, number, number, number] | null
  prompt: string; agentCount: number; brush: number; feather: number; erase: boolean
  conversion: { format: string; quality: number; transparent: boolean; fill: string; width: number; height: number; original: boolean; filename: string } | null
}

/** Treat even locally stored recovery records as untrusted. In particular,
 * bound replay work before allocating a canvas or walking mask points. */
export function parseImageInput(content: string): ImageInput {
  const v = JSON.parse(content) as ImageInput
  const number = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
  const dimension = (n: unknown) => number(n, 1, 8192) && Number.isInteger(n)
  const crop = (c: unknown): boolean => c === null || Array.isArray(c) && c.length === 4 && c.every(Number.isInteger) && c[0] >= 0 && c[1] >= 0 && c[2] > 0 && c[3] > 0 && c[0] + c[2] <= v.width && c[1] + c[3] <= v.height
  if (!v || v.schemaVersion !== 'hcd-image-input/1' || !Number.isSafeInteger(v.baseRevision) || v.baseRevision < 0 || !dimension(v.width) || !dimension(v.height)
    || !v.edits || !dimension(v.edits.width) || !dimension(v.edits.height) || ![0, 90, 180, 270].includes(v.edits.rotation)
    || typeof v.edits.flipX !== 'boolean' || typeof v.edits.flipY !== 'boolean' || !crop(v.edits.crop) || !crop(v.cropSelection)
    || !['exposure', 'contrast', 'highlights', 'shadows', 'warmth', 'saturation'].every(key => number(v.edits[key as keyof ImageEdits], -100, 100))
    || typeof v.prompt !== 'string' || v.prompt.length > 32000 || !number(v.agentCount, 1, 4) || !Number.isInteger(v.agentCount)
    || !number(v.brush, 4, 240) || !number(v.feather, 0, 64) || typeof v.erase !== 'boolean' || !Array.isArray(v.strokes) || v.strokes.length > 10000) throw new Error('图片草稿格式无效，请下载核对')
  let points = 0
  for (const stroke of v.strokes) {
    if (!stroke || typeof stroke.erase !== 'boolean' || !number(stroke.size, 4, 240) || !Array.isArray(stroke.points) || !stroke.points.length || (points += stroke.points.length) > 100000
      || !stroke.points.every(p => Array.isArray(p) && p.length === 2 && number(p[0], 0, v.width) && number(p[1], 0, v.height))) throw new Error('蒙版笔画无效或过多，请下载核对')
  }
  const c = v.conversion
  if (c !== null && (!c || !['png', 'jpeg', 'webp'].includes(c.format) || !number(c.quality, 1, 100) || !dimension(c.width) || !dimension(c.height)
    || typeof c.transparent !== 'boolean' || typeof c.original !== 'boolean' || typeof c.fill !== 'string' || !/^#[0-9a-f]{6}$/i.test(c.fill) || typeof c.filename !== 'string' || c.filename.length > 4096)) throw new Error('图片转换参数无效，请下载核对')
  return v
}
