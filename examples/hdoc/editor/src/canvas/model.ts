import type fluentStickers from '../../../../../crates/canvas-core/assets/fluent-stickers.json'
import type stickerCatalog from '../../../../../crates/canvas-core/assets/stickers.json'
import type brushCatalog from '../../../../../crates/canvas-core/assets/brushes.json'

export const CANVAS_PROTOCOL = 'officecli-canvas/1'
export type CanvasElement = Record<string, unknown> & { id: string; type: string; x: number; y: number; width: number; height: number }
export type CanvasFile = Record<string, unknown> & { id: string; mimeType: string; dataURL: string }
export type CanvasScene = { type: 'excalidraw'; version: 2; source: string; elements: CanvasElement[]; files: Record<string, CanvasFile>; appState: Record<string, unknown> }
export type Region = { x: number; y: number; width: number; height: number }
export type Selection = { elementIds: string[]; region: Region }
export type Operation =
  | { op: 'element.add'; element: CanvasElement }
  | { op: 'element.update'; id: string; before: Record<string, unknown>; changes: Record<string, unknown> }
  | { op: 'spec.update'; id:string; update:string }
  | { op: 'spec.splice'; id:string; block:number; start:number; end:number; expected:string; insert:string }
  | { op: 'element.remove'; id: string; expectedHash: string }
  | { op: 'file.add'; id: string; file: CanvasFile }
  | { op: 'scene.update'; before: Record<string, unknown>; changes: Record<string, unknown> }
export type Batch = { schemaVersion: typeof CANVAS_PROTOCOL; documentId: string; patchId: string; baseRevision: number; operations: Operation[]; vacantRegions?: Region[] }
export type StickerMotif = keyof typeof stickerCatalog | keyof typeof fluentStickers
export type StickerMotion = 'none' | 'float' | 'wiggle' | 'twinkle' | 'auto'
export type ArtBrush = keyof typeof brushCatalog
export type AvatarMotif = 'mascot' | 'moonPal' | 'starPal'
export type ReactionKind = 'thumbsUp' | 'plusOne' | 'loveIt' | 'insight' | 'done' | 'favorite' | 'fire' | 'watch' | 'celebrate' | 'smile' | 'launch' | 'action' | 'okay' | 'question' | 'thumbsDown' | 'dot' | 'profile' | `emoji-${string}`
export type Composition = { title: string; layout: 'grid' | 'flow' | 'timeline' | 'flowchart' | 'architecture' | 'mindmap' | 'lesson'; visual?: { style: 'journal' | 'studio'; palette: 'apricot' | 'meadow' | 'lavender' | 'ocean'; paper: 'plain' | 'ruled' | 'dot'; brush: 'ink' | 'pencil' | 'marker' | ArtBrush; stickers: { motif: StickerMotif; motion: StickerMotion; position: 'heading' | 'footer' }[] }; diagram?: { nodes: { id: string; title?: string | null; body?: string | null; kind: string; group: string | null }[]; edges: { from: string; to: string; label: string; kind: string }[]; groups: { id: string; title: string }[] }; items: { title?: string | null; body?: string | null; kind: 'card' | 'bubble' | 'note' }[] }
export type Snapshot = { schemaVersion: string; documentId: string; revision: number; collaborationEpoch: number; scene: CanvasScene; hashes: Record<string, string> }
export type CanvasEmote = { id: string; kind: ReactionKind; x: number; y: number }
export type CanvasEvent = {
  specCursor?: import('./specCoordinates').SpecCursor | null
  specSeq?: number | null
  rewriteOwner?: string | null
  undoRevision?: number | null
  viewport?: {x:number;y:number;zoom:number}
  chat?: {id:string; text:string}
  agentPhase?: 'idle' | 'writing'
  actorKind?: 'agent' | 'person'
  emote?: CanvasEmote
  type: 'ready' | 'refresh' | 'heartbeat' | 'commit' | 'presence' | 'reactions'; revision?: number; collaborationEpoch?: number
  avatar?: AvatarMotif | null
  patchId?: string; actorId?: string; name?: string; at?: number; clientId?: string
  elements?: CanvasElement[]; removedIds?: string[]; files?: Record<string, CanvasFile>; appState?: Record<string, unknown>
  pointer?: { x: number; y: number }; selectedIds?: string[]; preview?: CanvasElement[]
}
