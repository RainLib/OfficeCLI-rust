import {
  HcdBundleClient, type ChunkDescriptor, type HcdManifest, type LoadedChunk,
} from '../../xlsx-univer-viewer/src/hcd.ts'
import { api, type Session } from './api.ts'
import { translate, type EditorLocale } from './i18n.tsx'

/** The existing Univer adapter reads verified HCD objects through the Rust API. */
export class ServiceGridClient extends HcdBundleClient {
  private readonly cancellation=new AbortController()
  private request(route:string){return api(this.session,route,{signal:AbortSignal.any([this.cancellation.signal,AbortSignal.timeout(45_000)])})}
  private readonly assetUrls = new Map<string, string>()
  private sourceRevision:number|null=null
  sourceHash=''
  private snapshot(route:string){return this.request(`${route}?revision=${this.sourceRevision}`)}
  override chunkRevision(){return this.sourceRevision??this.manifest.revision}

  constructor(private readonly session: Session, private readonly locale: EditorLocale) { super('/') }

  override async open(): Promise<void> {
    this.manifest = await (await this.request('')).json() as HcdManifest
    if (this.manifest.schemaVersion !== 'hcd/2' || this.manifest.profile !== 'grid') {
      throw new Error(translate(this.locale, 'workbookRequired'))
    }
    if(!Number.isSafeInteger(this.manifest.revision)||this.manifest.revision<0)throw new Error(translate(this.locale,'workbookChunkMismatch'))
    this.sourceRevision=this.manifest.revision
    const source=(this.manifest as HcdManifest&{source?:{sha256?:string}}).source
    if(!source?.sha256||!/^[a-f0-9]{64}$/.test(source.sha256))throw new Error(translate(this.locale,'workbookChunkMismatch'))
    this.sourceHash=source.sha256
    if (this.manifest.indexPageCount > 10_000) throw new Error(translate(this.locale, 'workbookIndexLimit'))
    const descriptors: ChunkDescriptor[] = []
    for (let start = 0; start < this.manifest.indexPageCount; start += 8) {
      const pages = await Promise.all(Array.from({ length: Math.min(8, this.manifest.indexPageCount - start) },
        (_, offset) => this.snapshot(`/index/${start + offset}`).then(response => response.json()) as Promise<{ chunks: ChunkDescriptor[] }>))
      for (const page of pages) descriptors.push(...page.chunks)
    }
    this.descriptors = descriptors.sort((a, b) => a.sequence - b.sequence)
    if (this.descriptors.some(descriptor => !descriptor.grid)) throw new Error(translate(this.locale, 'workbookMissingGrid'))
  }

  override async readChunk(descriptor: ChunkDescriptor): Promise<LoadedChunk> {
    const result = await (await this.snapshot(`/chunks/${descriptor.sequence}`)).json() as LoadedChunk
    if (result.descriptor.chunkId !== descriptor.chunkId) throw new Error(translate(this.locale, 'workbookChunkMismatch'))
    const references = Array.from(result.html.matchAll(/assets\/sha256\/([0-9a-f]{64})\.[a-z0-9]+/g), match => match[1])
    if (references.length > 64) throw new Error(translate(this.locale, 'workbookAssetLimit'))
    await Promise.all([...new Set(references)].map(async hash => {
      if (this.assetUrls.has(hash)) return
      const blob = await (await this.request(`/assets/${hash}`)).blob()
      this.assetUrls.set(hash, URL.createObjectURL(blob))
    }))
    return result
  }

  override async readStyles(): Promise<string> {
    return (await this.snapshot('/styles')).text()
  }

  override resolve(href: string): URL {
    const hash = href.match(/assets\/sha256\/([0-9a-f]{64})\.[a-z0-9]+/)?.[1]
    if (hash) {
      const url = this.assetUrls.get(hash)
      if (!url) throw new Error(translate(this.locale, 'workbookAssetMissing', { hash }))
      return new URL(url)
    }
    return super.resolve(href)
  }

  dispose(): void {
    this.cancellation.abort()
    for (const url of this.assetUrls.values()) URL.revokeObjectURL(url)
    this.assetUrls.clear()
  }
}
