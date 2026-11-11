//! Conservative A1 formula updates for structural worksheet deletion.
//! Unsupported reference syntax is rejected before a revision is committed.

use crate::HcdError;

#[derive(Clone, Copy)]
pub enum FormulaDeletion {
    Row(u32),
    Column(u32),
}

#[derive(Clone, Copy)]
pub enum FormulaInsertion {
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

pub fn insert_formula_references(
    formula: &str,
    insertion: FormulaInsertion,
) -> Result<String, HcdError> {
    if formula.len() > 8191
        || !formula.is_ascii()
        || formula
            .replace("#REF!", "")
            .bytes()
            .any(|byte| matches!(byte, b'!' | b'[' | b']' | b'\'' | b'@' | b';'))
    {
        return Err(HcdError::Unsupported(
            "XLSX formula uses references that structural insertion cannot safely update"
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
            if let Some(mut first) = parse_reference(bytes, offset) {
                if bytes.get(first.end) == Some(&b':') {
                    if let Some(mut last) = parse_reference(bytes, first.end + 1) {
                        if first.row > last.row || first.column > last.column {
                            return Err(HcdError::Unsupported(
                                "XLSX formula has a reversed A1 range".to_string(),
                            ));
                        }
                        match insertion {
                            FormulaInsertion::Row(at) => {
                                if first.row >= at {
                                    first.row += 1;
                                }
                                if last.row >= at {
                                    last.row += 1;
                                }
                            }
                            FormulaInsertion::Column(at) => {
                                if first.column >= at {
                                    first.column += 1;
                                }
                                if last.column >= at {
                                    last.column += 1;
                                }
                            }
                        }
                        if last.row > 1_048_576 || last.column > 16_384 {
                            return Err(HcdError::ResourceLimit(
                                "XLSX formula reference exceeds the worksheet limit".to_string(),
                            ));
                        }
                        output.push_str(&render(&first));
                        output.push(':');
                        output.push_str(&render(&last));
                        offset = last.end;
                        continue;
                    }
                }
                match insertion {
                    FormulaInsertion::Row(at) if first.row >= at => first.row += 1,
                    FormulaInsertion::Column(at) if first.column >= at => first.column += 1,
                    _ => {}
                }
                if first.row > 1_048_576 || first.column > 16_384 {
                    return Err(HcdError::ResourceLimit(
                        "XLSX formula reference exceeds the worksheet limit".to_string(),
                    ));
                }
                let end = first.end;
                output.push_str(&render(&first));
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

/// Rewrite worksheet-name references after a tab rename.
///
/// `renames` is `(previous name, new name)` applied in order, so a chain of
/// renames lands on the final name. String literals are copied verbatim, a
/// quoted name matches only as a whole name or a `name:name` range endpoint,
/// and a bare name matches only when the full run before `!` is the previous
/// name. The replacement keeps the reference quoted when the previous name was
/// quoted, and quotes a bare reference when the new name needs it.
pub fn rename_formula_sheet_references(formula: &str, renames: &[(&str, &str)]) -> String {
    let mut current = formula.to_string();
    for (previous, next) in renames {
        current = rename_one_sheet_reference(&current, previous, next);
    }
    current
}

fn rename_one_sheet_reference(formula: &str, previous: &str, next: &str) -> String {
    if previous.is_empty() || next.is_empty() {
        return formula.to_string();
    }
    let bytes = formula.as_bytes();
    let mut result = String::with_capacity(formula.len());
    let mut cursor = 0usize;
    while cursor < formula.len() {
        if bytes[cursor] == b'"' {
            let end = string_literal_end(formula, cursor);
            result.push_str(&formula[cursor..end]);
            cursor = end;
            continue;
        }
        if bytes[cursor] == b'\'' {
            if let Some((name, end)) = quoted_reference(formula, cursor) {
                if sheet_name_matches(&name, previous) {
                    result.push_str(&quoted_reference_token(&name, previous, next));
                } else {
                    // Re-emit the literal quote run; the closing quote and the
                    // `!` are copied by the caller so an untouched reference
                    // keeps its original bytes.
                    result.push('\'');
                    result.push_str(&escape_quoted_name(&name));
                    result.push('\'');
                    result.push('!');
                }
                cursor = end;
                continue;
            }
        }
        let run_end = name_run_end(formula, cursor);
        if run_end > cursor {
            // A reference token is always maximal: `TotalSales!` is one name, so
            // a suffix of it can never be the sheet being renamed.
            let token = &formula[cursor..run_end];
            if bytes.get(run_end) == Some(&b'!') && token.eq_ignore_ascii_case(previous) {
                result.push_str(&bare_reference_token(next));
                cursor = run_end + 1;
            } else {
                result.push_str(token);
                cursor = run_end;
            }
            continue;
        }
        let character = formula[cursor..].chars().next().unwrap_or('\0');
        if character == '\0' {
            break;
        }
        result.push(character);
        cursor += character.len_utf8();
    }
    result
}

fn string_literal_end(formula: &str, start: usize) -> usize {
    let bytes = formula.as_bytes();
    let mut cursor = start + 1;
    while cursor < bytes.len() {
        if bytes[cursor] == b'"' {
            if bytes.get(cursor + 1) == Some(&b'"') {
                cursor += 2;
                continue;
            }
            return cursor + 1;
        }
        cursor += 1;
    }
    bytes.len()
}

/// Read one `'name'!` reference, returning the decoded name and the offset
/// after the `!`. A quote that does not open such a reference yields `None`.
fn quoted_reference(formula: &str, start: usize) -> Option<(String, usize)> {
    let bytes = formula.as_bytes();
    let mut cursor = start + 1;
    let mut name = String::new();
    while cursor < bytes.len() {
        if bytes[cursor] == b'\'' {
            if bytes.get(cursor + 1) == Some(&b'\'') {
                name.push('\'');
                cursor += 2;
                continue;
            }
            if bytes.get(cursor + 1) == Some(&b'!') {
                return Some((name, cursor + 2));
            }
            return None;
        }
        let character = formula[cursor..].chars().next()?;
        name.push(character);
        cursor += character.len_utf8();
    }
    None
}

fn name_run_end(formula: &str, start: usize) -> usize {
    let mut cursor = start;
    while cursor < formula.len() {
        let character = formula[cursor..].chars().next().unwrap_or('\0');
        if character == '\0' || !is_reference_name_char(character) {
            break;
        }
        cursor += character.len_utf8();
    }
    cursor
}

fn is_reference_name_char(character: char) -> bool {
    if character.is_whitespace() || character.is_control() {
        return false;
    }
    !matches!(
        character,
        '!' | '"'
            | '\''
            | '#'
            | '$'
            | '%'
            | '('
            | ')'
            | '*'
            | '+'
            | ','
            | '-'
            | '.'
            | '/'
            | ':'
            | ';'
            | '<'
            | '='
            | '>'
            | '?'
            | '@'
            | '['
            | ']'
            | '^'
            | '{'
            | '|'
            | '}'
            | '~'
            | '&'
    )
}

fn sheet_name_matches(name: &str, previous: &str) -> bool {
    name.eq_ignore_ascii_case(previous)
        || name
            .split(':')
            .any(|part| part.eq_ignore_ascii_case(previous))
}

fn escape_quoted_name(name: &str) -> String {
    name.replace('\'', "''")
}

fn quoted_reference_token(name: &str, previous: &str, next: &str) -> String {
    if name.eq_ignore_ascii_case(previous) {
        return format!("'{}'!", escape_quoted_name(next));
    }
    let parts = name
        .split(':')
        .map(|part| {
            if part.eq_ignore_ascii_case(previous) {
                next
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(":");
    format!("'{}'!", escape_quoted_name(&parts))
}

fn bare_reference_token(next: &str) -> String {
    if reference_name_needs_quotes(next) {
        return format!("'{}'!", escape_quoted_name(next));
    }
    format!("{next}!")
}

/// A worksheet name that cannot appear bare in a formula: it would parse as a
/// cell address, an R1C1 address, or a keyword, or it holds a character that A1
/// grammar reserves for operators. Letters outside ASCII, such as a Chinese tab
/// name, stay bare because that is how Excel writes them.
fn reference_name_needs_quotes(name: &str) -> bool {
    if name.is_empty()
        || name
            .chars()
            .next()
            .is_some_and(|character| character.is_numeric())
    {
        return true;
    }
    if !name
        .chars()
        .all(|character| character.is_alphanumeric() || matches!(character, '_' | '.'))
    {
        return true;
    }
    if matches!(
        name.to_ascii_uppercase().as_str(),
        "TRUE" | "FALSE" | "NULL"
    ) {
        return true;
    }
    let bytes = name.as_bytes();
    let letters = bytes
        .iter()
        .position(|byte| !byte.is_ascii_alphabetic())
        .unwrap_or(bytes.len());
    if (1..=3).contains(&letters) && bytes.len() > letters {
        let digits = &bytes[letters..];
        if !digits.is_empty()
            && digits.len() <= 7
            && digits.iter().all(u8::is_ascii_digit)
            && !bytes[0].eq_ignore_ascii_case(&b'R')
        {
            return true;
        }
    }
    if bytes[0].eq_ignore_ascii_case(&b'R') {
        let middle = bytes
            .iter()
            .skip(1)
            .position(|byte| byte.eq_ignore_ascii_case(&b'C'));
        if let Some(offset) = middle {
            let row = &bytes[1..offset + 1];
            let column = &bytes[offset + 2..];
            if !row.is_empty()
                && row.iter().all(u8::is_ascii_digit)
                && !column.is_empty()
                && column.iter().all(u8::is_ascii_digit)
            {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insertion_updates_scalar_absolute_and_range_references() {
        assert_eq!(
            insert_formula_references("=SUM(C8:F8)+G8/$B$8+\"A8\"", FormulaInsertion::Row(8))
                .unwrap(),
            "=SUM(C9:F9)+G9/$B$9+\"A8\""
        );
        assert_eq!(
            insert_formula_references("=SUM(B8:B14)", FormulaInsertion::Row(9)).unwrap(),
            "=SUM(B8:B15)"
        );
        assert!(insert_formula_references("=Other!A1", FormulaInsertion::Row(1)).is_err());
    }

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

    #[test]
    fn rename_updates_bare_and_quoted_sheet_references() {
        assert_eq!(
            rename_formula_sheet_references("=SUM(Sales!A1:A3)+Sales!B9", &[("Sales", "Revenue")]),
            "=SUM(Revenue!A1:A3)+Revenue!B9"
        );
        assert_eq!(
            rename_formula_sheet_references("=sales!A1", &[("Sales", "Revenue")]),
            "=Revenue!A1"
        );
        assert_eq!(
            rename_formula_sheet_references(
                "='My Sheet'!A1+'Other'!B2",
                &[("My Sheet", "Quarter 1"), ("Other", "Base")]
            ),
            "='Quarter 1'!A1+'Base'!B2"
        );
        assert_eq!(
            rename_formula_sheet_references("=销售!A1", &[("销售", "采购")]),
            "=采购!A1"
        );
        assert_eq!(
            rename_formula_sheet_references("='It''s'!A1", &[("It's", "New")]),
            "='New'!A1"
        );
    }

    #[test]
    fn rename_keeps_literals_and_longer_names_untouched() {
        assert_eq!(
            rename_formula_sheet_references(
                "=IF(A1>0,\"Sales!x\",Sales!B1)+TotalSales!C1",
                &[("Sales", "Profit")]
            ),
            "=IF(A1>0,\"Sales!x\",Profit!B1)+TotalSales!C1"
        );
        assert_eq!(
            rename_formula_sheet_references("=SUM(Start:End!A1)", &[("End", "Profit")]),
            "=SUM(Start:Profit!A1)"
        );
        assert_eq!(
            rename_formula_sheet_references("='Start:End'!A1", &[("End", "Profit")]),
            "='Start:Profit'!A1"
        );
        assert_eq!(
            rename_formula_sheet_references("=Data!A1", &[("Data", "Sheet2")]),
            "=Sheet2!A1"
        );
        assert_eq!(
            rename_formula_sheet_references("=Data!A1", &[("Data", "A1")]),
            "='A1'!A1"
        );
        assert_eq!(
            rename_formula_sheet_references("=Data!A1", &[("Data", "7月")]),
            "='7月'!A1"
        );
    }

    #[test]
    fn chained_renames_follow_the_final_name() {
        assert_eq!(
            rename_formula_sheet_references(
                "=Sales!A1+1",
                &[
                    ("Sales", "North"),
                    ("North", "South"),
                    ("Unrelated", "Name")
                ]
            ),
            "=South!A1+1"
        );
        assert_eq!(
            rename_formula_sheet_references("=SUM(A1:B2)", &[("Sales", "Revenue")]),
            "=SUM(A1:B2)"
        );
    }
}
