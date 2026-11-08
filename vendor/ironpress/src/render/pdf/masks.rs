use super::*;

/// Rasterise a gradient mask into one bounded window of its full sampling grid.
pub(super) fn rasterize_mask_coverage(
    source: &MaskSource,
    mode: MaskMode,
    window: MaskRasterWindow,
) -> Option<Vec<u8>> {
    use crate::style::computed::{RadialPos, RadialShape};
    let w = window.grid.pixels.width as f32;
    let h = window.grid.pixels.height as f32;
    let scale_x = window.grid.scale_x();
    let scale_y = window.grid.scale_y();
    // Resolve a `RadialPos` to MASK PIXELS along an axis of `extent` pixels.
    // `Fraction` scales by the pixel extent directly; point offsets use the
    // grid's exact pixels-per-point scale.
    let resolve_px = |p: RadialPos, extent: f32, scale: f32| -> f32 {
        match p {
            RadialPos::Fraction(f) => extent * f,
            RadialPos::Points(pt) => pt * scale,
            RadialPos::EndOffset(pt) => extent - pt * scale,
        }
    };
    let mut out = Vec::with_capacity(window.len()?);
    match source {
        MaskSource::Linear(lg) => {
            // CSS gradient line: angle 0 = to top, 90 = to right, 180 = to
            // bottom. The line passes through the box centre; the gradient
            // extends from the start corner (projection min) to the end corner
            // (projection max). Normalise each pixel's projection to 0..1.
            // Direction vector of increasing gradient (CSS y grows downward).
            let (dx, cos) = sin_cos_degrees(lg.angle);
            let dy = -cos;
            // Half-length of the projected gradient line: project the box's
            // half-extents onto the direction and sum the absolute components.
            let half = w * 0.5 * dx.abs() + h * 0.5 * dy.abs();
            if !half.is_finite() || half <= 0.0 {
                return None;
            }
            let stop_scale = (scale_x + scale_y) * 0.5;
            let ramp = lg.ramp.resolve_scaled(half * 2.0, stop_scale)?;
            let (cx, cy) = (w * 0.5, h * 0.5);
            for py in 0..window.tile.height {
                let fy = window.global_y(py);
                for px in 0..window.tile.width {
                    let fx = window.global_x(px);
                    let proj = (fx - cx) * dx + (fy - cy) * dy;
                    let t = (proj + half) / (2.0 * half);
                    out.push(coverage_byte(ramp.sample(t), mode));
                }
            }
        }
        MaskSource::Radial(rg) => {
            // Centre in mask pixels.
            let center = PdfPoint::new(
                resolve_px(rg.center.x, w, scale_x),
                resolve_px(rg.center.y, h, scale_y),
            );
            // Resolve the ending-shape radii (px). Explicit radii win; else the
            // extent keyword (default farthest-corner) is computed from the box.
            let distances = RadialEdgeDistances::resolve(center, PdfVector::new(w, h));
            let radii = if let Some(r) = rg.radius {
                let rp = r * scale_x;
                PdfVector::new(rp, rp)
            } else if let Some(radii) = rg.radii {
                PdfVector::new(
                    resolve_px(radii.x, w, scale_x),
                    resolve_px(radii.y, h, scale_y),
                )
            } else {
                match (rg.shape, rg.extent) {
                    (RadialShape::Circle, RadialExtent::ClosestSide) => {
                        let radius = distances.near.x.min(distances.near.y);
                        PdfVector::new(radius, radius)
                    }
                    (RadialShape::Circle, RadialExtent::FarthestSide) => {
                        let radius = distances.far.x.max(distances.far.y);
                        PdfVector::new(radius, radius)
                    }
                    (RadialShape::Circle, RadialExtent::ClosestCorner) => {
                        let radius = distances.near.dot(distances.near).sqrt();
                        PdfVector::new(radius, radius)
                    }
                    (RadialShape::Circle, _) => {
                        let radius = distances.far.dot(distances.far).sqrt();
                        PdfVector::new(radius, radius)
                    }
                    (RadialShape::Ellipse, RadialExtent::ClosestSide) => distances.near,
                    (RadialShape::Ellipse, RadialExtent::FarthestSide) => distances.far,
                    (RadialShape::Ellipse, RadialExtent::ClosestCorner) => {
                        corner_ellipse_radii(distances.near, distances.near)
                    }
                    (RadialShape::Ellipse, RadialExtent::FarthestCorner) => {
                        corner_ellipse_radii(distances.far, distances.far)
                    }
                }
            };
            if !radii.is_positive() {
                return None;
            }
            let stop_scale = (scale_x + scale_y) * 0.5;
            let ramp = rg.ramp.resolve_scaled(radii.x, stop_scale)?;
            for py in 0..window.tile.height {
                let fy = window.global_y(py);
                for px in 0..window.tile.width {
                    let fx = window.global_x(px);
                    let nx = (fx - center.x) / radii.x;
                    let ny = (fy - center.y) / radii.y;
                    let t = (nx * nx + ny * ny).sqrt();
                    out.push(coverage_byte(ramp.sample(t), mode));
                }
            }
        }
        MaskSource::Conic(cg) => {
            let cx = resolve_px(cg.center.x, w, scale_x);
            let cy = resolve_px(cg.center.y, h, scale_y);
            let from = cg.from_angle.to_radians();
            let ramp = cg.ramp.resolve(1.0)?;
            for py in 0..window.tile.height {
                let fy = window.global_y(py);
                for px in 0..window.tile.width {
                    let fx = window.global_x(px);
                    // CSS conic angle: clockwise from 12 o'clock (up). atan2 with
                    // (dx, -dy) gives angle CW from +y axis (up) in CSS space.
                    let dx = fx - cx;
                    let dy = fy - cy;
                    let mut ang = dx.atan2(-dy) - from;
                    ang = ang.rem_euclid(std::f32::consts::TAU);
                    let t = ang / std::f32::consts::TAU;
                    out.push(coverage_byte(ramp.sample(t), mode));
                }
            }
        }
        // SVG `url()` masks are rasterised by `rasterize_svg_mask_coverage` and
        // never reach this gradient sampler.
        MaskSource::Svg(_)
        | MaskSource::Url(_)
        | MaskSource::Layers(_)
        | MaskSource::BorderRing { .. }
        | MaskSource::Ref(_) => return None,
    }
    Some(out)
}

