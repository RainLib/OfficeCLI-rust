// Shared by the standalone paginator and the reference editor's isolated
// typography measurement. The document grid is source layout, never a revision.
export function applyWordGrid(root) {
  const doc = root.ownerDocument || root, view = doc.defaultView;
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
