use super::*;
use crate::layout::elements::GridRow;

impl NestedRowsRenderer<'_, '_> {
    pub(super) fn render_grid_row(&mut self, element: &GridRow) {
        self.handled = true;
        let content = &mut *self.content;
        let origin_x = self.origin_x;
        let mut cursor_y = self.cursor_y;
        let page_ext_gstates = &mut *self.page_ext_gstates;
        let bg_alpha_counter = &mut *self.bg_alpha_counter;
        let custom_fonts = self.custom_fonts;
        let prepared_custom_fonts = self.prepared_custom_fonts;
        let page_shadings = &mut *self.page_shadings;
        let shading_counter = &mut *self.shading_counter;
        let pdf_writer = &mut *self.pdf_writer;
        let page_images = &mut *self.page_images;
        let annotations = &mut *self.annotations;
        let page_paint_box = self.page_paint_box;
        let initial_fixed_origin = self.initial_fixed_origin;
        let page_height = self.page_height;
        let cells = &element.content.cells;
        let col_widths = &element.content.column_widths;
        let gap = element.content.gap;
        let grid_border = &element.box_model.border;
        let grid_padding = element.box_model.padding;
        let margin_top = element.box_model.margins.start;
        let margin_bottom = element.box_model.margins.end;
        self.previous_margin_bottom = 0.0;
        if self.first_margin == FirstMarginState::Pending {
            cursor_y -= margin_top;
        }
        self.first_margin = FirstMarginState::Pending;
        let row_y = cursor_y;
        let row_height =
            compute_grid_row_height(cells) + grid_padding.vertical() + grid_border.vertical_width();
        if !self.paint {
            cursor_y -= row_height + margin_bottom;
            self.cursor_y = cursor_y;
            self.previous_margin_bottom = 0.0;
            return;
        }
        let grid_total_w = col_widths.iter().sum::<f32>()
            + gap * col_widths.len().saturating_sub(1) as f32
            + grid_padding.horizontal()
            + grid_border.horizontal_width();
        let grid_geometry = LayoutBoxGeometry::from_layout(
            PdfRect::from_top(origin_x, row_y, grid_total_w, row_height),
            grid_border,
            grid_padding,
            None,
        );
        let grid_fragment_geometry = pdf_writer
            .resolve_box_geometry(grid_geometry)
            .fragment(Default::default());
        paint_box_decoration(
            content,
            grid_fragment_geometry,
            grid_border,
            CornerRadii::ZERO,
            None,
            BorderPaintResources {
                shadings: page_shadings,
                shading_counter,
                page_ext_gstates,
                alpha_counter: bg_alpha_counter,
                pdf_writer,
                page_images,
            },
        );

        let cell_row_y = grid_geometry.content_box().top();
        let cell_content_h = compute_grid_row_height(cells);
        let stacking_scope = StackingScope::for_element(element);
        let mut stacking_plan = StackingPaintPlan::default();
        let mut cells_in_paint_order: Vec<_> = cells.iter().collect();
        cells_in_paint_order.sort_by_key(|cell| cell.placement.paint_order);
        for cell in cells_in_paint_order {
            let column_start = cell.placement.column_start;
            let span = cell.placement.column_span.max(1);
            let marker = self.stacking.marker();
            let mut cell_content = String::new();
            'paint_cell: {
                let content = &mut cell_content;
                let track_x = grid_geometry.content_box().left
                    + col_widths.iter().take(column_start).sum::<f32>()
                    + gap * column_start as f32;
                let track_w = col_widths.iter().skip(column_start).take(span).sum::<f32>()
                    + gap * span.saturating_sub(1) as f32;
                let (box_x, box_y, box_w, box_h) = match cell.placement.inset {
                    Some(inset) => (
                        track_x + inset.offset.x,
                        cell_row_y - inset.offset.y - inset.size.height,
                        inset.size.width,
                        inset.size.height,
                    ),
                    None => (
                        track_x,
                        cell_row_y - cell_content_h,
                        track_w,
                        cell_content_h,
                    ),
                };
                let cell_geometry = LayoutBoxGeometry::from_layout(
                    PdfRect::new(box_x, box_y, box_w, box_h),
                    &cell.layout.box_model.border,
                    cell.layout.box_model.padding(),
                    cell.layout.paint.border_image.as_ref(),
                );
                let cell_box_geometry = pdf_writer.resolve_box_geometry(cell_geometry);
                let cell_paint_geometry = cell_box_geometry.painting();
                let cell_fragment_geometry = cell_box_geometry.fragment(Default::default());
                let cell_background = cell_box_geometry.background(
                    cell.layout.paint.background.layers.origin,
                    cell.layout.paint.background.layers.clip,
                    cell.layout.paint.border_radii,
                );
                let cell_content_box = cell_geometry.content_box();
                let cell_group = {
                    let mut cell_ctx = PageRenderContext::new(
                        pdf_writer,
                        page_images,
                        custom_fonts,
                        prepared_custom_fonts,
                        page_shadings,
                        shading_counter,
                        page_ext_gstates,
                        bg_alpha_counter,
                        annotations,
                        page_paint_box,
                        page_height,
                    )
                    .with_initial_fixed_origin(initial_fixed_origin);
                    PaintGroupScope::begin(
                        content,
                        &cell.layout,
                        cell_fragment_geometry,
                        &mut cell_ctx,
                    )
                };

                let filtered = {
                    let mut filter_ctx = PageRenderContext::new(
                        pdf_writer,
                        page_images,
                        custom_fonts,
                        prepared_custom_fonts,
                        page_shadings,
                        shading_counter,
                        page_ext_gstates,
                        bg_alpha_counter,
                        annotations,
                        page_paint_box,
                        page_height,
                    )
                    .with_initial_fixed_origin(initial_fixed_origin);
                    paint_box_filter_output(
                        content,
                        &cell.layout,
                        cell_paint_geometry,
                        &mut filter_ctx,
                    )
                };
                if filtered {
                    let mut cell_ctx = PageRenderContext::new(
                        pdf_writer,
                        page_images,
                        custom_fonts,
                        prepared_custom_fonts,
                        page_shadings,
                        shading_counter,
                        page_ext_gstates,
                        bg_alpha_counter,
                        annotations,
                        page_paint_box,
                        page_height,
                    )
                    .with_initial_fixed_origin(initial_fixed_origin);
                    cell_group.finish(content, &mut cell_ctx);
                    break 'paint_cell;
                }
                render_box_shadows(
                    content,
                    &cell.layout.paint.shadows,
                    cell_fragment_geometry,
                    cell.layout.paint.border_radii,
                    page_ext_gstates,
                    bg_alpha_counter,
                    pdf_writer,
                );

                if let Some(background) = cell.layout.paint.background.color {
                    paint_solid_background(
                        content,
                        background,
                        cell_background.painting_box,
                        page_ext_gstates,
                        bg_alpha_counter,
                    );
                }
                {
                    let mut cell_ctx = PageRenderContext::new(
                        pdf_writer,
                        page_images,
                        custom_fonts,
                        prepared_custom_fonts,
                        page_shadings,
                        shading_counter,
                        page_ext_gstates,
                        bg_alpha_counter,
                        annotations,
                        page_paint_box,
                        page_height,
                    )
                    .with_initial_fixed_origin(initial_fixed_origin);
                    paint_box_gradient_backgrounds(
                        content,
                        &cell.layout.paint,
                        cell_box_geometry,
                        &mut cell_ctx,
                    );
                    render_box_shadows_inset(
                        content,
                        &cell.layout.paint.shadows,
                        cell_fragment_geometry,
                        cell.layout.paint.border_radii,
                        cell_ctx.page_ext_gstates,
                        cell_ctx.bg_alpha_counter,
                        cell_ctx.text.pdf_writer,
                    );
                }

                paint_box_decoration(
                    content,
                    cell_fragment_geometry,
                    &cell.layout.box_model.border,
                    cell.layout.paint.border_radii,
                    cell.layout.paint.border_image.as_ref(),
                    BorderPaintResources {
                        shadings: page_shadings,
                        shading_counter,
                        page_ext_gstates,
                        alpha_counter: bg_alpha_counter,
                        pdf_writer,
                        page_images,
                    },
                );

                let content_clip = cell.placement.clips.then(|| {
                    ContentClip::rounded_padding_box(
                        cell_paint_geometry,
                        cell.layout.paint.border_radii,
                    )
                });
                if let Some(clip) = &content_clip {
                    clip.begin(content, self.stacking);
                }
                let cell_inner_w = cell_content_box.width;
                let mut baseline_cursor = TextBaselineCursor::new(
                    cell_content_box.top(),
                    pdf_writer.page_content_transform,
                );
                for line in &cell.layout.content.lines {
                    let metrics = line_box_metrics(line, custom_fonts);
                    let text_y = baseline_cursor.next_horizontal(metrics);
                    let text_content: String =
                        line.runs.iter().map(|run| run.text.as_str()).collect();
                    if text_content.is_empty() {
                        continue;
                    }
                    let merged = crate::text::coalesce_text_runs(&line.runs);
                    let line_width = merged
                        .iter()
                        .map(|run| estimate_run_width_with_fonts(run, custom_fonts))
                        .sum::<f32>();
                    let text_x = match cell.layout.alignment.inline {
                        TextAlign::Right => {
                            cell_content_box.left + (cell_inner_w - line_width).max(0.0)
                        }
                        TextAlign::Center => {
                            cell_content_box.left + ((cell_inner_w - line_width) / 2.0).max(0.0)
                        }
                        _ => cell_content_box.left,
                    };
                    let mut lx = text_x;
                    for (run_index, run) in merged.iter().enumerate() {
                        if let Some(advance) = run.atomic_inline_advance() {
                            lx += advance;
                            continue;
                        }
                        if run.text.is_empty() {
                            continue;
                        }
                        let run_width = estimate_run_width_with_fonts(run, custom_fonts);
                        let previous = merged[..run_index].iter().rev().find(|previous| {
                            previous.inline_box.is_none() && !previous.text.is_empty()
                        });
                        let decoration =
                            HorizontalRunDecorations::new(run, lx, run_width, text_y, custom_fonts)
                                .continuing_after(previous);
                        let run_width = decoration.paint_text(
                            content,
                            crate::layout::text::line_primary_font_size(&merged),
                            prepared_custom_fonts,
                            0.0,
                            pdf_writer,
                            page_images,
                        );
                        lx += run_width;
                    }
                }

                if !cell.layout.content.children.is_empty() {
                    let text_h = cell
                        .layout
                        .content
                        .lines
                        .iter()
                        .map(|line| line.height)
                        .sum::<f32>();
                    let nested_x = cell_content_box.left;
                    let nested_w = cell_content_box.width;
                    let nested_y = cell_content_box.top() - text_h;
                    let mut nested_abs = self.abs_origins.clone();
                    if let Some(depth) = cell.layout.established_containing_block_depth() {
                        let padding_box = cell_geometry.padding_box();
                        nested_abs
                            .insert(depth, PdfPoint::new(padding_box.left, padding_box.top()));
                    }
                    let mut child_ctx = PageRenderContext::new(
                        pdf_writer,
                        page_images,
                        custom_fonts,
                        prepared_custom_fonts,
                        page_shadings,
                        shading_counter,
                        page_ext_gstates,
                        bg_alpha_counter,
                        annotations,
                        page_paint_box,
                        page_height,
                    )
                    .with_initial_fixed_origin(initial_fixed_origin);
                    child_ctx.stacking = self.stacking.fork();
                    render_container_children(
                        content,
                        &cell.layout.content.children,
                        ContainerFrame::new(
                            PdfPoint::new(nested_x, nested_y),
                            crate::types::Size::new(
                                nested_w,
                                (cell_content_box.height - text_h).max(0.0),
                            ),
                            PdfPoint::new(
                                nested_x - cell.layout.box_model.content_insets.left,
                                nested_y + cell.layout.box_model.content_insets.top,
                            ),
                        ),
                        &mut nested_abs,
                        &mut child_ctx,
                        ContainerRenderOptions {
                            stacking_scope: if cell.layout.establishes_stacking_context() {
                                StackingScope::Local
                            } else {
                                StackingScope::Ancestor
                            },
                            ..Default::default()
                        },
                    );
                    self.stacking.restore(child_ctx.stacking.take_since(0));
                }

                if let Some(clip) = &content_clip {
                    clip.finish(content, self.stacking);
                }
                let mut cell_ctx = PageRenderContext::new(
                    pdf_writer,
                    page_images,
                    custom_fonts,
                    prepared_custom_fonts,
                    page_shadings,
                    shading_counter,
                    page_ext_gstates,
                    bg_alpha_counter,
                    annotations,
                    page_paint_box,
                    page_height,
                )
                .with_initial_fixed_origin(initial_fixed_origin);
                cell_group.finish(content, &mut cell_ctx);
            }
            let descendants = self.stacking.take_since(marker);
            self.stacking.commit(
                stacking_scope,
                content,
                &mut stacking_plan,
                cell.layout.stacking_level(),
                cell_content,
                descendants,
            );
        }
        if stacking_scope.is_local() {
            self.stacking.paint_plan(stacking_plan, content);
        }
        cursor_y -= row_height + margin_bottom;
        self.cursor_y = cursor_y;
        self.previous_margin_bottom = 0.0;
    }
}
