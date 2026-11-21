//! Resolve the bounded layout/master defaults before streaming a slide. Slide
//! placeholders match layout placeholders by idx; layout placeholders inherit
//! the corresponding master type. None of these defaults rewrite source XML.

use super::{design, SlideRunFormat};
use hcd_core::{pptx_design::PptxSlideDesign, HcdError};
use oxml::StreamingOxmlArchive;
use quick_xml::{events::Event, name::ResolveResult, NsReader};
use roxmltree::{Document, Node};
use std::{
    collections::{BTreeMap, HashMap},
    io::{BufReader, Read},
    sync::Arc,
};

const PML: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DML: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub(super) enum SlideColorMap {
    #[default]
    Inherit,
    Master,
    Override(BTreeMap<String, String>),
}

impl SlideColorMap {
    pub(super) fn read(archive: &mut StreamingOxmlArchive, part: &str) -> Result<Self, HcdError> {
        archive
            .with_part(part, |source| {
                Self::parse(source, part)
                    .map_err(|error| oxml::PackageError::ReadPartError(error.to_string()))
            })
            .map_err(super::package_error)
    }

    fn parse(source: &mut dyn Read, part: &str) -> Result<Self, HcdError> {
        // The override follows the shape tree. Stream past it rather than loading
        // a potentially large slide into the bounded control-part DOM cache.
        let mut reader = NsReader::from_reader(BufReader::with_capacity(64 * 1024, source));
        reader.config_mut().check_end_names = true;
        let mut buffer = Vec::with_capacity(64 * 1024);
        let mut budget = super::XmlBudget::default();
        let mut depth = 0usize;
        let mut override_depth = None;
        let mut result = Self::Inherit;
        loop {
            let (ns, event) = reader
                .read_resolved_event_into(&mut buffer)
                .map_err(|error| {
                    HcdError::InvalidBundle(format!("slide color map XML: {error}"))
                })?;
            budget.observe(&event, part)?;
            match &event {
                Event::Start(start) | Event::Empty(start) => {
                    let local = start.local_name();
                    if depth == 1
                        && local.as_ref() == b"clrMapOvr"
                        && ns == ResolveResult::Bound(quick_xml::name::Namespace(PML.as_bytes()))
                    {
                        override_depth = Some(depth + 1);
                    } else if override_depth == Some(depth)
                        && ns == ResolveResult::Bound(quick_xml::name::Namespace(DML.as_bytes()))
                    {
                        if local.as_ref() == b"masterClrMapping" {
                            result = Self::Master;
                        } else if local.as_ref() == b"overrideClrMapping" {
                            let mut map = BTreeMap::new();
                            for slot in [
                                "bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3",
                                "accent4", "accent5", "accent6", "hlink", "folHlink",
                            ] {
                                if let Some(value) = super::attribute(start, slot).filter(|value| {
                                    matches!(
                                        value.as_str(),
                                        "dk1"
                                            | "lt1"
                                            | "dk2"
                                            | "lt2"
                                            | "accent1"
                                            | "accent2"
                                            | "accent3"
                                            | "accent4"
                                            | "accent5"
                                            | "accent6"
                                            | "hlink"
                                            | "folHlink"
                                    )
                                }) {
                                    map.insert(slot.into(), value);
                                }
                            }
                            result = Self::Override(map);
                        }
                    }
                    if matches!(&event, Event::Start(_)) {
                        depth += 1;
                    } else if override_depth == Some(depth + 1) {
                        override_depth = None;
                    }
                }
                Event::End(_) => {
                    if override_depth == Some(depth) {
                        override_depth = None;
                    }
                    depth = depth.saturating_sub(1);
                }
                Event::Eof => break,
                _ => {}
            }
            buffer.clear();
        }
        Ok(result)
    }
}

#[derive(Clone, Default)]
pub(super) struct TextStyle {
    pub alignment: Option<String>,
    pub format: SlideRunFormat,
}

