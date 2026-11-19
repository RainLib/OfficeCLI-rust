//! Presentation shape, run and slide mutations.
use super::*;

#[derive(Clone)]
pub(super) struct PptxTextInsertion {
    pub(super) node_id: String,
    pub(super) slide_part: String,
    pub(super) x_emu: u64,
    pub(super) y_emu: u64,
    pub(super) width_emu: u64,
    pub(super) height_emu: u64,
    pub(super) font_size_hundredths: u32,
    pub(super) text: String,
}

#[derive(Clone)]
pub(super) struct PptxGeometryChange {
    pub(super) geometry: PptxShapeGeometry,
    pub(super) expected: PptxShapeGeometry,
    pub(super) node_hash: String,
}

/// Slide a patch asks to append: the part its page will need in the package and
/// the slide size HCD already draws its pages at, taken from a page the bundle
/// has rather than from the source package, which the patch never reads.
#[derive(Clone)]
pub(super) struct PptxSlideAddTarget {
    pub(super) slide_part: String,
    pub(super) width_emu: u64,
    pub(super) height_emu: u64,
}

/// Slide a patch asks to drop: the page it names, and the part that page points
/// at, read off the section the bundle already holds rather than the source
/// package the patch never opens.
#[derive(Clone)]
pub(super) struct PptxSlideRemovalTarget {
    pub(super) chunk_id: String,
    pub(super) slide_part: String,
    /// Every chunk that section repeats: a slide whose table is split across
    /// chunks has more than one, and all of them leave with the page.
    pub(super) dropped_chunk_ids: HashSet<String>,
}

/// Slide a patch asks to move, and the page it passes on the way. Both travel
/// as the chunks they hold, because a page that spans chunks is still one page:
/// the run those chunks form is what changes place.
#[derive(Clone)]
pub(super) struct PptxSlideMoveTarget {
    /// Legacy adjacent move; empty for an absolute target position.
    pub(super) direction: String,
    pub(super) target_index: Option<usize>,
    pub(super) chunk_id: String,
    pub(super) slide_part: String,
    pub(super) moving_chunk_ids: Vec<String>,
    pub(super) passed_chunk_ids: Vec<String>,
}

/// Slide a patch asks to duplicate, named by one of the chunks that hold it. The
/// copy is a page of its own, standing right behind the page it came from, under
/// a part the source package does not carry yet — which is what the revision
/// records, and what the export has to write.
#[derive(Clone)]
pub(super) struct PptxSlideCopyTarget {
    pub(super) chunk_id: String,
    /// Part the page the patch named holds today.
    pub(super) slide_part: String,
    /// Part the copy will stand in.
    pub(super) new_slide_part: String,
    /// Every chunk of the page, in the order the index holds them: a page whose
    /// table reaches over several chunks is copied chunk for chunk.
    pub(super) page_chunk_ids: Vec<String>,
}

/// One page as the index holds it: the part its section names, and every chunk
/// that repeats that section, in the order they stand.
pub(super) struct PptxIndexSlidePage {
    pub(super) slide_part: String,
    pub(super) chunks: Vec<String>,
}

pub(super) fn collect_pptx_insertions(
    patch: &PatchBatch,
) -> HashMap<String, Vec<PptxTextInsertion>> {
    let mut grouped: HashMap<String, Vec<PptxTextInsertion>> = HashMap::new();
    for (index, operation) in patch.operations.iter().enumerate() {
        let PatchOperation::PptxTextInsert {
            chunk_id,
            slide_part,
            x_emu,
            y_emu,
            width_emu,
            height_emu,
            font_size_pt,
            text,
        } = operation
        else {
            continue;
        };
        grouped
            .entry(chunk_id.clone())
            .or_default()
            .push(PptxTextInsertion {
                node_id: stable_node_id(&[
                    &patch.document_id,
                    &patch.patch_id,
                    &index.to_string(),
                    "pptx-text-insert",
                ]),
                slide_part: slide_part.clone(),
                x_emu: *x_emu,
                y_emu: *y_emu,
                width_emu: *width_emu,
                height_emu: *height_emu,
                font_size_hundredths: (*font_size_pt * 100.0).round() as u32,
                text: text.clone(),
            });
    }
    grouped
}

