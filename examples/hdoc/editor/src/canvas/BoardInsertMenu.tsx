import { useRef, useState, type DragEvent } from 'react'
import {
  ArrowLeft, Workflow, NotepadText, CodeXml, Link2, Eye, ImagePlus,
  Blocks,
  BookOpen,
  ChevronRight,
  FileImage,
  FolderOpen,
  Library,
  ListChecks,
  Puzzle,
  Search,
  Timer,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { readBoardMedia, type BoardMedia } from './BoardBuiltins'
import { readTabState, writeTabState } from '../tabState'
import originals from '../../../../../crates/canvas-core/assets/materials.json'
import fluent from '../../../../../crates/canvas-core/assets/fluent-materials.json'
import diagrams from '../../../../../crates/canvas-core/fixtures/diagrams.json'
import { isStickerMotif, StickerIllustration } from './CanvasStickers'
import type { Composition } from './model'
import type { MaterialDetail } from './materialCatalog'

const tabs = ['全部', '贴纸', '模板', '小组件', '插件', '更多'] as const
type Tab = (typeof tabs)[number]
export type BoardWidget = 'timer' | 'vote'
type Props = {
  writable: boolean
  storageKey: string | null
  close: () => void
  onMaterial: (item: MaterialDetail) => void
  onTemplate: (composition: Composition) => Promise<void>
  onWidget: (widget: BoardWidget) => void
  openLibrary: () => void
  onLibraryFile: (file: File) => Promise<unknown>
  more: (id: MoreTool) => void
  media: BoardMedia[]
  onMedia: (item: BoardMedia) => void
  onImage: () => void
  onResource?: () => void
}
type ShelfItem = MaterialDetail & { pack?: string }
const stickers = [...originals, ...fluent].filter(
  (item) => item.category === 'sticker',
) as ShelfItem[]
const packs = ['手账精选', ...new Set(fluent.map((item) => item.pack))]
const prepared: { name: string; keys: string; spec: Composition }[] = [
  {
    name: '头脑风暴',
    keys: '想法 创意 便利贴 brainstorm',
    spec: {
      title: '头脑风暴',
      layout: 'grid',
      items: [
        { title: '提出问题', body: '今天希望一起解决什么？', kind: 'bubble' },
        { title: '记录想法', body: '每张便利贴写一个想法。', kind: 'note' },
        { title: '选择下一步', body: '圈出最值得验证的一项。', kind: 'card' },
      ],
    },
  },
  {
    name: '项目复盘',
    keys: '回顾 retro 复盘',
    spec: {
      title: '项目复盘',
      layout: 'grid',
      items: [
        { title: '值得保留', body: '哪件事帮助我们向前走？', kind: 'note' },
        { title: '遇到的阻力', body: '什么让大家停了下来？', kind: 'note' },
        { title: '下次试试', body: '写下一个小实验。', kind: 'note' },
      ],
    },
  },
  ...Object.entries(diagrams).map(([key, spec], i) => ({
    name: ['流程梳理', '系统架构', '思维导图', '课程讲解'][i],
    keys: key + ' ' + spec.title,
    spec: spec as Composition,
  })),
]
const workshopTemplates: {name:string; keys:string; layout:Composition['layout']; prompts:[string,string][]}[] = [
  {name:'SWOT 分析',keys:'优势 劣势 机会 风险 战略',layout:'grid',prompts:[['优势','我们擅长什么？'],['劣势','目前有哪些局限？'],['机会','外部有哪些有利变化？'],['威胁','需要提前应对什么？']]},
  {name:'用户旅程',keys:'体验 地图 用户旅程 customer journey',layout:'timeline',prompts:[['发现','用户因为什么找到我们？'],['尝试','记录用户第一次行动。'],['遇到阻力','留下用户的真实反馈。'],['再次使用','什么让用户愿意回来？']]},
  {name:'每周计划',keys:'周计划 weekly planning 工作坊',layout:'flow',prompts:[['本周目标','写下最想完成的一件事。'],['进行中','标记负责人和下一步。'],['已完成','记录交付与复盘。']]},
]
for (const t of workshopTemplates) prepared.push({name:t.name,keys:t.keys,spec:{title:t.name,layout:t.layout,items:t.prompts.map(([title,body])=>({title,body,kind:'note'}))}})
const moreTools = [
  {id:'mind',name:'思维导图',keys:'mind map diagram 流程图',info:'从一个主题向外展开分支。',icon:Workflow},
  {id:'spec',name:'Spec 文档',keys:'spec document 文档',info:'在画布上写作、排版与协同编辑。',icon:NotepadText},
  {id:'code',name:'代码块',keys:'code block syntax 语法高亮',info:'插入带语法高亮的可编辑代码。',icon:CodeXml},
  {id:'timer',name:'计时器',keys:'timer countdown 会议 倒计时',info:'为所有参与者开启共享倒计时。',icon:Timer},
  {id:'media',name:'媒体',keys:'media image upload 图片 上传',info:'上传图片，或复用这张白板的媒体。',icon:FileImage},
  {id:'link',name:'链接',keys:'links link url website 网页',info:'添加可直接打开的网页链接。',icon:Link2},
] as const
export type MoreTool = typeof moreTools[number]['id']
type Plugin = {
  id: string
  name: string
  actions: { name: string; composition: Composition }[]
}
function readPlugin(input: unknown): Plugin {
  const p = input as Partial<Plugin> & { schema?: string }
  if (
    p?.schema !== 'officecli-board-plugin/1' ||
    typeof p.id !== 'string' ||
    !p.id.trim() ||
    typeof p.name !== 'string' ||
    !p.name.trim() ||
    !Array.isArray(p.actions) ||
    p.actions.length < 1 ||
    p.actions.length > 32
  )
    throw new Error(
      '请选择含 id、name 和 actions 的 officecli-board-plugin/1 JSON 文件。',
    )
  for (const a of p.actions) {
    if (
      typeof a?.name !== 'string' ||
      !a.name.trim() ||
      typeof a.composition?.title !== 'string' ||
      ![
        'grid',
        'flow',
        'timeline',
        'flowchart',
        'architecture',
        'mindmap',
        'lesson',
      ].includes(a.composition.layout) ||
      !Array.isArray(a.composition.items)
    )
      throw new Error('插件中的排版动作缺少名称或有效的 composition。')
  }
  return { id: p.id, name: p.name, actions: p.actions }
}
export function BoardInsertMenu(props: Props) {
  const results=useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<Tab>('全部'),
    [query, setQuery] = useState(''),
    [pack, setPack] = useState('')
  const [preview,setPreview]=useState<(typeof prepared)[number] | null>(null)
  const [mediaOpen,setMediaOpen]=useState(false)
  const mediaInput=useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [plugins, setPlugins] = useState<Plugin[]>(
      () => readTabState<Plugin[]>(props.storageKey) || [],
    )
  const libraryFile = useRef<HTMLInputElement>(null),
    pluginFile = useRef<HTMLInputElement>(null)
  // The click generated after a drop must not arm a second insertion.
  const dragged = useRef(false)
  function finish(fn: () => void) {
    props.close()
    fn()
  }
  async function run(fn: () => Promise<unknown>, close = true) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
      if (close) props.close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  function updatePlugins(next: Plugin[]) {
    if (JSON.stringify(next).length > 65_536)
      throw new Error('此工作区插件动作已超过 64 KB。请移除不用的动作后重试。')
    setPlugins(next)
    writeTabState(props.storageKey, next)
  }
  function choose(t: Tab) {
    setTab(t)
    setPreview(null)
    setMediaOpen(false)
    setPack('')
    setError('')
  }
  function startDrag(event: DragEvent<HTMLButtonElement>, item: ShelfItem) {
    dragged.current = true
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/x-officecli-sticker', item.id)
  }
  const q = query.trim().toLowerCase()
  const matches = (...terms: string[]) =>
    !q || terms.some((t) => t.toLowerCase().includes(q))
  const show = (t: Tab) => tab === t || tab === '全部'
  const foundStickers = stickers.filter(
    (s) =>
      (!pack || (s.pack || '手账精选') === pack) &&
      matches(s.name, s.summary, ...s.tags),
  )
  const foundTemplates = prepared.filter((t) =>
    matches(t.name, t.keys, t.spec.title),
  )
  const matchedPacks = packs.filter((p) =>
    foundStickers.some((s) => (s.pack || '手账精选') === p),
  )
  const showPacks = show('贴纸') && !pack && !q
  const widgets = (
    [
      {
        id: 'timer',
        name: '工作坊计时器',
        info: '所有人共享同一倒计时',
        icon: Timer,
      },
      {
        id: 'vote',
        name: '举手表决',
        info: '在画布上收集每个人的反馈',
        icon: ListChecks,
      },
    ] as const
  ).filter((w) => matches(w.name, w.info, '小组件'))
  const visiblePlugins = plugins.flatMap((p) =>
    p.actions
      .filter((a) => matches(p.name, a.name, '插件'))
      .map((a) => ({ p, a })),
  )
  let hasRows = false
  const section = (title: string, visible: boolean, items: React.ReactNode) => {
    if (!visible) return null
    hasRows = true
    return (
      <section aria-label={title}>
        <h4>{title}</h4>
        {items}
      </section>
    )
  }
  return (
    <div className="board-insert-content" data-tab={tab} onKeyDown={e=>{
      if(e.nativeEvent.isComposing||!['ArrowDown','ArrowUp','Enter'].includes(e.key))return
      const search=e.target instanceof HTMLInputElement && e.target.getAttribute('aria-label')==='搜索插入项目'
      if(!search&&!results.current?.contains(e.target as Node))return
      const items=Array.from(results.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]).filter(el=>el.checkVisibility())
      if(!items.length)return
      if(e.key==='Enter'){if(search&&query.trim()){e.preventDefault();items[0].click()}return}
      e.preventDefault()
      const index=items.indexOf(e.target as HTMLButtonElement), step=e.key==='ArrowDown'?1:-1
      items[index<0?(step>0?0:items.length-1):(index+step+items.length)%items.length]?.focus()
    }}>
      <div className="board-insert-header">
        <label className="board-insert-search"><Search size={16} />
        <input
          aria-label="搜索插入项目"
          placeholder="搜索素材、模板和工具"
          autoFocus
          value={query}
          onChange={(e) => {
            setPreview(null);setMediaOpen(false);setQuery(e.target.value)
            setPack('')
          }}
        />
        </label>
        <button aria-label="关闭插入菜单" onClick={props.close}>
          <X size={16} />
        </button>
      </div>
      <div className="board-insert-tabs" aria-label="素材类别">
        {tabs.map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => choose(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="board-insert-body" ref={results}>
        {mediaOpen ? <section className="board-media-shelf" aria-label="白板媒体">
          <button className="board-library-back" onClick={()=>setMediaOpen(false)}><ArrowLeft size={15}/>媒体</button>
          <button className="board-media-upload" disabled={!props.writable||busy} onClick={()=>mediaInput.current?.click()}><ImagePlus size={20}/>上传图片<small>PNG、JPEG、WebP、GIF</small></button>
          <div className="board-media-grid">{props.media.map(item=><button key={item.file.id} disabled={!props.writable} onClick={()=>finish(()=>props.onMedia(item))}><img src={item.file.dataURL} alt=""/><span>{item.name}</span></button>)}</div>
          <input type="file" hidden aria-label="选择白板媒体" ref={mediaInput} accept="image/png,image/jpeg,image/webp,image/gif" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(async()=>props.onMedia(await readBoardMedia(file)))}}/>
        </section> : preview ? <section aria-label="模板预览" className="board-template-preview">
          <button className="board-library-back" onClick={()=>setPreview(null)}><ArrowLeft size={15}/>模板</button>
          <h3>{preview.name}</h3><div className="template-outline" data-layout={preview.spec.layout}>{(preview.spec.diagram?.nodes??preview.spec.items).map((item,index)=><article key={index}><strong>{item.title}</strong><small>{item.body}</small></article>)}</div>
          <button className="board-template-use" disabled={!props.writable||busy} onClick={()=>void run(()=>props.onTemplate(preview.spec))}>使用此模板</button>
        </section> : <>
        {pack && (
          <button className="board-library-back" onClick={() => setPack('')}>
            <ArrowLeft size={14} />
            {pack}
          </button>
        )}
        {section(
          '贴纸包',
          showPacks && matchedPacks.length > 0,
          <div className="board-pack-grid">
            {matchedPacks.map((p, index) => {
              const items = foundStickers.filter(
                (s) => (s.pack || '手账精选') === p,
              )
              return (
                <button
                  key={p}
                  data-variant={index % 4}
                  onClick={() => {
                    setPack(p)
                    setTab('贴纸')
                  }}
                >
                  <span className="board-pack-cover">
                    {items
                      .slice(0, 3)
                      .map(
                        (s) =>
                          isStickerMotif(s.id) && (
                            <StickerIllustration key={s.id} motif={s.id} />
                          ),
                      )}
                  </span>
                  <span>
                    {p}
                    <small>{items.length}</small>
                  </span>
                </button>
              )
            })}
          </div>,
        )}
        {section(
          '贴纸',
          show('贴纸') && !showPacks && foundStickers.length > 0,
          <div className="board-sticker-grid">
            {foundStickers.map((s) => (
              <button
                key={s.id}
                draggable={props.writable}
                disabled={!props.writable}
                title={s.name + ' · ' + s.useWhen}
                aria-label={'放置' + s.name}
                onDragStart={(e) => startDrag(e, s)}
                onDragEnd={() => {
                  dragged.current = false
                }}
                onClick={() => {
                  if (!dragged.current) props.onMaterial(s)
                }}
              >
                {isStickerMotif(s.id) && (
                  <StickerIllustration motif={s.id} motion="auto" />
                )}
                <span>{s.name}</span>
              </button>
            ))}
          </div>,
        )}
        {section(
          '白板模板',
          show('模板') && foundTemplates.length > 0,
          <div className="board-template-grid">
            {foundTemplates.map((t) => (
              <div className="template-choice" key={t.name}><button aria-label={t.name}
                disabled={!props.writable || busy}
                onClick={() => void run(() => props.onTemplate(t.spec))}
              >
                <i data-layout={t.spec.layout}>
                  <b />
                  <b />
                  <b />
                </i>
                {t.name}
              </button><button aria-label={'预览'+t.name} title="预览模板" onClick={()=>setPreview(t)}><Eye size={14}/></button></div>
            ))}
          </div>,
        )}
        {section(
          '小组件',
          show('小组件') && widgets.length > 0,
          <div className="board-action-list">
            {widgets.map((w) => (
              <button
                key={w.id}
                disabled={!props.writable}
                onClick={() => props.onWidget(w.id)}
              >
                <w.icon />
                <span>
                  {w.name}
                  <small>{w.info}</small>
                </span>
                <ChevronRight />
              </button>
            ))}
          </div>,
        )}
        {section(
          '插件',
          show('插件') &&
            (visiblePlugins.length > 0 || matches('导入排版插件', '插件 JSON')),
          <div className="board-action-list">
            {visiblePlugins.map(({ p, a }, i) => (
              <div key={p.id + i} className="board-plugin-row">
                <button
                  disabled={busy || !props.writable}
                  onClick={() =>
                    void run(() => props.onTemplate(a.composition))
                  }
                >
                  <Puzzle />
                  <span>
                    {a.name}
                    <small>{p.name}</small>
                  </span>
                </button>
                <button
                  title={'移除' + p.name}
                  aria-label={'移除' + p.name}
                  onClick={() =>
                    updatePlugins(plugins.filter((other) => other.id !== p.id))
                  }
                >
                  <Trash2 />
                </button>
              </div>
            ))}
            {matches('导入排版插件', '插件 JSON') && (
              <button
                disabled={!props.writable}
                onClick={() => pluginFile.current?.click()}
              >
                <Blocks />
                <span>
                  导入排版插件<small>OfficeCLI · 本地 JSON</small>
                </span>
                <Upload />
              </button>
            )}
          </div>,
        )}
        {section('内置工具',show('更多')&&moreTools.some(t=>matches(t.name,t.keys,t.info)),
          <div className="board-action-list builtin-list">{moreTools.filter(t=>matches(t.name,t.keys,t.info)).map(t=>
            <button key={t.id} aria-label={t.name} disabled={!props.writable && t.id!=='media'} onClick={()=>t.id==='media'?setMediaOpen(true):finish(()=>props.more(t.id))}>
              <i><t.icon/></i><span>{t.name}<small>{t.info}</small></span>
            </button>)}</div>)}
        {section(
          '更多工具',
          show('更多') &&
            [
              '素材库 画笔 动态贴纸 头像',
              '插入图片',
              '导入图形素材包 Excalidraw',
              props.onResource ? '引用文档与表格区域' : '',
            ].some((s) => !!s && matches(s)),
          <div className="board-action-list">
            {matches('素材库 画笔 动态贴纸 头像') && (
              <button onClick={() => finish(props.openLibrary)}>
                <Library />
                <span>画笔、动态贴纸与头像</span>
                <ChevronRight />
              </button>
            )}
            {matches('插入图片') && (
              <button
                disabled={!props.writable}
                onClick={() => finish(props.onImage)}
              >
                <FileImage />
                <span>插入图片</span>
                <ChevronRight />
              </button>
            )}
            {matches('导入图形素材包 Excalidraw') && (
              <button
                disabled={!props.writable}
                onClick={() => libraryFile.current?.click()}
              >
                <FolderOpen />
                <span>
                  导入图形素材包<small>.excalidrawlib</small>
                </span>
                <Upload />
              </button>
            )}
            {props.onResource && matches('引用文档与表格区域') && (
              <button onClick={() => finish(props.onResource!)}>
                <BookOpen />
                <span>引用文档与表格区域</span>
                <ChevronRight />
              </button>
            )}
          </div>,
        )}
        {!hasRows && (
          <p className="board-empty-result">没有找到“{query}”的匹配项。</p>
        )}
        </>}
        {error && <p role="alert">{error}</p>}
      </div>
      <input
        hidden
        type="file"
        aria-label="选择排版插件"
        accept=".json,application/json"
        ref={pluginFile}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file)
            void run(async () => {
              if (file.size > 512_000)
                throw new Error('插件请控制在 500 KB 以内。')
              const p = readPlugin(JSON.parse(await file.text()))
              updatePlugins([...plugins.filter((old) => old.id !== p.id), p])
              setTab('插件')
            }, false)
        }}
      />
      <input
        hidden
        type="file"
        aria-label="选择图形素材包"
        accept=".excalidrawlib,.json"
        ref={libraryFile}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void run(() => props.onLibraryFile(file))
        }}
      />
    </div>
  )
}
export const dockStickerById = (id: string) =>
  stickers.find((item) => item.id === id)
