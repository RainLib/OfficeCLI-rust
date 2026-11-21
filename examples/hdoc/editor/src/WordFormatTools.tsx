import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { useI18n } from './i18n.tsx'
import { localizeSource } from './sourceLocale.tsx'

import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, List, ListOrdered, Underline } from 'lucide-react'
import { RibbonButton } from './DocumentRibbon'

const fonts = ['Arial', 'Calibri', 'Times New Roman', '宋体', '微软雅黑', '等线', '黑体']
const pointSizes = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72]

export function WordFormatTools({ editor, readOnly, section = 'font' }: { editor: Editor | null; readOnly: boolean; section?: 'font' | 'paragraph' }) {
  const { locale } = useI18n()
  const format = useEditorState({ editor, selector: ({ editor }) => {
    const style = editor?.getAttributes('hcdTextFormat')
    return {
      font: style?.font as string | undefined,
      sizeHalfPoints: style?.sizeHalfPoints as number | undefined,
      color: style?.color as string | undefined,
      alignment: editor?.getAttributes('paragraph').hcdAlignment || editor?.getAttributes('heading').hcdAlignment,
      underline: editor?.isActive('underline') ?? false,
      bold: editor?.isActive('bold') ?? false, italic: editor?.isActive('italic') ?? false,
      bullet: editor?.isActive('bulletList') ?? false, ordered: editor?.isActive('orderedList') ?? false,
    }
  } })
  const font: string = format?.font || ''
  const points = format?.sizeHalfPoints ? Number(format.sizeHalfPoints) / 2 : 0
  const disabled = !editor || readOnly

  const align = (hcdAlignment: string) => editor?.chain().focus().command(({ commands }) => {
    const paragraph = commands.updateAttributes('paragraph', { hcdAlignment })
    const heading = commands.updateAttributes('heading', { hcdAlignment })
    return paragraph || heading
  }).run()
  if (section === 'paragraph') return <>
    <div className="ribbon-control-row">{([{ value: 'left', label: '左对齐', icon: AlignLeft }, { value: 'center', label: '居中', icon: AlignCenter },
      { value: 'right', label: '右对齐', icon: AlignRight }, { value: 'justify', label: '两端对齐', icon: AlignJustify }]).map(item =>
      <RibbonButton key={item.value} icon={item.icon} iconOnly label={localizeSource(locale, item.label)} disabled={disabled}
        aria-pressed={(format?.alignment || 'left') === item.value} onClick={() => align(item.value)}/>)}</div>
    <div className="ribbon-control-row"><RibbonButton icon={List} iconOnly label={localizeSource(locale, '项目符号')} disabled={disabled} aria-pressed={format?.bullet ?? false} onClick={() => editor?.chain().focus().toggleBulletList().run()}/>
    <RibbonButton icon={ListOrdered} iconOnly label={localizeSource(locale, '编号')} disabled={disabled} aria-pressed={format?.ordered ?? false} onClick={() => editor?.chain().focus().toggleOrderedList().run()}/></div>
  </>
  return <>
    <div className="ribbon-control-row"><select aria-label={localizeSource(locale, '字体')} value={font} disabled={disabled}
      onChange={event => editor?.chain().focus().setMark('hcdTextFormat', { font: event.target.value || null }).run()}>
      <option value="">{localizeSource(locale, '字体')}</option>
      {font && !fonts.includes(font) && <option value={font}>{font}</option>}
      {fonts.map(name => <option key={name} value={name}>{name}</option>)}
    </select>
    <select aria-label={localizeSource(locale, '字号')} value={points || ''} disabled={disabled}
      onChange={event => editor?.chain().focus().setMark('hcdTextFormat', { sizeHalfPoints: Number(event.target.value) * 2 || null }).run()}>
      <option value="">{localizeSource(locale, '字号')}</option>
      {points > 0 && !pointSizes.includes(points) && <option value={points}>{points} pt</option>}
      {pointSizes.map(size => <option key={size} value={size}>{size} pt</option>)}
    </select>
    </div><div className="ribbon-control-row"><input type="color" aria-label={localizeSource(locale, '文字颜色')} title={localizeSource(locale, '文字颜色')}
      value={`#${format?.color || '000000'}`} disabled={disabled}
      onChange={event => editor?.chain().focus().setMark('hcdTextFormat', { color: event.target.value.slice(1).toUpperCase() }).run()} />
    <RibbonButton icon={Bold} iconOnly label={localizeSource(locale, '加粗')} disabled={disabled} aria-pressed={format?.bold ?? false} onClick={() => editor?.chain().focus().toggleBold().run()}/>
    <RibbonButton icon={Italic} iconOnly label={localizeSource(locale, '斜体')} disabled={disabled} aria-pressed={format?.italic ?? false} onClick={() => editor?.chain().focus().toggleItalic().run()}/>
    <RibbonButton icon={Underline} iconOnly label={localizeSource(locale, '下划线')} disabled={disabled} aria-pressed={format?.underline ?? false} onClick={() => editor?.chain().focus().toggleUnderline().run()}/></div>
  </>
}
