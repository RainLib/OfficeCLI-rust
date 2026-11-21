import { applyWordGrid } from '../../../../crates/hcd-core/src/docx_layout.js'

/** Use the same page/margin/paragraph axes as the paged Word renderer. Floating
 * letterheads may extend across the text margins or above their anchor line;
 * an inline, text-width frame would clip them or consume a second line box. */
export function layoutWordRunningImages(doc: Document, kind: 'header' | 'footer') {
  const page = doc.querySelector<HTMLElement>('.word-running-page'), region = page?.querySelector<HTMLElement>('.word-running-content')
  if (!page || !region) return
  const layout = JSON.parse(page.dataset.wordPageGeometry!) as {width:number;height:number;left:number;right:number;top:number;bottom:number}
  const pixels = (value: string) => parseFloat(value) * (value.trim().endsWith('pt') ? 4/3 : 1) || 0
  const drawings = [...region.querySelectorAll<HTMLImageElement>('img[data-hcd-drawing-layout="anchor"]')].map(image=>({image,paragraph:image.closest('p') || region}))
  for (const {image,paragraph} of drawings) {
    let wrapper = image.parentElement; image.remove()
    while (wrapper && wrapper !== paragraph && !wrapper.textContent && !wrapper.children.length) {
      const parent = wrapper.parentElement; wrapper.remove(); wrapper = parent
    }
  }
  applyWordGrid(doc)
  for (const {image,paragraph} of drawings) {
    const bounds = paragraph.getBoundingClientRect(), paper = page.getBoundingClientRect()
    const width = pixels(image.style.width), height = pixels(image.style.height)
    const axis = (horizontal: boolean) => {
      const direction = horizontal ? 'H' : 'V', relative = image.dataset[`hcdPosition${direction}RelativeFrom`]
      const offset = Number(image.dataset[`hcdPosition${direction}OffsetEmu`] || 0) / 9525, size = horizontal ? width : height
      let origin = horizontal ? layout.left : layout.top
      let available = horizontal ? layout.width-layout.left-layout.right : layout.height-layout.top-layout.bottom
      if (relative === 'page') { origin=0; available=horizontal ? layout.width : layout.height }
      else if (['paragraph','line','character'].includes(relative || '')) { origin=horizontal ? bounds.left-paper.left : bounds.top-paper.top; available=horizontal ? bounds.width : bounds.height }
      else if (['topMargin','leftMargin'].includes(relative || '')) { origin=0; available=horizontal ? layout.left : layout.top }
      else if (['bottomMargin','rightMargin'].includes(relative || '')) { origin=horizontal ? layout.width-layout.right : layout.height-layout.bottom; available=horizontal ? layout.right : layout.bottom }
      const alignment = image.dataset[`hcdPosition${direction}Align`]
      return origin + (alignment === 'center' ? (available-size)/2 : ['right','bottom','outside'].includes(alignment || '') ? available-size : offset)
    }
    let top = axis(false)
    if (kind === 'header' && top < 0 && image.dataset.hcdPositionVRelativeFrom === 'margin' && image.dataset.hcdLayoutInCell === 'true') {
      const probe = doc.createElement('span'); probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
      paragraph.append(probe); const baseline = probe.getBoundingClientRect().top-paper.top; probe.remove()
      if (top+height < baseline) { top = baseline-height; image.dataset.hcdAnchorConstrained = 'true' }
    }
    Object.assign(image.style,{position:'absolute',left:`${axis(true)}px`,top:`${top}px`,maxWidth:'none',margin:'0',float:'none',zIndex:image.dataset.hcdBehindDocument === 'true' ? '0' : '2'})
    image.dataset.hcdRunningDrawing = kind; page.append(image)
  }
}
