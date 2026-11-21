// Shared by the standalone paginator and the reference editor's isolated
// typography measurement. The document grid is source layout, never a revision.
export function applyWordGrid(root) {
  const doc = root.ownerDocument || root, view = doc.defaultView;
  applyWordPictures(root);
  const pixels = value => Number.parseFloat(value) * (value.trim().endsWith('pt') ? 4 / 3 : 1);
  const canvas = doc.createElement('canvas').getContext('2d'), metrics = new Map();
  const fontHeight = style => {
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if (!metrics.has(font)) {
      canvas.font = font;
      const measured = canvas.measureText('国Ag');
      metrics.set(font, measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent || Number.parseFloat(style.fontSize) || 0);
    }
    return metrics.get(font);
  };
  for (const paragraph of root.querySelectorAll('.hcd-paragraph')) {
    const style = view.getComputedStyle(paragraph);
    const pitch = pixels(style.getPropertyValue('--hcd-grid-line-pitch'));
    const snap = style.getPropertyValue('--hcd-snap-grid').trim();
    // Word table cells use their own line layout unless explicitly snapped.
    if (!(pitch > 0) || snap === '0' || (paragraph.closest('table') && snap !== '1')) continue;
    if (style.getPropertyValue('--hcd-line-rule').trim() === 'exact') continue;
    let natural = Math.max(fontHeight(style), Number.parseFloat(style.lineHeight) || 0);
    for (const run of paragraph.querySelectorAll('span,a')) {
      if (run.closest('.hcd-list-marker')) continue;
      const runStyle = view.getComputedStyle(run);
      if (runStyle.display !== 'none') natural = Math.max(natural, fontHeight(runStyle));
    }
    const line = Math.max(1, Math.ceil((natural - 0.01) / pitch)) * pitch;
    // A tall run must not inherit the full grid leading on top of the
    // paragraph strut: that adds a few pixels at every paragraph boundary.
    for (const run of paragraph.querySelectorAll('span,a')) {
      if (!run.closest('.hcd-list-marker')) run.style.lineHeight = 'normal';
    }
    paragraph.style.lineHeight = `${line}px`;
    paragraph.dataset.hcdGridLine = String(line);
  }
}

function applyWordPictures(root) {
  const px = value => {
    const emu = Number(value);
    return Number.isFinite(emu) ? Math.max(-25_400_000, Math.min(25_400_000, emu)) / 9525 : 0;
  };
  for (const image of root.querySelectorAll('img[data-hcd-source-part="word/document.xml"][data-hcd-drawing-id]')) {
    const data = image.dataset;
    let layout;
    try { layout = data.hcdDocxPictureLayout ? JSON.parse(data.hcdDocxPictureLayout) : null; }
    catch { continue; }
    const paragraph = image.closest('p,.hcd-paragraph');
    if (!paragraph) continue;
    const nativeMode = data.hcdDrawingLayout === 'inline' ? 'inline'
      : data.hcdWrap === 'top-and-bottom' ? 'topAndBottom'
      : data.hcdWrap === 'square' ? 'square'
      : data.hcdWrap === 'none' ? data.hcdBehindDocument === 'true' ? 'behind' : 'inFront'
      : null;
    const mode = layout?.wrap || nativeMode;
    if (!mode || !layout && mode === 'inline') continue;
    const style = image.style;
    for (const property of ['display', 'float', 'clear', 'position', 'left', 'right', 'top', 'z-index',
      'transform', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom']) {
      style.removeProperty(property);
    }
    image.dataset.hcdEffectiveWrap = mode;
    if (mode === 'inline') {
      style.display = 'inline-block';
      style.verticalAlign = 'middle';
      continue;
    }
    const align = layout?.horizontalAlignment
      || (layout?.horizontalOffsetEmu == null ? data.hcdPositionHAlign : null);
    const x = px(layout?.horizontalOffsetEmu ?? data.hcdPositionHOffsetEmu ?? data.hcdSimpleXEmu);
    const y = px(layout?.verticalOffsetEmu ?? data.hcdPositionVOffsetEmu ?? data.hcdSimpleYEmu);
    const side = layout?.wrapSide || data.hcdWrapSide;
    const distance = edge => px(layout?.textDistanceEmu ?? data[`hcdDistance${edge}Emu`]);
    if (mode === 'behind' || mode === 'inFront') {
      paragraph.style.position = 'relative';
      paragraph.style.isolation = 'isolate';
      style.position = 'absolute';
      style.top = `${y}px`;
      style.zIndex = mode === 'behind' ? '-1' : '1';
      if (align === 'right') style.right = '0';
      else if (align === 'center') {
        style.left = '50%';
        style.transform = 'translateX(-50%)';
      } else style.left = `${align === 'left' ? 0 : x}px`;
      continue;
    }
    style.display = 'block';
    style.marginTop = `${Math.max(0, y + distance('Top'))}px`;
    style.marginBottom = `${distance('Bottom')}px`;
    if (mode === 'topAndBottom') {
      style.clear = 'both';
      style.marginLeft = align === 'right' || align === 'center' ? 'auto' : `${Math.max(0, x + distance('Left'))}px`;
      style.marginRight = align === 'center' ? 'auto' : `${distance('Right')}px`;
    } else {
      const right = align === 'right' || !align && side === 'left';
      style.cssFloat = right ? 'right' : 'left';
      style.marginLeft = align === 'center'
        ? `max(0px,calc(50% - ${px(data.hcdWidthEmu) / 2}px))`
        : `${Math.max(0, (right || align === 'left' ? 0 : x) + distance('Left'))}px`;
      style.marginRight = `${distance('Right')}px`;
    }
  }
}
