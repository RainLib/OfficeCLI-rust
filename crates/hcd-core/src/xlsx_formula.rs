//! Conservative A1 formula updates for structural worksheet deletion.
//! Unsupported reference syntax is rejected before a revision is committed.

use crate::HcdError;

#[derive(Clone, Copy)]
pub enum FormulaDeletion {
    Row(u32),
    Column(u32),
}

#[derive(Clone)]
struct Reference {
    end: usize,
    row: u32,
    column: u32,
    row_absolute: bool,
    column_absolute: bool,
}

fn parse_reference(bytes: &[u8], start: usize) -> Option<Reference> {
    let mut cursor = start;
    let column_absolute = bytes.get(cursor) == Some(&b'$');
    if column_absolute {
        cursor += 1;
    }
    let letters_start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_alphabetic) && cursor - letters_start < 3 {
        cursor += 1;
    }
    if cursor == letters_start || bytes.get(cursor).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let mut column = 0u32;
    for byte in &bytes[letters_start..cursor] {
        column = column * 26 + u32::from(byte.to_ascii_uppercase() - b'A' + 1);
    }
    if column > 16_384 {
        return None;
    }
    let row_absolute = bytes.get(cursor) == Some(&b'$');
    if row_absolute {
        cursor += 1;
    }
    let digits_start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) && cursor - digits_start < 7 {
        cursor += 1;
    }
    if cursor == digits_start || bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    if bytes
        .get(cursor)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'('))
    {
        return None;
    }
    let row = std::str::from_utf8(&bytes[digits_start..cursor])
        .ok()?
        .parse()
        .ok()?;
    if !(1..=1_048_576).contains(&row) {
        return None;
    }
    Some(Reference {
        end: cursor,
        row,
        column,
        row_absolute,
        column_absolute,
    })
}

fn column_name(mut column: u32) -> String {
    let mut result = String::new();
    while column > 0 {
        column -= 1;
        result.insert(0, (b'A' + (column % 26) as u8) as char);
        column /= 26;
    }
    result
}

fn render(reference: &Reference) -> String {
    format!(
        "{}{}{}{}",
        if reference.column_absolute { "$" } else { "" },
        column_name(reference.column),
        if reference.row_absolute { "$" } else { "" },
        reference.row
    )
}

fn shift_one(mut reference: Reference, deletion: FormulaDeletion) -> Option<Reference> {
    match deletion {
        FormulaDeletion::Row(at) if reference.row == at => return None,
        FormulaDeletion::Row(at) if reference.row > at => reference.row -= 1,
        FormulaDeletion::Column(at) if reference.column == at => return None,
        FormulaDeletion::Column(at) if reference.column > at => reference.column -= 1,
        _ => {}
    }
    Some(reference)
}

fn shift_range(
    mut first: Reference,
    mut last: Reference,
    deletion: FormulaDeletion,
) -> Option<(Reference, Reference)> {
    match deletion {
        FormulaDeletion::Row(at) => {
            if first.row <= at && at <= last.row {
                if first.row == last.row {
                    return None;
                }
                last.row -= 1;
            } else {
                if first.row > at {
                    first.row -= 1;
                }
                if last.row > at {
                    last.row -= 1;
                }
            }
        }
        FormulaDeletion::Column(at) => {
            if first.column <= at && at <= last.column {
                if first.column == last.column {
                    return None;
                }
                last.column -= 1;
            } else {
                if first.column > at {
                    first.column -= 1;
                }
                if last.column > at {
                    last.column -= 1;
                }
            }
        }
    }
    Some((first, last))
}

pub fn delete_formula_references(
    formula: &str,
    deletion: FormulaDeletion,
) -> Result<String, HcdError> {
    if formula.len() > 8191
        || !formula.is_ascii()
        || formula
            .replace("#REF!", "")
            .bytes()
            .any(|byte| matches!(byte, b'!' | b'[' | b']' | b'\'' | b'@' | b';'))
    {
        return Err(HcdError::Unsupported(
            "XLSX formula uses references that structural deletion cannot safely update"
                .to_string(),
        ));
    }
    let bytes = formula.as_bytes();
    let mut output = String::with_capacity(formula.len());
    let mut offset = 0;
    let mut quoted = false;
    while offset < bytes.len() {
        let byte = bytes[offset];
        if byte == b'"' {
            if quoted && bytes.get(offset + 1) == Some(&b'"') {
                output.push_str("\"\"");
                offset += 2;
                continue;
            }
            quoted = !quoted;
            output.push('"');
            offset += 1;
            continue;
        }
        if !quoted
            && (byte == b'$' || byte.is_ascii_alphabetic())
            && (offset == 0
                || !matches!(bytes[offset - 1], b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.'))
        {
            if let Some(first) = parse_reference(bytes, offset) {
                if bytes.get(first.end) == Some(&b':') {
                    if let Some(last) = parse_reference(bytes, first.end + 1) {
                        if first.row > last.row || first.column > last.column {
                            return Err(HcdError::Unsupported(
                                "XLSX formula has a reversed A1 range".to_string(),
                            ));
                        }
                        if let Some((first, last)) = shift_range(first, last.clone(), deletion) {
                            output.push_str(&render(&first));
                            output.push(':');
                            output.push_str(&render(&last));
                        } else {
                            output.push_str("#REF!");
                        }
                        offset = last.end;
                        continue;
                    }
                }
                let end = first.end;
                if let Some(shifted) = shift_one(first, deletion) {
                    output.push_str(&render(&shifted));
                } else {
                    output.push_str("#REF!");
                }
                offset = end;
                continue;
            }
        }
        output.push(byte as char);
        offset += 1;
    }
    if quoted {
        return Err(HcdError::Unsupported(
            "XLSX formula has an unterminated string".to_string(),
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_updates_scalar_and_range_references() {
        assert_eq!(
            delete_formula_references("=SUM(C8:F8)+G8/B8", FormulaDeletion::Column(3)).unwrap(),
            "=SUM(C8:E8)+F8/B8"
        );
        assert_eq!(
            delete_formula_references("=SUM(B8:B14)", FormulaDeletion::Row(9)).unwrap(),
            "=SUM(B8:B13)"
        );
        assert_eq!(
            delete_formula_references("=SUM(A1:B1)", FormulaDeletion::Column(2)).unwrap(),
            "=SUM(A1:A1)"
        );
        assert_eq!(
            delete_formula_references("=A2+$B$2+\"A2\"", FormulaDeletion::Row(2)).unwrap(),
            "=#REF!+#REF!+\"A2\""
        );
        assert!(delete_formula_references("=Other!A1", FormulaDeletion::Row(1)).is_err());
        assert_eq!(
            delete_formula_references("=#REF!+C4", FormulaDeletion::Column(2)).unwrap(),
            "=#REF!+B4"
        );
    }
}
