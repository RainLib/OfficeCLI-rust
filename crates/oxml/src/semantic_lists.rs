//! Optional list-item ownership alongside native Word numbering. Unknown
//! consumers may ignore it; it never replaces native numbering or body text.
pub const NAMESPACE: &str = "urn:officecli:semantic-lists:1";
pub const ATTRIBUTE: &str = "list";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParagraphRole {
    Start,
    Continuation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListParagraph {
    item: u32,
    depth: u8,
    role: ParagraphRole,
}

impl ListParagraph {
    pub fn new(item: u32, depth: u8, role: ParagraphRole) -> Result<Self, &'static str> {
        if !(1..=1_000_000).contains(&item) || depth > 8 {
            return Err("list ownership exceeds item/depth limits");
        }
        Ok(Self { item, depth, role })
    }

    pub fn item(self) -> u32 {
        self.item
    }

    pub fn depth(self) -> u8 {
        self.depth
    }

    pub fn role(self) -> ParagraphRole {
        self.role
    }
}

impl std::fmt::Display for ListParagraph {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let role = match self.role {
            ParagraphRole::Start => "start",
            ParagraphRole::Continuation => "continue",
        };
        write!(output, "1:{}:{}:{role}", self.item, self.depth)
    }
}

impl std::str::FromStr for ListParagraph {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() > 64 {
            return Err("list ownership value is too long");
        }
        let fields: Vec<_> = value.split(':').collect();
        if fields.len() != 4 || fields[0] != "1" {
            return Err("unsupported list ownership version/fields");
        }
        let role = match fields[3] {
            "start" => ParagraphRole::Start,
            "continue" => ParagraphRole::Continuation,
            _ => return Err("unknown list paragraph role"),
        };
        let parsed = Self::new(
            fields[1].parse().map_err(|_| "invalid list item ID")?,
            fields[2].parse().map_err(|_| "invalid list depth")?,
            role,
        )?;
        if parsed.to_string() != value {
            return Err("noncanonical list ownership value");
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ownership_codec_is_bounded_and_versioned() {
        for role in [ParagraphRole::Start, ParagraphRole::Continuation] {
            let value = ListParagraph::new(1_000_000, 8, role).unwrap();
            assert_eq!(value.to_string().parse::<ListParagraph>().unwrap(), value);
        }
        for invalid in [
            "2:1:0:start",
            "1:0:0:start",
            "1:1000001:0:start",
            "1:1:9:start",
            "1:1:0:unknown",
            "1:1:0:start:extra",
            "1:01:0:start",
            "1:+1:0:start",
        ] {
            assert!(invalid.parse::<ListParagraph>().is_err(), "{invalid}");
        }
    }
}
