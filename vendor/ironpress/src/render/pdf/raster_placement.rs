use super::*;

/// Append one image XObject using the coordinate model owned by its asset.
///
/// Document images remain in their resolved layout rectangle. Renderer-owned
/// images retain the physical density of their offscreen surface and, when no
/// CSS transform intervenes, stay in Chromium's print-device coordinate
/// hierarchy. A transformed owner deliberately keeps point-space placement so
/// the single generic paint transform continues to apply to all descendants.
pub(super) fn push_raster_xobject(
    content: &mut String,
    name: &str,
    rect: PdfRect,
    asset: &crate::layout::engine::RasterImageAsset,
    pdf_writer: &PdfWriter,
) {
    let device_placement = (!pdf_writer.has_active_paint_transform())
        .then(|| asset.origin.pixel_density())
        .flatten()
        .and_then(|density| {
            pdf_writer.page_content_transform.device_raster_placement(
                rect,
                crate::util::RasterDimensions {
                    width: asset.source_width,
                    height: asset.source_height,
                },
                density,
            )
        });

    content.push_str("q\n");
    if let Some(placement) = device_placement {
        content.push_str(&placement.operators());
    } else {
        content.push_str(
            &PdfMatrix::new(
                PdfVector::new(rect.width, 0.0),
                PdfVector::new(0.0, rect.height),
                PdfPoint::new(rect.left, rect.bottom),
            )
            .cm_operator(),
        );
    }
    content.push_str(&format!("/{name} Do\nQ\n"));
}