pub(super) fn collect_pptx_geometry(patch: &PatchBatch) -> HashMap<String, PptxGeometryChange> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::PptxShapeGeometry {
                node_id,
                geometry,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                PptxGeometryChange {
                    geometry: *geometry,
                    expected: precondition.geometry,
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

#[derive(Clone)]
pub(super) struct PptxFormatChange {
    pub(super) format: PptxRunFormat,
    pub(super) node_hash: String,
}

pub(super) fn collect_pptx_formats(patch: &PatchBatch) -> HashMap<String, PptxFormatChange> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::PptxRunFormat {
                node_id,
                format,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                PptxFormatChange {
                    format: format.clone(),
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

#[derive(Clone)]
pub(super) struct PptxAlignChange {
    pub(super) align: PptxShapeAlignPatch,
    pub(super) node_hash: String,
}

pub(super) fn collect_pptx_aligns(patch: &PatchBatch) -> HashMap<String, PptxAlignChange> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::PptxShapeAlign {
                node_id,
                align,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                PptxAlignChange {
                    align: align.clone(),
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

pub(super) fn validate_pptx_run_format(format: &PptxRunFormat) -> Result<(), HcdError> {
    if format.bold.is_none()
        && format.italic.is_none()
        && format.underline.is_none()
        && format.font_size_pt.is_none()
        && format.color.is_none()
    {
        return Err(HcdError::InvalidPatch(
            "PPTX run format must set bold, italic, underline, font size, or color".to_string(),
        ));
    }
    if let Some(size) = format.font_size_pt {
        if !size.is_finite() || !(1.0..=256.0).contains(&size) {
            return Err(HcdError::InvalidPatch(
                "PPTX font size must be from 1 to 256 points".to_string(),
            ));
        }
    }
    if let Some(color) = &format.color {
        validate_hex_color("color", color)?;
    }
    Ok(())
}

pub(super) fn validate_pptx_shape_align(align: &PptxShapeAlignPatch) -> Result<(), HcdError> {
    if align.horizontal.is_none() && align.vertical.is_none() {
        return Err(HcdError::InvalidPatch(
            "PPTX shape alignment must set a horizontal or a vertical value".to_string(),
        ));
    }
    if let Some(value) = &align.horizontal {
        if !matches!(
            value.as_str(),
            "left" | "center" | "right" | "justify" | "distributed"
        ) {
            return Err(HcdError::InvalidPatch(
                "PPTX horizontal alignment must be left, center, right, justify, or distributed"
                    .to_string(),
            ));
        }
    }
    if let Some(value) = &align.vertical {
        if !matches!(value.as_str(), "top" | "center" | "bottom") {
            return Err(HcdError::InvalidPatch(
                "PPTX vertical alignment must be top, center, or bottom".to_string(),
            ));
        }
    }
    Ok(())
}

pub(super) fn collect_pptx_deletions(patch: &PatchBatch) -> HashMap<String, String> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::PptxTextDelete {
                node_id,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((node_id.clone(), precondition.node_hash.clone()))
        })
        .collect()
}

pub(super) fn valid_pptx_geometry(geometry: PptxShapeGeometry) -> bool {
    geometry.x_emu <= 100_000_000
        && geometry.y_emu <= 100_000_000
        && (1..=100_000_000).contains(&geometry.width_emu)
        && (1..=100_000_000).contains(&geometry.height_emu)
}

/// Whether this patch appends a slide. The operation carries no fields: the new
/// page lands after the last one the bundle has, the same way a new worksheet
/// tab lands after the last tab.
pub(super) fn collect_pptx_slide_add(patch: &PatchBatch) -> bool {
    patch
        .operations
        .iter()
        .any(|operation| matches!(operation, PatchOperation::PptxSlideAdd {}))
}

/// Trailing number of a slide part such as `ppt/slides/slide12.xml`.
pub(super) fn slide_part_number(part: &str) -> Option<usize> {
    let stem = part.rsplit('/').next()?.strip_suffix(".xml")?;
    stem.strip_prefix("slide")?.parse().ok()
}

/// Work out where a new page lands: the slide part it will need in the package,
/// and the page size every other page already draws at. A patch never reads the
/// source package, so both come from the chunks the bundle holds. A part name is
/// only free for as long as the bundle can see it, and the package rewrite
/// refuses to shadow a name the source archive already carries.
pub(super) fn resolve_pptx_slide_add(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
) -> Result<PptxSlideAddTarget, HcdError> {
    let mut known_parts: HashSet<String> = HashSet::new();
    let mut highest_number: usize = 0;
    let mut size: Option<(u64, u64)> = None;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            if descriptor.region != "slide" {
                continue;
            }
            let (part, width_emu, height_emu) = pptx_slide_page(&bundle.read_chunk(&descriptor)?)?;
            if known_parts.insert(part.clone()) {
                highest_number = highest_number.max(slide_part_number(&part).unwrap_or_default());
            }
            let page_size = (width_emu, height_emu);
            if let Some(seen) = size.filter(|seen| *seen != page_size) {
                return Err(HcdError::Unsupported(format!(
                    "PPTX slides disagree on the page size ({}x{} and {}x{})",
                    seen.0, seen.1, page_size.0, page_size.1
                )));
            }
            size = Some(page_size);
        }
    }
    // A page the source deck carried can leave the index through a deletion, and
    // the name it held then looks free to hand out again. The package does not
    // agree: it still carries that part until the export drops it, and a page
    // named after one the history already used would ask the export to both write
    // and delete the same entry. So a number the history spent is spent.
    for revision in 1..=manifest.revision {
        for removal in &bundle.revision(revision)?.slide_removals {
            highest_number =
                highest_number.max(slide_part_number(&removal.slide_part).unwrap_or_default());
        }
    }
    let Some((width_emu, height_emu)) = size else {
        return Err(HcdError::Unsupported(
            "hcd-patch/41 needs a presentation with at least one slide".to_string(),
        ));
    };
    if !(1..=100_000_000).contains(&width_emu) || !(1..=100_000_000).contains(&height_emu) {
        return Err(HcdError::InvalidBundle(
            "PPTX slide page size is out of bounds".to_string(),
        ));
    }
    Ok(PptxSlideAddTarget {
        slide_part: format!(
            "ppt/slides/slide{}.xml",
            highest_number.max(known_parts.len()) + 1
        ),
        width_emu,
        height_emu,
    })
}

/// What a slide page chunk says about itself: the source part it was imported
/// from and the page size the deck draws at. Reading it off the section the
/// bundle already holds is what lets a slide operation work without opening the
/// source package, which a patch never does.
pub(super) fn pptx_slide_page(html: &str) -> Result<(String, u64, u64), HcdError> {
    let tag_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("PPTX slide section is not closed".to_string()))?;
    let tag = &html[..=tag_end];
    if !tag.starts_with("<section class=\"hcd-slide\"") {
        return Err(HcdError::InvalidBundle(
            "PPTX slide chunk is not a slide section".to_string(),
        ));
    }
    let part = xlsx_attribute(tag, "data-hcd-source-part")
        .map(unescape_attribute)
        .ok_or_else(|| {
            HcdError::InvalidBundle("PPTX slide chunk does not name its source part".to_string())
        })?;
    let dimension = |name: &str| -> Result<u64, HcdError> {
        xlsx_attribute(tag, name)
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| HcdError::InvalidBundle(format!("PPTX slide {name} is missing")))
    };
    Ok((
        part,
        dimension("data-hcd-width-emu")?,
        dimension("data-hcd-height-emu")?,
    ))
}

/// Slide a patch asks to drop, named by the page chunk it addresses.
pub(super) fn collect_pptx_slide_removal(patch: &PatchBatch) -> Option<PptxSlideRemovalTarget> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::PptxSlideDelete { chunk_id } = operation else {
            return None;
        };
        Some(PptxSlideRemovalTarget {
            chunk_id: chunk_id.clone(),
            slide_part: String::new(),
            dropped_chunk_ids: HashSet::new(),
        })
    })
}

/// Turn the page a deletion names into the part the package loses, and into every
/// chunk that leaves with it. Two bounds come from the file format rather than
/// from HCD: the page has to be there to drop, and a presentation with no slides
/// is not something PowerPoint opens, so the last page survives.
pub(super) fn resolve_pptx_slide_removal(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    removal: &PptxSlideRemovalTarget,
) -> Result<PptxSlideRemovalTarget, HcdError> {
    let mut pages: HashSet<String> = HashSet::new();
    let mut slide_part: Option<String> = None;
    let mut carriers: Vec<(String, String)> = Vec::new();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            if descriptor.region != "slide" {
                continue;
            }
            let (part, _, _) = pptx_slide_page(&bundle.read_chunk(&descriptor)?)?;
            pages.insert(part.clone());
            if descriptor.chunk_id == removal.chunk_id {
                slide_part = Some(part.clone());
            }
            carriers.push((descriptor.chunk_id, part));
        }
    }
    let Some(slide_part) = slide_part else {
        return Err(HcdError::Unsupported(
            "PPTX slide chunk is not in the HCD index".to_string(),
        ));
    };
    if pages.len() < 2 {
        return Err(HcdError::InvalidPatch(
            "PPTX presentation must keep one slide".to_string(),
        ));
    }
    // A page that spans chunks repeats its section in every one of them, so the
    // whole page leaves whichever chunk the patch named: the chunks in front of
    // that one go with the ones behind it.
    let dropped_chunk_ids: HashSet<String> = carriers
        .into_iter()
        .filter(|(_, part)| *part == slide_part)
        .map(|(chunk_id, _)| chunk_id)
        .collect();
    Ok(PptxSlideRemovalTarget {
        chunk_id: removal.chunk_id.clone(),
        slide_part,
        dropped_chunk_ids,
    })
}

/// The deck's pages in the order the index holds them. A page that reaches over
/// more than one chunk repeats its section in every one of them, so the chunks
/// of a page are gathered together here rather than guessed from its first one.
pub(super) fn pptx_index_slide_pages(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
) -> Result<Vec<PptxIndexSlidePage>, HcdError> {
    let mut pages: Vec<PptxIndexSlidePage> = Vec::new();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            if descriptor.region != "slide" {
                continue;
            }
            let (part, _, _) = pptx_slide_page(&bundle.read_chunk(&descriptor)?)?;
            match pages.last_mut() {
                Some(page) if page.slide_part == part => page.chunks.push(descriptor.chunk_id),
                _ => pages.push(PptxIndexSlidePage {
                    slide_part: part,
                    chunks: vec![descriptor.chunk_id],
                }),
            }
        }
    }
    Ok(pages)
}

/// The operation asking one page to move, if the patch carries one.
pub(super) fn collect_pptx_slide_reorder(patch: &PatchBatch) -> Option<PptxSlideMoveTarget> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::PptxSlideReorder {
            chunk_id,
            direction,
            target_index,
        } = operation
        else {
            return None;
        };
        Some(PptxSlideMoveTarget {
            direction: direction.clone(),
            target_index: *target_index,
            chunk_id: chunk_id.clone(),
            slide_part: String::new(),
            moving_chunk_ids: Vec::new(),
            passed_chunk_ids: Vec::new(),
        })
    })
}

