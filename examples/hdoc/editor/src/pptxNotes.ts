import { useEffect, useRef, useState } from 'react'
import { api, type Session } from './api'

export type PptxNoteDescriptor = {
  sequence: number; chunkId: string; region: string; continuation: boolean; htmlHash: string; mapHash: string
}
type NotePages = { pages: PptxNoteDescriptor[]; loading: boolean; error: string; linked: boolean }

/** Match the importer's stable chunk id without downloading every note page. */
export async function pptxChunkId(documentId: string, part: string, ordinal = 0) {
  const encoder = new TextEncoder()
  const fields = [documentId, part, 'slide-chunk', String(ordinal)].map(value => encoder.encode(value))
  const bytes = new Uint8Array(fields.reduce((sum, field) => sum + 8 + field.length, 0))
  const view = new DataView(bytes.buffer)
  let offset = 0
  for (const field of fields) {
    view.setUint32(offset, Math.floor(field.length / 0x100000000))
    view.setUint32(offset + 4, field.length >>> 0)
    offset += 8
    bytes.set(field, offset)
    offset += field.length
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return 'c_' + Array.from(digest.slice(0, 16), value => value.toString(16).padStart(2, '0')).join('')
}

function noteAttribute(html: string, name: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return document.querySelector('.hcd-slide')?.getAttribute(name) || ''
}

/** Linked note pages belong in the note panel; old, unlinked notes stay visible. */
export function useAssociatedNoteChunks(session: Session, descriptors: PptxNoteDescriptor[], revision: number | null) {
  const cache = useRef(new Map<string, boolean>())
  const [associated, setAssociated] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (session.format !== 'pptx' || revision === null) return
    const controller = new AbortController()
    const notes = descriptors.filter(item => item.region === 'note')
    const pending = notes.filter(item => !cache.current.has(`${item.chunkId}:${item.htmlHash}`))
    const publish = () => {
      if (controller.signal.aborted) return
      setAssociated(new Set(notes.filter(item => cache.current.get(`${item.chunkId}:${item.htmlHash}`)).map(item => item.chunkId)))
    }
    publish()
    void (async () => {
      for (let start = 0; start < pending.length; start += 8) {
        await Promise.all(pending.slice(start, start + 8).map(async item => {
          try {
            const result = await (await api(session, `/chunks/${item.sequence}?revision=${revision}`, { signal: controller.signal })).json() as { html: string; map: { chunkId: string } }
            if (!controller.signal.aborted && result.map.chunkId === item.chunkId)
              cache.current.set(`${item.chunkId}:${item.htmlHash}`, !!noteAttribute(result.html, 'data-hcd-notes-owner'))
          } catch { /* Keep an unreadable or legacy note in the existing page list. */ }
        }))
        publish()
      }
    })()
    return () => controller.abort()
  }, [session, descriptors, revision])
  return associated
}

/** Resolve only this slide's associated fragments, including continuation chunks. */
export function useSlideNoteChunks(session: Session, slide: PptxNoteDescriptor | undefined,
  revision: number | null, indexPageCount: number, enabled: boolean): NotePages {
  const [state, setState] = useState<NotePages>({ pages: [], loading: false, error: '', linked: false })
  useEffect(() => {
    if (!enabled || session.format !== 'pptx' || !slide || revision === null) {
      setState({ pages: [], loading: false, error: '', linked: false })
      return
    }
    const controller = new AbortController()
    setState({ pages: [], loading: true, error: '', linked: false })
    void (async () => {
      const chunk = await (await api(session, `/chunks/${slide.sequence}?revision=${revision}`, { signal: controller.signal })).json() as { html: string; map: { chunkId: string } }
      if (chunk.map.chunkId !== slide.chunkId) throw new Error('页面位置已变化，请重新选择幻灯片。')
      const part = noteAttribute(chunk.html, 'data-hcd-notes-part')
      if (!part) {
        if (!controller.signal.aborted) setState({ pages: [], loading: false, error: '', linked: false })
        return
      }
      const first = await pptxChunkId(session.documentId, part)
      const descriptors: PptxNoteDescriptor[] = []
      for (let start = 0; start < indexPageCount; start += 8) {
        const batch = await Promise.all(Array.from({ length: Math.min(8, indexPageCount - start) }, (_, index) =>
          api(session, `/index/${start + index}?revision=${revision}`, { signal: controller.signal })
            .then(response => response.json() as Promise<{ chunks: PptxNoteDescriptor[] }>)))
        descriptors.push(...batch.flatMap(page => page.chunks))
      }
      const start = descriptors.findIndex(item => item.chunkId === first && item.region === 'note')
      if (start < 0) throw new Error('找不到此页的备注，请重新打开文件。')
      const pages = [descriptors[start]]
      for (const next of descriptors.slice(start + 1)) {
        if (next.region !== 'note' || !next.continuation) break
        pages.push(next)
      }
      if (!controller.signal.aborted) setState({ pages, loading: false, error: '', linked: true })
    })().catch(error => {
      if (!controller.signal.aborted) setState({ pages: [], loading: false, error: String(error), linked: false })
    })
    return () => controller.abort()
  }, [session, slide?.chunkId, slide?.sequence, slide?.htmlHash, revision, indexPageCount, enabled])
  return state
}
