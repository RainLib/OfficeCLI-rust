export type GridChunkKind = 'cells' | 'picture' | 'chart';

export interface GridChunkAddress {
  sheetId: string;
  sheetName: string;
  sheetIndex: number;
  sheetState: 'visible' | 'hidden' | 'veryHidden';
  kind: GridChunkKind;
  rowStart?: number;
  rowEnd?: number;
  columnStart?: number;
  columnEnd?: number;
  defaultColumnWidthEmu?: number;
  defaultRowHeightEmu?: number;
}

export interface ChunkDescriptor {
  sequence: number;
  chunkId: string;
  htmlHref: string;
  htmlHash: string;
  byteLength: number;
  mapHref: string;
  mapHash: string;
  nodeCount: number;
  grid?: GridChunkAddress;
}

export interface HcdManifest {
  schemaVersion: 'hcd/1' | 'hcd/2';
  storageCodec?: 'none' | 'gzip';
  documentId: string;
  profile: string;
  revision: number;
  rootHash: string;
  indexPrefix: string;
  indexRootHref?: string;
  indexPageCount: number;
  stylesHref: string;
}

export interface NodeMapEntry {
  nodeId: string;
  nodeHash: string;
  source: {
    part: string;
    nodeKind: string;
    editable: boolean;
  };
}

export interface ChunkSourceMap {
  chunkId: string;
  entries: NodeMapEntry[];
}

interface ChunkIndexPage {
  chunks: ChunkDescriptor[];
}

interface IndexTreeNode {
  firstPage: number;
  childSpan: number;
  children: string[];
}

export interface LoadedChunk {
  descriptor: ChunkDescriptor;
  html: string;
  map: ChunkSourceMap;
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value || '/hcd/', window.location.href);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function fetchChecked(url: URL): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response;
}

