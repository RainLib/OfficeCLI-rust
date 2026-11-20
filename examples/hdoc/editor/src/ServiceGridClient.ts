import {
  HcdBundleClient, type ChunkDescriptor, type HcdManifest, type LoadedChunk, type WorksheetCondition,
} from '../../xlsx-univer-viewer/src/hcd.ts'
import { api, type Session } from './api.ts'
import { readCapabilities, type CalculationResult } from './capabilities.ts'

/** The existing Univer adapter reads verified HCD objects through the Rust API. */
export class ServiceGridClient extends HcdBundleClient {
  private readonly assetUrls = new Map<string, string>()
  private readonly calculations = new Map<string, Promise<Map<string, { formula?: string; calculation: CalculationResult }>>>()
  verifiedFunctions: string[] = []
  worksheetChartsSupported = false
  worksheetConditionsSupported = false
  worksheetPivotsSupported = false

  constructor(private readonly session: Session) { super('/') }

  override async open(): Promise<void> {
    this.manifest = await (await api(this.session, '')).json() as HcdManifest
    if (this.manifest.schemaVersion !== 'hcd/2' || this.manifest.profile !== 'grid') {
      throw new Error('需要 HCD/2 工作簿')
    }
    const capabilities = await readCapabilities(this.session).catch(() => null)
    this.verifiedFunctions = capabilities?.calculation.verifiedFunctions ?? []
    this.worksheetChartsSupported = this.manifest.source?.format === 'xlsx'
      && !!capabilities?.patchSchemas['hcd-patch/56']?.operations.includes('xlsx.chart.set')
    this.worksheetConditionsSupported = this.manifest.source?.format === 'xlsx'
      && !!capabilities?.patchSchemas['hcd-patch/58']?.operations.includes('xlsx.condition.set')
    this.worksheetPivotsSupported = this.manifest.source?.format === 'xlsx'
      && !!capabilities?.patchSchemas['hcd-patch/59']?.operations.includes('xlsx.pivot.set')
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

  worksheetConditions(sheetId: string): WorksheetCondition[] {
    const first = this.descriptors.find(({ grid }) => grid?.kind === 'cells' && grid.sheetId === sheetId)
    return (first?.grid?.conditions ?? []).filter(rule => !rule.removed)
      .sort((a, b) => (a.sourcePriority ?? Infinity) - (b.sourcePriority ?? Infinity))
  }

  override async readChunk(descriptor: ChunkDescriptor): Promise<LoadedChunk> {
    const result = await (await api(this.session, `/chunks/${descriptor.sequence}`)).json() as LoadedChunk
    if (result.descriptor.chunkId !== descriptor.chunkId) throw new Error('工作簿分片 ID 不匹配')
    const references = Array.from(result.html.matchAll(/(?:assets\/sha256\/|asset:\/\/sha256\/)([0-9a-f]{64})/g), match => match[1])
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

  override visuals(sheetId: string): ChunkDescriptor[] {
    return super.visuals(sheetId).filter(({ grid }) => !this.worksheetChartsSupported
      || grid?.kind !== 'chart' || !grid.charts?.some(chart => chart.imported))
  }

  override async readCalculations(sheetId: string) {
    const revision = this.manifest.revision
    const key = `${revision}:${sheetId}`
    for (const cached of this.calculations.keys()) if (!cached.startsWith(`${revision}:`)) this.calculations.delete(cached)
    let pending = this.calculations.get(key)
    if (!pending) {
      pending = (async () => {
        const index = this.sheets().findIndex(sheet => sheet.sheetId === sheetId)
        if (index < 0) throw new Error('工作表已变化')
        const result = await (await api(this.session, `/sheets/${index}`)).json() as {
          revision: number; cells: Array<{ address: string; formula?: string; calculation: CalculationResult }>
        }
        if (result.revision !== revision || this.manifest.revision !== revision) throw new Error('工作簿已更新，等待重新核算')
        return new Map(result.cells.map(cell => [cell.address, cell]))
      })()
      this.calculations.set(key, pending)
      pending.catch(() => { if (this.calculations.get(key) === pending) this.calculations.delete(key) })
    }
    return pending
  }

  async readCalculation(sheetId: string, address: string) {
    return (await this.readCalculations(sheetId)).get(address)
  }

  override resolve(href: string): URL {
    const hash = href.match(/(?:assets\/sha256\/|asset:\/\/sha256\/)([0-9a-f]{64})/)?.[1]
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
    this.calculations.clear()
  }
}