impl TextStyle {
    pub fn overlay(&mut self, other: &Self) {
        if other.alignment.is_some() {
            self.alignment.clone_from(&other.alignment);
        }
        self.format.overlay(&other.format);
    }
}

#[derive(Clone, Default)]
pub(super) struct Placeholder {
    pub text_kind: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub rotation: Option<i64>,
    pub flip_h: Option<bool>,
    pub flip_v: Option<bool>,
    pub anchor: Option<&'static str>,
    pub margins: [Option<u64>; 4],
    pub styles: [TextStyle; 9],
}

#[derive(Default)]
pub(super) struct LayoutInheritance {
    placeholders: HashMap<u32, Arc<Placeholder>>,
    title: [TextStyle; 9],
    body: [TextStyle; 9],
    other: [TextStyle; 9],
    fonts: HashMap<String, String>,
    colors: HashMap<String, String>,
}

fn child<'a, 'i>(node: Node<'a, 'i>, ns: &str, name: &str) -> Option<Node<'a, 'i>> {
    node.children().find(|n| n.has_tag_name((ns, name)))
}

fn path<'a, 'i>(node: Node<'a, 'i>, ns: &str, names: &[&str]) -> Option<Node<'a, 'i>> {
    names
        .iter()
        .try_fold(node, |node, name| child(node, ns, name))
}

fn master_type(kind: &str) -> &str {
    match kind {
        "title" | "ctrTitle" => "title",
        "body" | "subTitle" | "obj" | "chart" | "tbl" | "pic" | "media" | "clipArt" | "dgm" => {
            "body"
        }
        other => other,
    }
}

pub(super) fn text_kind(kind: &str) -> &'static str {
    match master_type(kind) {
        "title" => "title",
        "body" => "body",
        _ => "other",
    }
}

fn placeholder<'a, 'i>(shape: Node<'a, 'i>) -> Option<Node<'a, 'i>> {
    path(shape, PML, &["nvSpPr", "nvPr", "ph"])
}

fn placeholders<'a, 'i>(root: Node<'a, 'i>) -> Vec<Node<'a, 'i>> {
    path(root, PML, &["cSld", "spTree"])
        .into_iter()
        .flat_map(|tree| tree.children())
        .filter(|shape| shape.has_tag_name((PML, "sp")) && placeholder(*shape).is_some())
        .collect()
}

fn bounded_font(font: &str) -> Option<String> {
    (!font.is_empty() && font.len() <= 512 && !font.chars().any(char::is_control))
        .then(|| font.to_owned())
}

impl LayoutInheritance {
    pub(super) fn read(
        archive: &mut StreamingOxmlArchive,
        design: &PptxSlideDesign,
        slide_map: &SlideColorMap,
    ) -> Result<Self, HcdError> {
        let Some(layout) = design::xml_part(archive, &design.layout_part)? else {
            return Ok(Self::default());
        };
        let Some(master) = design::xml_part(archive, &design.master_part)? else {
            return Ok(Self::default());
        };
        let theme = match design::related_part(archive, &design.master_part, "/theme")? {
            Some(part) => design::xml_part(archive, &part)?,
            None => None,
        };
        let (Ok(layout), Ok(master)) = (Document::parse(&layout), Document::parse(&master)) else {
            return Ok(Self::default());
        };
        let theme = theme.as_deref().and_then(|xml| Document::parse(xml).ok());
        Self::from_roots(
            layout.root_element(),
            master.root_element(),
            theme.as_ref().map(Document::root_element),
            slide_map,
        )
    }

