import { AgentPointer } from '../AgentPointer'
import { StickerIllustration } from './CanvasStickers'
import { isAvatar } from './materialCatalog'
import type { CanvasEvent } from './model'

export function CanvasPresenceLayer({ peers, camera, paused }: {
  paused: boolean
  peers: Map<string, CanvasEvent>
  camera: { x: number; y: number; zoom: number }
}) {
  const position = (x: number, y: number) => ({
    left: (x + camera.x) * camera.zoom,
    top: (y + camera.y) * camera.zoom,
  })
  return <div className="canvas-peer-previews" data-paused={paused} aria-hidden="true">
    {[...peers].map(([id, peer]) => {
      if (!peer.pointer) return null
      const at = position(peer.pointer.x, peer.pointer.y)
      // The Spec has a character-accurate caret. Avoid a second board pointer
      // on the bounding box of the same sentence.
      if (peer.actorKind === 'agent') return peer.specCursor ? null :
        <span key={id} className="canvas-peer-agent" style={at}>
          <AgentPointer phase={peer.agentPhase ?? 'idle'} />
          <span className="agent-name-chip">{peer.name || '墨点'}</span>
        </span>
      return isAvatar(peer.avatar) && <span key={id} className="canvas-peer-avatar" data-avatar={peer.avatar} style={at}>
        <StickerIllustration motif={peer.avatar} motion="auto" />
      </span>
    })}
    {[...peers].flatMap(([peerId, peer]) => (peer.preview || []).filter(e => !e.isDeleted).map(e =>
      <div key={peerId + ':' + e.id} className="canvas-peer-preview" style={{
        ...position(e.x + Math.min(0, e.width), e.y + Math.min(0, e.height)),
        width: Math.abs(e.width) * camera.zoom, height: Math.abs(e.height) * camera.zoom,
      }}><span>{peer.name || '协作者'}</span></div>))}
  </div>
}
