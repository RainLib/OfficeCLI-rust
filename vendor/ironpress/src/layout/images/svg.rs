use crate::parser::dom::ElementNode;
use crate::types::Size;

struct SvgSizeSource<'a> {
    width_raw: Option<&'a str>,
    height_raw: Option<&'a str>,
    natural_width: Option<f32>,
    natural_height: Option<f32>,
    natural_ratio: Option<f32>,
}

impl<'a> SvgSizeSource<'a> {
    fn from_tree(tree: &'a crate::parser::svg::SvgTree) -> Self {
        Self::from_tree_with_viewport_fallback(tree, true)
    }

    fn from_css_image(tree: &'a crate::parser::svg::SvgTree) -> Self {
        Self::from_tree_with_viewport_fallback(tree, false)
    }

    fn from_tree_with_viewport_fallback(
        tree: &'a crate::parser::svg::SvgTree,
        use_resolved_viewport: bool,
    ) -> Self {
        let explicit_width = tree
            .width_attr
            .as_deref()
            .and_then(crate::parser::svg::parse_absolute_length)
            .filter(|width| *width > 0.0);
        let explicit_height = tree
            .height_attr
            .as_deref()
            .and_then(crate::parser::svg::parse_absolute_length)
            .filter(|height| *height > 0.0);
        let natural_width = explicit_width.or_else(|| {
            (use_resolved_viewport && tree.view_box.is_none() && tree.width > 0.0)
                .then_some(tree.width)
        });
        let natural_height = explicit_height.or_else(|| {
            (use_resolved_viewport && tree.view_box.is_none() && tree.height > 0.0)
                .then_some(tree.height)
        });
        Self {
            width_raw: tree.width_attr.as_deref(),
            height_raw: tree.height_attr.as_deref(),
            natural_ratio: svg_natural_ratio(
                explicit_width,
                explicit_height,
                natural_width,
                natural_height,
                tree.view_box,
            ),
            natural_width,
            natural_height,
        }
    }

    fn from_element(el: &'a ElementNode) -> Self {
        let width_raw = el.attributes.get("width").map(String::as_str);
        let height_raw = el.attributes.get("height").map(String::as_str);
        let view_box = el
            .attributes
            .get("viewBox")
            .and_then(|value| crate::parser::svg::parse_viewbox(value));
        let natural_width = width_raw
            .and_then(crate::parser::svg::parse_absolute_length)
            .filter(|width| *width > 0.0);
        let natural_height = height_raw
            .and_then(crate::parser::svg::parse_absolute_length)
            .filter(|height| *height > 0.0);

        Self {
            width_raw,
            height_raw,
            natural_width,
            natural_height,
            natural_ratio: svg_natural_ratio(
                natural_width,
                natural_height,
                natural_width,
                natural_height,
                view_box,
            ),
        }
    }

    fn resolve(
        self,
        available_width: f32,
        available_height: f32,
        allow_percent_width: bool,
        allow_percent_height: bool,
        default_object_size: Size,
    ) -> (f32, f32) {
        let default_width = default_object_size.width;
        let default_height = default_object_size.height;
        let width = resolve_svg_dimension(self.width_raw, available_width, allow_percent_width);
        let height = resolve_svg_dimension(self.height_raw, available_height, allow_percent_height);

        match (width, height) {
            (Some(width), Some(height)) => (width, height),
            (Some(width), None) => {
                if let Some(ratio) = self.natural_ratio {
                    (width, width * ratio)
                } else {
                    (width, self.natural_height.unwrap_or(default_height))
                }
            }
            (None, Some(height)) => {
                if let Some(ratio) = self.natural_ratio {
                    (height / ratio.max(f32::EPSILON), height)
                } else {
                    (self.natural_width.unwrap_or(default_width), height)
                }
            }
            (None, None) => {
                if let Some(width) = self.natural_width {
                    if let Some(height) = self.natural_height {
                        (width, height)
                    } else if let Some(ratio) = self.natural_ratio {
                        (width, width * ratio)
                    } else {
                        (width, default_height)
                    }
                } else if let Some(height) = self.natural_height {
                    if let Some(ratio) = self.natural_ratio {
                        (height / ratio.max(f32::EPSILON), height)
                    } else {
                        (default_width, height)
                    }
                } else if let Some(ratio) = self.natural_ratio {
                    contain_object_size(ratio, default_object_size)
                } else {
                    (default_width, default_height)
                }
            }
        }
    }
}

