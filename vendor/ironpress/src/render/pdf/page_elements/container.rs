use super::*;
use crate::layout::elements::Container;

pub(in crate::render::pdf) fn render_container(
    content: &mut String,
    element: &Container,
    frame: PageElementFrame<'_>,
    phase: ElementPaintPhase,
    ctx: &mut PageRenderContext<'_>,
) {
    let page_size = frame.page_size;
    let margin = frame.margin;
    let available_width = frame.available_width;
    let y_pos = &frame.y_pos;
    let children = &element.children;
    let background_color = &element.paint.background.color;
    let border = &element.box_model.border;
    let c_border_radii = &element.paint.border_radii;
    let c_outline_width = &element.paint.outline.width;
    let c_padding = &element.box_model.padding;
    let block_width = &element.box_model.size.width;
    let c_block_height = &element.box_model.size.height;
    let c_bg_blend = &element.paint.background.blend_mode;
    let c_visible = &element.paint.visible;
    let c_float = &element.flow.float;
    let c_position = &element.positioning.scheme;
    let c_offset_left = &element.positioning.insets.left;
    let c_overflow = &element.overflow.combined;
    let c_overflow_x = &element.overflow.x;
    let c_overflow_y = &element.overflow.y;
    let c_box_transform = &element.paint.group.transform;
    let c_transform = &c_box_transform.value;
    let c_containing_block = &element.positioning.containing_block;
    let c_box_shadow = &element.paint.shadows;
    let c_bg_gradient = &element.paint.background.layers.gradient;
    let c_bg_radial = &element.paint.background.layers.radial_gradient;
    let c_bg_conic = &element.paint.background.layers.conic_gradient;
    let c_bg_svg = ctx
        .text
        .pdf_writer
        .resolve_background_svg(&element.paint.background.layers);
    let c_bg_svg = &c_bg_svg;
    let c_bg_blur = &element.paint.background.layers.blur_radius;
    let c_bg_clip = &element.paint.background.layers.clip;
    let c_positioned_depth = &element.positioning.containing_block_depth;
    // CSS2 §11.2: `visibility: hidden` (or `collapse`) hides only
    // THIS box's own decoration (background, border, outline,
    // box-shadow); it is inherited but a descendant may override it
    // back to `visible` and still paint. So we must keep recursing
    // into the children and only gate the container's own painting
    // on `c_visible` — never skip the whole subtree.
    let c_visible_self = *c_visible;

    let container_w = block_width.resolve(available_width);
    let container_x = match c_position {
        Position::Absolute | Position::Fixed => c_containing_block
            .map_or(margin.left + c_offset_left, |cb| {
                margin.left + cb.x + c_offset_left
            }),
        _ => match c_float {
            Float::Right => margin.left + available_width - container_w,
            _ => margin.left + c_offset_left,
        },
    };
    let container_y_top = page_size.height - margin.top - y_pos;

    // Use explicit block_height if set, otherwise compute from
    // children (with adjacent-sibling margin collapse so the
    // painted box height matches the collapsed child flow).
    //
    // A Container's `block_height` is a definite border-box height
    // (set only when the element has an explicit `height`). Per
    // CSS, a definite height is a hard size: content that exceeds
    // it overflows the box rather than growing it (the box border
    // stays at the declared height regardless of `overflow`). This
    // matters for grids/flex whose definite tracks can overflow the
    // content box — Chrome keeps the container border-box at the
    // declared height and lets the cells spill past it. Honour the
    // declared height directly instead of `content_h.max(h)`, which
    // wrongly inflated the border-box by the overflow amount.
    let children_h: f32 = collapsed_children_height(children);
    let content_h = c_padding.vertical() + children_h + border.vertical_width();
    let total_h = c_block_height.resolve(content_h);
    let c_geometry = LayoutBoxGeometry::from_layout(
        PdfRect::new(container_x, container_y_top - total_h, container_w, total_h),
        border,
        *c_padding,
        element.paint.border_image.as_ref(),
    );
    let page_content = ctx.text.pdf_writer.page_content_transform;
    let c_box_geometry = ctx.text.pdf_writer.resolve_box_geometry(c_geometry);
    let c_paint_geometry = c_box_geometry.painting();
    let c_fragment_geometry = c_box_geometry.fragment(element.fragmentation);
    let c_paint_box = c_paint_geometry.border_box;

    if c_visible_self
        && let Some(t) = c_transform
        && is_projected_transform(t)
        && projected_solid_children_are_empty(children)
        && c_bg_gradient.is_none()
        && c_bg_radial.is_none()
        && c_bg_conic.is_none()
        && c_bg_svg.is_none()
        && *c_bg_blur == 0.0
        && c_border_radii.is_zero()
        && *c_outline_width == 0.0
        && c_box_shadow.is_empty()
        && element.paint.group.effects.is_identity()
        && *c_bg_blend == crate::style::computed::BlendMode::Normal
        && *c_bg_clip == BackgroundClip::Border
        && !c_overflow.clips()
    {
        render_projected_solid_box(
            content,
            page_content,
            c_box_transform,
            c_paint_geometry,
            *background_color,
            border,
        );
        return;
    }

    if c_visible_self
        && let Some(t) = c_transform
        && !is_projected_transform(t)
        && projected_solid_children_are_empty(children)
        && c_bg_gradient.is_none()
        && c_bg_radial.is_none()
        && c_bg_conic.is_none()
        && c_bg_svg.is_none()
        && *c_bg_blur == 0.0
        && c_border_radii.is_zero()
        && *c_outline_width == 0.0
        && c_box_shadow.is_empty()
        && element.paint.group.effects.is_identity()
        && *c_bg_blend == crate::style::computed::BlendMode::Normal
        && *c_bg_clip == BackgroundClip::Border
        && !c_overflow.clips()
        && render_affine_solid_box(
            content,
            ctx.text.pdf_writer,
            ctx.text.page_images,
            c_box_transform,
            c_paint_geometry,
            *background_color,
            border,
        )
    {
        return;
    }

    let c_group = PaintGroupScope::begin(content, element, c_fragment_geometry, ctx);

    if c_visible_self
        && *c_bg_blur > 0.0
        && !children.is_empty()
        && c_bg_gradient.is_none()
        && c_bg_radial.is_none()
        && c_bg_conic.is_none()
        && c_bg_svg.is_none()
        && c_border_radii.is_zero()
        && *c_outline_width == 0.0
        && !border.has_visible()
        && let Some(blurred) = blurred_simple_container_group(
            children,
            c_paint_box.width,
            c_paint_box.height,
            *background_color,
            border,
            *c_padding,
            *c_bg_blur,
            ctx.text.pdf_writer.opts.raster_quality.filter_dpi,
            ctx.text.custom_fonts,
        )
    {
        let img_obj_id = ctx.text.pdf_writer.add_image_object(
            &blurred.asset.data,
            blurred.asset.source_width,
            blurred.asset.source_height,
            blurred.asset.format,
            blurred.asset.png_metadata.as_ref(),
        );
        let img_name = format!("Im{img_obj_id}");
        let ov = blurred.overflow_pt;
        content.push_str(&format!(
            "q\n{w} 0 0 {h} {ix} {iy} cm\n/{name} Do\nQ\n",
            w = c_paint_box.width + 2.0 * ov,
            h = c_paint_box.height + 2.0 * ov,
            ix = c_paint_box.left - ov,
            iy = c_paint_box.bottom - ov,
            name = img_name,
        ));
        ctx.text.page_images.push(ImageRef {
            name: img_name,
            obj_id: img_obj_id,
        });
        c_group.finish(content, ctx);
        return;
    }

    if c_visible_self
        && *c_bg_blur > 0.0
        && children.is_empty()
        && c_bg_gradient.is_none()
        && c_bg_radial.is_none()
        && c_bg_conic.is_none()
        && c_bg_svg.is_none()
        && c_border_radii.is_zero()
        && *c_outline_width == 0.0
        && let Some(blurred) = crate::render::blur::blur_box(
            c_paint_box.width,
            c_paint_box.height,
            *background_color,
            border,
            *c_bg_blur,
            ctx.text.pdf_writer.opts.raster_quality.filter_dpi,
        )
    {
        let img_obj_id = ctx.text.pdf_writer.add_image_object(
            &blurred.asset.data,
            blurred.asset.source_width,
            blurred.asset.source_height,
            blurred.asset.format,
            blurred.asset.png_metadata.as_ref(),
        );
        let img_name = format!("Im{img_obj_id}");
        let ov = blurred.overflow_pt;
        content.push_str(&format!(
            "q\n{w} 0 0 {h} {ix} {iy} cm\n/{name} Do\nQ\n",
            w = c_paint_box.width + 2.0 * ov,
            h = c_paint_box.height + 2.0 * ov,
            ix = c_paint_box.left - ov,
            iy = c_paint_box.bottom - ov,
            name = img_name,
        ));
        ctx.text.page_images.push(ImageRef {
            name: img_name,
            obj_id: img_obj_id,
        });
        c_group.finish(content, ctx);
        return;
    }

    if phase.paints_decoration() {
        container_decoration::paint_container_decoration(
            content,
            element,
            frame,
            c_fragment_geometry,
            ctx,
        );
    }

    let c_padding_box = c_geometry.padding_box();
    let c_paint_padding_box = c_paint_geometry.padding_box();
    let c_pad_box_w = c_padding_box.width;
    let c_pad_box_h = c_padding_box.height;
    let c_avail_w = (c_pad_box_w - c_padding.horizontal()).max(0.0);
    let c_avail_h = (c_pad_box_h - c_padding.vertical()).max(0.0);
    let (c_over_w, c_over_h) = children_overflow_extent(children);
    let c_ratio_h = if c_avail_w > 0.0 {
        c_over_w / c_avail_w
    } else {
        0.0
    };
    let c_ratio_v = if c_avail_h > 0.0 {
        c_over_h / c_avail_h
    } else {
        0.0
    };
    let c_scroll_ok = c_border_radii.is_zero();
    let c_has_v = c_scroll_ok
        && match c_overflow_y {
            Overflow::Scroll => true,
            Overflow::Auto => c_ratio_v > 1.001,
            _ => false,
        };
    let c_has_h = c_scroll_ok
        && match c_overflow_x {
            Overflow::Scroll => true,
            Overflow::Auto => c_ratio_h > 1.001,
            _ => false,
        };
    let c_sb = SCROLLBAR_THICKNESS_PT;
    let c_v_gutter = if c_has_v { c_sb } else { 0.0 };
    let c_h_gutter = if c_has_h { c_sb } else { 0.0 };
    let c_scrollport_w = (c_avail_w - c_v_gutter).max(0.0);
    let c_scrollport_h = (c_avail_h - c_h_gutter).max(0.0);
    let c_thumb_ratio_h = if c_scrollport_w > 0.0 {
        c_over_w / c_scrollport_w
    } else {
        c_ratio_h
    };
    let c_thumb_ratio_v = if c_scrollport_h > 0.0 {
        c_over_h / c_scrollport_h
    } else {
        c_ratio_v
    };

    // Apply clip if overflow clips. Per CSS, `overflow` clips to
    // the *padding box* — the border is painted outside the clip
    // region and stays visible — and follows the rounded inner
    // corners when border-radius is set.
    let needs_clip = c_overflow.clips();
    let clip_command = needs_clip.then(|| {
        let mut command = String::from("q\n");
        if c_has_v || c_has_h {
            let cx = c_paint_padding_box.left;
            let cy = c_paint_padding_box.bottom + c_h_gutter;
            let cw = c_paint_padding_box.width - c_v_gutter;
            let ch = c_paint_padding_box.height - c_h_gutter;
            command.push_str(&format!("{cx} {cy} {cw} {ch} re W n\n"));
        } else {
            command.push_str(&overflow_clip_path(
                c_paint_box.left,
                c_paint_box.bottom,
                c_paint_box.width,
                c_paint_box.height,
                c_paint_geometry.border,
                *c_border_radii,
            ));
            command.push_str("W n\n");
        }
        command
    });
    if let Some(command) = &clip_command {
        content.push_str(command);
        ctx.stacking.push_clip(command.clone());
    }

    // Render children recursively
    // Pass both content-box origin (for flow children) and
    // padding-box origin (for absolute children).
    let c_content_box = c_geometry.content_box();
    let inner_x = c_content_box.left;
    let inner_w = c_content_box.width;
    let inner_y = c_content_box.top();
    // Seed positioned-ancestor origins with this (top-level) box's
    // padding-box origin so absolute descendants nested inside
    // static intermediates resolve to it (their containing block).
    let mut abs_origins: HashMap<usize, PdfPoint> = HashMap::new();
    if *c_positioned_depth > 0 && (c_position.is_positioned() || c_transform.is_some()) {
        abs_origins.insert(
            *c_positioned_depth,
            PdfPoint::new(c_padding_box.left, c_padding_box.top()),
        );
    }
    if phase.paints_contents() {
        // Page-level phase separation belongs only to this principal box.
        // Descendants retain their normal atomic paint order; recursively
        // passing `Contents` used to suppress their backgrounds and borders,
        // while passing `Decoration` painted transformed descendants too
        // early. This is the same decoration/content boundary used by flex.
        render_container_children(
            content,
            children,
            ContainerFrame::new(
                PdfPoint::new(inner_x, inner_y),
                crate::types::Size::new(inner_w, c_content_box.height),
                PdfPoint::new(c_padding_box.left, c_padding_box.top()),
            ),
            &mut abs_origins,
            ctx,
            ContainerRenderOptions {
                device_space_available: c_transform.is_none(),
                paint_phase: ElementPaintPhase::All,
                stacking_scope: StackingScope::for_element(element),
            },
        );
    }

    // Restore clip
    if needs_clip {
        ctx.stacking.pop_clip();
        content.push_str("Q\n");
    }
    // Paint print scrollbar chrome in the reserved gutter, after
    // the (gutter-inset) content clip is closed.
    if phase.paints_decoration() && (c_has_v || c_has_h) {
        paint_scrollbars(
            content,
            c_paint_padding_box.left,
            c_paint_padding_box.bottom,
            c_paint_padding_box.width,
            c_paint_padding_box.height,
            c_has_v,
            c_has_h,
            c_thumb_ratio_v.max(1.0),
            c_thumb_ratio_h.max(1.0),
        );
    }
    c_group.finish(content, ctx);
}
