import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'

const fonts = ['Arial', 'Calibri', 'Times New Roman', '宋体', '微软雅黑', '等线', '黑体']
const pointSizes = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72]

export function WordFormatTools({ editor, readOnly }: { editor: Editor | null; readOnly: boolean }) {
  const { locale } = useI18n()
  const format = useEditorState({ editor, selector: ({ editor }) => {
    const style = editor?.getAttributes('hcdTextFormat')
    return {
      font: style?.font as string | undefined,
      sizeHalfPoints: style?.sizeHalfPoints as number | undefined,
      color: style?.color as string | undefined,
      alignment: editor?.getAttributes('paragraph').hcdAlignment || editor?.getAttributes('heading').hcdAlignment,
      underline: editor?.isActive('underline') ?? false,
    }
  } })
  const font: string = format?.font || ''
  const points = format?.sizeHalfPoints ? Number(format.sizeHalfPoints) / 2 : 0
  const disabled = !editor || readOnly

  return <div className="tool-group word-format-tools" role="group" aria-label={localizeSource(locale, '文字与段落格式')}>
    <select aria-label={localizeSource(locale, '字体')} value={font} disabled={disabled}
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
    <input type="color" aria-label={localizeSource(locale, '文字颜色')} title={localizeSource(locale, '文字颜色')}
      value={`#${format?.color || '000000'}`} disabled={disabled}
      onChange={event => editor?.chain().focus().setMark('hcdTextFormat', { color: event.target.value.slice(1).toUpperCase() }).run()} />
    <button type="button" aria-pressed={format?.underline ?? false} disabled={disabled}
      onClick={() => editor?.chain().focus().toggleUnderline().run()}><LocalText source="下划线" /></button>
    <select aria-label={localizeSource(locale, '段落对齐')} value={format?.alignment || ''} disabled={disabled}
      onChange={event => {
        const hcdAlignment = event.target.value || null
        editor?.chain().focus().command(({ commands }) => {
          const paragraph = commands.updateAttributes('paragraph', { hcdAlignment })
          const heading = commands.updateAttributes('heading', { hcdAlignment })
          return paragraph || heading
        }).run()
      }}>
      <option value="">{localizeSource(locale, '段落对齐')}</option>
      <option value="left">{localizeSource(locale, '左对齐')}</option>
      <option value="center">{localizeSource(locale, '居中')}</option>
      <option value="right">{localizeSource(locale, '右对齐')}</option>
      <option value="justify">{localizeSource(locale, '两端对齐')}</option>
    </select>
  </div>
}
