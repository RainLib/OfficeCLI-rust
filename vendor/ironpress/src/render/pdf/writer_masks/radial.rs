use super::*;

#[derive(Debug, Clone)]
struct RadialMaskShading {
    geometry: RadialGradientGeometry,
    terminal: f32,
    terminal_coverage: f32,
    stops: PdfGradientStops,
}

impl RadialMaskShading {
    fn resolve(
        gradient: &RadialGradient,
        mode: MaskMode,
        tile: PdfRect,
        invert_coverage: bool,
    ) -> Option<Self> {
        if gradient.shape != RadialShape::Circle {
            return None;
        }
        let geometry =
            RadialGradientGeometry::resolve(gradient, PdfVector::new(tile.width, tile.height))?;
        let resolved = gradient.ramp.resolve(geometry.stop_basis())?;
        if resolved.repeat().is_repeating() {
            return None;
        }
        let terminal = resolved.stops().last()?.position.max(1.0);
        if !terminal.is_finite()
            || terminal <= 0.0
            || resolved.stops().iter().any(|stop| {
                !stop.position.is_finite() || stop.position < 0.0 || stop.position > terminal
            })
        {
            return None;
        }
        let coverage = |color: crate::types::Color| {
            let coverage = coverage_fraction(color.to_f32_rgba(), mode);
            if invert_coverage {
                1.0 - coverage
            } else {
                coverage
            }
        };
        let terminal_coverage = coverage(resolved.stops().last()?.color.color);
        let stops = PdfGradientStops::unit(resolved.stops().iter().map(|stop| {
            let gray = coverage(stop.color.color);
            (stop.position / terminal, (gray, gray, gray))
        }))
        .ok()?;
        Some(Self {
            geometry,
            terminal,
            terminal_coverage,
            stops,
        })
    }

    fn paint(
        self,
        writer: &mut PdfWriter,
        tile: PdfRect,
        paint: PdfRect,
        form_bounds: PdfRect,
    ) -> String {
        let pattern = writer.add_shading_pattern(PdfShadingPattern::radial(
            self.geometry.center,
            self.geometry.radii.x * self.terminal,
            PdfMatrix::new(
                PdfVector::new(crate::fonts::PT_PER_CSS_PX, 0.0),
                PdfVector::new(0.0, -crate::fonts::PT_PER_CSS_PX),
                PdfPoint::new(tile.left, tile.top()),
            ),
            self.stops,
            PdfPatternGeometryFormat::SixDecimals,
        ));
        let stream = format!("/Pattern cs\n/{pattern} scn\n{}f\n", paint.rect_path());
        let form = writer.add_transparency_group_form(stream, form_bounds);
        let state = format!("GSmask{}", form.obj_id);
        writer.register_soft_mask(state.clone(), form.obj_id);
        state
    }
}

#[derive(Debug, Clone, Copy)]
struct BinaryLinearMask {
    boundary: f32,
    opaque_at_start: bool,
    reverse_axis: bool,
}

impl BinaryLinearMask {
    fn resolve(layer: &MaskLayer, tile: PdfRect) -> Option<Self> {
        let MaskLayerSource::Linear(gradient) = &layer.source else {
            return None;
        };
        let angle = gradient.angle.rem_euclid(360.0);
        let reverse_axis = if (angle - 90.0).abs() <= 0.000_1 {
            false
        } else if (angle - 270.0).abs() <= 0.000_1 {
            true
        } else {
            return None;
        };
        let basis = linear_gradient_line_length(gradient.angle, tile.width, tile.height);
        let resolved = gradient.ramp.resolve(basis)?;
        if resolved.repeat().is_repeating() {
            return None;
        }
        let stops = resolved.stops();
        let binary_coverage = |stop: &crate::style::computed::ResolvedGradientStop| {
            let coverage = coverage_fraction(stop.color.color.to_f32_rgba(), layer.mode);
            if coverage <= f32::EPSILON {
                Some(false)
            } else if (coverage - 1.0).abs() <= f32::EPSILON {
                Some(true)
            } else {
                None
            }
        };
        let opaque_at_start = binary_coverage(stops.first()?)?;
        let opaque_at_end = binary_coverage(stops.last()?)?;
        if opaque_at_start == opaque_at_end {
            return None;
        }
        let mut boundary = None;
        for pair in stops.windows(2) {
            let lower = binary_coverage(&pair[0])?;
            let upper = binary_coverage(&pair[1])?;
            if lower == upper {
                continue;
            }
            if pair[0].position != pair[1].position || boundary.replace(pair[0].position).is_some()
            {
                return None;
            }
        }
        let boundary = boundary?;
        ((0.0..=1.0).contains(&boundary)).then_some(Self {
            boundary,
            opaque_at_start,
            reverse_axis,
        })
    }