    pub(super) fn from_roots(
        layout: Node<'_, '_>,
        master: Node<'_, '_>,
        theme: Option<Node<'_, '_>>,
        slide_map: &SlideColorMap,
    ) -> Result<Self, HcdError> {
        let mut result = Self::default();
        let color_map = match slide_map {
            SlideColorMap::Inherit => child(layout, PML, "clrMapOvr")
                .and_then(|node| child(node, DML, "overrideClrMapping"))
                .or_else(|| child(master, PML, "clrMap")),
            SlideColorMap::Master => child(master, PML, "clrMap"),
            SlideColorMap::Override(_) => None,
        };
        if let Some(theme) = theme {
            if let Some(fonts) = path(theme, DML, &["themeElements", "fontScheme"]) {
                for (set, alias) in [("majorFont", "+mj"), ("minorFont", "+mn")] {
                    if let Some(fonts) = child(fonts, DML, set) {
                        for (tag, suffix) in [("latin", "lt"), ("ea", "ea"), ("cs", "cs")] {
                            if let Some(font) = child(fonts, DML, tag)
                                .and_then(|font| font.attribute("typeface"))
                                .and_then(bounded_font)
                            {
                                result.fonts.insert(format!("{alias}-{suffix}"), font);
                            }
                        }
                        for font in fonts
                            .children()
                            .filter(|node| node.has_tag_name((DML, "font")))
                        {
                            if let (Some(script), Some(face)) = (
                                font.attribute("script").filter(|s| {
                                    s.len() == 4 && s.bytes().all(|c| c.is_ascii_alphabetic())
                                }),
                                font.attribute("typeface").and_then(bounded_font),
                            ) {
                                result.fonts.insert(format!("{alias}:{script}"), face);
                            }
                        }
                    }
                }
            }
            for slot in [
                "bg1", "bg2", "tx1", "tx2", "dk1", "dk2", "lt1", "lt2", "accent1", "accent2",
                "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink",
            ] {
                let mapped = match slide_map {
                    SlideColorMap::Override(map) => map.get(slot).map(String::as_str),
                    _ => None,
                }
                .or_else(|| color_map.and_then(|map| map.attribute(slot)))
                .unwrap_or(match slot {
                    "bg1" => "lt1",
                    "bg2" => "lt2",
                    "tx1" => "dk1",
                    "tx2" => "dk2",
                    _ => slot,
                });
                if let Some(color) = path(theme, DML, &["themeElements", "clrScheme", mapped])
                    .and_then(|color| color.children().find(Node::is_element))
                    .and_then(|color| design::color_of(color, Some(theme), None, None))
                {
                    result
                        .colors
                        .insert(slot.into(), color.trim_start_matches('#').into());
                }
            }
        }
        if let Some(styles) = child(master, PML, "txStyles") {
            result.title = result.styles(child(styles, PML, "titleStyle"));
            result.body = result.styles(child(styles, PML, "bodyStyle"));
            result.other = result.styles(child(styles, PML, "otherStyle"));
        }
        for style in result
            .title
            .iter_mut()
            .chain(result.body.iter_mut())
            .chain(result.other.iter_mut())
        {
            style.format.master_mask = hcd_core::pptx_design::MASTER_ALL;
            style.format.blocked_master_mask = 0;
        }
        let masters = placeholders(master);
        let mut budget = 0usize;
        for shape in placeholders(layout) {
            let ph = placeholder(shape).expect("placeholder was filtered");
            let index = ph.attribute("idx").unwrap_or("0").parse::<u32>().ok();
            let Some(index) = index.filter(|index| *index != u32::MAX) else {
                continue;
            };
            let kind = ph.attribute("type").unwrap_or("obj");
            let mut inherited = Placeholder {
                text_kind: Some(kind.into()),
                styles: result.text_styles(kind).clone(),
                ..Placeholder::default()
            };
            let master_kind = master_type(kind);
            let mut matching = masters.iter().copied().filter(|shape| {
                placeholder(*shape)
                    .and_then(|ph| ph.attribute("type"))
                    .unwrap_or("obj")
                    == master_kind
            });
            if let Some(base) = matching.next().filter(|_| matching.next().is_none()) {
                result.overlay_shape(&mut inherited, base);
            }
            result.overlay_shape(&mut inherited, shape);
            budget += 256
                + inherited
                    .styles
                    .iter()
                    .map(|style| {
                        let f = &style.format;
                        128 + [
                            &style.alignment,
                            &f.color,
                            &f.font,
                            &f.east_asia_font,
                            &f.complex_script_font,
                            &f.language,
                        ]
                        .into_iter()
                        .map(|s| s.as_ref().map_or(0, String::len))
                        .sum::<usize>()
                    })
                    .sum::<usize>();
            if budget > 8 * 1024 * 1024 {
                return Err(HcdError::ResourceLimit(
                    "PPTX layout inheritance exceeds 8 MiB".into(),
                ));
            }
            // Ambiguous duplicate idx values must never bind to an arbitrary shape.
            result
                .placeholders
                .entry(index)
                .and_modify(|value| *value = Arc::new(Placeholder::default()))
                .or_insert_with(|| Arc::new(inherited));
        }
        Ok(result)
    }

