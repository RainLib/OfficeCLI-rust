//! Point the text a PDF already carries at a face the caller embedded.
//!
//! Embedding a theme face puts its bytes in the file, but a PDF's existing
//! operators name the font that wrote them, so the page still renders in the
//! producer's font. This module re-points the runs it can prove are safe to
//! re-point and leaves the rest alone, counting what it did and why.
//!
//! A run moves only when all of these hold:
//!
//! * the page's text lives in one content stream, so rewriting the parsed lines
//!   cannot duplicate the streams that were merged to read them;
//! * the original font states what its codes spell — a `ToUnicode` CMap, or a
//!   one-byte font in a standard encoding holding printable ASCII
//!   ([`crate::content_stream::page_font_decodes_trustably`]);
//! * the run is one operand, not a block the parser merged from several;
//! * one candidate face can draw every character of the run
//!   ([`crate::content_stream::face_char_to_cid`]);
//! * the swap fits the original width within [`MIN_HORIZONTAL_SCALE`] to
//!   [`MAX_HORIZONTAL_SCALE`] percent once `Tz` is set to hold the line.
//!
//! Text inside a Form XObject is never touched: its operators live in another
//! stream, with its own resources, and the count is reported instead. Kerning
//! from a `TJ` array is lost when such a run moves — the whole run goes out as
//! one string at the width the page had before.

use crate::content_stream::{
    decode_operand_with_font, encode_chunk_with_font, estimate_text_width, face_char_to_cid,
    page_font_decodes_trustably, parse_page_content_stream_text_only_bounded, tokenize_pdf_line,
    FontInfo, PdfXObjectKind,
};
use crate::modifier::write_content_to_page;
use handler_common::HandlerError;
use lopdf::{Dictionary, Document as LopdfDocument, ObjectId};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Character-map streams this pass may decompress to read a font's codes.
const MAX_AUX_STREAM_BYTES: usize = 64 * 1024 * 1024;
/// The tightest squeeze we are willing to pass off as the original width.
const MIN_HORIZONTAL_SCALE: f32 = 50.0;
/// The loosest one. Past this the line is still the right length, but every
/// glyph is visibly stretched, which is worse than the font the file came with.
const MAX_HORIZONTAL_SCALE: f32 = 200.0;

/// What one pass over a file did to its text, and what it refused to do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextRetargetReport {
    /// Pages whose content was rewritten.
    pub pages_changed: usize,
    pub runs_retargeted: usize,
    /// Runs whose font does not say what its codes spell, runs the page parser
    /// merged from several operands, and runs on pages this pass would have to
    /// rewrite blindly.
    pub runs_kept_unreadable: usize,
    /// Runs no candidate face can draw in full.
    pub runs_kept_uncovered: usize,
    /// Runs whose width would need more or less squeeze than the limits allow.
    pub runs_kept_unfittable: usize,
    /// Runs already drawn with one of the faces handed to the pass.
    pub runs_kept_already_theme: usize,
    /// Distinct Form XObjects placed on the pages, whose text stays as it is.
    pub forms_left_alone: usize,
    /// Pages whose text is split over more than one content stream.
    pub pages_with_split_content: usize,
    /// Candidate resource name and how many runs it now draws, in the order the
    /// faces were first used.
    pub faces: Vec<(String, usize)>,
}

impl TextRetargetReport {
    /// Every run the pass looked at, whether it moved or not.
    pub fn runs_seen(&self) -> usize {
        self.runs_retargeted
            + self.runs_kept_unreadable
            + self.runs_kept_uncovered
            + self.runs_kept_unfittable
            + self.runs_kept_already_theme
    }
}

