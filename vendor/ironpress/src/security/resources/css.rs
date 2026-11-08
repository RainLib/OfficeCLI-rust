use std::path::Path;

use super::DocumentResources;

pub(super) fn rewrite(css: &str, resources: &DocumentResources, base: Option<&Path>) -> String {
    CssUrlRewriter::new(css, resources, base).rewrite()
}

struct CssUrlRewriter<'a> {
    css: &'a str,
    resources: &'a DocumentResources,
    base: Option<&'a Path>,
    cursor: usize,
    output: String,
}

impl<'a> CssUrlRewriter<'a> {
    fn new(css: &'a str, resources: &'a DocumentResources, base: Option<&'a Path>) -> Self {
        Self {
            css,
            resources,
            base,
            cursor: 0,
            output: String::with_capacity(css.len()),
        }
    }

    fn rewrite(mut self) -> String {
        while self.cursor < self.css.len() {
            if self.copy_comment() || self.copy_string() || self.rewrite_url() {
                continue;
            }
            self.copy_char();
        }
        self.output
    }

    fn copy_comment(&mut self) -> bool {
        if !self.remaining().starts_with("/*") {
            return false;
        }
        let end = self.remaining()[2..]
            .find("*/")
            .map_or(self.css.len(), |offset| self.cursor + 2 + offset + 2);
        self.copy_through(end);
        true
    }

    fn copy_string(&mut self) -> bool {
        let Some(quote @ (b'\'' | b'"')) = self.current_byte() else {
            return false;
        };
        let end = quoted_end(self.css.as_bytes(), self.cursor + 1, quote).unwrap_or(self.css.len());
        self.copy_through(end);
        true
    }

    fn rewrite_url(&mut self) -> bool {
        let bytes = self.css.as_bytes();
        if !is_url_function_at(bytes, self.cursor) {
            return false;
        }
        let body_start = self.cursor + 4;
        let Some(close) = css_function_close(bytes, body_start) else {
            self.output.push_str("url(\"\")");
            self.cursor = self.css.len();
            return true;
        };
        let raw_body = &self.css[body_start..close];
        let reference = unquote_url_body(raw_body);
        match reference.and_then(|value| self.resources.resolve(value, self.base)) {
            Some(resolved) => {
                self.output.push_str("url(\"");
                push_css_string(&mut self.output, &resolved.reference());
                self.output.push_str("\")");
            }
            None => self.output.push_str("url(\"\")"),
        }
        self.cursor = close + 1;
        true
    }

    fn current_byte(&self) -> Option<u8> {
        self.css.as_bytes().get(self.cursor).copied()
    }

    fn remaining(&self) -> &str {
        &self.css[self.cursor..]
    }

    fn copy_char(&mut self) {
        let Some(ch) = self.remaining().chars().next() else {
            return;
        };
        self.output.push(ch);
        self.cursor += ch.len_utf8();
    }

    fn copy_through(&mut self, end: usize) {
        if let Some(text) = self.css.get(self.cursor..end) {
            self.output.push_str(text);
            self.cursor = end;
        } else {
            self.cursor = self.css.len();
        }
    }
}

fn is_url_function_at(bytes: &[u8], index: usize) -> bool {
    let Some(candidate) = bytes.get(index..index + 4) else {
        return false;
    };
    candidate[..3].eq_ignore_ascii_case(b"url")
        && candidate[3] == b'('
        && index
            .checked_sub(1)
            .and_then(|previous| bytes.get(previous))
            .is_none_or(|byte| !is_css_ident_byte(*byte))
}

fn is_css_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | 0x80..=0xff)
}

fn css_function_close(bytes: &[u8], mut cursor: usize) -> Option<usize> {
    while let Some(byte) = bytes.get(cursor).copied() {
        match byte {
            b'\'' | b'"' => cursor = quoted_end(bytes, cursor + 1, byte)?,
            b'\\' => cursor = (cursor + 2).min(bytes.len()),
            b')' => return Some(cursor),
            _ => cursor += 1,
        }
    }
    None
}

fn quoted_end(bytes: &[u8], mut cursor: usize, quote: u8) -> Option<usize> {
    while let Some(byte) = bytes.get(cursor).copied() {
        match byte {
            b'\\' => cursor = (cursor + 2).min(bytes.len()),
            byte if byte == quote => return Some(cursor + 1),
            _ => cursor += 1,
        }
    }
    None
}

fn unquote_url_body(body: &str) -> Option<&str> {
    let body = body.trim();
    match body.as_bytes() {
        [quote @ (b'\'' | b'"'), .., closing] if quote == closing => body
            .get(1..body.len().saturating_sub(1))
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        [b'\'' | b'"', ..] => None,
        _ => (!body.is_empty()).then_some(body),
    }
}

fn push_css_string(output: &mut String, value: &str) {
    for ch in value.chars() {
        if matches!(ch, '"' | '\\') {
            output.push('\\');
        }
        output.push(ch);
    }
}
