//! Section-aware, read-only HTML presentation. Canonical regions and layout
//! remain once in the file; browser page views do not acquire editing authority.
use hcd_core::{FlowDocumentLayout, FlowStoryKind, HcdError, FLOW_REGION_LAYOUT_SCHEMA};
use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cases {
    first_odd: Option<String>,
    first_even: Option<String>,
    odd: Option<String>,
    even: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Section {
    id: String,
    width: f64,
    height: f64,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    header_distance: f64,
    footer_distance: f64,
    header: Cases,
    footer: Cases,
    number_start: Option<u32>,
    default_dimensions: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan<'a> {
    schema_version: &'static str,
    layout: &'a FlowDocumentLayout,
    sections: Vec<Section>,
}
fn cases(layout: &FlowDocumentLayout, index: usize, kind: FlowStoryKind) -> Cases {
    let id = |first, even| {
        layout
            .story_for_page(index, kind, first, even)
            .map(|story| story.id.clone())
    };
    Cases {
        first_odd: id(true, false),
        first_even: id(true, true),
        odd: id(false, false),
        even: id(false, true),
    }
}
fn plan(layout: &FlowDocumentLayout) -> Result<Plan<'_>, HcdError> {
    layout.validate()?;
    if layout.schema_version != FLOW_REGION_LAYOUT_SCHEMA {
        return Err(HcdError::Unsupported("Project Word regions before HTML export; legacy section metadata lacks canonical region identities".into()));
    }
    let sections = layout
        .sections
        .iter()
        .enumerate()
        .map(|(index, section)| {
            let p = &section.page;
            let margin = |key, default| {
                f64::from(p.margins_twips.get(key).copied().unwrap_or(default).max(0)) / 15.0
            };
            Section {
                id: section.id.clone(),
                width: f64::from(p.width_twips.unwrap_or(11906)) / 15.0,
                height: f64::from(p.height_twips.unwrap_or(16838)) / 15.0,
                left: margin("left", 1440) + margin("gutter", 0),
                right: margin("right", 1440),
                top: margin("top", 1440),
                bottom: margin("bottom", 1440),
                header_distance: margin("header", 720),
                footer_distance: margin("footer", 720),
                header: cases(layout, index, FlowStoryKind::Header),
                footer: cases(layout, index, FlowStoryKind::Footer),
                number_start: p.number_start,
                default_dimensions: p.width_twips.is_none() || p.height_twips.is_none(),
            }
        })
        .collect();
    Ok(Plan {
        schema_version: "hcd-word-html/1",
        layout,
        sections,
    })
}
pub(super) fn suffix(layout: &FlowDocumentLayout) -> Result<String, HcdError> {
    let data = serde_json::to_string(&plan(layout)?)?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    Ok(format!("<script type=\"application/json\" id=\"hcd-word-export-plan\">{data}</script><style>{}</style><script>{}</script>",include_str!("word.css"),include_str!("word.js")))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn layout() -> FlowDocumentLayout {
        serde_json::from_value(serde_json::json!({"schemaVersion":"hcd-flow-layout/2","evenAndOddHeaders":true,"sections":[{"id":format!("n_{:032x}",1),"canonicalEndBlockId":format!("n_{:032x}",10),"source":{"part":"word/document.xml","paragraphOrdinal":2},"differentFirstPage":true,"page":{"widthTwips":12240,"heightTwips":15840,"marginsTwips":{"left":720,"right":720,"top":720,"bottom":720}},"headers":{"default":format!("n_{:032x}",3),"first":format!("n_{:032x}",4),"even":format!("n_{:032x}",5)},"footers":{}},{"id":format!("n_{:032x}",2),"source":{"part":"word/document.xml"},"differentFirstPage":false,"page":{"widthTwips":16838,"heightTwips":11906},"headers":{},"footers":{}}],"stories":[{"id":format!("n_{:032x}",3),"kind":"header","sourcePart":"word/header.xml"},{"id":format!("n_{:032x}",4),"kind":"header","sourcePart":"word/first.xml"},{"id":format!("n_{:032x}",5),"kind":"header","sourcePart":"word/even.xml"}]})).unwrap()
    }
    #[test]
    fn region_html_plan_preserves_paper_dimensions_variants_and_inherited_stories() {
        let l = layout();
        let p = plan(&l).unwrap();
        assert_eq!(p.sections[0].width, 816.0);
        assert_eq!(p.sections[0].height, 1056.0);
        assert_eq!(p.sections[0].left, 48.0);
        assert!(p.sections[1].width > p.sections[1].height);
        assert_eq!(
            p.sections[0].header.first_odd,
            Some(format!("n_{:032x}", 4))
        );
        assert_eq!(
            p.sections[0].header.first_even,
            p.sections[0].header.first_odd
        );
        assert_eq!(p.sections[1].header.odd, Some(format!("n_{:032x}", 3)));
        assert_eq!(p.sections[1].header.even, Some(format!("n_{:032x}", 5)));
    }
    #[test]
    fn region_html_missing_first_or_even_story_stays_blank() {
        let mut l = layout();
        l.sections[0].headers.first = None;
        l.sections[0].headers.even = None;
        let p = plan(&l).unwrap();
        assert!(p.sections[0].header.first_odd.is_none());
        assert!(p.sections[0].header.even.is_none());
        assert!(p.sections[0].header.odd.is_some());
    }
    #[test]
    fn region_html_marks_default_dimensions_and_keeps_original_metadata() {
        let mut l = layout();
        l.sections[1].page.width_twips = None;
        l.sections[1].page.margins_twips.insert("top".into(), -200);
        let p = plan(&l).unwrap();
        assert!(p.sections[1].default_dimensions);
        assert_eq!(p.sections[1].top, 0.0);
        assert_eq!(p.layout.sections[1].page.margins_twips["top"], -200);
    }
    #[test]
    fn region_html_rejects_legacy_unscoped_layout_and_invalid_metadata() {
        let mut l = layout();
        l.schema_version = "hcd-flow-layout/1".into();
        l.sections[0].canonical_end_block_id = None;
        assert!(plan(&l).is_err());
        l.schema_version = "hcd-flow-layout/2".into();
        l.sections[0].id = "bad".into();
        assert!(plan(&l).is_err());
    }
    #[test]
    fn region_html_json_cannot_break_out_of_its_inert_script() {
        let mut l = layout();
        l.sections[1].source.original_properties_xml=Some("<w:sectPr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:unknown a=\"&lt;/script&gt;\"/></w:sectPr>".into());
        let text = suffix(&l).unwrap();
        assert_eq!(text.matches("</script>").count(), 2);
        assert!(text.contains("\\u003c"));
    }
}