/// Re-point a file's own text at `faces`, tried in the order given.
///
/// `faces` are PDF font resource names, as registered on every page by
/// [`crate::font_embedder::embed_font_file`]. The file is rewritten only when
/// at least one run moved.
pub fn retarget_text_fonts(
    path: &Path,
    faces: &[String],
) -> Result<TextRetargetReport, HandlerError> {
    let mut report = TextRetargetReport::default();
    if faces.is_empty() {
        return Ok(report);
    }
    let mut document = LopdfDocument::load(path).map_err(|error| {
        HandlerError::OperationFailed(format!("failed to open PDF for font retarget: {error}"))
    })?;
    let pages: Vec<ObjectId> = document.get_pages().values().copied().collect();
    for page_id in pages {
        let outcome = retarget_page(&document, page_id, faces)?;
        report.runs_retargeted += outcome.retargeted;
        report.runs_kept_unreadable += outcome.unreadable;
        report.runs_kept_uncovered += outcome.uncovered;
        report.runs_kept_unfittable += outcome.unfittable;
        report.runs_kept_already_theme += outcome.already_theme;
        report.forms_left_alone += outcome.forms;
        report.pages_with_split_content += usize::from(outcome.split_content);
        for (name, runs) in outcome.faces {
            tally(&mut report.faces, name, runs);
        }
        if let Some(content) = outcome.content {
            write_content_to_page(&mut document, page_id, content.as_bytes())?;
            report.pages_changed += 1;
        }
    }
    if report.pages_changed > 0 {
        document.save(path).map_err(|error| {
            HandlerError::OperationFailed(format!(
                "failed to save PDF after retargeting text fonts: {error}"
            ))
        })?;
    }
    Ok(report)
}

#[derive(Default)]
struct PageOutcome {
    content: Option<String>,
    retargeted: usize,
    unreadable: usize,
    uncovered: usize,
    unfittable: usize,
    already_theme: usize,
    forms: usize,
    split_content: bool,
    faces: Vec<(String, usize)>,
}

impl PageOutcome {
    fn record(&mut self, name: String) {
        tally(&mut self.faces, name, 1);
    }
}

/// Add `runs` to this face's line in a report, keeping first-use order.
fn tally(entries: &mut Vec<(String, usize)>, name: String, runs: usize) {
    if runs == 0 {
        return;
    }
    if let Some(position) = entries.iter().position(|(entry, _)| *entry == name) {
        entries[position].1 += runs;
        return;
    }
    entries.push((name, runs));
}

/// One edit: replace `start..end` tokens of one line with `tokens`.
struct Edit {
    line: usize,
    start: usize,
    end: usize,
    tokens: Vec<String>,
}

/// A candidate face, ready to answer "can you draw this, and how wide".
struct Candidate {
    name: String,
    info: FontInfo,
    drawable: HashSet<char>,
}

