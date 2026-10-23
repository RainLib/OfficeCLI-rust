//! PDF user space (bottom-left) ↔ cropped/rotated editor viewport (top-left).
use super::*;
use lopdf::{Document, Object, ObjectId};
use std::collections::HashSet;

pub(super) const COORDINATE_SYSTEM: &str = "viewport-v1";

#[derive(Debug, Clone, Copy)]
pub(super) struct Viewport {
    pub left: f64,
    pub bottom: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: u16,
}

fn inherited<'a>(
    doc: &'a Document,
    mut page: ObjectId,
    key: &[u8],
) -> Result<Option<&'a Object>, HcdError> {
    let mut seen = HashSet::new();
    while seen.insert(page) {
        let dict = doc
            .get_dictionary(page)
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        if let Ok(value) = dict.get(key) {
            return doc
                .dereference(value)
                .map(|(_, value)| Some(value))
                .map_err(|error| HcdError::InvalidBundle(error.to_string()));
        }
        page = match dict.get(b"Parent").and_then(Object::as_reference) {
            Ok(parent) => parent,
            Err(_) => return Ok(None),
        };
    }
    Err(HcdError::InvalidBundle("cycle in PDF page tree".into()))
}

fn box_values(value: &Object) -> Option<[f64; 4]> {
    let values = value.as_array().ok()?;
    if values.len() != 4 {
        return None;
    }
    let mut rect = [0.; 4];
    for (out, input) in rect.iter_mut().zip(values) {
        *out = input.as_float().ok()? as f64;
    }
    if !rect.iter().all(|value| value.is_finite()) {
        return None;
    }
    Some([
        rect[0].min(rect[2]),
        rect[1].min(rect[3]),
        rect[0].max(rect[2]),
        rect[1].max(rect[3]),
    ])
}

pub(super) fn rotation(doc: &Document, page: ObjectId) -> Result<u16, HcdError> {
    let value = inherited(doc, page, b"Rotate")?
        .and_then(|value| value.as_i64().ok())
        .unwrap_or(0)
        .rem_euclid(360);
    Ok(if value % 90 == 0 { value as u16 } else { 0 })
}

impl Viewport {
    pub fn from_document(doc: &Document, page: ObjectId) -> Result<Self, HcdError> {
        // Match the renderer's inherited boxes, intersection, and A4 fallback.
        let a4 = hayro::hayro_syntax::page::A4;
        let media = inherited(doc, page, b"MediaBox")?
            .and_then(box_values)
            .unwrap_or([0., 0., a4.x1, a4.y1]);
        let crop = inherited(doc, page, b"CropBox")?
            .and_then(box_values)
            .unwrap_or(media);
        let left = crop[0].max(media[0]);
        let bottom = crop[1].max(media[1]);
        let width = (crop[2].min(media[2]) - left).max(0.);
        let height = (crop[3].min(media[3]) - bottom).max(0.);
        let (width, height) = if width < 1e-6 || height < 1e-6 {
            (a4.width(), a4.height())
        } else {
            (width.max(1.), height.max(1.))
        };
        Ok(Self {
            left,
            bottom,
            width,
            height,
            rotation: rotation(doc, page)?,
        })
    }

    pub fn from_rendered(page: &hayro::hayro_syntax::page::Page<'_>) -> Self {
        use hayro::hayro_syntax::page::Rotation;
        let crop = page.intersected_crop_box();
        let (width, height) = page.base_dimensions();
        Self {
            left: crop.x0,
            bottom: crop.y0,
            width: width as f64,
            height: height as f64,
            rotation: match page.rotation() {
                Rotation::None => 0,
                Rotation::Horizontal => 90,
                Rotation::Flipped => 180,
                Rotation::FlippedHorizontal => 270,
            },
        }
    }

    pub fn dimensions(self) -> (f32, f32) {
        if self.rotation == 90 || self.rotation == 270 {
            (self.height as f32, self.width as f32)
        } else {
            (self.width as f32, self.height as f32)
        }
    }

    pub fn to_view(self, rect: [f64; 4]) -> [f64; 4] {
        let [x, y, w, h] = rect;
        let x = x - self.left;
        let y = y - self.bottom;
        match self.rotation {
            90 => [y, x, h, w],
            180 => [self.width - x - w, y, w, h],
            270 => [self.height - y - h, self.width - x - w, h, w],
            _ => [x, self.height - y - h, w, h],
        }
    }

    pub fn to_source(self, rect: [f64; 4]) -> [f64; 4] {
        let [x, y, w, h] = rect;
        let [x, y, w, h] = match self.rotation {
            90 => [y, x, h, w],
            180 => [self.width - x - w, y, w, h],
            270 => [self.width - y - h, self.height - x - w, h, w],
            _ => [x, self.height - y - h, w, h],
        };
        [x + self.left, y + self.bottom, w, h]
    }

    /// Rotate the text inside an axis-aligned selection rectangle, keeping the
    /// outer rectangle directly usable by editor hit-testing and property UI.
    pub fn text_transform(self, width: f32, height: f32) -> String {
        if self.rotation == 0 {
            return String::new();
        }
        let (left, top) = if self.rotation == 90 || self.rotation == 270 {
            ((height - width) / 2., (width - height) / 2.)
        } else {
            (0., 0.)
        };
        format!("position:absolute;left:{left}pt;top:{top}pt;display:block;width:{width}pt;height:{height}pt;transform-origin:center;transform:rotate({}deg)", self.rotation)
    }
}

/// Hayro 0.5 reads /Rotate as unsigned. Normalize signed rotations in the
/// disposable rendering/candidate copy, while keeping the source bytes intact.
pub(super) fn normalize_rotations(doc: &mut Document) -> Result<bool, HcdError> {
    let mut changed = false;
    for page in doc.get_pages().into_values() {
        let normalized = rotation(doc, page)? as i64;
        let value = inherited(doc, page, b"Rotate")?
            .and_then(|value| value.as_i64().ok())
            .unwrap_or(0);
        if value != normalized {
            doc.get_dictionary_mut(page)
                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                .set("Rotate", normalized);
            changed = true;
        }
    }
    Ok(changed)
}

pub(super) fn raster_bytes(
    reader: &pdf_handler::reader::PdfReader,
    source: &Path,
) -> Result<Vec<u8>, HcdError> {
    let doc = reader.document();
    let mut needs_normalization = false;
    for page in doc.get_pages().into_values() {
        let normalized = rotation(doc, page)?;
        let value = inherited(doc, page, b"Rotate")?
            .and_then(|v| v.as_i64().ok())
            .unwrap_or(0);
        needs_normalization |= value != normalized as i64;
    }
    if !needs_normalization {
        return Ok(std::fs::read(source)?);
    }
    let mut doc = doc.clone();
    normalize_rotations(&mut doc)?;
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn viewport_roundtrips_cropped_rectangles_in_every_quarter_turn() {
        let source = [27., 48., 34., 16.];
        let expected = [
            [17., 126., 34., 16.],
            [28., 17., 16., 34.],
            [69., 28., 34., 16.],
            [126., 69., 16., 34.],
        ];
        for (rotation, expected) in [0, 90, 180, 270].into_iter().zip(expected) {
            let viewport = Viewport {
                left: 10.,
                bottom: 20.,
                width: 120.,
                height: 170.,
                rotation,
            };
            assert_eq!(viewport.to_view(source), expected);
            assert_eq!(viewport.to_source(expected), source);
        }
    }
}
