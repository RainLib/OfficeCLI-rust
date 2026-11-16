//! Shared positioned images. Payloads enter the revision asset index only at commit.
use crate::*;
use std::collections::HashMap;

pub(crate) struct Insertion {
    pub node_id: String,
    pub asset_hash: String,
    pub geometry: ImageGeometry,
    pub alt: String,
}

pub(crate) fn collect(patch: &PatchBatch) -> HashMap<String, Vec<Insertion>> {
    let mut output: HashMap<String, Vec<Insertion>> = HashMap::new();
    for (index, op) in patch.operations.iter().enumerate() {
        if let PatchOperation::ImageInsert {
            chunk_id,
            asset_hash,
            geometry,
            alt,
        } = op
        {
            output.entry(chunk_id.clone()).or_default().push(Insertion {
                node_id: stable_node_id(&[
                    &patch.document_id,
                    &patch.patch_id,
                    "image",
                    &index.to_string(),
                ]),
                asset_hash: asset_hash.clone(),
                geometry: geometry.clone(),
                alt: alt.clone(),
            });
        }
    }
    output
}

pub(crate) fn insert(
    html: &mut String,
    map: &mut ChunkSourceMap,
    descriptor: &ChunkDescriptor,
    format: &str,
    insertion: &Insertion,
    asset: &AssetDescriptor,
) -> Result<String, HcdError> {
    let g = &insertion.geometry;
    let fixed = matches!(format, "pptx" | "pdf" | "xlsx");
    let scale = if g.unit == ImageGeometryUnit::Emu {
        96.0 / 914400.0
    } else {
        96.0 / 72.0
    };
    let attr = |key: &str| {
        html.split_once(&format!("{key}=\""))
            .and_then(|(_, s)| s.split_once('"'))
            .and_then(|(s, _)| s.parse::<f64>().ok())
    };
    if format == "pptx"
        && (attr("data-hcd-width-emu").is_none_or(|w| g.x + g.width > w + 0.01)
            || attr("data-hcd-height-emu").is_none_or(|h| g.y + g.height > h + 0.01))
    {
        return Err(HcdError::InvalidPatch(
            "image rectangle is outside its slide".into(),
        ));
    }
    let part = map
        .entries
        .first()
        .map(|entry| entry.source.part.clone())
        .or_else(|| {
            descriptor
                .grid
                .as_ref()
                .and_then(|grid| grid.sheet_part.clone())
        })
        .or_else(|| {
            html.split_once("data-hcd-source-part=\"")
                .and_then(|(_, s)| s.split_once('"'))
                .map(|(s, _)| s.to_string())
        })
        .or_else(|| match format {
            "pdf" => Some(format!("pdf/pages/{}", descriptor.sequence + 1)),
            "md" => Some("markdown/document".into()),
            "html" => Some("html/document".into()),
            "docx" => Some("word/document.xml".into()),
            _ => None,
        })
        .ok_or_else(|| HcdError::InvalidBundle("image target has no source part".into()))?;
    let node_hash = hash_bytes(b"");
    let visual_hash = image_visual_hash(Some(&asset.hash), Some(g));
    let escape = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let position = if fixed {
        format!(
            "position:absolute;left:{}px;top:{}px;",
            g.x * scale,
            g.y * scale
        )
    } else {
        "position:relative;max-width:100%;".into()
    };
    let unit = if g.unit == ImageGeometryUnit::Emu {
        "emu"
    } else {
        "pt"
    };
    let extra = if format == "xlsx" {
        format!(" data-hcd-anchor-kind=\"absolute\" data-hcd-absolute-x-emu=\"{}\" data-hcd-absolute-y-emu=\"{}\" data-hcd-extent-width-emu=\"{}\" data-hcd-extent-height-emu=\"{}\" data-hcd-width-emu=\"{}\" data-hcd-height-emu=\"{}\"",g.x,g.y,g.width,g.height,g.width,g.height)
    } else if !fixed {
        " data-hcd-image-flow=\"true\"".into()
    } else {
        String::new()
    };
    let class = if format == "xlsx" {
        "hcd-generated-image hcd-sheet-picture"
    } else {
        "hcd-generated-image"
    };
    let figure = format!("<figure class=\"{class}\"{extra} data-hcd-id=\"{}\" data-hcd-node-hash=\"{node_hash}\" data-hcd-visual-hash=\"{visual_hash}\" data-hcd-asset-hash=\"{}\" data-hcd-node-kind=\"image\" data-hcd-created-image=\"true\" data-hcd-x=\"{}\" data-hcd-y=\"{}\" data-hcd-width=\"{}\" data-hcd-height=\"{}\" data-hcd-geometry-unit=\"{unit}\" style=\"{position}width:{}px;height:{}px;margin:0;overflow:hidden\"><img data-hcd-asset-href=\"asset://sha256/{hash}\" src=\"asset://sha256/{}\" alt=\"{}\" style=\"display:block;width:100%;height:100%;object-fit:fill\" /></figure>",insertion.node_id,asset.hash,g.x,g.y,g.width,g.height,g.width*scale,g.height*scale,asset.hash,escape(&insertion.alt),hash=asset.hash);
    let end = html
        .rfind("</section>")
        .or_else(|| html.rfind("</div>"))
        .unwrap_or(html.len());
    html.insert_str(end, &figure);
    let ordinal = map
        .entries
        .iter()
        .map(|entry| entry.source.text_ordinal)
        .max()
        .unwrap_or(0)
        + 1;
    map.entries.push(NodeMapEntry {
        node_id: insertion.node_id.clone(),
        node_hash,
        source: SourceAnchor {
            part,
            text_ordinal: ordinal,
            paragraph_id: None,
            text_id: Some(format!("hcd:image:{}", insertion.node_id)),
            node_kind: "image".into(),
            editable: true,
            created_in_hcd: true,
            source_cell_ref: None,
        },
    });
    Ok(insertion.node_id.clone())
}