fn retarget_page(
    document: &LopdfDocument,
    page_id: ObjectId,
    faces: &[String],
) -> Result<PageOutcome, HandlerError> {
    let mut outcome = PageOutcome::default();
    let content_streams = document.get_page_contents(page_id);
    if content_streams.len() != 1 {
        // Writing the merged bytes back would leave the other streams in place.
        outcome.split_content = true;
        return Ok(outcome);
    }
    let content = document
        .get_page_content(page_id)
        .map_err(|error| HandlerError::OperationFailed(format!("page content: {error}")))?;
    let parsed = parse_page_content_stream_text_only_bounded(
        &content,
        page_id,
        document,
        MAX_AUX_STREAM_BYTES,
    )?;
    outcome.forms = parsed
        .image_blocks
        .iter()
        .filter(|block| block.xobject_kind == PdfXObjectKind::Form)
        .map(|block| block.xobject_name.as_str())
        .collect::<HashSet<&str>>()
        .len();
    if parsed.text_blocks.is_empty() {
        return Ok(outcome);
    }

    let candidates = page_candidates(document, page_id, faces, &parsed.font_map);
    if candidates.is_empty() {
        return Ok(outcome);
    }

    let mut edits = Vec::new();
    for block in &parsed.text_blocks {
        if block.text.trim().is_empty() {
            continue;
        }
        let Some(original_name) = block.style.font_name.as_deref() else {
            outcome.unreadable += 1;
            continue;
        };
        if faces.iter().any(|face| face == original_name) {
            outcome.already_theme += 1;
            continue;
        }
        let Some(original_info) = parsed.font_map.get(original_name) else {
            outcome.unreadable += 1;
            continue;
        };
        if !page_font_decodes_trustably(document, page_id, original_name, &block.text) {
            outcome.unreadable += 1;
            continue;
        }
        let Some(line) = parsed.lines.get(block.text_line_index) else {
            outcome.unreadable += 1;
            continue;
        };
        let tokens = tokenize_pdf_line(line);
        let Some(operand) = tokens.get(block.line_token_index) else {
            outcome.unreadable += 1;
            continue;
        };
        // The block has to be this operand alone: a merged block's text runs
        // past it, and re-writing it here would print the rest a second time.
        if decode_operand_with_font(document, page_id, original_name, operand).as_deref()
            != Some(block.text.as_str())
        {
            outcome.unreadable += 1;
            continue;
        }
        let operator = tokens
            .get(block.line_token_index + 1)
            .map(|token| token.as_str())
            .unwrap_or("");
        if operator != "Tj" && operator != "TJ" {
            outcome.unreadable += 1;
            continue;
        }
        let Some(candidate) = candidates
            .iter()
            .find(|candidate| covers(&candidate.drawable, &block.text))
        else {
            outcome.uncovered += 1;
            continue;
        };
        let Ok(encoded) = encode_chunk_with_font(document, page_id, &candidate.name, &block.text)
        else {
            outcome.uncovered += 1;
            continue;
        };
        // The raw `Tf` size, because the page's own text matrix still scales
        // whatever this run writes.
        let size = block
            .style
            .raw_font_size
            .or(block.style.font_size)
            .unwrap_or(1.0);
        let original_scale = block.style.horizontal_scaling;
        let Some(scale) = fit_scale(&block.text, original_info, candidate, size, original_scale)
        else {
            outcome.unfittable += 1;
            continue;
        };

        let mut replacement = vec![
            format!("/{}", candidate.name),
            format_number(size),
            "Tf".to_string(),
        ];
        if (scale - original_scale).abs() >= 0.05 {
            replacement.push(format_number(scale));
            replacement.push("Tz".to_string());
        }
        // One string operand, so the operator is `Tj` whether the page used
        // `Tj` or a kerning array: `TJ` only accepts an array.
        replacement.push(encoded);
        replacement.push("Tj".to_string());
        // Leave the state as it was found, so the rest of this text object is
        // unaffected by the run that moved.
        replacement.push(format!("/{original_name}"));
        replacement.push(format_number(size));
        replacement.push("Tf".to_string());
        replacement.push(format_number(original_scale));
        replacement.push("Tz".to_string());

        edits.push(Edit {
            line: block.text_line_index,
            start: block.line_token_index,
            end: block.line_token_index + 2,
            tokens: replacement,
        });
        outcome.retargeted += 1;
        outcome.record(candidate.name.clone());
    }

    if edits.is_empty() {
        return Ok(outcome);
    }
    let mut lines = parsed.lines.clone();
    let mut by_line: HashMap<usize, Vec<Edit>> = HashMap::new();
    for edit in edits {
        by_line.entry(edit.line).or_default().push(edit);
    }
    for (line_index, mut line_edits) in by_line {
        let Some(original) = lines.get(line_index).cloned() else {
            continue;
        };
        let mut tokens = tokenize_pdf_line(&original);
        // Right to left within the line, so an earlier run's token indexes
        // still point where they did.
        line_edits.sort_by_key(|edit| std::cmp::Reverse(edit.start));
        for edit in line_edits {
            if edit.start >= tokens.len() {
                continue;
            }
            let end = edit.end.min(tokens.len());
            tokens.splice(edit.start..end, edit.tokens);
        }
        lines[line_index] = tokens.join(" ");
    }
    outcome.content = Some(lines.join("\n"));
    Ok(outcome)
}

/// The faces on this page that a run could be moved to, in the order offered.
fn page_candidates(
    document: &LopdfDocument,
    page_id: ObjectId,
    faces: &[String],
    font_map: &HashMap<String, FontInfo>,
) -> Vec<Candidate> {
    faces
        .iter()
        .filter_map(|name| {
            let info = font_map.get(name).cloned()?;
            let dictionary = page_font_document(document, page_id, name)?;
            let drawable = face_char_to_cid(document, dictionary)?;
            Some(Candidate {
                name: name.clone(),
                info,
                drawable: HashSet::from_iter(drawable.keys().copied()),
            })
        })
        .collect()
}

fn page_font_document<'a>(
    document: &'a LopdfDocument,
    page_id: ObjectId,
    name: &str,
) -> Option<&'a Dictionary> {
    let fonts = document.get_page_fonts(page_id).ok()?;
    fonts
        .into_iter()
        .find(|(entry, _)| String::from_utf8_lossy(entry) == name)
        .map(|(_, dictionary)| dictionary)
}

fn covers(drawable: &HashSet<char>, text: &str) -> bool {
    text.chars().all(|character| drawable.contains(&character))
}