    fn overlay_shape(&self, inherited: &mut Placeholder, shape: Node<'_, '_>) {
        if let Some(xfrm) = path(shape, PML, &["spPr"]).and_then(|props| child(props, DML, "xfrm"))
        {
            if let Some(off) = child(xfrm, DML, "off") {
                inherited.x = off
                    .attribute("x")
                    .and_then(|s| s.parse().ok())
                    .or(inherited.x);
                inherited.y = off
                    .attribute("y")
                    .and_then(|s| s.parse().ok())
                    .or(inherited.y);
            }
            if let Some(ext) = child(xfrm, DML, "ext") {
                inherited.width = ext
                    .attribute("cx")
                    .and_then(|s| s.parse().ok())
                    .or(inherited.width);
                inherited.height = ext
                    .attribute("cy")
                    .and_then(|s| s.parse().ok())
                    .or(inherited.height);
            }
            inherited.rotation = xfrm
                .attribute("rot")
                .and_then(|s| s.parse().ok())
                .or(inherited.rotation);
            inherited.flip_h = xfrm
                .attribute("flipH")
                .map(|s| matches!(s, "1" | "true"))
                .or(inherited.flip_h);
            inherited.flip_v = xfrm
                .attribute("flipV")
                .map(|s| matches!(s, "1" | "true"))
                .or(inherited.flip_v);
        }
        if let Some(body) = child(shape, PML, "txBody") {
            if let Some(props) = child(body, DML, "bodyPr") {
                inherited.anchor = props
                    .attribute("anchor")
                    .and_then(|anchor| match anchor {
                        "t" => Some("flex-start"),
                        "ctr" => Some("center"),
                        "b" => Some("flex-end"),
                        _ => None,
                    })
                    .or(inherited.anchor);
                for (i, name) in ["lIns", "rIns", "tIns", "bIns"].iter().enumerate() {
                    inherited.margins[i] = props
                        .attribute(*name)
                        .and_then(|s| s.parse().ok())
                        .or(inherited.margins[i]);
                }
            }
            let styles = self.styles(child(body, DML, "lstStyle"));
            for (style, over) in inherited.styles.iter_mut().zip(styles.iter()) {
                style.overlay(over);
            }
        }
    }

    fn styles(&self, styles: Option<Node<'_, '_>>) -> [TextStyle; 9] {
        std::array::from_fn(|level| {
            let mut style = TextStyle::default();
            if let Some(styles) = styles {
                if let Some(default) = child(styles, DML, "defPPr") {
                    self.paragraph(&mut style, default);
                }
                if let Some(props) = child(styles, DML, &format!("lvl{}pPr", level + 1)) {
                    self.paragraph(&mut style, props);
                }
            }
            style
        })
    }

