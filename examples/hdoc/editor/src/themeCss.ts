import type { Session } from './api.ts'

const MAX_FACE_BYTES = 8 * 1024 * 1024

type ThemeFace = { href?: string; webPreview?: boolean }
type ThemeResponse = { theme?: { css?: string; faces?: ThemeFace[] } }

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

function themeRequestUrl(session: Session, revision: number | null): string {
  const base = `${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}/theme`
  return revision === null ? base : `${base}?revision=${encodeURIComponent(String(revision))}`
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

/** Load the pinned theme. A document with no pin resolves to an empty stylesheet. */
export async function loadThemeCss(session: Session, revision: number | null, editor = false): Promise<string> {
  const response = await fetch(themeRequestUrl(session, revision), {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (response.status === 404) return ''
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  const body = await response.json() as ThemeResponse
  const css = body.theme?.css || ''
  if (!css) return ''
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
  return editor ? `${applied}${editorThemeRules()}` : applied
}