/// The `Tz` that keeps this run as long as it was, or `None` when the fit would
/// be visible.
///
/// `Tz` scales the glyph advances only, not `Tc`/`Tw` spacing, so the spacing
/// part of the original width carries over untouched and the ratio is taken
/// between the bare glyph runs.
fn fit_scale(
    text: &str,
    original: &FontInfo,
    candidate: &Candidate,
    size: f32,
    original_scale: f32,
) -> Option<f32> {
    if size <= 0.0 || !original_scale.is_finite() {
        return None;
    }
    let before = estimate_text_width(text, original, size, 0.0, 0.0);
    let after = estimate_text_width(text, &candidate.info, size, 0.0, 0.0);
    if before <= 0.0 || after <= 0.0 {
        return None;
    }
    let scale = original_scale * before / after;
    if !scale.is_finite() || scale < MIN_HORIZONTAL_SCALE || scale > MAX_HORIZONTAL_SCALE {
        return None;
    }
    Some(scale)
}

/// A PDF number with no trailing zeros, so `12` stays `12` and a fitted scale
/// keeps three digits at most.
fn format_number(value: f32) -> String {
    if (value - value.round()).abs() < 0.0005 {
        return format!("{}", value.round() as i64);
    }
    let text = format!("{:.3}", value);
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content_stream::parse_page_content_stream;
    use crate::font_embedder::{bundled_noto_emoji, bundled_noto_sans_sc, embed_font_file};
    use lopdf::{dictionary, Dictionary, Object, Stream};
    use std::path::PathBuf;

    /// The `Tz` values a content stream sets, in the order it sets them.
    fn tz_values(content: &str) -> Vec<f32> {
        content
            .split_whitespace()
            .zip(content.split_whitespace().skip(1))
            .filter(|(_, next)| *next == "Tz")
            .filter_map(|(value, _)| value.parse::<f32>().ok())
            .collect()
    }

    /// A one-byte TrueType font with a real width table and no `ToUnicode`,
    /// which is what most producers write for plain ASCII text.
    fn plain_font() -> Dictionary {
        plain_font_with_width(600)
    }

    fn plain_font_with_width(units: i64) -> Dictionary {
        dictionary! {
            "Type" => "Font",
            "Subtype" => "TrueType",
            "BaseFont" => "CourierLike",
            "Encoding" => "WinAnsiEncoding",
            "FirstChar" => 32i64,
            "LastChar" => 126i64,
            "Widths" => Object::Array((32..=126u32).map(|_| Object::Integer(units)).collect()),
        }
    }

    fn write_page(
        dir: &Path,
        name: &str,
        content: &str,
        fonts: Vec<(&str, Dictionary)>,
    ) -> PathBuf {
        let mut document = LopdfDocument::with_version("1.5");
        let fonts_id = document.add_object(Dictionary::new());
        for (name, dictionary) in fonts {
            let id = document.add_object(dictionary);
            if let Ok(entry) = document.get_object_mut(fonts_id) {
                if let Ok(dict) = entry.as_dict_mut() {
                    dict.set(name.as_bytes().to_vec(), Object::Reference(id));
                }
            }
        }
        let resources_id =
            document.add_object(dictionary! { "Font" => Object::Reference(fonts_id) });
        let content_id =
            document.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
            "Resources" => Object::Reference(resources_id),
            "Contents" => Object::Array(vec![Object::Reference(content_id)]),
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(vec![Object::Reference(page_id)]),
                "Count" => 1,
            }),
        );
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        document.trailer.set("Root", Object::Reference(catalog));
        let path = dir.join(name);
        document.save(&path).unwrap();
        path
    }

    fn body_line(path: &Path) -> String {
        let document = LopdfDocument::load(path).unwrap();
        let page = *document.get_pages().values().next().unwrap();
        String::from_utf8_lossy(&document.get_page_content(page).unwrap()).to_string()
    }

    /// Re-read the page the way a viewer would, to check the run is still the
    /// same text and now names the theme face.
    fn blocks(path: &Path) -> Vec<(String, String)> {
        let document = LopdfDocument::load(path).unwrap();
        let page = *document.get_pages().values().next().unwrap();
        let content = document.get_page_content(page).unwrap();
        parse_page_content_stream(&content, page, &document)
            .unwrap()
            .text_blocks
            .into_iter()
            .map(|block| (block.text, block.style.font_name.unwrap_or_default()))
            .collect()
    }

    #[test]
    fn a_trusted_ascii_run_moves_to_the_face_and_keeps_its_width() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_page(
            dir.path(),
            "move.pdf",
            "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(Quarterly report) Tj\nET\n",
            vec![("F1", plain_font())],
        );
        embed_font_file(&path, "HcdSans", bundled_noto_sans_sc()).unwrap();

        let report = retarget_text_fonts(&path, &["HcdSans".to_string()]).unwrap();
        assert_eq!(report.runs_retargeted, 1, "{report:?}");
        assert_eq!(report.pages_changed, 1);
        assert_eq!(report.faces, vec![("HcdSans".to_string(), 1)]);

        // Same text, same place, now drawn by the pinned face.
        let moved = blocks(&path);
        assert_eq!(
            moved,
            vec![("Quarterly report".to_string(), "HcdSans".to_string())],
            "the run must still read as the text it did"
        );

        let content = body_line(&path);
        assert!(content.contains("/HcdSans 12 Tf"), "{content}");
        assert!(content.contains("/F1 12 Tf"), "{content}");
        assert!(content.contains("100 Tz"), "{content}");

        // The squeeze has to bring the new face back to the old advance.
        let document = LopdfDocument::load(&path).unwrap();
        let page = *document.get_pages().values().next().unwrap();
        let parsed =
            parse_page_content_stream(&document.get_page_content(page).unwrap(), page, &document)
                .unwrap();
        let text = "Quarterly report";
        let size = 12.0;
        let before = estimate_text_width(text, &parsed.font_map["F1"], size, 0.0, 0.0);
        let after = estimate_text_width(text, &parsed.font_map["HcdSans"], size, 0.0, 0.0);
        let expected = 100.0 * before / after;
        let emitted = *tz_values(&content)
            .first()
            .unwrap_or_else(|| panic!("no Tz in {content}"));
        assert!(
            (emitted - expected).abs() < 0.11,
            "Tz {emitted} does not fit {before} into {after} (want {expected})"
        );
        assert!(
            (after * emitted / 100.0 - before).abs() < 0.05,
            "the line must end as long as it started"
        );
    }

    #[test]
    fn a_run_whose_font_does_not_name_its_characters_stays_put() {
        let dir = tempfile::tempdir().unwrap();
        // 0xE9 in WinAnsi is é, and with no ToUnicode CMap only this font knows
        // that. A face that cannot be read back cannot be rewritten.
        let path = write_page(
            dir.path(),
            "unreadable.pdf",
            "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n<436166E9> Tj\nET\n",
            vec![("F1", plain_font())],
        );
        embed_font_file(&path, "HcdSans", bundled_noto_sans_sc()).unwrap();
        let before = body_line(&path);

        let report = retarget_text_fonts(&path, &["HcdSans".to_string()]).unwrap();
        assert_eq!(report.runs_kept_unreadable, 1, "{report:?}");
        assert_eq!(report.runs_retargeted, 0);
        assert_eq!(report.pages_changed, 0);
        assert_eq!(body_line(&path), before, "the file must not be rewritten");
        assert_eq!(blocks(&path)[0].1, "F1");
    }

    #[test]
    fn a_run_no_face_can_draw_is_left_in_the_font_that_can() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_page(
            dir.path(),
            "uncovered.pdf",
            "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(Quarterly report) Tj\nET\n",
            vec![("F1", plain_font())],
        );
        embed_font_file(&path, "HcdEmoji", bundled_noto_emoji()).unwrap();
        let before = body_line(&path);

        let report = retarget_text_fonts(&path, &["HcdEmoji".to_string()]).unwrap();
        assert_eq!(report.runs_kept_uncovered, 1, "{report:?}");
        assert_eq!(report.runs_retargeted, 0);
        assert_eq!(body_line(&path), before);
    }

    #[test]
    fn text_the_parser_merged_from_two_operands_is_not_written_once_as_one() {
        let dir = tempfile::tempdir().unwrap();
        // Two runs, same font, size and colour, adjacent: the parser reports
        // them as one block whose text spans both operands.
        let path = write_page(
            dir.path(),
            "merged.pdf",
            "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(Alpha) Tj (Beta) Tj\nET\n",
            vec![("F1", plain_font())],
        );
        embed_font_file(&path, "HcdSans", bundled_noto_sans_sc()).unwrap();
        let merged = blocks(&path);
        assert_eq!(merged.len(), 1, "the parser should have merged them");
        assert_eq!(merged[0].0, "AlphaBeta");

        let before = body_line(&path);
        let report = retarget_text_fonts(&path, &["HcdSans".to_string()]).unwrap();
        assert_eq!(report.runs_kept_unreadable, 1, "{report:?}");
        assert_eq!(report.runs_retargeted, 0);
        assert_eq!(
            body_line(&path),
            before,
            "rewriting the head operand would print Beta twice"
        );
    }

    #[test]
    fn a_scale_the_page_already_applied_is_folded_into_the_fit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_page(
            dir.path(),
            "scaled.pdf",
            "BT\n/F1 12 Tf\n80 Tz\n1 0 0 1 72 720 Tm\n(Quarterly report) Tj\nET\n",
            vec![("F1", plain_font())],
        );
        embed_font_file(&path, "HcdSans", bundled_noto_sans_sc()).unwrap();

        let document = LopdfDocument::load(&path).unwrap();
        let page = *document.get_pages().values().next().unwrap();
        let parsed =
            parse_page_content_stream(&document.get_page_content(page).unwrap(), page, &document)
                .unwrap();
        let block = &parsed.text_blocks[0];
        assert_eq!(block.text, "Quarterly report");
        assert_eq!(
            block.style.horizontal_scaling, 80.0,
            "the page's own squeeze has to reach the fit"
        );
        let before = estimate_text_width(&block.text, &parsed.font_map["F1"], 12.0, 0.0, 0.0);
        let after = estimate_text_width(&block.text, &parsed.font_map["HcdSans"], 12.0, 0.0, 0.0);
        let wanted = 80.0 * before / after;
        drop(parsed);
        drop(document);

        let report = retarget_text_fonts(&path, &["HcdSans".to_string()]).unwrap();
        assert_eq!(report.runs_retargeted, 1, "{report:?}");
        let content = body_line(&path);
        let scales = tz_values(&content);
        // The page's own `80 Tz` is still there, then the fit for this run,
        // then the restore.
        assert_eq!(scales.len(), 3, "{scales:?} in {content}");
        assert!((scales[0] - 80.0).abs() < 0.01, "{scales:?}");
        assert!(
            (scales[1] - wanted).abs() < 0.11,
            "{scales:?} should squeeze to the fitted {wanted}: {content}"
        );
        assert!(
            (scales[2] - 80.0).abs() < 0.01,
            "the state after the run must be the 80 the page had set: {content}"
        );
    }

    #[test]
    fn a_face_the_page_drew_with_already_is_counted_not_moved_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_page(
            dir.path(),
            "already.pdf",
            "BT\n/HcdSans 12 Tf\n1 0 0 1 72 720 Tm\n(Quarterly report) Tj\nET\n",
            Vec::new(),
        );
        embed_font_file(&path, "HcdSans", bundled_noto_sans_sc()).unwrap();

        let report = retarget_text_fonts(&path, &["HcdSans".to_string()]).unwrap();
        assert_eq!(report.runs_kept_already_theme, 1, "{report:?}");
        assert_eq!(report.runs_retargeted, 0);
        assert_eq!(report.pages_changed, 0);
    }

    #[test]
    fn text_inside_a_form_xobject_is_counted_and_left_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let form = "BT\n/F1 12 Tf\n1 0 0 1 10 10 Tm\n(Inside the form) Tj\nET\n";
        let mut document = LopdfDocument::with_version("1.5");
        let fonts_id = document.add_object(Dictionary::new());
        let courier = document.add_object(plain_font());
        if let Ok(entry) = document.get_object_mut(fonts_id) {
            entry
                .as_dict_mut()
                .unwrap()
                .set(b"F1", Object::Reference(courier));
        }
        let form_resources = document.add_object(dictionary! {
            "Font" => Object::Reference(fonts_id)
        });
        let form_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => Object::Array(vec![0.into(), 0.into(), 300.into(), 100.into()]),
                "Resources" => Object::Reference(form_resources),
            },
            form.as_bytes().to_vec(),
        ));
        let resources_id = document.add_object(dictionary! {
            "Font" => Object::Reference(fonts_id),
            "XObject" => Object::Dictionary(dictionary! {
                "Fx" => Object::Reference(form_id)
            }),
        });
        let content = "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(Quarterly report) Tj\nET\n/Fx Do\n";
        let content_id =
            document.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
            "Resources" => Object::Reference(resources_id),
            "Contents" => Object::Array(vec![Object::Reference(content_id)]),
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(vec![Object::Reference(page_id)]),
                "Count" => 1,
            }),
        );
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        document.trailer.set("Root", Object::Reference(catalog));
        let path = dir.path().join("form.pdf");
        document.save(&path).unwrap();
        embed_font_file(&path, "HcdSans", bundled_noto_sans_sc()).unwrap();

        let report = retarget_text_fonts(&path, &["HcdSans".to_string()]).unwrap();
        assert_eq!(report.runs_retargeted, 1, "{report:?}");
        assert_eq!(report.forms_left_alone, 1, "{report:?}");
        let document = LopdfDocument::load(&path).unwrap();
        let stream = document.get_object(form_id).unwrap().as_stream().unwrap();
        let bytes = stream
            .decompressed_content()
            .unwrap_or_else(|_| stream.content.clone());
        assert_eq!(
            String::from_utf8_lossy(&bytes),
            form,
            "the form's own operators are not this pass's to rewrite"
        );
        assert_eq!(
            blocks(&path),
            vec![("Quarterly report".to_string(), "HcdSans".to_string())]
        );
    }

    #[test]
    fn a_page_whose_text_is_split_over_two_streams_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let mut document = LopdfDocument::with_version("1.5");
        let fonts_id = document.add_object(Dictionary::new());
        let courier = document.add_object(plain_font());
        if let Ok(entry) = document.get_object_mut(fonts_id) {
            entry
                .as_dict_mut()
                .unwrap()
                .set(b"F1", Object::Reference(courier));
        }
        let resources_id =
            document.add_object(dictionary! { "Font" => Object::Reference(fonts_id) });
        let first = document.add_object(Stream::new(
            Dictionary::new(),
            b"BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n".to_vec(),
        ));
        let second = document.add_object(Stream::new(
            Dictionary::new(),
            b"(Quarterly report) Tj\nET\n".to_vec(),
        ));
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
            "Resources" => Object::Reference(resources_id),
            "Contents" => Object::Array(vec![
                Object::Reference(first),
                Object::Reference(second),
            ]),
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(vec![Object::Reference(page_id)]),
                "Count" => 1,
            }),
        );
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        document.trailer.set("Root", Object::Reference(catalog));
        let path = dir.path().join("split.pdf");
        document.save(&path).unwrap();
        embed_font_file(&path, "HcdSans", bundled_noto_sans_sc()).unwrap();
        let before = std::fs::read(&path).unwrap();

        let report = retarget_text_fonts(&path, &["HcdSans".to_string()]).unwrap();
        assert_eq!(report.pages_with_split_content, 1, "{report:?}");
        assert_eq!(report.pages_changed, 0);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_face_that_is_not_on_the_page_draws_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_page(
            dir.path(),
            "absent.pdf",
            "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(Quarterly report) Tj\nET\n",
            vec![("F1", plain_font())],
        );
        let before = body_line(&path);
        let report = retarget_text_fonts(&path, &["HcdNothing".to_string()]).unwrap();
        assert_eq!(report, TextRetargetReport::default());
        assert_eq!(body_line(&path), before);
    }

    #[test]
    fn a_swap_too_far_from_the_original_width_is_kept() {
        // Both edges of the band at once: an original font much narrower than
        // the face would need to be stretched past 200 percent, and one much
        // wider squeezed below 50. Either would keep the line the right length
        // and make every glyph visibly wrong, so the run stays where it is.
        for width in [60i64, 2000] {
            let dir = tempfile::tempdir().unwrap();
            let long = "a".repeat(200);
            let content = format!("BT\n/F1 1 Tf\n1 0 0 1 72 720 Tm\n({long}) Tj\nET\n");
            let path = write_page(
                dir.path(),
                "band.pdf",
                &content,
                vec![("F1", plain_font_with_width(width))],
            );
            embed_font_file(&path, "HcdSans", bundled_noto_sans_sc()).unwrap();
            let before = body_line(&path);

            let report = retarget_text_fonts(&path, &["HcdSans".to_string()]).unwrap();
            assert_eq!(report.runs_kept_unfittable, 1, "width {width}: {report:?}");
            assert_eq!(report.runs_retargeted, 0);
            assert_eq!(body_line(&path), before, "width {width}");
        }
    }
}
