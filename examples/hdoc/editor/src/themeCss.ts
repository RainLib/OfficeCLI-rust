import type { Session } from './api.ts'

const MAX_FACE_BYTES = 8 * 1024 * 1024

export type ThemeFace = { href?: string; webPreview?: boolean; slot?: string; family?: string }
type ThemeResponse = { theme?: { css?: string; faces?: ThemeFace[] } }

/** A family the pinned theme offers, with the script slots it fills. A
 * `text.font` patch names slots, so the slots are what an editor can offer. */
export type ThemeFontOption = { family: string; latin: boolean; eastAsia: boolean; bidi: boolean }

/**
 * The six theme slots `resolve` reports, narrowed to the three a `text.font`
 * patch can name. A patch does not pick a typographic scale, so major and minor
 * faces of one script collapse into that script.
 */
const SLOT_SCRIPTS: Record<string, 'latin' | 'eastAsia' | 'bidi'> = {
  'major-latin': 'latin', 'major-east-asia': 'eastAsia', 'major-bidi': 'bidi',
  'minor-latin': 'latin', 'minor-east-asia': 'eastAsia', 'minor-bidi': 'bidi',
}

/**
 * The families a `text.font` patch may pin on this document, grouped from the
 * pinned theme's faces. A family that fills no known slot, or whose name the
 * patch would refuse (`safe_font_family` in the core), is left out rather than
 * offered and rejected later.
 */
export function themeFontOptions(faces: readonly ThemeFace[]): ThemeFontOption[] {
  const grouped = new Map<string, ThemeFontOption>()
  for (const face of faces) {
    const script = SLOT_SCRIPTS[face.slot || '']
    if (!script) continue
    const family = (face.family || '').trim()
    if (!family || new TextEncoder().encode(family).length > 128) continue
    if (/[<>"';:&]/.test(family) || [...family].some(character => /\p{Cc}/u.test(character))) continue
    const option = grouped.get(family) || { family, latin: false, eastAsia: false, bidi: false }
    option[script] = true
    grouped.set(family, option)
  }
  return Array.from(grouped.values()).sort((left, right) => left.family.localeCompare(right.family))
}

/** The patch body a family needs: exactly the slots the theme gives it. */
export function themeFontPatch(option: ThemeFontOption): Record<string, string> {
  const font: Record<string, string> = {}
  if (option.latin) font.latin = option.family
  if (option.eastAsia) font.eastAsia = option.family
  if (option.bidi) font.bidi = option.family
  return font
}

export function applyThemeFaces(css: string, replacements: Array<{ href: string; dataUrl: string }>): string {
  let result = css
  for (const { href, dataUrl } of replacements) {
    if (!href.startsWith('/v1/') || /["'()\\\s]/.test(href) || /["()]/.test(dataUrl)) continue
    result = result.split(`url("${href}")`).join(`url("${dataUrl}")`)
  }
  return result.replace(/<\/style/gi, '<\\/style')
}

export function editorThemeRules(): string {
  return '.hcd-editor-body{font-family:var(--hcd-minor-latin,var(--hcd-major-latin))}.hcd-editor-body h1,.hcd-editor-body h2{font-family:var(--hcd-major-latin,var(--hcd-minor-latin))}'
}

/**
 * Delimiter `pin_document_theme` writes into the document's own stylesheet. When
 * it is there, the document already carries the theme variables and the rules
 * that use them, so a surface rendering that stylesheet only needs the bytes.
 */
export const THEME_REGION_MARK = '/* hcd-theme-begin */'

export function hasThemeRegion(styles: string): boolean {
  return styles.includes(THEME_REGION_MARK)
}

function themeRequestUrl(session: Session, revision: number | null, facesOnly: boolean): string {
  const base = `${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}/theme`
  const query = new URLSearchParams()
  if (revision !== null) query.set('revision', String(revision))
  if (facesOnly) query.set('faces', 'only')
  const suffix = query.toString()
  return suffix ? `${base}?${suffix}` : base
}

function fontRequestUrl(session: Session, href: string): string {
  if (!session.apiUrl || session.apiUrl.startsWith('/')) return href
  return new URL(href, new URL(session.apiUrl).origin).toString()
}

async function dataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export type ThemeCssOptions = {
  /** Append the editor's own rules that apply the theme variables. */
  editor?: boolean
  /** Ask for the `@font-face` rules alone: the caller renders a stylesheet that
   * already carries the pinned theme, so the variables and family rules must not
   * arrive a second time. */
  facesOnly?: boolean
}

/** Load the pinned theme: its stylesheet and the faces behind it. A document
 * with no pin resolves to an empty stylesheet and no faces. */
export async function loadTheme(session: Session, revision: number | null, options: ThemeCssOptions = {}): Promise<{ css: string; faces: ThemeFace[] }> {
  const { editor = false, facesOnly = false } = options
  const response = await fetch(themeRequestUrl(session, revision, facesOnly), {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (response.status === 404) return { css: '', faces: [] }
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  const body = await response.json() as ThemeResponse
  const css = body.theme?.css || ''
  if (!css) return { css: '', faces: [] }
  const replacements: Array<{ href: string; dataUrl: string }> = []
  const seen = new Set<string>()
  for (const face of body.theme?.faces || []) {
    if (!face.webPreview || !face.href || seen.has(face.href) || !face.href.startsWith('/v1/')) continue
    seen.add(face.href)
    const font = await fetch(fontRequestUrl(session, face.href), {
      headers: { Authorization: `Bearer ${session.token}` },
    })
    if (!font.ok) continue
    const blob = await font.blob()
    if (blob.size === 0 || blob.size > MAX_FACE_BYTES) continue
    replacements.push({ href: face.href, dataUrl: await dataUrl(blob) })
  }
  const applied = applyThemeFaces(css, replacements)
  return { css: editor ? `${applied}${editorThemeRules()}` : applied, faces: body.theme?.faces || [] }
}

/** Load the pinned theme's stylesheet alone. */
export async function loadThemeCss(session: Session, revision: number | null, options: ThemeCssOptions = {}): Promise<string> {
  return (await loadTheme(session, revision, options)).css
}