    fn coverage_rect(self, tile: PdfRect, invert: bool) -> Option<PdfRect> {
        let start_is_covered = self.opaque_at_start != invert;
        let boundary_x = if self.reverse_axis {
            tile.right() - tile.width * self.boundary
        } else {
            tile.left + tile.width * self.boundary
        };
        let start_is_left = !self.reverse_axis;
        let covered_is_left = start_is_covered == start_is_left;
        let rect = if covered_is_left {
            PdfRect::new(tile.left, tile.bottom, boundary_x - tile.left, tile.height)
        } else {
            PdfRect::new(
                boundary_x,
                tile.bottom,
                tile.right() - boundary_x,
                tile.height,
            )
        };
        (!rect.is_empty()).then_some(rect)
    }
}

impl PdfWriter {
    /// Render an initial one-layer repeating radial mask as a type-1 function
    /// in a luminosity group. Its implicit `mask-repeat: repeat` does not add a
    /// second tile here: an initial CSS gradient tile already spans the whole
    /// border box, while the radial function itself supplies the ring period.
    pub(super) fn try_single_repeating_radial_mask_layer_function(
        &mut self,
        layers: &[MaskLayer],
        geometry: PaintBoxGeometry,
    ) -> Option<String> {
        let [layer] = layers else {
            return None;
        };
        let MaskLayerSource::Radial(gradient) = &layer.source else {
            return None;
        };
        layer.uses_initial_paint_area().then(|| {
            self.try_repeating_radial_mask_function(gradient, layer.mode, geometry.border_box)
        })?
    }

    /// Build a vector soft mask for an alpha-interpreted repeating radial
    /// gradient. A PDF function emits equal RGB coverage inside a luminosity
    /// transparency group, so the result has no source-raster resolution or
    /// tiling seam.
    pub(super) fn try_repeating_radial_mask_function(
        &mut self,
        gradient: &RadialGradient,
        mode: MaskMode,
        tile: PdfRect,
    ) -> Option<String> {
        if gradient.shape != RadialShape::Circle
            || !matches!(mode, MaskMode::Alpha | MaskMode::MatchSource)
        {
            return None;
        }
        let radial =
            RadialGradientGeometry::resolve(gradient, PdfVector::new(tile.width, tile.height))?;
        let function = radial_alpha_function_gradient(&gradient.ramp, radial.stop_basis())?;
        let period_radii = radial.point_radii() * function.period();
        if !period_radii.is_positive() {
            return None;
        }
        let transform = PdfMatrix::new(
            PdfVector::new(period_radii.x, 0.0),
            PdfVector::new(0.0, -period_radii.y),
            radial.page_center(tile),
        );
        let mask_bounds = self.page_content_transform.enclosing_device_bounds(tile);
        // Type-1 shading domains are clipped at their upper/left boundary by
        // Poppler's sample grid. Keep one physical device pixel of function
        // domain outside the form's paint and BBox: the form itself remains
        // exactly `mask_bounds`, while its boundary samples receive the same
        // gradient coverage as the interior.
        let function_bounds =
            mask_bounds.outset_uniform(PageContentTransform::DEVICE_TO_PAGE as f32);
        let inverse = transform.inverse()?;
        let domain = function_bounds.transformed_bounds(inverse);
        let pattern_name = self.add_function_pattern(PdfFunctionPattern::new(
            transform,
            domain,
            function.calculator()?,
        )?);
        let pattern_id = self
            .pdf_patterns
            .last()
            .filter(|entry| entry.name == pattern_name)?
            .object_id;
        let group = format!(
            "q\n/Pattern cs\n/{pattern_name} scn\n{}f\nQ\n",
            mask_bounds.rect_path(),
        );
        let form_id = self.next_id();
        self.objects.push(format!(
            "{form_id} 0 obj\n<< /Type /XObject /Subtype /Form /FormType 1 /BBox [{left} {bottom} {right} {top}] /Group << /Type /Group /S /Transparency /CS /DeviceRGB /I true >> /Resources << /Pattern << /{pattern_name} {pattern_id} 0 R >> >> /Length {len} >>\nstream\n",
            left = mask_bounds.left,
            bottom = mask_bounds.bottom,
            right = mask_bounds.right(),
            top = mask_bounds.top(),
            len = group.len(),
        ));
        self.binary_objects.insert(form_id, group.into_bytes());
        let state_name = format!("GSmask{form_id}");
        self.register_soft_mask(state_name.clone(), form_id);
        Some(state_name)
    }