/// Work out which page a move shifts and which one it passes. The bounds come
/// from what a move means: a deck of one page has nothing to swap with, and a
/// page at either end has no neighbour on the side the patch asked for. Which
/// chunk of a split page the patch names does not matter, because the page moves
/// as a whole either way.
pub(super) fn resolve_pptx_slide_reorder(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    request: &PptxSlideMoveTarget,
) -> Result<PptxSlideMoveTarget, HcdError> {
    let pages = pptx_index_slide_pages(bundle, manifest)?;
    let Some(placed) = pages
        .iter()
        .position(|page| page.chunks.contains(&request.chunk_id))
    else {
        return Err(HcdError::Unsupported(
            "PPTX slide chunk is not in the HCD index".to_string(),
        ));
    };
    if pages.len() < 2 {
        return Err(HcdError::InvalidPatch(
            "PPTX presentation must hold two slides to move one".to_string(),
        ));
    }
    let target = if let Some(target) = request.target_index {
        if target >= pages.len() || target == placed {
            return Err(HcdError::InvalidPatch(
                "PPTX targetIndex must name a different slide position".into(),
            ));
        }
        Some(target)
    } else if request.direction == "up" {
        placed.checked_sub(1)
    } else {
        placed.checked_add(1).filter(|next| *next < pages.len())
    };
    let Some(target) = target else {
        let end = if request.direction == "up" {
            "first"
        } else {
            "last"
        };
        return Err(HcdError::InvalidPatch(format!(
            "PPTX slide {} cannot move {}: it is already the {end} page",
            pages[placed].slide_part, request.direction
        )));
    };
    Ok(PptxSlideMoveTarget {
        direction: request.direction.clone(),
        target_index: request.target_index,
        chunk_id: request.chunk_id.clone(),
        slide_part: pages[placed].slide_part.clone(),
        moving_chunk_ids: pages[placed].chunks.clone(),
        passed_chunk_ids: if target < placed {
            pages[target..placed]
                .iter()
                .flat_map(|page| page.chunks.clone())
                .collect()
        } else {
            pages[placed + 1..=target]
                .iter()
                .flat_map(|page| page.chunks.clone())
                .collect()
        },
    })
}

/// Exchanges the two runs of chunks a move names. A page's chunks are one run,
/// so a page that spans chunks moves whole, and the two runs do not have to be
/// the same length: the shorter page takes the place the longer one leaves and
/// everything between them shifts to match. Chunks that belong to neither page
/// keep their order, and the caller numbers the list again from the front.
pub(super) fn swap_pptx_slide_pages(
    descriptors: &[crate::ChunkDescriptor],
    moving_chunk_ids: &[String],
    passed_chunk_ids: &[String],
) -> Result<Vec<crate::ChunkDescriptor>, HcdError> {
    let run = |wanted: &[String]| -> Result<(usize, usize), HcdError> {
        let Some(start) = wanted
            .first()
            .and_then(|first| descriptors.iter().position(|d| &d.chunk_id == first))
        else {
            return Err(HcdError::InvalidBundle(
                "PPTX slide reorder target disappeared from the index".to_string(),
            ));
        };
        let mut end = start;
        while end < descriptors.len() && wanted.iter().any(|id| *id == descriptors[end].chunk_id) {
            end += 1;
        }
        // A page's chunks stand together, so a run shorter than the page means
        // the index changed shape between resolving the patch and rebuilding it.
        if end - start != wanted.len() {
            return Err(HcdError::InvalidBundle(
                "PPTX slide reorder names chunks that are not one page".to_string(),
            ));
        }
        Ok((start, end))
    };
    let moving = run(moving_chunk_ids)?;
    let passed = run(passed_chunk_ids)?;
    let (first, second) = if moving.0 < passed.0 {
        (moving, passed)
    } else {
        (passed, moving)
    };
    // The two pages trade places and the list keeps its length: the slices below
    // are the front of the list, the page that got passed, whatever stood between
    // the two, the page that moved, and the back of the list.
    let mut output = Vec::with_capacity(descriptors.len());
    output.extend_from_slice(&descriptors[..first.0]);
    output.extend_from_slice(&descriptors[second.0..second.1]);
    output.extend_from_slice(&descriptors[first.1..second.0]);
    output.extend_from_slice(&descriptors[first.0..first.1]);
    output.extend_from_slice(&descriptors[second.1..]);
    Ok(output)
}

/// The operation asking one page to be copied, if the patch carries one.
pub(super) fn collect_pptx_slide_copy(patch: &PatchBatch) -> Option<PptxSlideCopyTarget> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::PptxSlideCopy { chunk_id } = operation else {
            return None;
        };
        Some(PptxSlideCopyTarget {
            chunk_id: chunk_id.clone(),
            slide_part: String::new(),
            new_slide_part: String::new(),
            page_chunk_ids: Vec::new(),
        })
    })
}

/// Work out which page a copy duplicates, which chunks go with it, and which
/// part the copy will stand in. The part is named the way a new page names its
/// own: from the numbers the index holds and the numbers this history has
/// already spent, so two pages never ask the package for the same name.
///
/// Two bounds come from how the copy is written rather than from HCD's liking.
/// The export builds the copy out of the source package's page, so a page HCD
/// created has nothing to build from, and a page HCD rewrote would copy the
/// words the source still holds instead of the ones the bundle shows. Both are
/// refused rather than quietly answered with a different page.
pub(super) fn resolve_pptx_slide_copy(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    request: &PptxSlideCopyTarget,
) -> Result<PptxSlideCopyTarget, HcdError> {
    let pages = pptx_index_slide_pages(bundle, manifest)?;
    let Some(placed) = pages
        .iter()
        .position(|page| page.chunks.contains(&request.chunk_id))
    else {
        return Err(HcdError::Unsupported(
            "PPTX slide chunk is not in the HCD index".to_string(),
        ));
    };
    let slide_part = pages[placed].slide_part.clone();
    let mut highest_number: usize = 0;
    let mut known_parts: HashSet<String> = HashSet::new();
    for page in &pages {
        if known_parts.insert(page.slide_part.clone()) {
            highest_number =
                highest_number.max(slide_part_number(&page.slide_part).unwrap_or_default());
        }
    }
    let mut created_in_hcd = false;
    let mut rewritten_at: Option<u64> = None;
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        for addition in &record.slide_additions {
            highest_number =
                highest_number.max(slide_part_number(&addition.slide_part).unwrap_or_default());
            created_in_hcd |= addition.slide_part == slide_part;
        }
        for copied in &record.slide_copies {
            highest_number =
                highest_number.max(slide_part_number(&copied.slide_part).unwrap_or_default());
            created_in_hcd |= copied.slide_part == slide_part;
        }
        for removal in &record.slide_removals {
            highest_number =
                highest_number.max(slide_part_number(&removal.slide_part).unwrap_or_default());
        }
        if record.dirty_source_parts.contains(&slide_part) {
            rewritten_at = Some(revision);
        }
    }
    if created_in_hcd {
        return Err(HcdError::InvalidPatch(format!(
            "hcd-patch/44 cannot copy {slide_part}: that page was created in HCD, and a copy is written from the page the source package holds"
        )));
    }
    if let Some(revision) = rewritten_at {
        return Err(HcdError::InvalidPatch(format!(
            "hcd-patch/44 cannot copy {slide_part} yet: revision {revision} rewrote that page in HCD, and a copy is written from the page the source package holds"
        )));
    }
    Ok(PptxSlideCopyTarget {
        chunk_id: request.chunk_id.clone(),
        new_slide_part: format!(
            "ppt/slides/slide{}.xml",
            highest_number.max(known_parts.len()) + 1
        ),
        slide_part,
        page_chunk_ids: pages[placed].chunks.clone(),
    })
}