pub(super) fn source_from_layer_source(source: &MaskLayerSource) -> Option<MaskSource> {
    match source {
        MaskLayerSource::Linear(g) => Some(MaskSource::Linear(g.clone())),
        MaskLayerSource::Radial(g) => Some(MaskSource::Radial(g.clone())),
        MaskLayerSource::Conic(g) => Some(MaskSource::Conic(g.clone())),
        MaskLayerSource::Svg(_) | MaskLayerSource::Url(_) | MaskLayerSource::Ref(_) => None,
    }
}

pub(super) fn rasterize_mask_layer_source(
    source: &MaskLayerSource,
    mode: MaskMode,
    window: MaskRasterWindow,
    svg_defs: &crate::parser::svg::SvgDefs,
) -> Option<Vec<u8>> {
    match source {
        MaskLayerSource::Svg(bytes) => rasterize_svg_mask_coverage(bytes, mode, window),
        MaskLayerSource::Url(_) => None,
        MaskLayerSource::Ref(id) => {
            let mask = svg_defs.masks.get(id)?;
            rasterize_svg_mask_ref_coverage(
                mask,
                mode,
                window,
                window.grid.width_pt / 0.75,
                window.grid.height_pt / 0.75,
            )
        }
        _ => source_from_layer_source(source)
            .and_then(|source| rasterize_mask_coverage(&source, mode, window)),
    }
}