pub(crate) fn svg_natural_ratio(
    explicit_width: Option<f32>,
    explicit_height: Option<f32>,
    natural_width: Option<f32>,
    natural_height: Option<f32>,
    view_box: Option<crate::parser::svg::ViewBox>,
) -> Option<f32> {
    match (explicit_width, explicit_height) {
        (Some(width), Some(height)) => Some(height / width.max(f32::EPSILON)),
        _ => view_box
            .and_then(|view_box| {
                (view_box.width > 0.0 && view_box.height > 0.0)
                    .then_some(view_box.height / view_box.width)
            })
            .or_else(|| match (natural_width, natural_height) {
                (Some(width), Some(height)) => Some(height / width.max(f32::EPSILON)),
                _ => None,
            }),
    }
}

pub(crate) fn contain_object_size(ratio: f32, default_object_size: Size) -> (f32, f32) {
    let default_ratio = default_object_size.height / default_object_size.width;
    if ratio > default_ratio {
        (
            default_object_size.height / ratio,
            default_object_size.height,
        )
    } else {
        (default_object_size.width, default_object_size.width * ratio)
    }
}

/// Resolve the rendered size of an SVG from its intrinsic dimensions and raw
/// `width`/`height` attributes.
pub(crate) fn resolve_svg_size(
    tree: &crate::parser::svg::SvgTree,
    available_width: f32,
    available_height: f32,
    allow_percent_width: bool,
    allow_percent_height: bool,
) -> (f32, f32) {
    SvgSizeSource::from_tree(tree).resolve(
        available_width,
        available_height,
        allow_percent_width,
        allow_percent_height,
        Size::new(300.0, 150.0),
    )
}

/// Resolve an SVG used as a CSS image against its context-defined default
/// object size. Unlike an inline SVG viewport, parser fallback dimensions are
/// not treated as natural dimensions.
pub(crate) fn resolve_svg_image_size(
    tree: &crate::parser::svg::SvgTree,
    default_object_size: Size,
) -> Size {
    let (width, height) = SvgSizeSource::from_css_image(tree).resolve(
        default_object_size.width,
        default_object_size.height,
        false,
        false,
        default_object_size,
    );
    Size::new(width, height)
}

pub(crate) fn resolve_svg_element_size(
    el: &ElementNode,
    available_width: f32,
    available_height: f32,
    allow_percent_width: bool,
    allow_percent_height: bool,
) -> (f32, f32) {
    SvgSizeSource::from_element(el).resolve(
        available_width,
        available_height,
        allow_percent_width,
        allow_percent_height,
        Size::new(300.0, 150.0),
    )
}

pub(crate) fn resolve_svg_dimension(
    raw: Option<&str>,
    available_space: f32,
    allow_percent: bool,
) -> Option<f32> {
    let raw = raw?;
    let raw = raw.trim();
    if let Some(pct) = raw.strip_suffix('%') {
        if allow_percent {
            if let Ok(value) = pct.trim().parse::<f32>() {
                if value >= 0.0 {
                    return Some(available_space * (value / 100.0));
                }
            }
        }
        return None;
    }

    // SVG width/height attributes are in CSS px by default.
    // Values with explicit "pt" suffix stay as-is; otherwise convert px→pt.
    if raw.ends_with("pt") {
        let value = crate::parser::svg::parse_length(raw)?;
        return if value >= 0.0 { Some(value) } else { None };
    }
    let value = crate::parser::svg::parse_length(raw)?;
    if value >= 0.0 {
        // Convert px to pt (1px = 0.75pt)
        Some(value * 0.75)
    } else {
        None
    }
}

pub(crate) fn sync_svg_tree_to_layout_box(
    tree: &mut crate::parser::svg::SvgTree,
    width: f32,
    height: f32,
) {
    if tree.view_box.is_none() {
        tree.width = width;
        tree.height = height;
    }
}

pub(crate) fn inject_inherited_svg_color(
    tree: &mut crate::parser::svg::SvgTree,
    inherited_color: crate::types::Color,
) {
    let inherit_color = |style: &mut crate::parser::svg::SvgStyle| {
        style.color.get_or_insert(inherited_color);
    };

    match tree.children.as_mut_slice() {
        [crate::parser::svg::SvgNode::Group { style, .. }] => inherit_color(style),
        _ => {
            tree.children = vec![crate::parser::svg::SvgNode::Group {
                transform: None,
                children: std::mem::take(&mut tree.children),
                style: crate::parser::svg::SvgStyle {
                    color: Some(inherited_color),
                    ..crate::parser::svg::SvgStyle::default()
                },
            }];
        }
    }
}
