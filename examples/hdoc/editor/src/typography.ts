/** Authored requests, independent of installed/resolved font-file identity. */
export type TextTypography = { family?: string; sizePt?: number; latin?: string; eastAsia?: string; bidi?: string }
const bytes = (value: string) => new TextEncoder().encode(value).length
const safeName = (value: string) => value.trim().length > 0 && bytes(value) <= 256 && /^[\p{L}\p{N} _.,'\-]+$/u.test(value)

export function safeFontStack(value: string): boolean {
  if (!value || bytes(value) > 2048) return false
  const families: string[] = []
  let quote = '', start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (quote) { if (c === quote) quote = '' }
    else if (c === "'" || c === '"') quote = c
    else if (c === ',') { families.push(value.slice(start, i)); start = i + 1 }
  }
  families.push(value.slice(start))
  return !quote && families.length <= 16 && families.every(item => {
    const family = item.trim()
    if (family[0] === "'" || family[0] === '"') {
      const name = family.slice(1, -1)
      return family.length >= 2 && family.endsWith(family[0]) && !name.includes(family[0]) && safeName(name)
    }
    return bytes(family) <= 256 && /^[\p{L}_-][\p{L}\p{N}_-]*(?:\s+[\p{L}_-][\p{L}\p{N}_-]*)*$/u.test(family)
  })
}

export function typography(value: unknown): TextTypography | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid text typography')
  const attributes = value as Record<string, unknown>
  const result: TextTypography = {}
  for (const key of Object.keys(attributes)) {
    if (key === 'explicitSize') {
      if (attributes[key] != null && typeof attributes[key] !== 'boolean') throw new Error('Invalid explicit size marker')
      continue
    }
    if (!['family', 'sizePt', 'latin', 'eastAsia', 'bidi'].includes(key)) throw new Error('Unknown text typography attribute')
    const item = attributes[key]
    if (item == null) continue
    if (key === 'sizePt') {
      if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0 || item > 4096) throw new Error('Invalid text size')
      result.sizePt = item
    } else {
      if (typeof item !== 'string' || !(key === 'family' ? safeFontStack(item) : safeName(item))) throw new Error('Invalid text font')
      result[key as 'family' | 'latin' | 'eastAsia' | 'bidi'] = item
    }
  }
  return Object.keys(result).length ? result : null
}

export function typographyCss(value: TextTypography | null): string {
  return `${value?.family ? `font-family:${value.family};` : ''}${value?.sizePt ? `font-size:${value.sizePt}pt;` : ''}`
}