    pub(super) fn try_radial_mask_vector_shading(
        &mut self,
        gradient: &RadialGradient,
        mode: MaskMode,
        tile: PdfRect,
    ) -> Option<String> {
        Some(RadialMaskShading::resolve(gradient, mode, tile, false)?.paint(self, tile, tile, tile))
    }

    /// Build one full-size circular radial layer as a vector luminosity mask.
    /// The resulting state is deliberately kept separate from composition: a
    /// later isolated group can combine several such alpha-painted layers with
    /// PDF's normal source-over rule.
    fn try_radial_layer_luminosity_mask(
        &mut self,
        layer: &MaskLayer,
        geometry: PaintBoxGeometry,
        invert_coverage: bool,
    ) -> Option<String> {
        let MaskLayerSource::Radial(gradient) = &layer.source else {
            return None;
        };
        if gradient.shape != RadialShape::Circle {
            return None;
        }
        let MaskLayerPaint { tile, clip } = MaskLayerPaint::resolve(layer, geometry)?;
        if tile != geometry.border_box || clip != geometry.border_box {
            return None;
        }
        let shading = RadialMaskShading::resolve(gradient, layer.mode, tile, invert_coverage)?;
        let expected_tail = if invert_coverage { 1.0 } else { 0.0 };
        if shading.terminal_coverage != expected_tail {
            return None;
        }
        Some(shading.paint(self, tile, tile, tile))
    }

    /// Vector source-over composition for two full-size circular alpha masks.
    /// CSS `mask-composite: add` is the union `s + d * (1 - s)`, which is the
    /// alpha produced by painting the two source masks normally into an
    /// isolated transparency group.
    pub(super) fn try_two_layer_add_mask_alpha(
        &mut self,
        layers: &[MaskLayer],
        geometry: PaintBoxGeometry,
    ) -> Option<String> {
        let [top, bottom] = layers else {
            return None;
        };
        if top.composite != MaskComposite::Add || bottom.composite != MaskComposite::Add {
            return None;
        }
        if layers.iter().any(|layer| {
            !matches!(
                layer.layer_box.repeat.unwrap_or(BackgroundRepeat::Repeat),
                BackgroundRepeat::NoRepeat
            )
        }) {
            return None;
        }

        let bottom_mask = self.try_radial_layer_luminosity_mask(bottom, geometry, false)?;
        let bottom_pattern =
            self.add_masked_solid_page_pattern(geometry.border_box, &bottom_mask, (1.0, 1.0, 1.0))?;
        let top_mask = self.try_radial_layer_luminosity_mask(top, geometry, false)?;
        let top_pattern =
            self.add_masked_solid_page_pattern(geometry.border_box, &top_mask, (1.0, 1.0, 1.0))?;

        let mut stream = String::new();
        patterns::paint_page_tiling_pattern(&mut stream, &bottom_pattern, geometry.border_box);
        patterns::paint_page_tiling_pattern(&mut stream, &top_pattern, geometry.border_box);
        let form = self.add_transparency_group_form(stream, geometry.border_box);
        let state = format!("GSmask{}", form.obj_id);
        self.register_alpha_soft_mask(state.clone(), form.obj_id);
        Some(state)
    }

