import { api, type Session } from './api.ts'
import type { Projection } from './schema.ts'
import { loadThemeCss } from './themeCss.ts'

/** Per-mounted-document resources. Immutable revisions are shared by the Word
 * typography, table previews and structural-edit receipts. Never cache a head
 * beyond its in-flight request, or reuse content after credentials change. */
export function createSemanticResources(session: () => Session) {
  const projections = new Map<number, Promise<Projection>>()
  const styles = new Map<number | null, Promise<string>>()
  let identity = '', generation = 0, head: Promise<Projection> | null = null
  const current = () => {
    const value = session(), next = JSON.stringify([value.apiUrl, value.documentId, value.accessToken?.() || value.token])
    if (identity !== next) { identity = next; generation++; projections.clear(); styles.clear(); head = null }
    return value
  }
  const retain = <K, V>(cache: Map<K, V>, key: K, value: V) => {
    cache.set(key, value)
    while (cache.size > 4) cache.delete(cache.keys().next().value!)
  }
  const remember = (projection: Projection) => { current(); retain(projections, projection.revision, Promise.resolve(projection)) }
  const projection = (revision: number | null = null): Promise<Projection> => {
    const value = current(), ticket = generation
    const cached = revision === null ? head : projections.get(revision)
    if (cached) return cached
    const query = revision === null ? '' : `?revision=${revision}`
    const result = api(value, `/editor${query}`).then(response=>response.json() as Promise<Projection>)
    if (revision === null) head = result
    else retain(projections, revision, result)
    void result.then(saved=>{
      if (head === result) head = null
      if (ticket === generation) retain(projections, saved.revision, result)
    },()=>{
      if (head === result) head = null
      if (ticket === generation && revision !== null && projections.get(revision) === result) projections.delete(revision)
    })
    return result
  }
  const loadStyles = (revision: number | null) => {
    const value = current(), cached = styles.get(revision)
    if (cached) return cached
    const query = revision === null ? '' : `?revision=${revision}`
    const result = Promise.all([
      api(value, `/styles${query}`).then(response=>response.text()), loadThemeCss(value, revision),
    ]).then(([css, theme])=>`${css}\n${theme}`)
    retain(styles, revision, result)
    void result.then(()=>{
      if (revision === null && styles.get(revision) === result) styles.delete(revision)
    },()=>{ if (styles.get(revision) === result) styles.delete(revision) })
    return result
  }
  return { projection, remember, load: (revision: number | null) => Promise.all([projection(revision), loadStyles(revision)]).then(([projection, styles])=>({projection, styles})) }
}

export type SemanticResources = ReturnType<typeof createSemanticResources>
