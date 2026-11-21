import { emojiFor } from './emojiCatalog'
import { stampSvg } from './stampArt'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Heart, Lightbulb, ThumbsUp } from 'lucide-react'
import { api, type Session } from '../api.ts'
import { selectedRegion } from './changes.ts'
import { isReaction, reactionNames } from './materialCatalog.ts'
import type { CanvasElement, ReactionKind } from './model.ts'

type Counts = Partial<Record<ReactionKind, { count: number; mine: boolean }>>
type Feedback = { epoch: number; version: number; elements: Record<string, Counts> }
const quickKinds: ReactionKind[] = ['thumbsUp', 'plusOne']

export function reactionTargets(elements: readonly CanvasElement[], selected: readonly string[]) {
  if (!selected.length) return []
  const ids = new Set(selected),
    targets = new Set<string>()
  const groups = new Map<string, CanvasElement[]>()
  for (const element of elements) {
    if (element.isDeleted || !ids.has(element.id)) continue
    const part = (element.customData as { officeStickerPart?: { anchor: string } } | undefined)
      ?.officeStickerPart
    if (part) {
      targets.add(part.anchor)
      continue
    }
    if (typeof element.containerId === 'string' && ids.has(element.containerId)) continue
    const group = Array.isArray(element.groupIds) && element.groupIds[0]
    if (group) {
      const members = groups.get(group)
      if (members) members.push(element)
      else groups.set(group, [element])
    } else targets.add(element.id)
  }
  for (const members of groups.values()) {
    targets.add((members.find((element) => element.id.endsWith('-body')) || members[0]).id)
  }
  return [...targets]
}

export function useCanvasReactions(
  session: Session,
  epoch: number | undefined,
  connected: boolean,
  tick: number,
) {
  const scope = JSON.stringify([session.apiUrl, session.serviceId, session.documentId, session.userId, epoch])
  const activeScope = useRef(scope)
  activeScope.current = scope
  const [book, setBook] = useState<{ scope: string; data: Feedback } | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  const flight = useRef<Promise<void> | null>(null)
  const receive = useCallback(
    (next: Feedback) => {
      if (next.epoch !== epoch || activeScope.current !== scope) return
      setBook((current) =>
        current?.scope === scope && current.data.version > next.version ? current : { scope, data: next },
      )
    },
    [epoch, scope],
  )

  useEffect(() => {
    if (epoch === undefined) return
    const controller = new AbortController()
    async function refresh() {
      try {
        const response = await api(session, '/canvas/reactions', {
          signal: controller.signal,
          cache: 'no-store',
        })
        const result = (await response.json()) as Feedback
        if (!controller.signal.aborted) {
          receive(result)
          setError('')
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(String(cause))
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
    }
  }, [session, epoch, connected, tick, attempt, receive])

  const current = book?.scope === scope ? book.data : null
  async function toggle(ids: string[], kind: ReactionKind, desired?: boolean) {
    if (!ids.length || (flight.current && desired === undefined)) return
    if (!current) throw new Error('反馈正在连接，请稍后重试。')
    const previous = flight.current
    setBusy(true)
    setError('')
    const active = desired ?? !ids.every((id) => current.elements[id]?.[kind]?.mine)
    // Stamping several different notes is a sequence of deliberate placements.
    // Keep their order even when a previous person's count is still in flight.
    const send = async () => {
      if (previous) await previous.catch(() => {})
      const response = await api(session, '/canvas/reactions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(epoch) },
        body: JSON.stringify({ elementIds: ids, kind, active }),
      })
      receive(await response.json())
    }
    const sending = send()
    flight.current = sending
    try {
      await sending
    } catch (cause) {
      setError(String(cause))
      retry((n) => n + 1)
      throw cause
    } finally {
      if (flight.current === sending) {
        flight.current = null
        setBusy(false)
      }
    }
  }
  return { book: current, busy, error, retry: () => retry((n) => n + 1), toggle }
}

type FeedbackControls = {
  feedback: ReturnType<typeof useCanvasReactions>
  onReact: (ids: string[], kind: ReactionKind) => void
}
export function ReactionGlyph({ kind, size = 14, person }: { kind: ReactionKind; size?: number | string; person?: string }) {
  const emoji = emojiFor(kind)
  if (emoji) return <span aria-hidden="true" className="office-stamp-glyph unicode-glyph" style={{width:size,height:size,fontSize:typeof size === 'number' ? size*.85 : 'calc('+size+' * .85)'}}>{emoji.glyph}</span>
  return <span className="office-stamp-glyph" aria-hidden="true" style={{width:size,height:size}} dangerouslySetInnerHTML={{__html:stampSvg(kind,person)}}/>
}

export function CanvasReactions({
  feedback,
  elements,
  camera,
  editable,
  onReact,
}: FeedbackControls & {
  elements: CanvasElement[]
  camera: { x: number; y: number; zoom: number }
  editable: boolean
}) {
  const { book, busy } = feedback
  const badges = useMemo(() => {
    if (!book || !Object.keys(book.elements).length) return []
    return elements.flatMap((element) => {
      const counts = book.elements[element.id]
      if (!counts || element.isDeleted) return []
      const region = selectedRegion([element], [element.id])?.region
      return region ? [{ id: element.id, counts, region }] : []
    })
  }, [book, elements])
  return (
    <div className="canvas-reactions">
      {badges.map(({ id, counts, region }) => (
        <div
          className="canvas-reaction-badges"
          data-element={id}
          key={id}
          style={{
            left: (region.x + region.width + camera.x) * camera.zoom,
            top: (region.y + camera.y) * camera.zoom,
          }}
        >
          {Object.keys(counts).filter(isReaction).map((kind) => {
            const vote = counts[kind]
            return (
              vote && (
                <button
                  key={kind}
                  data-kind={kind}
                  aria-label={reactionNames[kind] + ' · ' + vote.count + ' 人'}
                  aria-pressed={vote.mine}
                  disabled={!editable || busy}
                  onClick={() => onReact([id], kind)}
                >
                  <ReactionGlyph kind={kind} />
                  <span key={vote.count}>{vote.count}</span>
                </button>
              )
            )
          })}
        </div>
      ))}
    </div>
  )
}
export function CanvasReactionTools({
  feedback,
  targets,
  onReact,
}: FeedbackControls & { targets: string[] }) {
  return (
    <div className="canvas-react-tools" role="group" aria-label="回应选中元素">
      {quickKinds.map((kind) => (
        <button
          key={kind}
          title={reactionNames[kind]}
          aria-label={reactionNames[kind]}
          aria-pressed={targets.every((id) => !!feedback.book?.elements[id]?.[kind]?.mine)}
          disabled={!feedback.book || feedback.busy}
          onClick={() => onReact(targets, kind)}
        >
          <ReactionGlyph kind={kind} />
        </button>
      ))}
      {feedback.error && (
        <button title={feedback.error} onClick={feedback.retry}>
          重试反馈
        </button>
      )}
    </div>
  )
}
