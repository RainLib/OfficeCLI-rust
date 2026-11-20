use super::*;
use crate::{DocxPictureLayout, DocxPictureWrap};

pub fn validate_docx_picture_layout(layout: &DocxPictureLayout) -> Result<(), HcdError> {
    let has_position = layout.horizontal_alignment.is_some()
        || layout.horizontal_offset_emu.is_some()
        || layout.vertical_offset_emu.is_some();
    if layout.horizontal_alignment.is_some() && layout.horizontal_offset_emu.is_some()
        || [layout.horizontal_offset_emu, layout.vertical_offset_emu]
            .into_iter()
            .flatten()
            .any(|offset| !(-25_400_000..=25_400_000).contains(&offset))
        || layout
            .text_distance_emu
            .is_some_and(|distance| distance > 5_080_000)
        || layout.wrap_side.is_some() && layout.wrap != DocxPictureWrap::Square
        || layout.wrap == DocxPictureWrap::Inline
            && (has_position || layout.text_distance_emu.is_some())
    {
        return Err(HcdError::InvalidPatch(
            "invalid Word picture positioning or wrap".into(),
        ));
    }
    Ok(())
}

pub(super) fn apply(
    html: &mut String,
    entry: &NodeMapEntry,
    current: &crate::HtmlImageNode,
    layout: Option<&DocxPictureLayout>,
    expected_visual_hash: &str,
) -> Result<(), HcdError> {
    if entry.source.node_kind != "image"
        || !entry.source.editable
        || entry.source.created_in_hcd
        || entry.source.part != "word/document.xml"
        || current.docx_drawing_id.is_none()
    {
        return Err(HcdError::Unsupported(
            "Word picture layout requires an original, mapped body picture with a drawing ID"
                .into(),
        ));
    }
    if current.visual_hash != expected_visual_hash {
        return Err(HcdError::PreconditionFailed(
            "Word picture layout has changed".into(),
        ));
    }

    if let Some(layout) = layout {
        let config = serde_json::to_string(layout)?;
        set_element_attribute(
            html,
            &entry.node_id,
            "data-hcd-docx-picture-layout",
            &config,
        )?;
    } else {
        let (start, end) = element_start_tag_range(html, &entry.node_id)?;
        let mut tag = html[start..=end].to_owned();
        remove_attribute(&mut tag, "data-hcd-docx-picture-layout");
        html.replace_range(start..=end, &tag);
    }
    let hash = crate::html::image_visual_hash_with_layout(
        current.asset_hash.as_deref(),
        current.geometry.as_ref(),
        layout,
    );
    set_element_attribute(html, &entry.node_id, "data-hcd-visual-hash", &hash)?;
    Ok(())
}