    /// Intersect a circular radial layer with one binary horizontal linear
    /// layer without reducing either source to a bitmap. `subtract` is the
    /// same radial shading clipped to the inverse binary region.
    pub(super) fn try_radial_binary_composite_mask(
        &mut self,
        layers: &[MaskLayer],
        geometry: PaintBoxGeometry,
    ) -> Option<String> {
        let [radial, linear] = layers else {
            return None;
        };
        let invert_linear = match radial.composite {
            MaskComposite::Intersect => false,
            MaskComposite::Subtract => true,
            _ => return None,
        };
        if layers.iter().any(|layer| {
            !matches!(
                layer.layer_box.repeat.unwrap_or(BackgroundRepeat::Repeat),
                BackgroundRepeat::NoRepeat
            )
        }) {
            return None;
        }
        let radial_paint = MaskLayerPaint::resolve(radial, geometry)?;
        let linear_paint = MaskLayerPaint::resolve(linear, geometry)?;
        if radial_paint != linear_paint
            || radial_paint.tile != geometry.border_box
            || radial_paint.clip != geometry.border_box
        {
            return None;
        }
        let paint = BinaryLinearMask::resolve(linear, linear_paint.tile)?
            .coverage_rect(linear_paint.tile, invert_linear)?
            .intersection(radial_paint.tile)?
            .intersection(radial_paint.clip)?;
        let MaskLayerSource::Radial(gradient) = &radial.source else {
            return None;
        };
        Some(
            RadialMaskShading::resolve(gradient, radial.mode, radial_paint.tile, false)?.paint(
                self,
                radial_paint.tile,
                paint,
                geometry.border_box,
            ),
        )
    }

    /// Reduce an opaque linear source excluding a radial destination to the
    /// inverse radial coverage. This is the CSS alpha-composite result
    /// `1 * (1 - d) + d * (1 - 1)`, represented directly in one native PDF
    /// soft mask. Other layered exclusions remain on the general raster path:
    /// PDF's `/Exclusion` colour blend mode is not CSS mask alpha composition.
    pub(super) fn try_opaque_linear_exclude_radial_mask(
        &mut self,
        layers: &[MaskLayer],
        geometry: PaintBoxGeometry,
    ) -> Option<String> {
        let [top, bottom] = layers else {
            return None;
        };
        if top.composite != MaskComposite::Exclude {
            return None;
        }
        if layers.iter().any(|layer| {
            !matches!(
                layer.layer_box.repeat.unwrap_or(BackgroundRepeat::Repeat),
                BackgroundRepeat::NoRepeat
            )
        }) {
            return None;
        }
        let MaskLayerSource::Linear(linear) = &top.source else {
            return None;
        };
        let MaskLayerPaint { tile, clip } = MaskLayerPaint::resolve(top, geometry)?;
        if tile != geometry.border_box || clip != geometry.border_box {
            return None;
        }
        let basis = linear_gradient_line_length(linear.angle, tile.width, tile.height);
        let resolved = linear.ramp.resolve(basis)?;
        if !resolved
            .stops()
            .iter()
            .all(|stop| coverage_fraction(stop.color.color.to_f32_rgba(), top.mode) == 1.0)
        {
            return None;
        }
        self.try_radial_layer_luminosity_mask(bottom, geometry, true)
    }

    pub(super) fn try_single_radial_mask_layer_shading(
        &mut self,
        layers: &[MaskLayer],
        geometry: PaintBoxGeometry,
    ) -> Option<String> {
        let [layer] = layers else {
            return None;
        };
        if layer.composite != MaskComposite::Add {
            return None;
        }
        let MaskLayerSource::Radial(gradient) = &layer.source else {
            return None;
        };
        if !matches!(
            layer.layer_box.size,
            None | Some(BackgroundSize::Auto | BackgroundSize::Explicit { .. })
        ) {
            return None;
        }
        let layer_paint = MaskLayerPaint::resolve(layer, geometry)?;
        if !layer_paint
            .is_complete_single_tile(layer.layer_box.repeat.unwrap_or(BackgroundRepeat::Repeat))
        {
            return None;
        }
        let paint = layer_paint.tile.intersection(layer_paint.clip)?;
        Some(
            RadialMaskShading::resolve(gradient, layer.mode, layer_paint.tile, false)?.paint(
                self,
                layer_paint.tile,
                paint,
                geometry.border_box,
            ),
        )
    }
}
