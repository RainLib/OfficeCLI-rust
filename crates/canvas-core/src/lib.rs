//! Renderer-independent canvas transactions. Native Excalidraw records stay
//! intact; transports, credentials and persistence belong to the host.
mod composition;
mod diagram;
mod diagram_layout;
mod diagram_routing;
mod journal;
pub mod materials;
mod model;
pub mod spec;
mod transaction;
mod validation;

pub use composition::{
    compose, compose_sections, composition_schema, structured_composition_schema, Composition,
    Item, ItemKind, Layout,
};
pub use diagram::{Diagram, DiagramEdge, DiagramGroup, DiagramNode, EdgeKind, NodeKind};
pub use journal::{
    Brush, Motif, Motion, Palette, Paper, Sticker, StickerPosition, VisualPlan, VisualStyle,
};
pub use model::*;
pub use transaction::{apply, apply_with_base, apply_with_receipt, element_hash, scene_hash};
pub use validation::validate_scene;

pub const PROTOCOL: &str = "officecli-canvas/1";
pub const SCHEMA_JSON: &str = include_str!("../schema.json");
pub const MAX_ELEMENTS: usize = 20_000;
pub const MAX_SCENE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_OPERATIONS: usize = 2_000;

#[derive(Debug, thiserror::Error)]
pub enum CanvasError {
    #[error("invalid canvas: {0}")]
    Invalid(String),
    #[error("canvas conflict: {0}")]
    Conflict(String),
    #[error("canvas limit: {0}")]
    Limit(String),
    #[error("canvas JSON: {0}")]
    Json(#[from] serde_json::Error),
}