/// A node id is `n_` and the 32 lowercase hex characters a digest is written as.
pub(super) const PPTX_NODE_ID_LEN: usize = 34;

/// The id a node of the copy takes, named by the node it was copied from and by
/// the part the copy stands in. Copying one page into the same place again —
/// after an undo, say — gives its nodes the same ids back, and no copy shares an
/// id with the page it came from or with another copy of it.
pub(super) fn pptx_copied_node_id(document_id: &str, new_part: &str, node_id: &str) -> String {
    stable_node_id(&[document_id, new_part, "slide-copy-node", node_id])
}

/// Rewrites the node ids a slide chunk addresses. Only what stands between a
/// pair of double quotes is touched: generated HTML escapes every quote a text
/// node holds, so a quoted run is an attribute value and never a word of the
/// page. The copy therefore shows exactly the words the original shows.
pub(super) fn rewrite_pptx_copied_ids(html: &str, document_id: &str, new_part: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(open) = rest.find('"') {
        output.push_str(&rest[..=open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('"') else {
            output.push_str(after);
            return output;
        };
        output.push_str(&replace_pptx_copied_ids(
            &after[..close],
            document_id,
            new_part,
        ));
        output.push('"');
        rest = &after[close + 1..];
    }
    output.push_str(rest);
    output
}

/// Replaces every node id one attribute value names, in the order they appear,
/// writing each replacement straight to the output so a value that holds more
/// than one id — a table fragment names two — is rewritten once per id.
pub(super) fn replace_pptx_copied_ids(value: &str, document_id: &str, new_part: &str) -> String {
    if !value.contains("n_") {
        return value.to_string();
    }
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find("n_") {
        output.push_str(&rest[..at]);
        let candidate = &rest[at..];
        let bytes = candidate.as_bytes();
        // Only a whole id is an id: a run that is shorter, holds a character no
        // digest is written with, or runs on past 32 hex characters is text.
        let complete = bytes.len() >= PPTX_NODE_ID_LEN
            && bytes[2..PPTX_NODE_ID_LEN]
                .iter()
                .all(|byte| is_node_id_hex(*byte))
            && !bytes
                .get(PPTX_NODE_ID_LEN)
                .is_some_and(|next| is_node_id_hex(*next));
        if complete {
            output.push_str(&pptx_copied_node_id(
                document_id,
                new_part,
                &candidate[..PPTX_NODE_ID_LEN],
            ));
            rest = &candidate[PPTX_NODE_ID_LEN..];
        } else {
            output.push_str("n_");
            rest = &candidate[2..];
        }
    }
    output.push_str(rest);
    output
}

/// The chunks a copy is made of, written the way the importer writes a page: the
/// same HTML and the same map, with the part renamed and every node given an id
/// of the copy's own. A page whose table reaches over several chunks is copied
/// chunk for chunk, so the copy reaches over the same run.
pub(super) fn clone_pptx_slide_chunks(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    copy: &PptxSlideCopyTarget,
    descriptors: &[crate::ChunkDescriptor],
) -> Result<Vec<crate::ChunkDescriptor>, HcdError> {
    let mut cloned = Vec::with_capacity(copy.page_chunk_ids.len());
    for (ordinal, chunk_id) in copy.page_chunk_ids.iter().enumerate() {
        let source = descriptors
            .iter()
            .find(|descriptor| descriptor.chunk_id == *chunk_id)
            .ok_or_else(|| {
                HcdError::InvalidBundle(
                    "PPTX slide copy target disappeared from the index".to_string(),
                )
            })?;
        let html = bundle.read_chunk(source)?;
        let source_map = bundle.read_map(source)?;
        // Every element of the page that names the part it was read from — the
        // section, a picture, a chart — names the copy's part from now on.
        let html = html.replace(
            &format!(
                "data-hcd-source-part=\"{}\"",
                escape_attribute(&copy.slide_part)
            ),
            &format!(
                "data-hcd-source-part=\"{}\"",
                escape_attribute(&copy.new_slide_part)
            ),
        );
        let html = rewrite_pptx_copied_ids(&html, &manifest.document_id, &copy.new_slide_part);
        let entries: Vec<crate::NodeMapEntry> = source_map
            .entries
            .iter()
            .map(|entry| crate::NodeMapEntry {
                node_id: pptx_copied_node_id(
                    &manifest.document_id,
                    &copy.new_slide_part,
                    &entry.node_id,
                ),
                node_hash: entry.node_hash.clone(),
                source: crate::SourceAnchor {
                    part: copy.new_slide_part.clone(),
                    ..entry.source.clone()
                },
            })
            .collect();
        let chunk_id = stable_node_id(&[
            &manifest.document_id,
            &copy.new_slide_part,
            "slide-chunk",
            &ordinal.to_string(),
        ])
        .replacen("n_", "c_", 1);
        let copied_map = crate::ChunkSourceMap {
            schema_version: manifest.schema_version.clone(),
            chunk_id: chunk_id.clone(),
            entries,
        };
        let (html_href, html_hash) = bundle.write_chunk_object(&html)?;
        let (map_href, map_hash) = bundle.write_json_object("maps", &copied_map)?;
        cloned.push(crate::ChunkDescriptor {
            sequence: 0,
            chunk_id,
            region: "slide".to_string(),
            html_href,
            html_hash,
            map_href,
            map_hash,
            byte_length: html.len() as u64,
            // The copy holds the same blocks and the same words as the page it
            // came from; only the names it answers to are new.
            block_count: source.block_count,
            node_count: copied_map.entries.len(),
            text_chars: source.text_chars,
            node_bloom: node_bloom(
                copied_map
                    .entries
                    .iter()
                    .map(|entry| entry.node_id.as_str()),
            ),
            first_node_id: copied_map
                .entries
                .first()
                .map(|entry| entry.node_id.clone()),
            last_node_id: copied_map.entries.last().map(|entry| entry.node_id.clone()),
            continuation: source.continuation,
            grid: None,
        });
    }
    Ok(cloned)
}

/// The placeholder the importer writes for a slide that has no shapes at all.
/// A slide HCD created starts as one of those, and loses the marker as soon as
/// it carries its first text box.
pub(super) const PPTX_EMPTY_SLIDE_MARK: &str = "<div class=\"hcd-empty-slide\"></div>";

/// Write the new page's chunk exactly as the importer writes a slide that has no
/// shapes yet, so the page renders and takes a text box straight away.
pub(super) fn mint_pptx_slide_chunk(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    addition: &PptxSlideAddTarget,
) -> Result<crate::ChunkDescriptor, HcdError> {
    let px = |value: u64| format!("{:.2}px", value as f64 * 96.0 / 914_400.0);
    let html = format!(
        "<section class=\"hcd-slide\" data-hcd-source-part=\"{}\" data-hcd-width-emu=\"{}\" data-hcd-height-emu=\"{}\" style=\"position:relative;width:{};height:{}\">{}</section>",
        escape_attribute(&addition.slide_part),
        addition.width_emu,
        addition.height_emu,
        px(addition.width_emu),
        px(addition.height_emu),
        PPTX_EMPTY_SLIDE_MARK,
    );
    let chunk_id = stable_node_id(&[
        &manifest.document_id,
        &addition.slide_part,
        "slide-chunk",
        "0",
    ])
    .replacen("n_", "c_", 1);
    let source_map = crate::ChunkSourceMap {
        schema_version: manifest.schema_version.clone(),
        chunk_id: chunk_id.clone(),
        entries: Vec::new(),
    };
    let (html_href, html_hash) = bundle.write_chunk_object(&html)?;
    let (map_href, map_hash) = bundle.write_json_object("maps", &source_map)?;
    Ok(crate::ChunkDescriptor {
        sequence: manifest.chunk_count,
        chunk_id,
        region: "slide".to_string(),
        html_href,
        html_hash,
        map_href,
        map_hash,
        byte_length: html.len() as u64,
        // An empty page is still one block, so the first text box placed on it
        // opens that block instead of adding a second one.
        block_count: 1,
        node_count: 0,
        text_chars: 0,
        node_bloom: node_bloom(std::iter::empty::<&str>()),
        first_node_id: None,
        last_node_id: None,
        continuation: false,
        grid: None,
    })
}

pub(super) fn delete_pptx_text(html: &mut String, entry: &NodeMapEntry) -> Result<(), HcdError> {
    if !entry.source.created_in_hcd || entry.source.node_kind != "slide-text" {
        return Err(HcdError::Unsupported(
            "PPTX deletion is available only for HCD-created text boxes".to_string(),
        ));
    }
    let locator = entry
        .source
        .text_id
        .as_deref()
        .and_then(|value| value.strip_prefix("hcd-pptx-box:"))
        .ok_or_else(|| HcdError::InvalidBundle("PPTX text box locator is missing".to_string()))?;
    let values = locator
        .split(',')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| HcdError::InvalidBundle("PPTX text box locator is invalid".to_string()))?;
    if values.len() != 5 || !(100..=25_600).contains(&values[4]) {
        return Err(HcdError::InvalidBundle(
            "PPTX text box locator is invalid".to_string(),
        ));
    }
    let slide_part = format!("data-hcd-source-part=\"{}\"", entry.source.part);
    if !html.starts_with("<section class=\"hcd-slide\"") || !html.contains(&slide_part) {
        return Err(HcdError::InvalidBundle(
            "PPTX text box is not in its source slide".to_string(),
        ));
    }
    let marker = format!("data-hcd-id=\"{}\"", entry.node_id);
    let location = html.find(&marker).ok_or_else(|| {
        HcdError::InvalidBundle("PPTX text box is missing from its slide".to_string())
    })?;
    let start = html[..location]
        .rfind("<div class=\"hcd-slide-shape\"")
        .ok_or_else(|| HcdError::InvalidBundle("PPTX text box shape is missing".to_string()))?;
    let tag_end = html[start..]
        .find('>')
        .map(|offset| start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("PPTX text box tag is not closed".to_string()))?;
    let tag = &html[start..=tag_end];
    if xlsx_attribute(tag, "data-hcd-shape-id").is_some()
        || [
            "data-hcd-x-emu",
            "data-hcd-y-emu",
            "data-hcd-width-emu",
            "data-hcd-height-emu",
        ]
        .iter()
        .enumerate()
        .any(|(index, name)| {
            xlsx_attribute(tag, name).and_then(|value| value.parse::<u64>().ok())
                != Some(values[index])
        })
    {
        return Err(HcdError::InvalidBundle(
            "PPTX created text box differs from its source locator".to_string(),
        ));
    }
    let close = html[tag_end + 1..]
        .find("</div>")
        .map(|offset| tag_end + 1 + offset + "</div>".len())
        .ok_or_else(|| {
            HcdError::InvalidBundle("PPTX text box closing tag is missing".to_string())
        })?;
    let contents = &html[tag_end + 1..close];
    if contents.contains("<div")
        || contents.matches("data-hcd-id=\"").count() != 1
        || !contents.contains(&marker)
    {
        return Err(HcdError::InvalidBundle(
            "PPTX text box contains unexpected nested content".to_string(),
        ));
    }
    html.replace_range(start..close, "");
    Ok(())
}

pub(super) fn insert_pptx_text(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    insertion: &PptxTextInsertion,
) -> Result<(), HcdError> {
    let source_tag = format!("data-hcd-source-part=\"{}\"", insertion.slide_part);
    if !html.starts_with("<section class=\"hcd-slide\"") || !html.contains(&source_tag) {
        return Err(HcdError::InvalidPatch(
            "PPTX chunk does not match the requested slide".to_string(),
        ));
    }
    let dimension = |key: &str| -> Result<u64, HcdError> {
        let marker = format!("{key}=\"");
        html.split_once(&marker)
            .and_then(|(_, suffix)| suffix.split_once('"'))
            .and_then(|(number, _)| number.parse::<u64>().ok())
            .ok_or_else(|| HcdError::InvalidBundle(format!("PPTX slide {key} is missing")))
    };
    let slide_width = dimension("data-hcd-width-emu")?;
    let slide_height = dimension("data-hcd-height-emu")?;
    if insertion
        .x_emu
        .checked_add(insertion.width_emu)
        .is_none_or(|end| end > slide_width)
        || insertion
            .y_emu
            .checked_add(insertion.height_emu)
            .is_none_or(|end| end > slide_height)
    {
        return Err(HcdError::InvalidPatch(
            "PPTX text box is outside the slide".to_string(),
        ));
    }
    if source_map
        .entries
        .iter()
        .any(|entry| entry.node_id == insertion.node_id)
    {
        return Err(HcdError::InvalidPatch(
            "PPTX text node ID already exists".to_string(),
        ));
    }
    let ordinal = source_map
        .entries
        .iter()
        .map(|entry| entry.source.text_ordinal)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| HcdError::ResourceLimit("PPTX text ordinal overflowed".to_string()))?;
    let node_hash = hash_bytes(insertion.text.as_bytes());
    let emu_px = |value: u64| value as f64 * 96.0 / 914_400.0;
    let font_pt = insertion.font_size_hundredths as f64 / 100.0;
    let block = format!(
        "<div class=\"hcd-slide-shape\" data-hcd-x-emu=\"{}\" data-hcd-y-emu=\"{}\" data-hcd-width-emu=\"{}\" data-hcd-height-emu=\"{}\" style=\"position:absolute;left:{:.2}px;top:{:.2}px;width:{:.2}px;height:{:.2}px;overflow:hidden\"><p class=\"hcd-slide-text\" style=\"font-family:Arial,sans-serif;font-size:{font_pt:.2}pt;margin-top:0;margin-bottom:0;margin-left:0;margin-right:0\"><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{node_hash}\">{}</span></p></div>",
        insertion.x_emu, insertion.y_emu, insertion.width_emu, insertion.height_emu,
        emu_px(insertion.x_emu), emu_px(insertion.y_emu), emu_px(insertion.width_emu), emu_px(insertion.height_emu),
        insertion.node_id, escape_text(&insertion.text),
    );
    // A slide that gains its first shape is no longer an empty page, and the
    // placeholder the importer leaves behind would draw a blank panel over it.
    if let Some(start) = html.find(PPTX_EMPTY_SLIDE_MARK) {
        html.replace_range(start..start + PPTX_EMPTY_SLIDE_MARK.len(), "");
    }
    let end = html
        .rfind("</section>")
        .ok_or_else(|| HcdError::InvalidBundle("PPTX slide closing tag is missing".to_string()))?;
    html.insert_str(end, &block);
    source_map.entries.push(NodeMapEntry {
        node_id: insertion.node_id.clone(),
        node_hash,
        source: SourceAnchor {
            source_cell_ref: None,
            created_in_hcd: true,
            part: insertion.slide_part.clone(),
            text_ordinal: ordinal,
            paragraph_id: None,
            // The native shape locator is immutable across text edits.
            text_id: Some(format!(
                "hcd-pptx-box:{},{},{},{},{}",
                insertion.x_emu,
                insertion.y_emu,
                insertion.width_emu,
                insertion.height_emu,
                insertion.font_size_hundredths
            )),
            node_kind: "slide-text".to_string(),
            editable: true,
        },
    });
    Ok(())
}