pub(super) fn rasterize_mask_layer(
    layer: &MaskLayer,
    window: MaskRasterWindow,
    geometry: PaintBoxGeometry,
    svg_defs: &crate::parser::svg::SvgDefs,
) -> Option<Vec<u8>> {
    let border_box = geometry.border_box;
    let sx = window.grid.scale_x();
    let sy = window.grid.scale_y();
    let origin = geometry.shape_box(layer.origin);
    let clip = geometry.shape_box(layer.clip);
    // Raster rows are top-down. Keep this axis conversion at the raster boundary;
    // all box geometry above it remains in PDF bottom-left coordinates.
    let origin_x = origin.left - border_box.left;
    let origin_y = border_box.top() - origin.top();
    let clip_x = clip.left - border_box.left;
    let clip_y = border_box.top() - clip.top();
    if ![
        origin_x,
        origin_y,
        origin.width,
        origin.height,
        clip_x,
        clip_y,
        clip.width,
        clip.height,
    ]
    .into_iter()
    .all(f32::is_finite)
    {
        return None;
    }
    let resolve_axis = |value: f32, is_percent: bool, extent: f32| {
        if is_percent {
            extent * value / 100.0
        } else {
            value
        }
    };
    let (tile_w, tile_h) = match layer.layer_box.size {
        Some(BackgroundSize::Explicit {
            width,
            height,
            width_is_percent,
            height_is_percent,
        }) => (
            resolve_axis(width, width_is_percent, origin.width),
            height.map_or(origin.height, |v| {
                resolve_axis(v, height_is_percent, origin.height)
            }),
        ),
        _ => (origin.width, origin.height),
    };
    if tile_w <= 0.0 || tile_h <= 0.0 {
        return None;
    }
    let (offset_x, offset_y) = match layer.layer_box.position {
        Some(pos) => (
            if pos.x_is_percent {
                (origin.width - tile_w) * pos.x
            } else {
                pos.x
            },
            if pos.y_is_percent {
                (origin.height - tile_h) * pos.y
            } else {
                pos.y
            },
        ),
        None => (0.0, 0.0),
    };
    if !offset_x.is_finite() || !offset_y.is_finite() {
        return None;
    }
    let repeat = RepeatModes::from(layer.layer_box.repeat.unwrap_or(BackgroundRepeat::Repeat));
    let x_pattern =
        AxisRepeatPattern::new_layout(repeat.horizontal, offset_x, tile_w, origin.width)?
            .translated(origin_x)?;
    let y_pattern =
        AxisRepeatPattern::new_layout(repeat.vertical, offset_y, tile_h, origin.height)?
            .translated(origin_y)?;
    let (tile_w, tile_h) = (x_pattern.tile_size(), y_pattern.tile_size());
    let source_grid = MaskRasterGrid::new(
        window.grid.dimensions_for_points(tile_w, tile_h)?,
        tile_w,
        tile_h,
    )?;
    let mut out = vec![0u8; window.len()?];
    let clip_l = (clip_x * sx).floor() as i64;
    let clip_t = (clip_y * sy).floor() as i64;
    let clip_r = ((clip_x + clip.width) * sx).ceil() as i64;
    let clip_b = ((clip_y + clip.height) * sy).ceil() as i64;
    let window_l = i64::from(window.tile.x);
    let window_t = i64::from(window.tile.y);
    let window_r = window_l + i64::from(window.tile.width);
    let window_b = window_t + i64::from(window.tile.height);
    let visible_l = clip_l.max(window_l).max(0);
    let visible_t = clip_t.max(window_t).max(0);
    let visible_r = clip_r
        .min(window_r)
        .min(i64::from(window.grid.pixels.width));
    let visible_b = clip_b
        .min(window_b)
        .min(i64::from(window.grid.pixels.height));
    if visible_l >= visible_r || visible_t >= visible_b {
        return Some(out);
    }
    let xs = x_pattern.pixel_placements(visible_l, visible_r, sx)?;
    let ys = y_pattern.pixel_placements(visible_t, visible_b, sy)?;
    for dest_y in ys {
        for dest_x in xs.clone() {
            let dest_r = dest_x.checked_add(i64::from(source_grid.pixels.width))?;
            let dest_b = dest_y.checked_add(i64::from(source_grid.pixels.height))?;
            let left = dest_x.max(visible_l);
            let top = dest_y.max(visible_t);
            let right = dest_r.min(visible_r);
            let bottom = dest_b.min(visible_b);
            if left >= right || top >= bottom {
                continue;
            }
            let source_tile = RasterTile {
                x: u32::try_from(left - dest_x).ok()?,
                y: u32::try_from(top - dest_y).ok()?,
                width: u32::try_from(right - left).ok()?,
                height: u32::try_from(bottom - top).ok()?,
            };
            let source_window = source_grid.window(source_tile)?;
            let source =
                rasterize_mask_layer_source(&layer.source, layer.mode, source_window, svg_defs)?;
            if source.len() != source_window.len()? {
                return None;
            }
            let destination_x = usize::try_from(left - window_l).ok()?;
            let destination_y = usize::try_from(top - window_t).ok()?;
            let source_width = usize::try_from(source_tile.width).ok()?;
            let destination_width = usize::try_from(window.tile.width).ok()?;
            for row in 0..usize::try_from(source_tile.height).ok()? {
                let source_start = row.checked_mul(source_width)?;
                let destination_start = (destination_y + row)
                    .checked_mul(destination_width)?
                    .checked_add(destination_x)?;
                let source_end = source_start.checked_add(source_width)?;
                let destination_end = destination_start.checked_add(source_width)?;
                out.get_mut(destination_start..destination_end)?
                    .copy_from_slice(source.get(source_start..source_end)?);
            }
        }
    }
    Some(out)
}

