use crate::error::IronpressError;
use crate::parser::dom::{DomNode, ElementNode, HtmlTag};
use crate::parser::html::ParseResult;
use crate::security::resources::DocumentResources;

const HEADER_RUNNING_NAME: &str = "-ironpress-api-header";
const FOOTER_RUNNING_NAME: &str = "-ironpress-api-footer";

#[derive(Clone, Default)]
pub(crate) struct PageMargins {
    header: PageMarginContent,
    footer: PageMarginContent,
}

impl PageMargins {
    pub(crate) fn set_header_text(&mut self, text: String) {
        self.header = PageMarginText::new(text).into();
    }

    pub(crate) fn set_footer_text(&mut self, text: String) {
        self.footer = PageMarginText::new(text).into();
    }

    pub(crate) fn set_header_html(&mut self, html: String) {
        self.header = PageMarginHtml::new(html).into();
    }

    pub(crate) fn set_footer_html(&mut self, html: String) {
        self.footer = PageMarginHtml::new(html).into();
    }

    pub(crate) fn header_text(&self) -> Option<&str> {
        self.header.text()
    }

    pub(crate) fn footer_text(&self) -> Option<&str> {
        self.footer.text()
    }

    pub(crate) fn has_content(&self) -> bool {
        !matches!(self.header, PageMarginContent::Empty)
            || !matches!(self.footer, PageMarginContent::Empty)
    }

    pub(crate) fn enrich_document(
        &self,
        result: &mut ParseResult,
        sanitize: bool,
        resources: &DocumentResources,
    ) -> Result<(), IronpressError> {
        self.header
            .append_rich_fragment(result, sanitize, resources, PageBand::Header)?;
        self.footer
            .append_rich_fragment(result, sanitize, resources, PageBand::Footer)?;
        Ok(())
    }
}

#[derive(Clone, Default)]
enum PageMarginContent {
    #[default]
    Empty,
    Text(PageMarginText),
    Html(PageMarginHtml),
}

impl PageMarginContent {
    fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text.as_str()),
            Self::Empty | Self::Html(_) => None,
        }
    }

    fn append_rich_fragment(
        &self,
        result: &mut ParseResult,
        sanitize: bool,
        resources: &DocumentResources,
        band: PageBand,
    ) -> Result<(), IronpressError> {
        let Self::Html(fragment) = self else {
            return Ok(());
        };
        let parsed = fragment.parse(sanitize, resources, band)?;
        result.nodes.insert(0, parsed.running_element);
        result.stylesheets.extend(parsed.stylesheets);
        result.stylesheets.push(band.page_rule().to_string());
        Ok(())
    }
}

#[derive(Clone)]
struct PageMarginText(String);

impl PageMarginText {
    fn new(text: String) -> Self {
        Self(text)
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<PageMarginText> for PageMarginContent {
    fn from(text: PageMarginText) -> Self {
        Self::Text(text)
    }
}

#[derive(Clone)]
struct PageMarginHtml(String);

impl PageMarginHtml {
    fn new(html: String) -> Self {
        Self(html)
    }

    fn parse(
        &self,
        sanitize: bool,
        resources: &DocumentResources,
        band: PageBand,
    ) -> Result<ParsedPageMarginHtml, IronpressError> {
        let sanitized = sanitize
            .then(|| crate::security::sanitizer::sanitize_html_with_resources(&self.0, resources))
            .transpose()?;
        let html = sanitized.as_deref().unwrap_or(&self.0);
        let mut parsed = crate::parser::html::parse_html_with_styles(html)?;
        crate::security::sanitizer::sanitize_dom_resources(&mut parsed.nodes, resources);

        let mut running_element = ElementNode::new(HtmlTag::Div);
        running_element.attributes.insert(
            "style".to_string(),
            format!("position: running({})", band.running_name()),
        );
        running_element.children = parsed.nodes;

        Ok(ParsedPageMarginHtml {
            running_element: DomNode::Element(running_element),
            stylesheets: parsed.stylesheets,
        })
    }
}

impl From<PageMarginHtml> for PageMarginContent {
    fn from(html: PageMarginHtml) -> Self {
        Self::Html(html)
    }
}

struct ParsedPageMarginHtml {
    running_element: DomNode,
    stylesheets: Vec<String>,
}

#[derive(Clone, Copy)]
enum PageBand {
    Header,
    Footer,
}

impl PageBand {
    const fn running_name(self) -> &'static str {
        match self {
            Self::Header => HEADER_RUNNING_NAME,
            Self::Footer => FOOTER_RUNNING_NAME,
        }
    }

    const fn page_rule(self) -> &'static str {
        match self {
            Self::Header => {
                "@page { @top-center { content: element(-ironpress-api-header, last) } }"
            }
            Self::Footer => {
                "@page { @bottom-center { content: element(-ironpress-api-footer, last) } }"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::resources::NetworkPolicy;

    #[test]
    fn the_last_header_setter_selects_one_unambiguous_content_kind() {
        let mut margins = PageMargins::default();
        margins.set_header_text("plain".to_string());
        assert_eq!(margins.header_text(), Some("plain"));

        margins.set_header_html("<strong>rich</strong>".to_string());
        assert_eq!(margins.header_text(), None);
    }

    #[test]
    fn rich_fragment_is_sanitized_before_it_joins_the_document() {
        let resources = DocumentResources::new(None, None, NetworkPolicy::default());
        let fragment = PageMarginHtml::new(
            "<script>bad()</script><strong onclick='bad()'>safe</strong>".to_string(),
        );
        let parsed = fragment
            .parse(true, &resources, PageBand::Header)
            .expect("sanitized rich header");
        let DomNode::Element(wrapper) = parsed.running_element else {
            panic!("running wrapper");
        };
        let debug_tree = format!("{:?}", wrapper.children);

        assert!(!debug_tree.contains("script"));
        assert!(!debug_tree.contains("onclick"));
        assert!(debug_tree.contains("safe"));
    }

    #[test]
    fn rich_fragment_cannot_bypass_the_document_resource_boundary() {
        let resources = DocumentResources::new(None, None, NetworkPolicy::default());
        let fragment = PageMarginHtml::new(
            r#"<img src="file:///etc/passwd" style="background:url(../../secret.png)">"#
                .to_string(),
        );
        let parsed = fragment
            .parse(false, &resources, PageBand::Header)
            .expect("resource-filtered rich header");
        let DomNode::Element(wrapper) = parsed.running_element else {
            panic!("running wrapper");
        };
        let debug_tree = format!("{:?}", wrapper.children);

        assert!(!debug_tree.contains("file:///etc/passwd"));
        assert!(!debug_tree.contains("../../secret.png"));
    }
}