pub(super) fn update_pptx_run_format(
    html: &mut String,
    entry: &mut NodeMapEntry,
    format: &PptxRunFormat,
) -> Result<(), HcdError> {
    let marker = format!("data-hcd-id=\"{}\"", entry.node_id);
    let marker_at = html.find(&marker).ok_or_else(|| {
        HcdError::InvalidBundle(format!("PPTX text node {} is missing", entry.node_id))
    })?;
    let inner_start = html[..marker_at]
        .rfind('<')
        .ok_or_else(|| HcdError::InvalidBundle("PPTX text node tag is missing".to_string()))?;
    let inner_end = html[marker_at..]
        .find('>')
        .map(|offset| marker_at + offset)
        .ok_or_else(|| HcdError::InvalidBundle("PPTX text node tag is not closed".to_string()))?;
    let parent_start = html[..inner_start].rfind('<').ok_or_else(|| {
        HcdError::Unsupported("PPTX text is not inside a formatted run".to_string())
    })?;
    let parent_end = html[parent_start..]
        .find('>')
        .map(|offset| parent_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("PPTX run tag is not closed".to_string()))?;
    let parent = &html[parent_start..=parent_end];
    let parent_name = if parent.contains("class=\"hcd-ppt-run\"") {
        "span"
    } else if parent.contains("class=\"hcd-slide-text\"") {
        "p"
    } else {
        return Err(HcdError::Unsupported(
            "PPTX text is not inside a formatted run".to_string(),
        ));
    };
    let parent_close = matching_html_close(html, parent_end, parent_name)?;
    let interior = &html[parent_end + 1..parent_close];
    if interior.matches("data-hcd-id=").count() != 1 {
        return Err(HcdError::Unsupported(
            "PPTX run formatting applies to one text node in a run".to_string(),
        ));
    }
    let mut inner = html[inner_start..=inner_end].to_string();
    let existing = pptx_format_from_tag(&inner)?;
    let color = format
        .color
        .as_ref()
        .map(|color| format!("#{}", color.trim_start_matches('#').to_ascii_uppercase()));
    let merged = PptxRunFormat {
        bold: format.bold.or(existing.bold),
        italic: format.italic.or(existing.italic),
        underline: format.underline.or(existing.underline),
        font_size_pt: format.font_size_pt.or(existing.font_size_pt),
        color: color.or_else(|| existing.color.clone()),
    };
    if merged == existing {
        return Err(HcdError::InvalidPatch(
            "PPTX run format is unchanged".to_string(),
        ));
    }
    set_tag_attribute(&mut inner, "data-hcd-run-edited", "true");
    write_format_attributes(&mut inner, &merged);
    html.replace_range(inner_start..=inner_end, &inner);
    let parent_end = html[parent_start..]
        .find('>')
        .map(|offset| parent_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("PPTX run tag is not closed".to_string()))?;
    let mut parent = html[parent_start..=parent_end].to_string();
    apply_run_css(&mut parent, &merged)?;
    html.replace_range(parent_start..=parent_end, &parent);
    if entry.source.created_in_hcd {
        if let Some(size) = merged.font_size_pt {
            update_created_pptx_font(entry, size)?;
        }
    }
    Ok(())
}