    fn paragraph(&self, style: &mut TextStyle, node: Node<'_, '_>) {
        style.alignment = node
            .attribute("algn")
            .filter(|value| super::pptx_alignment(value).is_some())
            .map(str::to_owned)
            .or_else(|| style.alignment.clone());
        style.format.rtl = node
            .attribute("rtl")
            .map(|s| matches!(s, "1" | "true"))
            .or(style.format.rtl);
        if let Some(run) = child(node, DML, "defRPr") {
            let over = SlideRunFormat {
                master_mask: 0,
                blocked_master_mask: if run.children().any(|n| {
                    n.tag_name().namespace() == Some(DML)
                        && matches!(
                            n.tag_name().name(),
                            "solidFill"
                                | "noFill"
                                | "gradFill"
                                | "blipFill"
                                | "pattFill"
                                | "grpFill"
                        )
                }) {
                    hcd_core::pptx_design::MASTER_COLOR
                } else {
                    0
                },
                size_hundredth_points: run.attribute("sz").and_then(|s| s.parse().ok()),
                spacing_hundredth_points: run.attribute("spc").and_then(|s| s.parse().ok()),
                bold: run.attribute("b").map(|s| matches!(s, "1" | "true")),
                italic: run.attribute("i").map(|s| matches!(s, "1" | "true")),
                underline: run
                    .attribute("u")
                    .map(|s| !matches!(s, "none" | "0" | "false")),
                strike: run
                    .attribute("strike")
                    .map(|s| !matches!(s, "noStrike" | "0" | "false")),
                rtl: run.attribute("rtl").map(|s| matches!(s, "1" | "true")),
                language: run
                    .attribute("lang")
                    .filter(|value| value.len() <= 64)
                    .map(str::to_owned),
                color: child(run, DML, "solidFill")
                    .and_then(|fill| fill.children().find(Node::is_element))
                    .and_then(|color| {
                        if color.has_tag_name((DML, "schemeClr")) {
                            color
                                .attribute("val")
                                .and_then(|slot| self.colors.get(slot).cloned())
                        } else {
                            design::color_of(color, None, None, None)
                                .map(|s| s.trim_start_matches('#').into())
                        }
                    }),
                font: child(run, DML, "latin")
                    .and_then(|font| font.attribute("typeface"))
                    .and_then(|font| self.font(font)),
                east_asia_font: child(run, DML, "ea")
                    .and_then(|font| font.attribute("typeface"))
                    .and_then(|font| self.font(font)),
                complex_script_font: child(run, DML, "cs")
                    .and_then(|font| font.attribute("typeface"))
                    .and_then(|font| self.font(font)),
            };
            style.format.overlay(&over);
        }
    }

