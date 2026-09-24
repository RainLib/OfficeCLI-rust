import {
  HcdBundleClient, type ChunkDescriptor, type HcdManifest, type LoadedChunk,
} from '../../xlsx-univer-viewer/src/hcd.ts'
import { api, type Session } from './api.ts'

/** The existing Univer adapter reads verified HCD objects through the Rust API. */
export class ServiceGridClient extends HcdBundleClient {
  private readonly assetUrls = new Map<string, string>()

  constructor(private readonly session: Session) { super('/') }

  override async open(): Promise<void> {
    this.manifest = await (await api(this.session, '')).json() as HcdManifest
    if (this.manifest.schemaVersion !== 'hcd/2' || this.manifest.profile !== 'grid') {
      throw new Error('需要 HCD/2 工作簿')
    }
    if (this.manifest.indexPageCount > 10_000) throw new Error('工作簿索引页超过安全上限')
    const descriptors: ChunkDescriptor[] = []
    for (let start = 0; start < this.manifest.indexPageCount; start += 8) {
      const pages = await Promise.all(Array.from({ length: Math.min(8, this.manifest.indexPageCount - start) },
        (_, offset) => api(this.session, `/index/${start + offset}`).then(response => response.json()) as Promise<{ chunks: ChunkDescriptor[] }>))
      for (const page of pages) descriptors.push(...page.chunks)
    }
    this.descriptors = descriptors.sort((a, b) => a.sequence - b.sequence)
    if (this.descriptors.some(descriptor => !descriptor.grid)) throw new Error('工作簿缺少 grid 随机访问元数据')
  }

  override async readChunk(descriptor: ChunkDescriptor): Promise<LoadedChunk> {
    const result = await (await api(this.session, `/chunks/${descriptor.sequence}`)).json() as LoadedChunk
    if (result.descriptor.chunkId !== descriptor.chunkId) throw new Error('工作簿分片 ID 不匹配')
    const references = Array.from(result.html.matchAll(/assets\/sha256\/([0-9a-f]{64})\.[a-z0-9]+/g), match => match[1])
    if (references.length > 64) throw new Error('工作簿分片资产数量超过安全上限')
    await Promise.all([...new Set(references)].map(async hash => {
      if (this.assetUrls.has(hash)) return
      const blob = await (await api(this.session, `/assets/${hash}`)).blob()
      this.assetUrls.set(hash, URL.createObjectURL(blob))
    }))
    return result
  }

  override async readStyles(): Promise<string> {
    return (await api(this.session, '/styles')).text()
  }

  override resolve(href: string): URL {
    const hash = href.match(/assets\/sha256\/([0-9a-f]{64})\.[a-z0-9]+/)?.[1]
    if (hash) {
      const url = this.assetUrls.get(hash)
      if (!url) throw new Error(`未加载工作簿资产 ${hash}`)
      return new URL(url)
    }
    return super.resolve(href)
  }

  dispose(): void {
    for (const url of this.assetUrls.values()) URL.revokeObjectURL(url)
    this.assetUrls.clear()
  }
}
