use super::*;

impl PdfWriter {
    /// Add an image as a PDF XObject and return its object ID.
    pub(in crate::render::pdf) fn add_image_object(
        &mut self,
        data: &[u8],
        width: u32,
        height: u32,
        format: ImageFormat,
        png_metadata: Option<&PngMetadata>,
    ) -> usize {
        self.add_image_object_with_interpolation(
            data,
            width,
            height,
            format,
            png_metadata,
            PdfImageInterpolation::Default,
        )
    }

    /// Embed an image with the requested final PDF sampling behavior.
    pub(in crate::render::pdf) fn add_image_object_with_interpolation(
        &mut self,
        data: &[u8],
        width: u32,
        height: u32,
        format: ImageFormat,
        png_metadata: Option<&PngMetadata>,
        interpolation: PdfImageInterpolation,
    ) -> usize {
        if matches!(format, ImageFormat::Png | ImageFormat::PngAlpha)
            && !interpolation.preserves_source_edges()
            && should_try_lossy_png_reencode(width, height, data.len())
            && let Some(decoded) = try_decode_png_as_opaque_rgb(data)
            && let Some(jpeg) = encode_rgb_as_jpeg(
                &decoded.color_data,
                decoded.width,
                decoded.height,
                self.opts.jpeg_quality,
            )
            && jpeg.len() < data.len()
        {
            return self.add_image_object_with_interpolation(
                &jpeg,
                decoded.width,
                decoded.height,
                ImageFormat::Jpeg,
                None,
                interpolation,
            );
        }
        if format == ImageFormat::PngAlpha
            && let Some(obj_id) =
                self.add_raw_png_image_object_with_interpolation(data, interpolation)
        {
            return obj_id;
        }
        let id = self.next_id();
        let interpolation = interpolation.pdf_dictionary_entry();
        let header = match format {
            ImageFormat::Jpeg => {
                format!(
                    "{id} 0 obj\n<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode{interpolation} /Length {len} >>\nstream\n",
                    len = data.len(),
                )
            }
            ImageFormat::PngAlpha | ImageFormat::Png => {
                let parsed_png = crate::parser::png::parse_png(data);
                let recovered = parsed_png.as_ref().map(|info| PngMetadata {
                    channels: info.channels,
                    bit_depth: info.bit_depth,
                });
                let Some(meta) = png_metadata.or(recovered.as_ref()) else {
                    return self.add_blank_image_object();
                };
                let color_space = match meta.channels {
                    1 | 2 => "/DeviceGray",
                    _ => "/DeviceRGB",
                };
                let stream_data = parsed_png
                    .as_ref()
                    .map_or(data, |info| info.idat_data.as_slice());
                format!(
                    "{id} 0 obj\n<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace {color_space} /BitsPerComponent {bpc} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns {width} /Colors {channels} /BitsPerComponent {bpc} >>{interpolation} /Length {len} >>\nstream\n",
                    bpc = meta.bit_depth,
                    channels = meta.channels,
                    len = stream_data.len(),
                )
            }
        };
        self.objects.push(header);
        let stream_data = match format {
            ImageFormat::Png | ImageFormat::PngAlpha => crate::parser::png::parse_png(data)
                .map_or_else(|| data.to_vec(), |info| info.idat_data),
            ImageFormat::Jpeg => data.to_vec(),
        };
        self.binary_objects.insert(id, stream_data);
        id
    }

    fn add_blank_image_object(&mut self) -> usize {
        let id = self.next_id();
        self.objects.push(format!(
            "{id} 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n"
        ));
        self.binary_objects.insert(id, vec![255]);
        id
    }

    #[allow(dead_code)]
    fn add_icc_profile_object(&mut self, icc_profile: &[u8]) -> Option<usize> {
        let id = self.next_id();
        self.objects.push(format!(
            "{id} 0 obj\n<< /N 3 /Alternate /DeviceRGB /Length {} >>\nstream\n",
            icc_profile.len(),
        ));
        self.binary_objects.insert(id, icc_profile.to_vec());
        Some(id)
    }

    #[allow(dead_code)]
    pub(crate) fn add_raw_rgb_image_object(
        &mut self,
        rgb_data: &[u8],
        width: u32,
        height: u32,
        icc_profile: Option<&[u8]>,
    ) -> Option<usize> {
        let color_stream = flate_compress(rgb_data)?;
        let color_space = if let Some(icc_profile) = icc_profile {
            let icc_id = self.add_icc_profile_object(icc_profile)?;
            format!("[/ICCBased {icc_id} 0 R]")
        } else {
            "/DeviceRGB".to_string()
        };
        Some(self.add_flate_image_stream(
            color_stream,
            width,
            height,
            &color_space,
            None,
            PdfImageInterpolation::Default,
        ))
    }