pub(super) fn pptx_format_from_tag(tag: &str) -> Result<PptxRunFormat, HcdError> {
    if xlsx_attribute(tag, "data-hcd-run-edited") != Some("true") {
        return Ok(PptxRunFormat::default());
    }
    let flag = |name: &str| -> Result<Option<bool>, HcdError> {
        match xlsx_attribute(tag, name) {
            Some("1") => Ok(Some(true)),
            Some("0") => Ok(Some(false)),
            Some(_) => Err(HcdError::InvalidBundle(format!("PPTX {name} is invalid"))),
            None => Ok(None),
        }
    };
    let font_size_pt = match xlsx_attribute(tag, "data-hcd-font-size-pt") {
        Some(value) => Some(value.parse::<f32>().map_err(|_| {
            HcdError::InvalidBundle("PPTX stored font size is invalid".to_string())
        })?),
        None => None,
    };
    let color = xlsx_attribute(tag, "data-hcd-color").map(|value| format!("#{value}"));
    Ok(PptxRunFormat {
        bold: flag("data-hcd-bold")?,
        italic: flag("data-hcd-italic")?,
        underline: flag("data-hcd-underline")?,
        font_size_pt,
        color,
    })
}

pub(super) fn write_format_attributes(tag: &mut String, format: &PptxRunFormat) {
    if let Some(bold) = format.bold {
        set_tag_attribute(tag, "data-hcd-bold", if bold { "1" } else { "0" });
    }
    if let Some(italic) = format.italic {
        set_tag_attribute(tag, "data-hcd-italic", if italic { "1" } else { "0" });
    }
    if let Some(underline) = format.underline {
        set_tag_attribute(tag, "data-hcd-underline", if underline { "1" } else { "0" });
    }
    if let Some(size) = format.font_size_pt {
        let size = format!("{size:.2}");
        set_tag_attribute(tag, "data-hcd-font-size-pt", &size);
    }
    if let Some(color) = &format.color {
        let hex = color.trim_start_matches('#').to_ascii_uppercase();
        set_tag_attribute(tag, "data-hcd-color", &hex);
    }
}

