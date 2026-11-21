import { WorkspacePanel } from './WorkspacePanel.tsx'
import { useEffect, useState } from 'react'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, MousePointer2, Underline } from 'lucide-react'
import { CollapseSidebarIcon } from './EditorChrome.tsx'
import { useAgentActivities, agentStatus } from './AgentActivityLayer.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import type { ThemeFontOption } from './themeCss.ts'
import type { PptxGeometry, PptxRunFormat, PptxShapeAlign, TextNode } from './FixedViewer.tsx'

export function PptxProperties({ node, fonts, hidden, disabled, dirty, onClose, onAgents, onFormat, onAlign, onFont, onGeometry }: {
  node: TextNode | null; fonts: ThemeFontOption[]; hidden: boolean; disabled: boolean; dirty: boolean
  onClose: () => void; onAgents: () => void; onFormat: (format: PptxRunFormat) => void
  onAlign: (align: PptxShapeAlign) => void; onFont: (font: ThemeFontOption) => void; onGeometry: (geometry: PptxGeometry) => void
}) {
  const { locale } = useI18n(), agents = useAgentActivities()
  const [tab, setTab] = useState<'text' | 'layout'>('text'), [size, setSize] = useState('')
  const [position, setPosition] = useState({ xEmu: '', yEmu: '', widthEmu: '', heightEmu: '' })
  useEffect(() => {
    setSize(node?.runFontSizePt ? String(node.runFontSizePt) : String(Number.parseFloat(node?.fontSize || '') || ''))
    const geometry = node?.geometry
    setPosition({ xEmu: geometry ? String(Math.round(geometry.xEmu / 127) / 100) : '', yEmu: geometry ? String(Math.round(geometry.yEmu / 127) / 100) : '', widthEmu: geometry ? String(Math.round(geometry.widthEmu / 127) / 100) : '', heightEmu: geometry ? String(Math.round(geometry.heightEmu / 127) / 100) : '' })
  }, [node?.nodeId, node?.nodeHash])
  const unavailable = disabled || !node?.editable || dirty
  const family = node?.pinnedFont || node?.fontFamily?.split(',')[0].replace(/["']/g, '').trim() || ''
  const applySize = () => {
    const value = Number(size)
    const original = node?.runFontSizePt || Number.parseFloat(node?.fontSize || '')
    if (!unavailable && value >= 1 && value <= 256 && value !== original) onFormat({ fontSizePt: value })
  }
  const color = /^#[0-9a-f]{6}$/i.test(node?.runColor || '') ? node!.runColor! : '#272D3B'
  const geometry = Object.fromEntries(Object.entries(position).map(([key, value]) => [key, Math.round(Number(value) * 12700)])) as PptxGeometry
  const geometryValid = Object.values(position).every(value => value.trim() !== '' && Number.isFinite(Number(value))) && geometry.xEmu >= 0 && geometry.yEmu >= 0 && geometry.widthEmu > 0 && geometry.heightEmu > 0
  return <WorkspacePanel side="right" hidden={hidden} className="workspace-sidebar shape-properties" aria-label={localizeSource(locale, '形状属性')}>
    <div className="panel-head"><h2><LocalText source="形状属性" /></h2><button className="panel-close" aria-label={localizeSource(locale, '隐藏右侧栏')} onClick={onClose}><CollapseSidebarIcon /></button></div>
    <nav className="inspector-tabs" aria-label={localizeSource(locale, '属性分类')}>
      <button aria-pressed={tab === 'text'} onClick={() => setTab('text')}><LocalText source="文本" /></button>
      <button aria-pressed={tab === 'layout'} onClick={() => setTab('layout')}><LocalText source="布局" /></button>
      <button onClick={onAgents}><LocalText source="协作" /></button>
    </nav>
    <div className="inspector-content">
      {!node && <div className="inspector-empty"><MousePointer2 size={24} /><p><LocalText source="选择画布上的文字" /></p><small><LocalText source="在这里调整字体、对齐、位置与尺寸。" /></small></div>}
      {node && <>
        {dirty && <p className="inspector-notice"><LocalText source="请先保存文字修改，再调整属性。" /></p>}
        {tab === 'text' && <section className="inspector-section" aria-label={localizeSource(locale, '文字属性')}>
          <label><LocalText source="字体" /><select aria-label={localizeSource(locale, '属性字体')} value={fonts.find(font => font.family === family)?.family || ''} disabled={unavailable || !fonts.length} onChange={event => { const font = fonts.find(item => item.family === event.target.value); if (font) onFont(font) }}>
            <option value="">{family || localizeSource(locale, '文档字体')}</option>{fonts.map(font => <option value={font.family} key={font.family}>{font.family}</option>)}
          </select></label>
          <div className="inspector-grid"><label><LocalText source="字号" /><input aria-label={localizeSource(locale, '属性字号')} type="number" min="1" max="256" step="0.5" value={size} disabled={unavailable} onChange={event => setSize(event.target.value)} onBlur={applySize} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
            <label><LocalText source="字重" /><select aria-label={localizeSource(locale, '属性字重')} value={node.runBold ? 'bold' : 'normal'} disabled={unavailable} onChange={event => onFormat({ bold: event.target.value === 'bold' })}><option value="normal">Regular</option><option value="bold">Bold</option></select></label></div>
          <div className="inspector-segments" aria-label={localizeSource(locale, '文字样式')}>{[
            { key: 'bold', label: '加粗', active: node.runBold, icon: <Bold size={16} /> },
            { key: 'italic', label: '斜体', active: node.runItalic, icon: <Italic size={16} /> },
            { key: 'underline', label: '下划线', active: node.runUnderline, icon: <Underline size={16} /> },
          ].map(item => <button key={item.key} aria-label={localizeSource(locale, `属性${item.label}`)} aria-pressed={!!item.active} disabled={unavailable} onClick={() => onFormat({ [item.key]: !item.active })}>{item.icon}</button>)}</div>
          <label><LocalText source="对齐" /><span className="inspector-segments">{[
            { value: 'left', label: '左对齐', icon: <AlignLeft size={16} /> }, { value: 'center', label: '居中', icon: <AlignCenter size={16} /> },
            { value: 'right', label: '右对齐', icon: <AlignRight size={16} /> }, { value: 'justify', label: '两端对齐', icon: <AlignJustify size={16} /> },
          ].map(item => <button key={item.value} aria-label={localizeSource(locale, `属性${item.label}`)} aria-pressed={node.shapeHorizontal === item.value} disabled={unavailable} onClick={() => onAlign({ horizontal: item.value as PptxShapeAlign['horizontal'] })}>{item.icon}</button>)}</span></label>
          <label className="inspector-color"><LocalText source="文字颜色" /><span><input aria-label={localizeSource(locale, '属性文字颜色')} type="color" value={color} disabled={unavailable} onChange={event => onFormat({ color: event.target.value })} /><code>{color.slice(1).toUpperCase()}</code></span></label>
        </section>}
        {(tab === 'layout' || tab === 'text') && <section className="inspector-section inspector-geometry" aria-label={localizeSource(locale, '位置与尺寸')}>
          <h3><LocalText source="位置与尺寸" /><small>pt</small></h3>
          <div className="inspector-grid">{(['xEmu', 'yEmu', 'widthEmu', 'heightEmu'] as const).map((key, index) => <label key={key}>{['X', 'Y', 'W', 'H'][index]}<input aria-label={localizeSource(locale, ['形状 X', '形状 Y', '形状宽度', '形状高度'][index])} type="number" min={index > 1 ? '0.01' : '0'} step="0.5" disabled={unavailable || !node.geometry} value={position[key]} onChange={event => setPosition(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
          <button className="inspector-apply" disabled={unavailable || !node.geometry || !geometryValid || Object.entries(geometry).every(([key, value]) => Math.abs(value - node.geometry![key as keyof PptxGeometry]) < 127)} onClick={() => onGeometry(geometry)}><LocalText source="应用布局" /></button>
          {tab === 'layout' && <label><LocalText source="垂直对齐" /><select aria-label={localizeSource(locale, '属性垂直对齐')} disabled={unavailable} value={node.shapeVertical || 'top'} onChange={event => onAlign({ vertical: event.target.value as PptxShapeAlign['vertical'] })}><option value="top">{localizeSource(locale, '顶端对齐')}</option><option value="center">{localizeSource(locale, '垂直居中')}</option><option value="bottom">{localizeSource(locale, '底端对齐')}</option></select></label>}
        </section>}
      </>}
    </div>
    {!!agents.length && <div className="inspector-presence">{agents.slice(0, 3).map(agent => <span key={agent.agentId}><i>{agent.name.slice(0, 1)}</i>{agent.name} · <LocalText source={agentStatus[agent.status] || agent.status} /></span>)}</div>}
  </WorkspacePanel>
}