    pub(super) fn placeholder(&self, index: u32) -> Option<Arc<Placeholder>> {
        self.placeholders.get(&index).cloned()
    }
    pub(super) fn text_styles(&self, kind: &str) -> &[TextStyle; 9] {
        match master_type(kind) {
            "title" => &self.title,
            "body" => &self.body,
            _ => &self.other,
        }
    }
    pub(super) fn master_text_styles(&self) -> Vec<hcd_core::pptx_design::PptxMasterTextStyle> {
        use hcd_core::{
            pptx_design::{PptxMasterTextKind, PptxMasterTextStyle},
            FontPatch, PptxRunFormat,
        };
        [
            (PptxMasterTextKind::Title, &self.title),
            (PptxMasterTextKind::Body, &self.body),
            (PptxMasterTextKind::Other, &self.other),
        ]
        .into_iter()
        .flat_map(|(kind, levels)| {
            levels.iter().enumerate().map(move |(level, style)| {
                let f = &style.format;
                let font = FontPatch {
                    latin: f.font.clone(),
                    east_asia: f.east_asia_font.clone(),
                    bidi: f.complex_script_font.clone(),
                };
                PptxMasterTextStyle {
                    kind,
                    level: level as u8 + 1,
                    format: PptxRunFormat {
                        bold: f.bold,
                        italic: f.italic,
                        underline: f.underline,
                        font_size_pt: f.size_hundredth_points.map(|n| n as f32 / 100.),
                        color: f.color.as_ref().map(|s| format!("#{s}")),
                    },
                    font: (font.latin.is_some() || font.east_asia.is_some() || font.bidi.is_some())
                        .then_some(font),
                }
            })
        })
        .collect()
    }
    pub(super) fn font(&self, font: &str) -> Option<String> {
        if font.starts_with('+') {
            self.fonts.get(font).cloned().or_else(|| {
                let prefix = font
                    .strip_suffix("-ea")
                    .or_else(|| font.strip_suffix("-cs"))?;
                self.fonts
                    .keys()
                    .any(|key| key.starts_with(&format!("{prefix}:")))
                    .then(|| font.to_owned())
            })
        } else {
            bounded_font(font)
        }
    }
    pub(super) fn font_for_text(
        &self,
        font: &str,
        language: Option<&str>,
        text: &str,
    ) -> Option<String> {
        if !font.starts_with('+') {
            return bounded_font(font);
        }
        if let Some(face) = self.fonts.get(font) {
            return Some(face.clone());
        }
        let lang = language.unwrap_or("").to_ascii_lowercase();
        let script = if lang.starts_with("zh-tw")
            || lang.starts_with("zh-hk")
            || lang.starts_with("zh-mo")
            || lang.starts_with("zh-hant")
        {
            "Hant"
        } else if lang.starts_with("zh") {
            "Hans"
        } else if lang.starts_with("ja") {
            "Jpan"
        } else if lang.starts_with("ko") {
            "Hang"
        } else if lang.starts_with("ar") || lang.starts_with("fa") || lang.starts_with("ur") {
            "Arab"
        } else if lang.starts_with("he") {
            "Hebr"
        } else if lang.starts_with("th") {
            "Thai"
        } else if text.chars().any(|c| matches!(c as u32, 0x3040..=0x30ff)) {
            "Jpan"
        } else if text
            .chars()
            .any(|c| matches!(c as u32, 0x1100..=0x11ff | 0x3130..=0x318f | 0xac00..=0xd7af))
        {
            "Hang"
        } else if text
            .chars()
            .any(|c| matches!(c as u32, 0x3400..=0x9fff | 0x20000..=0x323af))
        {
            "Hans"
        } else if text
            .chars()
            .any(|c| matches!(c as u32, 0x0600..=0x06ff | 0x0750..=0x077f))
        {
            "Arab"
        } else {
            return None;
        };
        let east_asian = matches!(script, "Hans" | "Hant" | "Jpan" | "Hang");
        let prefix = if east_asian {
            font.strip_suffix("-ea")?
        } else {
            font.strip_suffix("-cs")?
        };
        self.fonts.get(&format!("{prefix}:{script}")).cloned()
    }
    pub(super) fn color(&self, slot: &str) -> Option<String> {
        self.colors.get(slot).cloned()
    }
    pub(super) fn colors(&self) -> &HashMap<String, String> {
        &self.colors
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LAYOUT: &str = include_str!("../../../../examples/hdoc/embed-host/fixtures/pptx-inheritance/ppt/slideLayouts/slideLayout1.xml");
    const MASTER: &str = include_str!("../../../../examples/hdoc/embed-host/fixtures/pptx-inheritance/ppt/slideMasters/slideMaster1.xml");
    const THEME: &str = include_str!(
        "../../../../examples/hdoc/embed-host/fixtures/pptx-inheritance/ppt/theme/theme1.xml"
    );

    #[test]
    fn slide_color_override_uses_its_own_master_or_palette_without_leaking_between_slides() {
        let layout = Document::parse(LAYOUT).unwrap();
        let master = Document::parse(MASTER).unwrap();
        let theme = Document::parse(THEME).unwrap();
        let mut palettes = Vec::new();
        for (mapping, expected) in [
            ("<a:masterClrMapping/>", "222222"),
            ("<a:overrideClrMapping tx1=\"accent4\"/>", "4a6c9a"),
            ("<a:overrideClrMapping tx1=\"accent6\"/>", "4d7878"),
        ] {
            let xml = format!("<p:sld xmlns:p=\"{PML}\" xmlns:a=\"{DML}\"><p:cSld/><p:clrMapOvr>{mapping}</p:clrMapOvr></p:sld>");
            let palette = SlideColorMap::parse(&mut std::io::Cursor::new(xml), "test.xml").unwrap();
            let data = LayoutInheritance::from_roots(
                layout.root_element(),
                master.root_element(),
                Some(theme.root_element()),
                &palette,
            )
            .unwrap();
            assert_eq!(
                data.placeholder(0).unwrap().styles[0]
                    .format
                    .color
                    .as_deref(),
                Some(expected)
            );
            palettes.push(palette);
        }
        assert!(palettes.windows(2).all(|pair| pair[0] != pair[1]));
        let spoofed = format!("<p:sld xmlns:p=\"{PML}\" xmlns:a=\"urn:unrelated\"><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>");
        assert_eq!(
            SlideColorMap::parse(&mut std::io::Cursor::new(spoofed), "test.xml").unwrap(),
            SlideColorMap::Inherit
        );
    }

    #[test]
    fn resolves_layout_indices_master_types_and_theme_defaults() {
        let layout = Document::parse(LAYOUT).unwrap();
        let master = Document::parse(MASTER).unwrap();
        let theme = Document::parse(THEME).unwrap();
        let data = LayoutInheritance::from_roots(
            layout.root_element(),
            master.root_element(),
            Some(theme.root_element()),
            &SlideColorMap::Inherit,
        )
        .unwrap();
        let title = data.placeholder(0).unwrap();
        assert_eq!(
            (title.x, title.y, title.width, title.height),
            (Some(914400), Some(457200), Some(7315200), Some(914400))
        );
        assert_eq!(title.styles[0].format.font.as_deref(), Some("Georgia"));
        assert_eq!(title.styles[0].format.color.as_deref(), Some("6a4b83"));
        assert_eq!(title.styles[0].alignment.as_deref(), Some("ctr"));
        assert_eq!(title.styles[0].format.bold, Some(true));
        let body = data.placeholder(7).unwrap();
        assert_eq!(
            (body.x, body.y, body.width, body.height),
            (Some(1371600), Some(1828800), Some(6400800), Some(2743200))
        );
        assert_eq!(body.styles[0].format.size_hundredth_points, Some(2000));
        assert_eq!(body.styles[0].format.font.as_deref(), Some("Arial"));
        assert_eq!(body.styles[0].format.color.as_deref(), Some("246b57"));
        assert_eq!(body.styles[1].format.size_hundredth_points, Some(1600));
        assert_eq!(body.styles[1].format.italic, Some(true));
        assert_eq!(
            data.font_for_text("+mn-ea", Some("zh-CN"), "主题字体")
                .as_deref(),
            Some("Noto Sans SC")
        );
        assert_eq!(
            data.font_for_text("+mn-ea", Some("zh-TW"), "主題字體")
                .as_deref(),
            Some("Noto Sans TC")
        );
        assert_eq!(
            data.font_for_text("+mn-cs", Some("ar-SA"), "نص").as_deref(),
            Some("Noto Naskh Arabic")
        );
        assert!(data.font_for_text("+mn-ea", None, "English text").is_none());
        assert!(
            data.placeholder(99).is_none(),
            "an unknown idx must not bind to another body placeholder"
        );
        assert_eq!(
            data.text_styles("other")[8].format.size_hundredth_points,
            Some(1100)
        );
    }

    #[test]
    fn duplicate_indices_and_unresolved_fonts_do_not_guess_a_parent() {
        let duplicate = LAYOUT.replace("idx=\"8\"", "idx=\"7\"");
        let layout = Document::parse(&duplicate).unwrap();
        let master = Document::parse(MASTER).unwrap();
        let data = LayoutInheritance::from_roots(
            layout.root_element(),
            master.root_element(),
            None,
            &SlideColorMap::Inherit,
        )
        .unwrap();
        assert_eq!(data.placeholder(7).unwrap().width, None);
        assert_eq!(
            data.font("+mj-lt"),
            None,
            "an unresolved theme alias is not a font name"
        );
        assert_eq!(master_type("ctrTitle"), "title");
        assert_eq!(master_type("subTitle"), "body");
    }
}