pub(super) fn apply_run_css(tag: &mut String, format: &PptxRunFormat) -> Result<(), HcdError> {
    let style_marker = " style=\"";
    let mut declarations = BTreeMap::new();
    let style_range = tag.find(style_marker).map(|start| {
        let value_start = start + style_marker.len();
        let value_end = tag[value_start..]
            .find('"')
            .map(|offset| value_start + offset)
            .unwrap_or(value_start);
        (value_start, value_end)
    });
    if let Some((value_start, value_end)) = style_range {
        for declaration in tag[value_start..value_end].split(';') {
            let Some((property, value)) = declaration.split_once(':') else {
                continue;
            };
            declarations.insert(
                property.trim().to_ascii_lowercase(),
                value.trim().to_string(),
            );
        }
    }
    if let Some(bold) = format.bold {
        if bold {
            declarations.insert("font-weight".to_string(), "700".to_string());
        } else {
            declarations.remove("font-weight");
        }
    }
    if let Some(italic) = format.italic {
        if italic {
            declarations.insert("font-style".to_string(), "italic".to_string());
        } else {
            declarations.remove("font-style");
        }
    }
    if let Some(underline) = format.underline {
        let mut tokens = declarations
            .get("text-decoration")
            .map(|value| {
                value
                    .split_whitespace()
                    .filter(|token| *token != "underline")
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if underline {
            tokens.push("underline".to_string());
        }
        if tokens.is_empty() {
            declarations.remove("text-decoration");
        } else {
            declarations.insert("text-decoration".to_string(), tokens.join(" "));
        }
    }
    if let Some(size) = format.font_size_pt {
        declarations.insert("font-size".to_string(), format!("{size:.2}pt"));
    }
    if let Some(color) = &format.color {
        declarations.insert(
            "color".to_string(),
            format!("#{}", color.trim_start_matches('#').to_ascii_lowercase()),
        );
    }
    let style_value = declarations
        .iter()
        .map(|(property, value)| format!("{property}:{value}"))
        .collect::<Vec<_>>()
        .join(";");
    if !style_value.is_empty() {
        crate::html::validate_inline_style(&style_value)?;
    }
    if let Some((value_start, value_end)) = style_range {
        if style_value.is_empty() {
            let style_start = tag[..value_start].rfind(" style=\"").unwrap_or(value_start);
            tag.replace_range(style_start..value_end + 1, "");
        } else {
            tag.replace_range(value_start..value_end, &style_value);
        }
    } else if !style_value.is_empty() {
        tag.insert_str(tag.len() - 1, &format!(" style=\"{style_value}\""));
    }
    Ok(())
}

pub(super) fn update_created_pptx_font(
    entry: &mut NodeMapEntry,
    font_size_pt: f32,
) -> Result<(), HcdError> {
    let locator = entry.source.text_id.as_deref().ok_or_else(|| {
        HcdError::InvalidBundle("created PPTX text box locator is missing".to_string())
    })?;
    let values = locator
        .strip_prefix("hcd-pptx-box:")
        .and_then(|values| {
            values
                .split(',')
                .map(str::parse::<u64>)
                .collect::<Result<Vec<_>, _>>()
                .ok()
        })
        .ok_or_else(|| HcdError::InvalidBundle("PPTX text box locator is invalid".to_string()))?;
    if values.len() != 5 {
        return Err(HcdError::InvalidBundle(
            "PPTX text box locator is invalid".to_string(),
        ));
    }
    let hundredths = (font_size_pt * 100.0).round() as u64;
    if !(100..=25_600).contains(&hundredths) {
        return Err(HcdError::InvalidPatch(
            "PPTX font size must be from 1 to 256 points".to_string(),
        ));
    }
    entry.source.text_id = Some(format!(
        "hcd-pptx-box:{},{},{},{},{hundredths}",
        values[0], values[1], values[2], values[3]
    ));
    Ok(())
}

/// The positioned shape div that holds one slide text node: the frame a desktop
/// editor selects and aligns as a whole, found by walking the tags that open
/// ahead of the node and keeping the nearest enclosing shape.
pub(super) fn enclosing_pptx_shape(
    html: &str,
    node_id: &str,
    search_from: usize,
) -> Result<(usize, usize), HcdError> {
    let marker = format!("data-hcd-id=\"{node_id}\"");
    let node_offset = html
        .find(&marker)
        .ok_or_else(|| HcdError::InvalidBundle(format!("PPTX text node {node_id} is missing")))?;
    let mut open_divs = Vec::new();
    let mut cursor = search_from;
    while cursor < node_offset {
        let opening = html[cursor..node_offset]
            .find("<div")
            .map(|offset| cursor + offset);
        let closing = html[cursor..node_offset]
            .find("</div>")
            .map(|offset| cursor + offset);
        if closing.is_some_and(|close| opening.is_none_or(|open| close < open)) {
            cursor = closing.expect("checked above") + "</div>".len();
            open_divs.pop().ok_or_else(|| {
                HcdError::InvalidBundle("PPTX slide has an unmatched closing div".to_string())
            })?;
            continue;
        }
        let Some(opening) = opening else { break };
        let end = html[opening..]
            .find('>')
            .map(|offset| opening + offset)
            .ok_or_else(|| HcdError::InvalidBundle("PPTX shape tag is not closed".to_string()))?;
        open_divs.push((opening, end));
        cursor = end + 1;
    }
    open_divs
        .into_iter()
        .rev()
        .find(|(start, end)| html[*start..=*end].starts_with("<div class=\"hcd-slide-shape\""))
        .ok_or_else(|| {
            HcdError::Unsupported("PPTX text is not inside a positioned shape".to_string())
        })
}

pub(super) fn update_pptx_shape_geometry(
    html: &mut String,
    entry: &mut NodeMapEntry,
    change: &PptxGeometryChange,
) -> Result<(), HcdError> {
    let slide_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("PPTX slide section is not closed".to_string()))?;
    let slide_tag = &html[..=slide_end];
    if !slide_tag.starts_with("<section class=\"hcd-slide\"")
        || xlsx_attribute(slide_tag, "data-hcd-source-part") != Some(entry.source.part.as_str())
    {
        return Err(HcdError::InvalidBundle(
            "PPTX slide section does not match the source map".to_string(),
        ));
    }
    let slide_dimension = |name: &str| -> Result<u64, HcdError> {
        xlsx_attribute(slide_tag, name)
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| HcdError::InvalidBundle(format!("PPTX slide {name} is missing")))
    };
    let slide_width = slide_dimension("data-hcd-width-emu")?;
    let slide_height = slide_dimension("data-hcd-height-emu")?;
    if change
        .geometry
        .x_emu
        .checked_add(change.geometry.width_emu)
        .is_none_or(|end| end > slide_width)
        || change
            .geometry
            .y_emu
            .checked_add(change.geometry.height_emu)
            .is_none_or(|end| end > slide_height)
    {
        return Err(HcdError::InvalidPatch(
            "PPTX text shape must stay inside the slide".to_string(),
        ));
    }

    let (start, end) = enclosing_pptx_shape(html, &entry.node_id, slide_end + 1)?;
    let mut tag = html[start..=end].to_string();
    let number = |name: &str| -> Result<u64, HcdError> {
        xlsx_attribute(&tag, name)
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| HcdError::Unsupported(format!("PPTX shape has no {name}")))
    };
    let current = PptxShapeGeometry {
        x_emu: number("data-hcd-x-emu")?,
        y_emu: number("data-hcd-y-emu")?,
        width_emu: number("data-hcd-width-emu")?,
        height_emu: number("data-hcd-height-emu")?,
    };
    if current != change.expected {
        return Err(HcdError::PreconditionFailed(
            "PPTX shape geometry changed since it was selected".to_string(),
        ));
    }
    if entry.source.created_in_hcd {
        if xlsx_attribute(&tag, "data-hcd-shape-id").is_some() {
            return Err(HcdError::InvalidBundle(
                "created PPTX text box has a source shape ID".to_string(),
            ));
        }
        let locator = entry.source.text_id.as_deref().ok_or_else(|| {
            HcdError::InvalidBundle("created PPTX text box locator is missing".to_string())
        })?;
        let values = locator
            .strip_prefix("hcd-pptx-box:")
            .and_then(|values| {
                values
                    .split(',')
                    .map(str::parse::<u64>)
                    .collect::<Result<Vec<_>, _>>()
                    .ok()
            })
            .ok_or_else(|| {
                HcdError::InvalidBundle("PPTX text box locator is invalid".to_string())
            })?;
        if values.len() != 5
            || values[..4]
                != [
                    current.x_emu,
                    current.y_emu,
                    current.width_emu,
                    current.height_emu,
                ]
            || !(100..=25_600).contains(&values[4])
        {
            return Err(HcdError::InvalidBundle(
                "PPTX text box locator differs from its page geometry".to_string(),
            ));
        }
        entry.source.text_id = Some(format!(
            "hcd-pptx-box:{},{},{},{},{}",
            change.geometry.x_emu,
            change.geometry.y_emu,
            change.geometry.width_emu,
            change.geometry.height_emu,
            values[4]
        ));
    } else {
        let shape_id = xlsx_attribute(&tag, "data-hcd-shape-id")
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| HcdError::Unsupported("PPTX source shape ID is missing".to_string()))?;
        let shape_id = shape_id.to_string();
        if entry.source.paragraph_id.as_deref() != Some(shape_id.as_str()) {
            return Err(HcdError::InvalidBundle(
                "PPTX text node does not belong to its shape".to_string(),
            ));
        }
    }
    let emu_px = |value: u64| format!("{:.2}px", value as f64 * 96.0 / 914_400.0);
    let updates = BTreeMap::from([
        ("left".to_string(), emu_px(change.geometry.x_emu)),
        ("top".to_string(), emu_px(change.geometry.y_emu)),
        ("width".to_string(), emu_px(change.geometry.width_emu)),
        ("height".to_string(), emu_px(change.geometry.height_emu)),
    ]);
    update_start_tag_style(&mut tag, "data-hcd-x-emu=", &updates, false)?;
    for (name, value) in [
        ("data-hcd-x-emu", change.geometry.x_emu),
        ("data-hcd-y-emu", change.geometry.y_emu),
        ("data-hcd-width-emu", change.geometry.width_emu),
        ("data-hcd-height-emu", change.geometry.height_emu),
    ] {
        let tag_end = tag.len() - 1;
        set_attribute_in_range(&mut tag, 0, tag_end, name, &value.to_string())?;
    }
    let tag_end = tag.len() - 1;
    set_attribute_in_range(&mut tag, 0, tag_end, "data-hcd-geometry-edited", "true")?;
    html.replace_range(start..=end, &tag);
    Ok(())
}