pub(super) fn composite_mask(source: u8, dest: u8, op: MaskComposite) -> u8 {
    let s = f32::from(source) / 255.0;
    let d = f32::from(dest) / 255.0;
    let a = match op {
        MaskComposite::Add => s + d * (1.0 - s),
        MaskComposite::Subtract => s * (1.0 - d),
        MaskComposite::Intersect => s * d,
        MaskComposite::Exclude => s * (1.0 - d) + d * (1.0 - s),
        MaskComposite::Destination => d,
    };
    (a.clamp(0.0, 1.0) * 255.0).round() as u8
}

pub(super) fn rasterize_mask_layers(
    layers: &[MaskLayer],
    window: MaskRasterWindow,
    geometry: PaintBoxGeometry,
    svg_defs: &crate::parser::svg::SvgDefs,
) -> Option<Vec<u8>> {
    let mut accum = vec![0u8; window.len()?];
    let mut first = true;
    for layer in layers.iter().rev() {
        let cov = rasterize_mask_layer(layer, window, geometry, svg_defs)?;
        if first {
            accum = cov;
            first = false;
        } else {
            for (dst, src) in accum.iter_mut().zip(cov) {
                *dst = composite_mask(src, *dst, layer.composite);
            }
        }
    }
    Some(accum)
}

pub(super) fn rasterize_mask_border_ring(window: MaskRasterWindow, width: f32) -> Option<Vec<u8>> {
    if !width.is_finite() {
        return None;
    }
    let left = (width.max(0.0) * window.grid.scale_x()).round() as u32;
    let top = (width.max(0.0) * window.grid.scale_y()).round() as u32;
    let right = window.grid.pixels.width.saturating_sub(left);
    let bottom = window.grid.pixels.height.saturating_sub(top);
    let mut out = vec![0u8; window.len()?];
    for y in 0..window.tile.height {
        let global_y = window.tile.y + y;
        for x in 0..window.tile.width {
            let global_x = window.tile.x + x;
            if global_x < left || global_x >= right || global_y < top || global_y >= bottom {
                out[(y * window.tile.width + x) as usize] = 255;
            }
        }
    }
    Some(out)
}

pub(super) fn svg_mask_effective_mode(
    requested: MaskMode,
    mask_type: crate::parser::svg::SvgMaskType,
) -> MaskMode {
    match requested {
        MaskMode::MatchSource => match mask_type {
            crate::parser::svg::SvgMaskType::Alpha => MaskMode::Alpha,
            crate::parser::svg::SvgMaskType::Luminance => MaskMode::Luminance,
        },
        other => other,
    }
}

