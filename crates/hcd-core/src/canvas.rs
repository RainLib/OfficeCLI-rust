//! Canvas scenes are immutable, revision-indexed HCD assets. HTML is a derived
//! preview; only canvas transactions may change the authoritative scene.
mod storage;
pub use canvas_core::{Batch, CanvasError, Operation, Region, Scene, Selection, PROTOCOL};
pub use storage::{
    apply_batch, apply_batch_with_rewrite, read_scene, rewrite_inverse, store_initial_scene,
};

pub fn node_id(document_id: &str, element_id: &str) -> String {
    crate::stable_node_id(&[document_id, "canvas", element_id])
}
pub fn chunk_id(document_id: &str) -> String {
    node_id(document_id, "preview").replacen("n_", "c_", 1)
}

pub fn error(error: CanvasError) -> crate::HcdError {
    match error {
        CanvasError::Conflict(message) => crate::HcdError::PreconditionFailed(message),
        CanvasError::Limit(message) => crate::HcdError::ResourceLimit(message),
        other => crate::HcdError::InvalidPatch(other.to_string()),
    }
}

/// The generated HTML intentionally declares its preview nature. Native scene
/// export retains freehand pressure, bindings, groups and renderer properties.
pub fn preview_html(scene: &Scene) -> String {
    let mut html = String::from("<section class=\"hcd-canvas-preview\"><h1>自由画布</h1><p>在画布编辑器中查看和编辑完整布局。</p>");
    for element in scene.elements.iter().filter(|e| e["isDeleted"] != true) {
        if let Some(text) = element["text"].as_str() {
            html.push_str("<p>");
            html.push_str(&crate::html::escape_text(text));
            html.push_str("</p>");
        }
    }
    html.push_str("</section>");
    html
}