/// Align one slide text shape. A request lands on a text node because that is
/// what the editor selects, but the box is what moves: every paragraph the shape
/// holds takes the horizontal value and the text body takes the vertical anchor,
/// the way selecting a frame restyles the whole box rather than the run under
/// the cursor.
pub(super) fn update_pptx_shape_align(
    html: &mut String,
    node_id: &str,
    align: &PptxShapeAlignPatch,
) -> Result<(), HcdError> {
    let slide_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("PPTX slide section is not closed".to_string()))?;
    if !html.starts_with("<section class=\"hcd-slide\"") {
        return Err(HcdError::InvalidBundle(
            "PPTX slide section is missing".to_string(),
        ));
    }
    let (start, end) = enclosing_pptx_shape(html, node_id, slide_end + 1)?;
    let close = matching_html_close(html, end, "div")?;
    let stored = stored_pptx_shape_align(&html[start..=end])?;
    let merged = PptxShapeAlignPatch {
        horizontal: align.horizontal.clone().or(stored.horizontal.clone()),
        vertical: align.vertical.clone().or(stored.vertical.clone()),
    };
    // A field the request leaves out keeps the value the shape already carries, so
    // what decides a no-op is the band the shape ends up naming, not the request.
    if merged == stored {
        return Err(HcdError::InvalidPatch(
            "PPTX shape alignment is unchanged".to_string(),
        ));
    }
    let mut tag = html[start..=end].to_string();
    let mut interior = html[end + 1..close].to_string();
    if let Some(horizontal) = &merged.horizontal {
        set_pptx_paragraph_align(&mut interior, horizontal)?;
    }
    if let Some(vertical) = &merged.vertical {
        // The marker has to sit inside the tag being rewritten, and it has to be
        // one every shape div carries: a box the editor drew has no node id of its
        // own on its frame, only the class both kinds share.
        let updates = BTreeMap::from([
            ("display".to_string(), "flex".to_string()),
            ("flex-direction".to_string(), "column".to_string()),
            (
                "justify-content".to_string(),
                pptx_vertical_css(vertical).to_string(),
            ),
        ]);
        update_start_tag_style(&mut tag, "class=\"hcd-slide-shape\"", &updates, false)?;
    }
    for (name, value) in [
        ("data-hcd-align-edited", Some("true".to_string())),
        ("data-hcd-horizontal", merged.horizontal.clone()),
        ("data-hcd-vertical", merged.vertical.clone()),
    ] {
        let Some(value) = value else { continue };
        let tag_end = tag.len() - 1;
        set_attribute_in_range(&mut tag, 0, tag_end, name, &value)?;
    }
    html.replace_range(start..close, &format!("{tag}{interior}"));
    Ok(())
}

pub(super) fn stored_pptx_shape_align(tag: &str) -> Result<PptxShapeAlignPatch, HcdError> {
    if xlsx_attribute(tag, "data-hcd-align-edited") != Some("true") {
        return Ok(PptxShapeAlignPatch::default());
    }
    let read = |name: &str, allowed: &[&str]| -> Result<Option<String>, HcdError> {
        match xlsx_attribute(tag, name) {
            Some(value) if allowed.contains(&value) => Ok(Some(value.to_string())),
            Some(_) => Err(HcdError::InvalidBundle(format!(
                "PPTX stored {name} is invalid"
            ))),
            None => Ok(None),
        }
    };
    Ok(PptxShapeAlignPatch {
        horizontal: read(
            "data-hcd-horizontal",
            &["left", "center", "right", "justify", "distributed"],
        )?,
        vertical: read("data-hcd-vertical", &["top", "center", "bottom"])?,
    })
}

pub(super) fn pptx_horizontal_css(horizontal: &str) -> &'static str {
    match horizontal {
        "left" => "left",
        "center" => "center",
        "right" => "right",
        _ => "justify",
    }
}

pub(super) fn pptx_vertical_css(vertical: &str) -> &'static str {
    match vertical {
        "top" => "flex-start",
        "bottom" => "flex-end",
        _ => "center",
    }
}

pub(super) fn set_pptx_paragraph_align(
    interior: &mut String,
    horizontal: &str,
) -> Result<(), HcdError> {
    const MARKER: &str = "<p class=\"hcd-slide-text\"";
    let updates = BTreeMap::from([(
        "text-align".to_string(),
        pptx_horizontal_css(horizontal).to_string(),
    )]);
    let mut output = String::with_capacity(interior.len());
    let mut cursor = 0usize;
    while let Some(offset) = interior[cursor..].find(MARKER) {
        let start = cursor + offset;
        let gap = interior[start..].find('>').ok_or_else(|| {
            HcdError::InvalidBundle("PPTX paragraph tag is not closed".to_string())
        })?;
        let end = start + gap;
        output.push_str(&interior[cursor..start]);
        let mut paragraph = interior[start..=end].to_string();
        // The helper looks for the tag that holds the marker, so it is handed a
        // name from inside the tag rather than the tag's own opening.
        update_start_tag_style(&mut paragraph, "class=\"hcd-slide-text\"", &updates, false)?;
        output.push_str(&paragraph);
        cursor = end + 1;
    }
    output.push_str(&interior[cursor..]);
    *interior = output;
    Ok(())
}

pub(super) fn validate_pptx_schema(
    manifest: &crate::HcdManifest,
    patch: &PatchBatch,
) -> Result<(), HcdError> {
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_27
        && (manifest.source.format != "pptx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PptxTextDelete { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/27 accepts one PPTX text-box deletion only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_30
        && (manifest.source.format != "pptx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PptxRunFormat { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/30 accepts one PPTX run format operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_41
        && (manifest.source.format != "pptx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PptxSlideAdd { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/41 accepts one PPTX slide addition operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_42
        && (manifest.source.format != "pptx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PptxSlideDelete { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/42 accepts one PPTX slide deletion operation only".to_string(),
        ));
    }
    if (patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_43
        || patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_48)
        && (manifest.source.format != "pptx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PptxSlideReorder { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "slide reordering accepts one PPTX slide reorder operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_44
        && (manifest.source.format != "pptx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PptxSlideCopy { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/44 accepts one PPTX slide copy operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_46
        && (manifest.source.format != "pptx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::PptxShapeAlign { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/46 accepts one PPTX shape alignment operation only".to_string(),
        ));
    }
    Ok(())
}