pub(super) fn svg_mask_fill_coverage(
    style: &crate::parser::svg::SvgStyle,
    mode: MaskMode,
) -> Option<u8> {
    let color = match style.fill {
        crate::parser::svg::SvgPaint::None => return None,
        crate::parser::svg::SvgPaint::Color(color) => color,
        crate::parser::svg::SvgPaint::Unspecified => crate::types::Color::BLACK,
        crate::parser::svg::SvgPaint::CurrentColor => {
            style.color.unwrap_or(crate::types::Color::BLACK)
        }
        crate::parser::svg::SvgPaint::Url(_) => return None,
    };
    let (r, g, b) = color.to_f32_rgb();
    let a = style.opacity.clamp(0.0, 1.0);
    let cov = match mode {
        MaskMode::Alpha | MaskMode::MatchSource => a,
        MaskMode::Luminance => (0.2126 * r + 0.7152 * g + 0.0722 * b) * a,
    };
    Some((cov.clamp(0.0, 1.0) * 255.0).round() as u8)
}

pub(super) fn rasterize_svg_mask_node(
    node: &crate::parser::svg::SvgNode,
    out: &mut [u8],
    window: MaskRasterWindow,
    user_w: f32,
    user_h: f32,
    mode: MaskMode,
) {
    match node {
        crate::parser::svg::SvgNode::Group { children, .. } => {
            for child in children {
                rasterize_svg_mask_node(child, out, window, user_w, user_h, mode);
            }
        }
        crate::parser::svg::SvgNode::Rect {
            x,
            y,
            width,
            height,
            style,
            ..
        } => {
            let Some(cov) = svg_mask_fill_coverage(style, mode) else {
                return;
            };
            for py in 0..window.tile.height {
                let uy = window.user_y(py, user_h);
                if uy < *y || uy >= *y + *height {
                    continue;
                }
                for px in 0..window.tile.width {
                    let ux = window.user_x(px, user_w);
                    if ux >= *x && ux < *x + *width {
                        out[(py * window.tile.width + px) as usize] = cov;
                    }
                }
            }
        }
        crate::parser::svg::SvgNode::Circle { cx, cy, r, style } => {
            let Some(cov) = svg_mask_fill_coverage(style, mode) else {
                return;
            };
            let rr = r * r;
            for py in 0..window.tile.height {
                let uy = window.user_y(py, user_h);
                for px in 0..window.tile.width {
                    let ux = window.user_x(px, user_w);
                    let dx = ux - *cx;
                    let dy = uy - *cy;
                    if dx * dx + dy * dy <= rr {
                        out[(py * window.tile.width + px) as usize] = cov;
                    }
                }
            }
        }
        crate::parser::svg::SvgNode::Ellipse {
            cx,
            cy,
            rx,
            ry,
            style,
        } => {
            let Some(cov) = svg_mask_fill_coverage(style, mode) else {
                return;
            };
            if *rx <= 0.0 || *ry <= 0.0 {
                return;
            }
            for py in 0..window.tile.height {
                let uy = window.user_y(py, user_h);
                for px in 0..window.tile.width {
                    let ux = window.user_x(px, user_w);
                    let nx = (ux - *cx) / *rx;
                    let ny = (uy - *cy) / *ry;
                    if nx * nx + ny * ny <= 1.0 {
                        out[(py * window.tile.width + px) as usize] = cov;
                    }
                }
            }
        }
        _ => {}
    }
}