    pub(in crate::render::pdf) fn add_raw_rgba_image_object(
        &mut self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Option<usize> {
        let pixels = usize::try_from(width.checked_mul(height)?).ok()?;
        if rgba.len() != pixels.checked_mul(4)? {
            return None;
        }
        let has_alpha = rgba.chunks_exact(4).any(|pixel| pixel[3] != 255);
        let mut rgb = Vec::with_capacity(pixels.checked_mul(3)?);
        let mut alpha = has_alpha.then(|| Vec::with_capacity(pixels));
        for pixel in rgba.chunks_exact(4) {
            rgb.extend_from_slice(&pixel[..3]);
            if let Some(alpha) = &mut alpha {
                alpha.push(pixel[3]);
            }
        }

        let color_stream = flate_compress(&rgb)?;
        let alpha_stream = match alpha {
            Some(alpha) => Some(flate_compress(&alpha)?),
            None => None,
        };
        let alpha_id = alpha_stream.map(|stream| {
            self.add_flate_image_stream(
                stream,
                width,
                height,
                "/DeviceGray",
                None,
                PdfImageInterpolation::Default,
            )
        });
        Some(self.add_flate_image_stream(
            color_stream,
            width,
            height,
            "/DeviceRGB",
            alpha_id,
            PdfImageInterpolation::Default,
        ))
    }

    pub(in crate::render::pdf) fn add_flate_image_stream(
        &mut self,
        stream: Vec<u8>,
        width: u32,
        height: u32,
        color_space: &str,
        alpha_id: Option<usize>,
        interpolation: PdfImageInterpolation,
    ) -> usize {
        let id = self.next_id();
        let soft_mask = alpha_id.map_or_else(String::new, |id| format!(" /SMask {id} 0 R"));
        let interpolation = interpolation.pdf_dictionary_entry();
        self.objects.push(format!(
            "{id} 0 obj\n<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace {color_space} /BitsPerComponent 8 /Filter /FlateDecode{soft_mask}{interpolation} /Length {len} >>\nstream\n",
            len = stream.len(),
        ));
        self.binary_objects.insert(id, stream);
        id
    }

    pub(in crate::render::pdf) fn add_dct_image_stream(
        &mut self,
        stream: Vec<u8>,
        width: u32,
        height: u32,
        color_space: &str,
        interpolation: PdfImageInterpolation,
    ) -> usize {
        let id = self.next_id();
        let interpolation = interpolation.pdf_dictionary_entry();
        self.objects.push(format!(
            "{id} 0 obj\n<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace {color_space} /BitsPerComponent 8 /Filter /DCTDecode{interpolation} /Length {len} >>\nstream\n",
            len = stream.len(),
        ));
        self.binary_objects.insert(id, stream);
        id
    }

    pub(crate) fn add_raw_png_image_object(&mut self, raw_png: &[u8]) -> Option<usize> {
        self.add_raw_png_image_object_with_interpolation(raw_png, PdfImageInterpolation::Default)
    }

    pub(super) fn add_raw_png_image_object_with_interpolation(
        &mut self,
        raw_png: &[u8],
        interpolation: PdfImageInterpolation,
    ) -> Option<usize> {
        let decoded = decode_png_for_pdf(raw_png)?;
        let alpha_id = match decoded.alpha_data.as_deref() {
            Some(alpha) => Some(self.add_flate_image_stream(
                flate_compress(alpha)?,
                decoded.width,
                decoded.height,
                "/DeviceGray",
                None,
                PdfImageInterpolation::Default,
            )),
            None => None,
        };
        let jpeg_color = (alpha_id.is_none()
            && decoded.color_space == "/DeviceRGB"
            && !interpolation.preserves_source_edges()
            && should_try_lossy_png_reencode(decoded.width, decoded.height, raw_png.len()))
        .then(|| {
            encode_rgb_as_jpeg(
                &decoded.color_data,
                decoded.width,
                decoded.height,
                self.opts.jpeg_quality,
            )
        })
        .flatten();
        if let Some(jpeg) = jpeg_color {
            return Some(self.add_dct_image_stream(
                jpeg,
                decoded.width,
                decoded.height,
                "/DeviceRGB",
                interpolation,
            ));
        }
        Some(self.add_flate_image_stream(
            flate_compress(&decoded.color_data)?,
            decoded.width,
            decoded.height,
            decoded.color_space,
            alpha_id,
            interpolation,
        ))
    }
}
