use super::page::parse_page_length;

/// CSS `bleed` as specified in a page context.
///
/// Resolution of `auto` depends on the selected printer marks and therefore
/// happens only after the page-context cascade has completed.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) enum PageBleed {
    /// Use the UA-defined bleed required by the selected printer marks.
    #[default]
    Auto,
    /// A non-negative physical length in points.
    Points(f32),
}

impl PageBleed {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        if value == "auto" {
            return Some(Self::Auto);
        }
        parse_page_length(value)
            .filter(|points| points.is_finite() && *points >= 0.0)
            .map(Self::Points)
    }
}

/// Closed set of printer-mark combinations accepted by CSS Paged Media.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum PrinterMarks {
    /// No printer marks.
    #[default]
    None,
    /// Crop marks only.
    Crop,
    /// Registration crosses only.
    Cross,
    /// Both crop marks and registration crosses.
    CropAndCross,
}

impl PrinterMarks {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let mut tokens = value.split_whitespace();
        match (tokens.next()?, tokens.next(), tokens.next()) {
            ("none", None, None) => Some(Self::None),
            ("crop", None, None) => Some(Self::Crop),
            ("cross", None, None) => Some(Self::Cross),
            ("crop", Some("cross"), None) | ("cross", Some("crop"), None) => {
                Some(Self::CropAndCross)
            }
            _ => None,
        }
    }

    pub(crate) const fn has_crop(self) -> bool {
        matches!(self, Self::Crop | Self::CropAndCross)
    }

    pub(crate) const fn has_cross(self) -> bool {
        matches!(self, Self::Cross | Self::CropAndCross)
    }

    pub(crate) const fn is_none(self) -> bool {
        matches!(self, Self::None)
    }
}

/// Post-layout orientation of the rendered page box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum PageOrientation {
    /// Do not rotate the laid-out page box.
    #[default]
    Upright,
    /// Rotate the laid-out page box 90 degrees counter-clockwise.
    RotateLeft,
    /// Rotate the laid-out page box 90 degrees clockwise.
    RotateRight,
}

impl PageOrientation {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "upright" => Some(Self::Upright),
            "rotate-left" => Some(Self::RotateLeft),
            "rotate-right" => Some(Self::RotateRight),
            _ => None,
        }
    }

    /// Whether this orientation swaps the physical sheet axes.
    pub(crate) const fn rotates(self) -> bool {
        !matches!(self, Self::Upright)
    }
}

/// Specified declarations that control the physical output sheet.
///
/// Each member is optional because omitted declarations must not overwrite an
/// earlier declaration during the page-context cascade.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct PageSheetDescriptors {
    bleed: Option<PageBleed>,
    marks: Option<PrinterMarks>,
    orientation: Option<PageOrientation>,
}

impl PageSheetDescriptors {
    pub(crate) fn set_bleed(&mut self, bleed: PageBleed) {
        self.bleed = Some(bleed);
    }

    pub(crate) fn set_marks(&mut self, marks: PrinterMarks) {
        self.marks = Some(marks);
    }

    pub(crate) fn set_orientation(&mut self, orientation: PageOrientation) {
        self.orientation = Some(orientation);
    }

    /// Cascade declarations from a later rule in source order.
    pub(crate) fn cascade(&mut self, later: Self) {
        self.bleed = later.bleed.or(self.bleed);
        self.marks = later.marks.or(self.marks);
        self.orientation = later.orientation.or(self.orientation);
    }

    pub(crate) const fn bleed(self) -> PageBleed {
        match self.bleed {
            Some(bleed) => bleed,
            None => PageBleed::Auto,
        }
    }

    pub(crate) const fn marks(self) -> PrinterMarks {
        match self.marks {
            Some(marks) => marks,
            None => PrinterMarks::None,
        }
    }

    pub(crate) const fn orientation(self) -> PageOrientation {
        match self.orientation {
            Some(orientation) => orientation,
            None => PageOrientation::Upright,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptors_accept_only_the_css_grammar() {
        assert_eq!(PageBleed::parse("auto"), Some(PageBleed::Auto));
        assert_eq!(PageBleed::parse("12px"), Some(PageBleed::Points(9.0)));
        assert_eq!(PageBleed::parse("-1pt"), None);
        assert_eq!(
            PrinterMarks::parse("crop cross"),
            Some(PrinterMarks::CropAndCross)
        );
        assert_eq!(
            PrinterMarks::parse("cross crop"),
            Some(PrinterMarks::CropAndCross)
        );
        assert_eq!(PrinterMarks::parse("crop crop"), None);
        assert_eq!(PrinterMarks::parse("none crop"), None);
        assert_eq!(
            PageOrientation::parse("rotate-left"),
            Some(PageOrientation::RotateLeft)
        );
        assert_eq!(PageOrientation::parse("sideways"), None);
    }
}