async function fetchDecoded(url: URL, maxBytes: number, expectedHash?: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetchChecked(url);
  const storedLimit = maxBytes + Math.floor(maxBytes / 16) + 64 * 1024;
  const storedReader = response.body?.getReader();
  if (!storedReader) throw new Error(`HCD object ${url} has no response body`);
  const storedParts: Uint8Array[] = [];
  let storedLength = 0;
  while (true) {
    const { done, value } = await storedReader.read();
    if (done) break;
    storedLength += value.byteLength;
    if (storedLength > storedLimit) {
      await storedReader.cancel();
      throw new Error(`HCD object ${url} exceeds ${storedLimit} stored bytes`);
    }
    storedParts.push(value);
  }
  let bytes = new Uint8Array(storedLength);
  let storedOffset = 0;
  for (const part of storedParts) {
    bytes.set(part, storedOffset);
    storedOffset += part.byteLength;
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('此浏览器不支持 gzip HCD 解压');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error(`HCD object ${url} exceeds ${maxBytes} decoded bytes`);
      }
      parts.push(value);
    }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
  }
  if (bytes.byteLength > maxBytes) throw new Error(`HCD object ${url} exceeds ${maxBytes} bytes`);
  if (expectedHash) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
    if (actual !== expectedHash) throw new Error(`HCD object ${url} failed SHA-256 verification`);
  }
  return bytes;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class HcdBundleClient {
  readonly baseUrl: URL;
  manifest!: HcdManifest;
  descriptors: ChunkDescriptor[] = [];
  private indexNodes = new Map<string, IndexTreeNode>();

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  resolve(href: string): URL {
    return new URL(href, this.baseUrl);
  }

  private async readText(href: string, maxBytes: number, expectedHash?: string): Promise<string> {
    return textDecoder.decode(await fetchDecoded(this.resolve(href), maxBytes, expectedHash));
  }

  private async readJson<T>(href: string, maxBytes = 16 * 1024 * 1024, expectedHash?: string): Promise<T> {
    const addressHash = href.match(/\/sha256\/([a-f0-9]{64})\.json(?:\.gz)?$/)?.[1];
    return JSON.parse(await this.readText(href, maxBytes, expectedHash ?? addressHash)) as T;
  }

  private async indexPageHref(page: number): Promise<string> {
    if (!this.manifest.indexRootHref) {
      const extension = this.manifest.storageCodec === 'gzip' ? '.json.gz' : '.json';
      return `${this.manifest.indexPrefix}/${page.toString().padStart(6, '0')}${extension}`;
    }
    let href = this.manifest.indexRootHref;
    for (let depth = 0; depth < 12; depth += 1) {
      let node = this.indexNodes.get(href);
      if (!node) {
        node = await this.readJson<IndexTreeNode>(href);
        this.indexNodes.set(href, node);
      }
      const child = Math.floor((page - node.firstPage) / node.childSpan);
      const next = node.children[child];
      if (!next) throw new Error(`HCD index tree is missing page ${page}`);
      if (node.childSpan === 1) return next;
      href = next;
    }
    throw new Error('HCD index tree exceeds depth 12');
  }

  async open(): Promise<void> {
    this.manifest = await this.readJson<HcdManifest>('manifest.json');
    if (!['hcd/1', 'hcd/2'].includes(this.manifest.schemaVersion) || this.manifest.profile !== 'grid') {
      throw new Error(`需要 HCD grid bundle，实际为 ${this.manifest.schemaVersion} ${this.manifest.profile}`);
    }
    if (this.manifest.indexPageCount > 10_000) {
      throw new Error(`indexPageCount ${this.manifest.indexPageCount} 超过前端安全上限 10000`);
    }
    const pages: ChunkIndexPage[] = [];
    for (let offset = 0; offset < this.manifest.indexPageCount; offset += 8) {
      const batch = Array.from(
        { length: Math.min(8, this.manifest.indexPageCount - offset) },
        async (_, index) => {
          const page = offset + index;
          const href = await this.indexPageHref(page);
          return this.readJson<ChunkIndexPage>(href);
        },
      );
      pages.push(...await Promise.all(batch));
    }
    this.descriptors = pages.flatMap((page) => page.chunks).sort((a, b) => a.sequence - b.sequence);
    if (this.descriptors.some((descriptor) => descriptor.grid === undefined)) {
      throw new Error('此 bundle 没有 grid 随机访问元数据，请用当前 OfficeCLI 重新执行 hdoc import');
    }
  }

  sheets(): GridChunkAddress[] {
    const found = new Map<string, GridChunkAddress>();
    for (const descriptor of this.descriptors) {
      const grid = descriptor.grid!;
      if (!found.has(grid.sheetId)) found.set(grid.sheetId, grid);
    }
    return [...found.values()].sort((a, b) => a.sheetIndex - b.sheetIndex);
  }

  cellWindows(sheetId: string, rowStart: number, rowEnd: number): ChunkDescriptor[] {
    return this.descriptors.filter(({ grid }) => grid?.sheetId === sheetId
      && grid.kind === 'cells'
      && (grid.rowStart === undefined || grid.rowEnd === undefined
        || (grid.rowEnd >= rowStart && grid.rowStart <= rowEnd)));
  }

  visuals(sheetId: string): ChunkDescriptor[] {
    return this.descriptors.filter(({ grid }) => grid?.sheetId === sheetId && grid.kind !== 'cells');
  }

  sheetDefaults(sheetId: string): { columnWidth: number; rowHeight: number } {
    const grids = this.descriptors
      .map(({ grid }) => grid)
      .filter((grid): grid is GridChunkAddress => grid?.sheetId === sheetId);
    const columnWidthEmu = grids.find(({ defaultColumnWidthEmu }) => defaultColumnWidthEmu)?.defaultColumnWidthEmu;
    const rowHeightEmu = grids.find(({ defaultRowHeightEmu }) => defaultRowHeightEmu)?.defaultRowHeightEmu;
    return {
      columnWidth: columnWidthEmu ? columnWidthEmu / 9525 : 64,
      rowHeight: rowHeightEmu ? rowHeightEmu / 9525 : 20,
    };
  }

  async readChunk(descriptor: ChunkDescriptor): Promise<LoadedChunk> {
    const [html, map] = await Promise.all([
      this.readText(descriptor.htmlHref, 2 * 1024 * 1024, descriptor.htmlHash),
      this.readJson<ChunkSourceMap>(descriptor.mapHref, 16 * 1024 * 1024, descriptor.mapHash),
    ]);
    if (new TextEncoder().encode(html).byteLength !== descriptor.byteLength) {
      throw new Error(`HCD chunk ${descriptor.chunkId} has an unexpected decoded length`);
    }
    return { descriptor, html, map };
  }

  async readStyles(): Promise<string> {
    return this.readText(this.manifest.stylesHref, 16 * 1024 * 1024);
  }
}
