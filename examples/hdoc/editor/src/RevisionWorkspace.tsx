import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Extension } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ArrowDown, ArrowLeft, ArrowUp, GitCompareArrows, History } from 'lucide-react'
import { schemaExtensions, projectionToJson, type Projection } from './schema.ts'
import { opaquePreviewExtension } from './opaquePreview.ts'
import { loadWordPresentation, wordPresentation } from './wordPresentation.ts'
import { type Session } from './api.ts'
import { loadThemeCss } from './themeCss.ts'
import { CanvasViewport } from './CanvasZoom.tsx'
import { compareRevisions, type RevisionChange } from './revisionDiff.ts'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'

const changeLabel = (change: RevisionChange) => change.kind === 'added' ? '新增段落' : change.kind === 'removed' ? '删除段落' : change.kind === 'moved' ? '段落移动' : change.detail === 'complex' ? '复杂内容变化' : change.detail === 'format' ? '格式变化' : '文字修改'

function RevisionPaper({ session, projection, changes, side }: { session: Session; projection: Projection; changes: RevisionChange[]; side: 'old' | 'new' }) {
  const { locale } = useI18n()
  const scope = `revision-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [theme, setTheme] = useState('')
  const [themeError, setThemeError] = useState(false)
  useEffect(() => {
    let active = true
    setTheme(''); setThemeError(false)
    loadThemeCss(session, projection.revision, { editor: true }).then(css => { if (active) setTheme(css) }).catch(() => { if (active) setThemeError(true) })
    return () => { active = false }
  }, [session, projection.revision])
  const highlights = useMemo(() => Extension.create({
    name: 'revisionHighlights',
    addProseMirrorPlugins() {
      const byId = new Map(changes.map(change => [change.id, change]))
      return [new Plugin({ props: { decorations(state) {
        const decorations: Decoration[] = []
        state.doc.descendants((node, pos) => {
          const change = byId.get(node.attrs.hcdBlockId)
          if (!change) return
          const label = localizeSource(locale, changeLabel(change))
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `revision-change diff-${change.kind}`, 'data-revision-change': change.id, 'data-diff-label': label, title: label }))
          const ranges = side === 'old' ? change.oldRanges : change.newRanges
          let offset = 0
          node.descendants((child, childPos) => {
            if (!child.isText) return
            const length = child.text!.length
            for (const range of ranges) {
              const from = Math.max(range.from, offset), to = Math.min(range.to, offset + length)
              if (to > from) decorations.push(Decoration.inline(pos + 1 + childPos + from - offset, pos + 1 + childPos + to - offset, { class: side === 'old' ? 'diff-text-removed' : 'diff-text-added' }))
            }
            offset += length
          })
          return false
        })
        return DecorationSet.create(state.doc, decorations)
      } } })]
    },
  }), [changes, side, locale])
  const editor = useEditor({
    extensions: [...schemaExtensions.map(extension => extension.name === 'hcdOpaque' ? opaquePreviewExtension(session) : extension), wordPresentation, highlights],
    content: projectionToJson(projection), editable: false,
    editorProps: { attributes: { class: 'hcd-editor-body revision-editor-body', 'aria-label': localizeSource(locale, side === 'old' ? '历史版本内容' : '当前内容') } },
  }, [session, projection, highlights])
  useEffect(() => {
    if (!editor || session.format !== 'docx') return
    const request = new AbortController()
    void loadWordPresentation(editor, session, projection.revision, request.signal)
      .catch(() => { if (!request.signal.aborted) setThemeError(true) })
    return () => request.abort()
  }, [editor, session, projection.revision])
  return <article className="revision-paper" data-revision-scope={scope}>
    {theme && <style>{`@scope ([data-revision-scope="${scope}"]) {${theme.replaceAll(':root', ':scope')}}`}</style>}
    {themeError && <p role="status"><LocalText source="版本字体加载失败，正在使用后备字体。" /></p>}
    <EditorContent editor={editor} />
  </article>
}

export function RevisionWorkspace({ session, selected, historical, current, comparing, loading, error, metadata, canRestore, restoring, onCompare, onReturn, onRetry, onRestore }: {
  session: Session; selected: number; historical: Projection | null; current: Projection | null
  comparing: boolean; loading: boolean; error: string; metadata?: string; canRestore: boolean; restoring: boolean
  onCompare: (value: boolean) => void; onReturn: () => void; onRetry: () => void; onRestore: () => void
}) {
  const { locale } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const changes = useMemo(() => historical && current && comparing ? compareRevisions(historical, current) : [], [historical, current, comparing])
  const noChanges = useMemo<RevisionChange[]>(() => [], [])
  const [active, setActive] = useState(-1)
  useEffect(() => { setActive(-1) }, [historical, comparing])
  function jump(direction: -1 | 1) {
    if (!changes.length) return
    const next = active < 0 ? direction > 0 ? 0 : changes.length - 1 : (active + direction + changes.length) % changes.length
    setActive(next)
    const matches = [...(container.current?.querySelectorAll<HTMLElement>('[data-revision-change]') || [])]
    matches.forEach(element => element.classList.toggle('diff-active', element.dataset.revisionChange === changes[next].id))
    matches.find(element => element.dataset.revisionChange === changes[next].id)?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  }
  return <section className="revision-workspace" aria-label={localizeSource(locale, comparing ? '版本对比' : '历史版本预览')} ref={container}>
    <div className="revision-preview-bar">
      <div className="revision-preview-title"><History size={17} /><div><strong><LocalText source={comparing ? '版本对比' : '历史版本预览'} /> · r{selected}</strong><small>{metadata}</small></div></div>
      <div className="revision-mode-switch"><button aria-pressed={!comparing} onClick={() => onCompare(false)}><LocalText source="预览" /></button><button aria-pressed={comparing} onClick={() => onCompare(true)}><GitCompareArrows size={14} /><LocalText source="对比当前" /></button></div>
      <button className="return-current" onClick={onReturn}><ArrowLeft size={14} /><LocalText source="返回当前" /></button>
    </div>
    {comparing && !loading && !error && <div className="revision-diff-summary" aria-live="polite">
      <strong>{changes.length} <LocalText source="处差异" /></strong>
      <span className="diff-count-added">+{changes.filter(change => change.kind === 'added').length} <LocalText source="新增" /></span>
      <span className="diff-count-removed">−{changes.filter(change => change.kind === 'removed').length} <LocalText source="删除" /></span>
      <span>{changes.filter(change => change.kind === 'modified' || change.kind === 'moved').length} <LocalText source="修改或移动" /></span>
      <nav aria-label={localizeSource(locale, '差异导航')}><small>{active >= 0 ? active + 1 : '—'} / {changes.length}</small><button disabled={!changes.length} aria-label={localizeSource(locale, '上一处差异')} onClick={() => jump(-1)}><ArrowUp size={14} /></button><button disabled={!changes.length} aria-label={localizeSource(locale, '下一处差异')} onClick={() => jump(1)}><ArrowDown size={14} /></button></nav>
    </div>}
    {loading ? <div className="revision-empty" role="status"><LocalText source="正在加载历史版本…" /></div> : error ? <div className="revision-empty" role="alert"><p>{error}</p><button onClick={onRetry}><LocalText source="重试" /></button></div> : historical && <CanvasViewport className="document-scroll revision-scroll">
      <div className={comparing ? 'revision-columns' : 'revision-single'}>
        <section className="revision-column"><header><span><LocalText source="历史版本" /> r{selected}</span><small><LocalText source="只读" /></small></header><RevisionPaper session={session} projection={historical} changes={changes} side="old" /></section>
        {comparing && current && <section className="revision-column"><header><span><LocalText source="当前内容" /></span><small><LocalText source="包含本地草稿" /></small></header><RevisionPaper session={session} projection={current} changes={comparing ? changes : noChanges} side="new" /></section>}
      </div>
      {comparing && !changes.length && <p className="revision-no-diff"><LocalText source="两个版本没有内容差异" /></p>}
    </CanvasViewport>}
    <div className="revision-preview-footer"><span><LocalText source="历史预览不会改写当前草稿" /></span>{canRestore && <button disabled={loading || !!error || restoring} onClick={onRestore}><LocalText source={restoring ? '正在恢复…' : '恢复为此版本'} /></button>}</div>
  </section>
}
