use crate::render::pdf::ImageRef;
use crate::render::pdf::geometry::{PdfPoint, PdfRect, PdfVector};
use crate::render::pdf::transforms::PageContentTransform;

pub(in crate::render::pdf) fn paint_tiling_pattern(
    content: &mut String,
    form: &ImageRef,
    rect: PdfRect,
) {
    content.push_str(&format!(
        "q\n1 0 0 1 {left} {bottom} cm\n/{name} Do\nQ\n",
        left = rect.left,
        bottom = rect.bottom,
        name = form.name,
    ));
}

pub(in crate::render::pdf) fn paint_shading_pattern(
    content: &mut String,
    name: &str,
    tile: PdfRect,
) {
    content.push_str("q\n/Pattern cs\n");
    content.push_str(&format!("/{name} scn\n"));
    content.push_str(&tile.rect_path());
    content.push_str("f\nQ\n");
}

pub(in crate::render::pdf) fn paint_page_tiling_pattern(
    content: &mut String,
    name: &str,
    rect: PdfRect,
) {
    content.push_str("q\n/Pattern cs\n");
    content.push_str(&format!("/{name} scn\n"));
    content.push_str(&rect.rect_path());
    content.push_str("f\nQ\n");
}

pub(in crate::render::pdf) fn paint_css_box_pattern(
    content: &mut String,
    page: PageContentTransform,
    name: &str,
    rect: PdfRect,
) -> Option<()> {
    let origin = PdfPoint::new(rect.left, rect.top());
    let size = PdfVector::new(
        rect.width / crate::fonts::PT_PER_CSS_PX,
        rect.height / crate::fonts::PT_PER_CSS_PX,
    );
    let operator = page.css_box_operator(origin)?;
    content.push_str("q\n");
    content.push_str(&operator);
    content.push_str(&format!(
        "/Pattern cs\n/{name} scn\n0 0 {} {} re\nf\nQ\n",
        size.x, size.y,
    ));
    Some(())
}

pub(in crate::render::pdf) fn paint_css_page_pattern(
    content: &mut String,
    page_transform: PageContentTransform,
    name: &str,
    rect: PdfRect,
) -> Option<()> {
    let page = page_transform.page_bounds()?;
    let scale = crate::fonts::PT_PER_CSS_PX;
    let left = (rect.left - page.left) / scale;
    let top = (page.top() - rect.top()) / scale;
    let width = rect.width / scale;
    let height = rect.height / scale;
    content.push_str("q\n");
    content.push_str(&page_transform.css_box_operator(PdfPoint::new(page.left, page.top()))?);
    content.push_str(&format!(
        "/Pattern cs\n/{name} scn\n{left} {top} {width} {height} re\nf\nQ\n",
    ));
    Some(())
}
