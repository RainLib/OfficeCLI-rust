//! Color-independent PDF soft masks for renderer-owned blur coverage.

use super::super::transforms::PdfDeviceRasterPlacement;
use super::super::*;

pub(in crate::render::pdf) struct PdfCoverageSoftMask {
    state: String,
    paint_space: CoveragePaintSpace,
}

impl PdfCoverageSoftMask {
    pub(in crate::render::pdf) fn apply(&self, content: &mut String) {
        if let CoveragePaintSpace::Device(device) = self.paint_space {
            content.push_str(&device.placement.enter_device_operator());
        }
        content.push_str(&format!("/{} gs\n", self.state));
    }

    pub(in crate::render::pdf) fn paint_bounds(&self) -> PdfRect {
        match self.paint_space {
            CoveragePaintSpace::Layout(layout) => layout.bounds,
            CoveragePaintSpace::Device(device) => device.placement.device_bounds(),
        }
    }
}

#[derive(Clone, Copy)]
enum CoveragePaintSpace {
    Layout(LayoutCoveragePaint),
    Device(DeviceCoveragePaint),
}

#[derive(Clone, Copy)]
struct LayoutCoveragePaint {
    bounds: PdfRect,
}

#[derive(Clone, Copy)]
struct DeviceCoveragePaint {
    placement: PdfDeviceRasterPlacement,
}

impl PdfWriter {
    /// Register one grayscale blur-coverage image as a native PDF soft mask.
    ///
    /// The image remains color-independent: callers paint their solid color
    /// through the returned graphics state. Untransformed masks retain the
    /// print-device hierarchy used by Chromium; transformed masks stay in the
    /// owner's generic layout paint space so the inherited affine transform is
    /// applied exactly once.
    pub(in crate::render::pdf) fn add_coverage_soft_mask(
        &mut self,
        mask: &crate::render::blur::BlurredCoverageMask,
        bounds: PdfRect,
    ) -> Option<PdfCoverageSoftMask> {
        let coverage = mask.coverage();
        if coverage.width() == 0 || coverage.height() == 0 || bounds.is_empty() {
            return None;
        }
        let image_id = match self.opts.raster_quality.blurred_coverage_compression {
            crate::style::raster_quality::CoverageCompression::Lossless => self
                .add_flate_image_stream(
                    flate_compress(coverage.as_raw())?,
                    coverage.width(),
                    coverage.height(),
                    "/DeviceGray",
                    None,
                    PdfImageInterpolation::Default,
                ),
            crate::style::raster_quality::CoverageCompression::Jpeg(compression) => self
                .add_dct_image_stream(
                    encode_gray_as_jpeg(
                        coverage.as_raw(),
                        coverage.width(),
                        coverage.height(),
                        compression.quality(),
                    )?,
                    coverage.width(),
                    coverage.height(),
                    "/DeviceGray",
                    PdfImageInterpolation::Default,
                ),
        };
        let image_name = format!("MaskImg{image_id}");

        let device_placement = (!self.has_active_paint_transform())
            .then(|| {
                self.page_content_transform.device_raster_placement(
                    bounds,
                    mask.raster_dimensions(),
                    mask.pixel_density(),
                )
            })
            .flatten();
        let (form_bounds, image_operator, paint_space) = device_placement.map_or_else(
            || {
                (
                    bounds,
                    PdfMatrix::new(
                        PdfVector::new(bounds.width, 0.0),
                        PdfVector::new(0.0, bounds.height),
                        PdfPoint::new(bounds.left, bounds.bottom),
                    )
                    .cm_operator(),
                    CoveragePaintSpace::Layout(LayoutCoveragePaint { bounds }),
                )
            },
            |placement| {
                (
                    placement.device_bounds(),
                    placement.image_operator(),
                    CoveragePaintSpace::Device(DeviceCoveragePaint { placement }),
                )
            },
        );
        let stream = format!("q\n{image_operator}/{image_name} Do\nQ\n");
        let bytes = stream.into_bytes();
        let form_id = self.next_id();
        let [left, right, lower, upper] = form_bounds.xy_domain();
        self.objects.push(format!(
            "{form_id} 0 obj\n<< /Type /XObject /Subtype /Form /FormType 1 /BBox [{left} {lower} {right} {upper}] /Group << /Type /Group /S /Transparency /CS /DeviceGray /I true >> /Resources << /XObject << /{image_name} {image_id} 0 R >> >> /Length {len} >>\nstream\n",
            len = bytes.len(),
        ));
        self.binary_objects.insert(form_id, bytes);

        let state = format!("GSmask{form_id}");
        self.register_soft_mask(state.clone(), form_id);
        Some(PdfCoverageSoftMask { state, paint_space })
    }
}