pub(super) fn rasterize_svg_mask_ref_coverage(
    mask: &crate::parser::svg::SvgMask,
    requested_mode: MaskMode,
    window: MaskRasterWindow,
    css_w: f32,
    css_h: f32,
) -> Option<Vec<u8>> {
    let user_w = if mask.width > 0.0 { mask.width } else { css_w };
    let user_h = if mask.height > 0.0 {
        mask.height
    } else {
        css_h
    };
    if !(user_w.is_finite() && user_h.is_finite() && user_w > 0.0 && user_h > 0.0) {
        return None;
    }
    let mode = svg_mask_effective_mode(requested_mode, mask.mask_type);
    let mut out = vec![0u8; window.len()?];
    for child in &mask.children {
        rasterize_svg_mask_node(child, &mut out, window, user_w, user_h, mode);
    }
    Some(out)
}

/// Rasterise one bounded window of an SVG `url()` mask source to DeviceGray
/// coverage (row 0 = top of the box, matching PDF image sample order), reusing
/// the `resvg`/`usvg`/`tiny-skia` stack already vendored for SVG rendering.
///
/// The SVG is transformed against the full sampling grid, then translated by
/// the window's integer origin. Thus every tile evaluates the same global SVG
/// geometry without rendering or cloning the full surface.
pub(super) fn rasterize_svg_mask_coverage(
    svg_bytes: &[u8],
    mode: crate::style::computed::MaskMode,
    window: MaskRasterWindow,
) -> Option<Vec<u8>> {
    use crate::style::computed::MaskMode;
    use resvg::tiny_skia;
    use resvg::usvg;

    let opt = usvg::Options::default();
    let tree = usvg::Tree::from_data(svg_bytes, &opt).ok()?;
    let svg_size = tree.size();
    let (sw, sh) = (svg_size.width(), svg_size.height());
    if sw <= 0.0 || sh <= 0.0 {
        return None;
    }
    let mut pixmap = tiny_skia::Pixmap::new(window.tile.width, window.tile.height)?;
    // Stretch the SVG's intrinsic size over the full mask grid, then express
    // that same transform in this window's local pixel coordinates.
    let transform = tiny_skia::Transform::from_scale(
        window.grid.pixels.width as f32 / sw,
        window.grid.pixels.height as f32 / sh,
    )
    .post_translate(-(window.tile.x as f32), -(window.tile.y as f32));
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    // The pixmap is premultiplied sRGB RGBA. For `match-source` on an image and
    // for `luminance`, coverage is the (premultiplied) Rec.709 luma; for `alpha`
    // it is the alpha channel directly.
    let data = pixmap.data();
    let mut out = Vec::with_capacity(window.len()?);
    for px in data.chunks_exact(4) {
        // tiny-skia stores premultiplied RGBA; r/g/b are already × alpha.
        let (r, g, b, a) = (
            px[0] as f32 / 255.0,
            px[1] as f32 / 255.0,
            px[2] as f32 / 255.0,
            px[3] as f32 / 255.0,
        );
        let cov = match mode {
            MaskMode::Alpha | MaskMode::MatchSource => a,
            // `luminance` uses premultiplied RGB, so alpha is already folded in.
            MaskMode::Luminance => 0.2126 * r + 0.7152 * g + 0.0722 * b,
        };
        out.push((cov.clamp(0.0, 1.0) * 255.0).round() as u8);
    }
    Some(out)
}

pub(super) fn rasterize_mask_source(
    source: &MaskSource,
    mode: MaskMode,
    window: MaskRasterWindow,
    geometry: PaintBoxGeometry,
    svg_defs: &crate::parser::svg::SvgDefs,
) -> Option<Vec<u8>> {
    match source {
        MaskSource::Svg(bytes) => rasterize_svg_mask_coverage(bytes, mode, window),
        MaskSource::Url(_) => None,
        MaskSource::Layers(layers) => rasterize_mask_layers(layers, window, geometry, svg_defs),
        MaskSource::BorderRing { width } => rasterize_mask_border_ring(window, *width),
        MaskSource::Ref(id) => rasterize_svg_mask_ref_coverage(
            svg_defs.masks.get(id)?,
            mode,
            window,
            window.grid.width_pt / 0.75,
            window.grid.height_pt / 0.75,
        ),
        _ => rasterize_mask_coverage(source, mode, window),
    }
}
