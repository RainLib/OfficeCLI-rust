import { useEffect, useState } from 'react'
import { ArrowLeft, BookOpen, Search, Sparkles } from 'lucide-react'
import { DefaultSidebar, Sidebar } from '@excalidraw/excalidraw'
import { api, type Session } from '../api.ts'
import { BrushSwatch, isStickerMotif, StickerIllustration } from './CanvasStickers.tsx'
import { ReactionGlyph } from './CanvasReactions.tsx'
import {
  isBrush,
  isReaction,
  type MaterialCategory,
  type MaterialSummary,
  type MaterialDetail,
} from './materialCatalog.ts'
import './materials.css'

function Sample({ item, large = false }: { item: MaterialSummary; large?: boolean }) {
  return (
    <span
      className={large ? 'material-sample large' : 'material-sample'}
      data-category={item.category}
      data-material={item.id}
    >
      {isBrush(item.id) ? (
        <BrushSwatch brush={item.id} />
      ) : isStickerMotif(item.id) ? (
        <StickerIllustration motif={item.id} motion="auto" />
      ) : isReaction(item.id) ? (
        <ReactionGlyph kind={item.id} size={32} />
      ) : null}
    </span>
  )
}
type Props = {
  session: Session
  paused: boolean
  canEdit: boolean
  selected: boolean
  mine: string[]
  avatar?: string | null
  onAvatar: (id: string) => void
  onUse: (item: MaterialDetail) => Promise<void>
}
function Library({ session, paused, canEdit, selected, mine, avatar, onAvatar, onUse }: Props) {
  const [categories, setCategories] = useState<{ id: MaterialCategory; name: string; count: number }[]>([])
  const [category, setCategory] = useState<MaterialCategory>('sticker'),
    [search, setSearch] = useState('')
  const [page,setPage]=useState(0), [total,setTotal]=useState(0)
  const [items, setItems] = useState<MaterialSummary[]>([]),
    [chosen, setChosen] = useState(''),
    [detail, setDetail] = useState<MaterialDetail | null>(null)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [attempt, retry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void api(session, '/canvas/materials', { signal: controller.signal })
      .then((r) => r.json())
      .then((r) => setCategories(r.categories))
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e))
      })
    return () => controller.abort()
  }, [session, attempt])
  useEffect(() => {
    const controller = new AbortController()
    const params = chosen ? { id: chosen } : search.trim() ? { q: search.trim() } : { category }
    setLoading(true)
    setError('')
    setDetail(null)
    const timer = setTimeout(
      async () => {
        try {
          const result = await (
            await api(session, '/canvas/materials?' + new URLSearchParams(Object.entries(chosen?params:{...params,page:String(page)})), {
              signal: controller.signal,
            })
          ).json()
          if (!controller.signal.aborted) {
            if (chosen) setDetail(result.material)
            else { setItems(old=>page ? [...old,...result.items] : result.items); setTotal(result.total ?? result.items.length) }
          }
        } catch (cause) {
          if (!controller.signal.aborted) setError(String(cause))
        } finally {
          if (!controller.signal.aborted) setLoading(false)
        }
      },
      chosen || !search.trim() ? 0 : 140,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [session, category, search, chosen, attempt,page])
  async function apply(item: MaterialDetail) {
    setBusy(true)
    setError('')
    try {
      await onUse(item)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="canvas-material-library" aria-label="白板素材库" data-paused={paused}>
      {chosen ? (
        <button className="material-back" onClick={() => {setPage(0);setChosen('')}}>
          <ArrowLeft size={15} />
          返回素材
        </button>
      ) : (
        <>
          <h2>素材库</h2>
          <label className="material-search">
            <Search size={15} />
            <input
              aria-label="搜索素材"
              maxLength={160}
              placeholder="搜索花瓣、微光、+1…"
              value={search}
              onChange={(e) => {setPage(0);setSearch(e.target.value)}}
            />
          </label>
          <div className="material-tabs" role="group" aria-label="素材分类">
            {categories.map((c) => (
              <button
                key={c.id}
                aria-pressed={!search && category === c.id}
                title={`${c.name} · ${c.count} 项`}
                onClick={() => {
                  setSearch('')
                  setPage(0)
                  setCategory(c.id)
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}
      {error && (
        <p role="alert">
          {error} <button onClick={() => retry((i) => i + 1)}>重试</button>
        </p>
      )}
      {loading ? (
        <p role="status">正在读取素材…</p>
      ) : chosen ? (
        detail && (
          <article className="material-detail">
            <Sample item={detail} large />
            <h2>{detail.name}</h2>
            <p>{detail.summary}</p>
            <dl>
              <dt>适用场景</dt>
              <dd>{detail.useWhen}</dd>
              {detail.motionDescription && (
                <>
                  <dt>动效</dt>
                  <dd>{detail.motionDescription}</dd>
                </>
              )}
            </dl>
            <details>
              <summary>素材参数</summary>
              <dl>
                <dt>标识</dt>
                <dd>{detail.id}</dd>
                <dt>关键词</dt>
                <dd>{detail.tags.join(' · ')}</dd>
                <dt>静态显示</dt>
                <dd>{detail.fallback}</dd>
                <dt>使用边界</dt>
                <dd>{detail.avoidWhen}</dd>
              </dl>
            </details>
            {canEdit && (
              <button
                className="material-primary"
                disabled={busy || (detail.category === 'reaction' && !selected)}
                onClick={() => void apply(detail)}
              >
                {detail.category === 'brush'
                  ? '用这支笔绘制'
                  : detail.category === 'reaction'
                    ? !selected
                      ? '先选择画布元素'
                      : mine.includes(detail.id)
                        ? '撤回我的反馈'
                        : '回应选中元素'
                    : '贴到白板'}
              </button>
            )}
            {detail.category === 'avatar' && (
              <button
                className="material-secondary"
                onClick={() => onAvatar(avatar === detail.id ? '' : detail.id)}
              >
                {avatar === detail.id ? '恢复默认头像' : '用作协作头像'}
              </button>
            )}
          </article>
        )
      ) : (
        <div className="material-grid">
          {items.map((item) => (
            <button
              className="material-card"
              key={item.id}
              aria-label={item.name}
              onClick={() => setChosen(item.id)}
            >
              <Sample item={item} />
              <strong>{item.name}</strong>
              <small>{item.summary}</small>
            </button>
          ))}
          {items.length<total&&<button onClick={()=>setPage(n=>n+1)}>更多素材</button>}
          {!items.length && !error && <p>没有匹配的素材</p>}
        </div>
      )}
    </section>
  )
}
export function CanvasMaterialSidebar(props: Props) {
  return (
    <>
      <DefaultSidebar.Trigger tab="office-materials" title="素材库" icon={<BookOpen size={16} />}>
        素材库
      </DefaultSidebar.Trigger>
      <DefaultSidebar>
        <DefaultSidebar.TabTriggers>
          <Sidebar.TabTrigger tab="office-materials" title="白板素材" aria-label="白板素材">
            <Sparkles size={16} />
          </Sidebar.TabTrigger>
        </DefaultSidebar.TabTriggers>
        <Sidebar.Tab tab="office-materials">
          <Library {...props} />
        </Sidebar.Tab>
      </DefaultSidebar>
    </>
  )
}
