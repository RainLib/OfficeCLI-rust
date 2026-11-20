//! The saved layer graph lives in the same revision as the rendered PNG.
//! The normal image node continues to be the preview and export surface.
pub use crate::image_codec::{decode_raster, png_bytes, MAX_IMAGE_BYTES};
use crate::{
    bundle::read_bytes_bounded, extract_html_image_nodes, hash_bytes, manifest_at_revision,
    AssetDescriptor, Bundle, HcdError, ImageGeometry, ImageGeometryUnit,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use image::{imageops, DynamicImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub(crate) const ATTRIBUTE: &str = "data-hcd-image-layers";
pub const MAX_LAYERS: usize = 64;
const MAX_LAYER_PIXELS: u64 = 128_000_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageLayerStack {
    pub width: u32,
    pub height: u32,
    /// Bottom to top.
    pub layers: Vec<ImageLayer>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageLayer {
    pub id: String,
    pub name: String,
    pub asset_hash: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub opacity: u8,
    pub visible: bool,
    #[serde(default)]
    pub blend: ImageLayerBlend,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageLayerBlend {
    #[default]
    Normal,
    /// A revision of an already-composited rectangle, including its alpha.
    Replace,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageLayersSnapshot {
    pub node_id: String,
    pub visual_hash: String,
    pub persisted: bool,
    pub stack: ImageLayerStack,
}

impl ImageLayer {
    pub fn at(id: String, name: String, asset_hash: String, rect: (i32, i32, u32, u32)) -> Self {
        let (x, y, width, height) = rect;
        Self {
            id,
            name,
            asset_hash,
            x,
            y,
            width,
            height,
            opacity: 100,
            visible: true,
            blend: ImageLayerBlend::Normal,
        }
    }
}

pub fn standalone(format: &str) -> bool {
    matches!(format, "png" | "jpg" | "jpeg" | "webp")
}

fn valid_size(width: u32, height: u32) -> bool {
    (1..=8192).contains(&width)
        && (1..=8192).contains(&height)
        && u64::from(width) * u64::from(height) <= 32_000_000
}

impl ImageLayerStack {
    pub fn validate(&self) -> Result<(), HcdError> {
        if !valid_size(self.width, self.height) || self.layers.len() > MAX_LAYERS {
            return Err(HcdError::ResourceLimit("图层数量或画布尺寸超出上限".into()));
        }
        let mut ids = HashSet::new();
        let mut area = 0;
        for layer in &self.layers {
            if !ids.insert(&layer.id)
                || layer.id.is_empty()
                || layer.id.len() > 64
                || !layer
                    .id
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_'))
                || layer.name.trim().is_empty()
                || layer.name.chars().count() > 120
                || layer
                    .name
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '\u{fffe}' | '\u{ffff}'))
                || !crate::validate::valid_sha256(&layer.asset_hash)
                || !valid_size(layer.width, layer.height)
                || layer.opacity > 100
                || !(-32768..=32768).contains(&layer.x)
                || !(-32768..=32768).contains(&layer.y)
            {
                return Err(HcdError::InvalidPatch("图层属性无效".into()));
            }
            area += u64::from(layer.width) * u64::from(layer.height);
        }
        if area > MAX_LAYER_PIXELS {
            return Err(HcdError::ResourceLimit("图层像素总量超出上限".into()));
        }
        Ok(())
    }

    pub(crate) fn geometry(&self) -> ImageGeometry {
        ImageGeometry {
            x: 0.0,
            y: 0.0,
            width: f64::from(self.width) * 0.75,
            height: f64::from(self.height) * 0.75,
            unit: ImageGeometryUnit::Pt,
        }
    }

    pub(crate) fn encode(&self) -> Result<String, HcdError> {
        Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?))
    }
}

pub(crate) fn saved_stack(html: &str) -> Result<Option<ImageLayerStack>, HcdError> {
    let Some((_, attribute)) = html.split_once(&format!(" {ATTRIBUTE}=\"")) else {
        return Ok(None);
    };
    let (encoded, _) = attribute
        .split_once('"')
        .ok_or_else(|| invalid("图层数据缺少属性边界"))?;
    if encoded.len() > 64 * 1024 {
        return Err(invalid("图层数据超过大小上限"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| invalid("图层数据编码无效"))?;
    let stack: ImageLayerStack = serde_json::from_slice(&bytes)?;
    stack.validate()?;
    Ok(Some(stack))
}

fn read_document(
    bundle: &Bundle,
    revision: u64,
) -> Result<(String, crate::HtmlImageNode, Option<ImageLayerStack>), HcdError> {
    let head = bundle.manifest()?;
    if !standalone(&head.source.format) {
        return Err(HcdError::Unsupported("图层需要独立图片文档".into()));
    }
    let (manifest, _) = manifest_at_revision(bundle, &head, Some(revision))?;
    let page = bundle.read_index_page(&manifest, 0)?;
    let chunk = page.chunks.first().ok_or_else(|| invalid("缺少图片分块"))?;
    let html = bundle.read_chunk_verified(chunk)?;
    let nodes = extract_html_image_nodes(&html)?;
    let (node_id, node) = nodes
        .into_iter()
        .next()
        .ok_or_else(|| invalid("缺少合成图片节点"))?;
    Ok((node_id, node, saved_stack(&html)?))
}

pub fn saved_snapshot(
    bundle: &Bundle,
    revision: u64,
) -> Result<Option<ImageLayersSnapshot>, HcdError> {
    let (node_id, node, stack) = read_document(bundle, revision)?;
    Ok(stack.map(|stack| ImageLayersSnapshot {
        node_id,
        visual_hash: node.visual_hash,
        persisted: true,
        stack,
    }))
}

pub fn snapshot(
    bundle: &Bundle,
    revision: u64,
    size: (u32, u32),
) -> Result<ImageLayersSnapshot, HcdError> {
    let (node_id, node, stack) = read_document(bundle, revision)?;
    let persisted = stack.is_some();
    let (width, height) = size;
    let stack = match stack {
        Some(stack) if (stack.width, stack.height) == size => stack,
        Some(_) => return Err(invalid("图层画布尺寸与合成图不符")),
        None => ImageLayerStack {
            width,
            height,
            layers: vec![ImageLayer::at(
                "background".into(),
                "原图".into(),
                node.asset_hash.ok_or_else(|| invalid("缺少原图资源"))?,
                (0, 0, width, height),
            )],
        },
    };
    Ok(ImageLayersSnapshot {
        node_id,
        visual_hash: node.visual_hash,
        persisted,
        stack,
    })
}

fn invalid(message: &str) -> HcdError {
    HcdError::InvalidBundle(message.into())
}

fn read_raster(bundle: &Bundle, asset: &AssetDescriptor) -> Result<DynamicImage, HcdError> {
    let bytes = read_bytes_bounded(
        &bundle.resolve_href(&asset.href)?,
        MAX_IMAGE_BYTES as u64,
        "layer raster",
    )?;
    if bytes.len() as u64 != asset.byte_length || hash_bytes(&bytes) != asset.hash {
        return Err(invalid("图层图片资源校验失败"));
    }
    decode_raster(&bytes).map(|(image, _)| image)
}

pub fn thumbnail(bundle: &Bundle, revision: u64, hash: &str) -> Result<Vec<u8>, HcdError> {
    let assets = bundle.read_asset_index_for_revision(revision)?;
    let asset = assets
        .iter()
        .find(|asset| asset.hash == hash)
        .ok_or_else(|| HcdError::NotFound("图层图片资源".into()))?;
    png_bytes(&read_raster(bundle, asset)?.thumbnail(112, 112))
}

pub(crate) fn render(
    bundle: &Bundle,
    stack: &ImageLayerStack,
    assets: &HashMap<String, AssetDescriptor>,
) -> Result<Vec<u8>, HcdError> {
    let mut canvas = RgbaImage::new(stack.width, stack.height);
    let mut decoded_area = 0;
    for layer in stack
        .layers
        .iter()
        .filter(|layer| layer.visible && layer.opacity > 0)
    {
        let asset = assets
            .get(&layer.asset_hash)
            .ok_or_else(|| invalid("找不到图层图片资源"))?;
        let raster = read_raster(bundle, asset)?;
        decoded_area += u64::from(raster.width()) * u64::from(raster.height());
        if decoded_area > MAX_LAYER_PIXELS {
            return Err(HcdError::ResourceLimit("图层素材像素总量超出上限".into()));
        }
        let raster = raster.into_rgba8();
        let mut raster = if raster.dimensions() == (layer.width, layer.height) {
            raster
        } else {
            imageops::resize(
                &raster,
                layer.width,
                layer.height,
                imageops::FilterType::Triangle,
            )
        };
        match layer.blend {
            ImageLayerBlend::Normal => {
                if layer.opacity != 100 {
                    for pixel in raster.pixels_mut() {
                        pixel[3] =
                            ((u16::from(pixel[3]) * u16::from(layer.opacity) + 50) / 100) as u8;
                    }
                }
                imageops::overlay(&mut canvas, &raster, i64::from(layer.x), i64::from(layer.y));
            }
            ImageLayerBlend::Replace => replace_region(&mut canvas, &raster, layer),
        }
    }
    let pixels = png_bytes(&DynamicImage::ImageRgba8(canvas))?;
    if pixels.len() > MAX_IMAGE_BYTES {
        return Err(HcdError::ResourceLimit("合成图片超过 32 MiB".into()));
    }
    Ok(pixels)
}

fn replace_region(canvas: &mut RgbaImage, raster: &RgbaImage, layer: &ImageLayer) {
    let left = layer.x.max(0)..(layer.x + raster.width() as i32).min(canvas.width() as i32);
    let top = layer.y.max(0)..(layer.y + raster.height() as i32).min(canvas.height() as i32);
    for y in top {
        for x in left.clone() {
            let new = raster.get_pixel((x - layer.x) as u32, (y - layer.y) as u32);
            let old = canvas.get_pixel_mut(x as u32, y as u32);
            *old = if layer.opacity == 100 {
                *new
            } else {
                crossfade(*old, *new, u32::from(layer.opacity))
            };
        }
    }
}

fn crossfade(old: Rgba<u8>, new: Rgba<u8>, opacity: u32) -> Rgba<u8> {
    let old_alpha = u32::from(old[3]) * (100 - opacity);
    let new_alpha = u32::from(new[3]) * opacity;
    let alpha = old_alpha + new_alpha;
    if alpha == 0 {
        return Rgba([0, 0, 0, 0]);
    }
    let channel = |i| {
        ((u32::from(old[i]) * old_alpha + u32::from(new[i]) * new_alpha + alpha / 2) / alpha) as u8
    };
    Rgba([
        channel(0),
        channel(1),
        channel(2),
        ((alpha + 50) / 100) as u8,
    ])
}
