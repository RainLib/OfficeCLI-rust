// Derived display only. Canonical chunks, source anchors and revisions stay
// unchanged. Move original body nodes; duplicate only running headers/footers.
(() => {
  const doc = document, body = doc.body;
  const view = doc.defaultView;
  const css = element => view.getComputedStyle(element);
  const length = (value, fallback = 0) => {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number * (value.trim().endsWith('pt') ? 4 / 3 : 1) : fallback;
  };
  const pages = [], templates = new Map();
  let page, content, layout, section, count = 0, sectionPage = 0, displayNumber = 0;

  function geometry(node) {
    const style = css(node), base = css(body);
    const property = name => style.getPropertyValue(`--hcd-${name}`).trim();
    return {
      width: length(property('page-width'), length(base.width, 816)),
      height: length(property('page-height'), length(base.minHeight, 1056)),
      top: length(property('page-top'), length(base.paddingTop)),
      right: length(property('page-right'), length(base.paddingRight)),
      bottom: length(property('page-bottom'), length(base.paddingBottom)),
      left: length(property('page-left'), length(base.paddingLeft)),
      headerOffset: length(property('page-header-offset'), 48),
      footerOffset: length(property('page-footer-offset'), 48),
      header: ['default', 'first', 'even'].map(variant => property(`page-header-${variant}`)),
      footer: ['default', 'first', 'even'].map(variant => property(`page-footer-${variant}`)),
      first: property('page-first') === '1', even: property('page-even') === '1',
      break: property('section-break') || 'nextPage',
      numberStart: Number.parseInt(property('page-number-start')),
    };
  }

  function repeated(node, kind) {
    const copy = node.cloneNode(true);
    copy.dataset.hcdRepeat = kind;
    for (const element of [copy, ...copy.querySelectorAll('[data-hcd-id]')]) {
      if (element.dataset.hcdId) {
        element.dataset.hcdOriginId = element.dataset.hcdId;
        element.removeAttribute('data-hcd-id');
      }
    }
    return copy;
  }

  function running(kind, keys) {
    const variant = layout.first && sectionPage === 1 ? 1 : layout.even && displayNumber % 2 === 0 ? 2 : 0;
    const template = templates.get(keys[variant]);
    // Missing first/even references mean an empty variant, not the default.
    if (!template) return;
    const region = repeated(template, kind);
    region.classList.add(`hcd-page-${kind}`, 'hcd-chunk');
    region.style.left = `${layout.left}px`; region.style.right = `${layout.right}px`;
    region.style[kind === 'header' ? 'top' : 'bottom'] = `${layout[`${kind}Offset`]}px`;
    page.append(region);
    // An anchored drawing is positioned in page/margin/paragraph coordinates.
    // Keeping it as a relative inline image would both consume a line box and
    // apply the offset twice, pushing header text down into the body.
    const drawings = [...region.querySelectorAll('img[data-hcd-drawing-layout="anchor"]')].map(image => ({image, paragraph:image.closest('p') || region}));
    for (const {image, paragraph} of drawings) {
      let wrapper = image.parentElement; image.remove();
      while (wrapper && wrapper !== paragraph && !wrapper.textContent && !wrapper.children.length) {
        const parent = wrapper.parentElement; wrapper.remove(); wrapper = parent;
      }
    }
    for (const {image, paragraph} of drawings) {
      const bounds = paragraph.getBoundingClientRect(), paper = page.getBoundingClientRect();
      const width = length(image.style.width), height = length(image.style.height);
      const axis = horizontal => {
        const direction = horizontal ? 'H' : 'V';
        const relative = image.dataset[`hcdPosition${direction}RelativeFrom`];
        const offset = Number(image.dataset[`hcdPosition${direction}OffsetEmu`] || 0) / 9525;
        const size = horizontal ? width : height;
        let origin = horizontal ? layout.left : layout.top;
        let available = horizontal ? layout.width - layout.left - layout.right : layout.height - layout.top - layout.bottom;
        if (relative === 'page') {origin=0; available=horizontal ? layout.width : layout.height;}
        else if (['paragraph','line','character'].includes(relative)) {origin=horizontal ? bounds.left-paper.left : bounds.top-paper.top; available=horizontal ? bounds.width : bounds.height;}
        else if (relative === 'topMargin' || relative === 'leftMargin') {origin=0; available=horizontal ? layout.left : layout.top;}
        else if (relative === 'bottomMargin' || relative === 'rightMargin') {origin=horizontal ? layout.width-layout.right : layout.height-layout.bottom; available=horizontal ? layout.right : layout.bottom;}
        const alignment = image.dataset[`hcdPosition${direction}Align`];
        return origin + (alignment === 'center' ? (available-size)/2 : ['right','bottom','outside'].includes(alignment) ? available-size : offset);
      };
      let top = axis(false);
      // Word constrains a margin-relative header anchor to reach its anchor
      // line. A linked portrait header on a shorter landscape top margin can
      // otherwise end above that line and clip the letterhead at the paper edge.
      if (kind === 'header' && top < 0 && image.dataset.hcdPositionVRelativeFrom === 'margin' && image.dataset.hcdLayoutInCell === 'true') {
        const probe = doc.createElement('span');
        probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        paragraph.append(probe);
        const baseline = probe.getBoundingClientRect().top - paper.top; probe.remove();
        if (top + height < baseline) {top = baseline - height; image.dataset.hcdAnchorConstrained = 'true';}
      }
      Object.assign(image.style, {position:'absolute',left:`${axis(true)}px`,top:`${top}px`,maxWidth:'none',margin:'0',float:'none',zIndex:image.dataset.hcdBehindDocument === 'true' ? '0' : '2'});
      image.dataset.hcdRunningDrawing=kind; page.append(image);
    }
  }

  function newPage(next = layout, nextSection = section, first = false) {
    if (pages.length >= 2000) throw new Error('Word preview exceeds 2000 pages');
    layout = next; section = nextSection;
    sectionPage = first ? 1 : sectionPage + 1;
    displayNumber = first && Number.isFinite(layout.numberStart) ? layout.numberStart : displayNumber + 1;
    page = doc.createElement('section');
    page.className = 'hcd-virtual-page hcd-chunk';
    page.dataset.hcdVirtualPage = String(pages.length + 1);
    page.dataset.hcdSection = section;
    page.dataset.hcdPageNumber = String(displayNumber);
    Object.assign(page.style, { width: `${layout.width}px`, height: `${layout.height}px`, padding: `${layout.top}px ${layout.right}px ${layout.bottom}px ${layout.left}px` });
    content = doc.createElement('div');
    content.className = 'hcd-virtual-page-content';
    content.style.height = `${Math.max(1, layout.height - layout.top - layout.bottom)}px`;
    page.append(content); body.append(page); pages.push(page); count = 0;
    running('header', layout.header); running('footer', layout.footer);
  }

  const fits = () => content.scrollHeight <= length(content.style.height) + 1;
  const add = node => { content.append(node); count++; };

  // Clone a range rather than flattening it, so inline sizes, links and colors
  // survive line splitting. Offsets are UTF-16 with surrogate pairs kept intact.
  function textRange(node, offset, tail) {
    const range = doc.createRange(); range.selectNodeContents(node);
    const walker = doc.createTreeWalker(node, 4);
    let text, remaining = offset;
    while ((text = walker.nextNode())) {
      if (remaining <= text.length) {
        if (tail) range.setStart(text, remaining); else range.setEnd(text, remaining);
        break;
      }
      remaining -= text.length;
    }
    return range.cloneContents();
  }

  function splitParagraph(node) {
    if (!node.matches('p,h1,h2,h3,h4,h5,h6,li') || node.querySelector('img,table,svg')) return null;
    const text = node.textContent;
    if (text.length < 2) return null;
    const original = node.cloneNode(true), originalBottom = node.style.marginBottom;
    let low = 0, high = text.length - 1;
    while (low < high) {
      let middle = Math.ceil((low + high) / 2);
      if (/[\uD800-\uDBFF]/.test(text[middle - 1]) && /[\uDC00-\uDFFF]/.test(text[middle])) middle--;
      if (middle <= low) break;
      node.replaceChildren(textRange(original, middle, false)); node.style.marginBottom = '0px';
      if (fits()) low = middle; else high = middle - 1;
    }
    if (low < 1) { node.replaceChildren(...original.childNodes); node.style.marginBottom = originalBottom; return null; }
    // Prefer a word boundary on the same line, with a bounded lookback for long
    // unbroken words. Chinese text can break between adjacent characters.
    let cut = low;
    if (/[A-Za-z0-9]/.test(text[cut - 1] || '') && /[A-Za-z0-9]/.test(text[cut] || '')) {
      const boundary = text.slice(Math.max(0, cut - 32), cut).search(/\s+\S*$/);
      if (boundary >= 0) cut = Math.max(0, cut - 32) + boundary + 1;
    }
    const tail = original.cloneNode(false);
    tail.append(textRange(original, cut, true));
    node.replaceChildren(textRange(original, cut, false));
    node.style.marginBottom = '0px';
    tail.style.marginTop = '0px'; tail.style.textIndent = '0px';
    tail.style.breakBefore = 'auto'; tail.dataset.hcdContinuation = 'true';
    return tail;
  }

  function splitTable(table) {
    if (table.tagName !== 'TABLE') return null;
    const rows = [...table.tBodies].flatMap(tbody => [...tbody.rows]);
    if (rows.length < 2) return null;
    const tail = table.cloneNode(false);
    for (const child of table.children) if (['COLGROUP','THEAD'].includes(child.tagName)) tail.append(repeated(child, 'table-header'));
    const remainder = doc.createElement('tbody'); tail.append(remainder);
    // Never split a connected rowspan group. Continuation rows in the source
    // are moved along with their restart cell, preserving all cell content.
    const groups = [];
    for (let start = 0; start < rows.length;) {
      let end = start + 1;
      for (let i = start; i < end; i++) for (const cell of rows[i].cells) end = Math.max(end, cell.rowSpan === 0 ? rows.length : Math.min(rows.length, i + cell.rowSpan));
      groups.push(rows.slice(start, end)); start = end;
    }
    const width = table.getBoundingClientRect().width;
    table.style.width = `${width}px`; tail.style.width = `${width}px`;
    for (const row of rows) row.remove();
    const target = table.tBodies[0] || table.createTBody();
    let accepted = 0;
    for (let i = 0; i < groups.length; i++) {
      target.append(...groups[i]);
      if (!fits()) {
        for (const group of groups.slice(i)) remainder.append(...group);
        break;
      }
      accepted++;
    }
    if (!accepted || !remainder.rows.length) {
      target.append(...rows); return null;
    }
    if (!table.tHead) {
      const headers = rows.filter(row => row.dataset.hcdRepeatHeader === 'true');
      if (headers.length && headers.every(row => target.contains(row))) {
        const head = doc.createElement('thead');
        for (const row of headers) head.append(repeated(row, 'table-header'));
        tail.insertBefore(head, remainder);
      }
    }
    tail.dataset.hcdContinuation = 'true';
    tail.style.breakBefore = 'auto';
    return tail;
  }

  function splitBreaks(node) {
    const result = [];
    if (!node.matches('p,h1,h2,h3,h4,h5,h6')) return [{node}];
    let marker;
    while ((marker = node.querySelector('br[data-hcd-break="page"],br[data-hcd-break="column"]'))) {
      const before = node.cloneNode(false), range = doc.createRange();
      range.selectNodeContents(node); range.setEndBefore(marker);
      before.append(range.extractContents()); marker.remove();
      result.push({node: before, after: true});
      node.style.breakBefore = 'auto';
    }
    if (node.textContent || node.querySelector('img') || !result.length) result.push({node});
    return result;
  }

  function paginate() {
    if (body.classList.contains('hcd-docx-paginated')) return;
    applyWordGrid(body);
    const chunks = [...body.querySelectorAll(':scope > section.hcd-chunk')];
    if (!chunks.length) return;
    const blocks = [];
    for (const chunk of chunks) {
      const region = chunk.dataset.hcdRegion || 'body';
      for (const node of [...chunk.children]) {
        if (region === 'header' || region === 'footer') {
          const part = node.dataset.hcdPart || node.querySelector('[data-hcd-part]')?.dataset.hcdPart || chunk.dataset.hcdPart;
          if (!part) continue;
          let template = templates.get(part);
          if (!template) { template = doc.createElement('div'); templates.set(part, template); }
          template.append(node);
        } else {
          // Word stores empty separator paragraphs in footnotes/endnotes even
          // when there are no notes. They must not create phantom final pages.
          if (region !== 'body' && !node.textContent.trim() && !node.querySelector('img,table,svg')) continue;
          // Resolve computed values while the source hierarchy still exists.
          const blockLayout = region !== 'body' && blocks.length ? blocks.at(-1).layout : geometry(node), style = css(node);
          const sid = region !== 'body' && blocks.length ? blocks.at(-1).section : node.dataset.hcdSection || node.querySelector('[data-hcd-section]')?.dataset.hcdSection || '0';
          if (region !== 'body') node.dataset.hcdSupplement=region;
          const before = ['page','always','left','right'].includes(style.breakBefore);
          const after = ['page','always','left','right'].includes(style.breakAfter);
          const keep = ['avoid','avoid-page'].includes(style.breakInside);
          for (const token of splitBreaks(node)) blocks.push({...token, layout:blockLayout, section:sid, before:before && !blocks.at(-1)?.after, keep, after:token.after || after});
        }
      }
    }
    body.replaceChildren(); body.classList.add('hcd-docx-paginated');
    let force = false;
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      const sectionChanged = section !== block.section;
      const geometryChanged = layout && ['width','height','top','right','bottom','left'].some(key => layout[key] !== block.layout[key]);
      if (!page) newPage(block.layout, block.section, true);
      else if (force || block.before || geometryChanged || (sectionChanged && block.layout.break !== 'continuous')) {
        if (count) {
          if (sectionChanged && ['oddPage','evenPage'].includes(block.layout.break)) {
            const wanted = block.layout.break === 'oddPage' ? 1 : 0;
            if ((pages.length + 1) % 2 !== wanted) { newPage(); page.dataset.hcdBlankPage = 'true'; }
          }
          newPage(block.layout, block.section, sectionChanged);
        }
      }
      // A continuous section shares this physical page, but subsequent overflow
      // pages must use the new section's margins and running-region references.
      if (section !== block.section) {
        layout = block.layout; section = block.section; sectionPage = 1;
      }
      add(block.node);
      if (!fits()) {
        let tail = !block.keep || count === 1 ? splitTable(block.node) || splitParagraph(block.node) : null;
        if (!tail && count > 1) {
          block.node.remove(); count--; newPage(block.layout, block.section, false); add(block.node);
          if (!fits()) tail = splitTable(block.node) || splitParagraph(block.node);
        }
        if (tail) {
          blocks.splice(index + 1, 0, {...block, node:tail, before:true});
          block.after = false;
        } else if (!fits()) {
          // A drawing or rowspan group larger than the page is explicit overflow,
          // never silently cropped or discarded.
          page.dataset.hcdPageOverflow = 'true'; page.style.height = 'auto'; content.style.height = 'auto';
        }
      }
      force = block.after;
    }
    const seen = new Set();
    for (const element of body.querySelectorAll('[data-hcd-id]')) {
      const id = element.dataset.hcdId;
      if (seen.has(id)) {element.dataset.hcdOriginId=id; element.removeAttribute('data-hcd-id');}
      else seen.add(id);
    }
    for (const element of body.querySelectorAll('[data-hcd-field]')) {
      const number = element.dataset.hcdField === 'NUMPAGES' ? pages.length : element.closest('[data-hcd-page-number]')?.dataset.hcdPageNumber;
      if (number == null) continue;
      const walker = doc.createTreeWalker(element, 4);
      let text, first = true;
      while ((text=walker.nextNode())) {text.textContent = first ? String(number) : ''; first=false;}
      if (first) element.textContent=String(number);
    }
    body.dataset.hcdPageCount=String(pages.length);
    body.dispatchEvent(new CustomEvent('hcd-pagination-ready', {bubbles:true}));
  }

  const ready = () => Promise.all([doc.fonts?.ready || Promise.resolve(), ...[...doc.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
    image.addEventListener('load',resolve,{once:true}); image.addEventListener('error',resolve,{once:true});
  }))]).then(paginate).catch(error => {body.dataset.hcdPaginationError=String(error);});
  if (doc.readyState === 'complete') ready(); else view.addEventListener('load', ready, {once:true});
})();
