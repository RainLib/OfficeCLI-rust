//! Formula tokenizer — converts a formula string into a stream of tokens.

use super::types::*;

/// Tokenize a formula string (without leading '=') into tokens.
pub fn tokenize(formula: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let formula = formula.trim();
    let chars: Vec<char> = formula.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }

        // Comparison operators: > < >= <= = <>
        if ch == '>' || ch == '<' || ch == '=' {
            if ch == '=' && i == 0 {
                i += 1;
                continue;
            } // skip leading =
            if i + 1 < len && (chars[i + 1] == '=' || (ch == '<' && chars[i + 1] == '>')) {
                tokens.push(Token::new(
                    TokenType::Compare,
                    chars[i..i + 2].iter().collect::<String>(),
                ));
                i += 2;
            } else {
                tokens.push(Token::new(TokenType::Compare, ch.to_string()));
                i += 1;
            }
            continue;
        }

        // Arithmetic operators
        if ch == '+' || ch == '-' || ch == '*' || ch == '/' || ch == '^' {
            // Unary +/- at start or after operator/open-paren
            if (ch == '-' || ch == '+')
                && (tokens.is_empty()
                    || matches!(
                        tokens.last().map(|t| t.tt),
                        Some(
                            TokenType::Op
                                | TokenType::LParen
                                | TokenType::Comma
                                | TokenType::Compare
                        )
                    ))
            {
                if let Some(ns) = parse_number_chars(&chars, i, &mut i) {
                    tokens.push(Token::new(TokenType::Number, ns));
                    continue;
                }
            }
            tokens.push(Token::new(TokenType::Op, ch.to_string()));
            i += 1;
            continue;
        }

        // Percent operator
        if ch == '%' {
            tokens.push(Token::new(TokenType::Op, "%"));
            i += 1;
            continue;
        }

        // String concat
        if ch == '&' {
            tokens.push(Token::new(TokenType::Op, "&"));
            i += 1;
            continue;
        }

        // Parens and comma
        if ch == '(' {
            tokens.push(Token::new(TokenType::LParen, "("));
            i += 1;
            continue;
        }
        if ch == ')' {
            tokens.push(Token::new(TokenType::RParen, ")"));
            i += 1;
            continue;
        }
        if ch == ',' {
            tokens.push(Token::new(TokenType::Comma, ","));
            i += 1;
            continue;
        }

        // Array constant literal: {1,2;3,4}
        if ch == '{' {
            let start = i + 1;
            let mut end = start;
            let mut depth = 1;
            while end < len && depth > 0 {
                if chars[end] == '{' {
                    depth += 1;
                } else if chars[end] == '}' {
                    depth -= 1;
                }
                if depth > 0 {
                    end += 1;
                }
            }
            if end >= len {
                return Err("Unclosed { in array constant".to_string());
            }
            tokens.push(Token::new(
                TokenType::ArrayLit,
                chars[start..end].iter().collect::<String>(),
            ));
            i = end + 1;
            continue;
        }

        // Quoted string
        if ch == '"' {
            i += 1;
            let mut s = String::new();
            let mut closed = false;
            while i < len {
                if chars[i] == '"' {
                    if i + 1 < len && chars[i + 1] == '"' {
                        s.push('"');
                        i += 2;
                    } else {
                        i += 1;
                        closed = true;
                        break;
                    }
                } else {
                    s.push(chars[i]);
                    i += 1;
                }
            }
            if !closed {
                return Err("Unclosed string literal".into());
            }
            tokens.push(Token::new(TokenType::String, s));
            continue;
        }

        // Quoted sheet reference: 'Sheet Name'!CellRef
        if ch == '\'' {
            let si = i + 1;
            let mut ei = si;
            while ei < len {
                if chars[ei] == '\'' {
                    if ei + 1 < len && chars[ei + 1] == '\'' {
                        ei += 2;
                        continue;
                    }
                    break;
                }
                ei += 1;
            }
            if ei < len && ei > si && ei + 1 < len && chars[ei + 1] == '!' {
                let sheet_name: String =
                    chars[si..ei].iter().collect::<String>().replace("''", "'");
                i = ei + 2; // skip closing ' and !
                let (ref_part, new_i) = read_ref_part(&chars, i);
                i = new_i;
                let ref_clean = strip_dollar(&ref_part);
                if ref_clean.contains(':') {
                    tokens.push(Token::new(
                        TokenType::SheetRange,
                        format!("{}!{}", sheet_name, ref_clean),
                    ));
                } else {
                    tokens.push(Token::new(
                        TokenType::SheetCellRef,
                        format!("{}!{}", sheet_name, ref_clean.to_uppercase()),
                    ));
                }
                continue;
            }
            // Not a sheet ref — fall through
        }

        // Number
        if ch.is_ascii_digit() || ch == '.' {
            if let Some(ns) = parse_number_chars(&chars, i, &mut i) {
                // Entire-row range like 1:1 or 2:5
                if i < len && chars[i] == ':' {
                    let peek_start = i + 1;
                    let mut peek_end = peek_start;
                    while peek_end < len && chars[peek_end].is_ascii_digit() {
                        peek_end += 1;
                    }
                    if peek_end > peek_start && ns.chars().all(|c| c.is_ascii_digit()) {
                        let rhs_row: String = chars[peek_start..peek_end].iter().collect();
                        i = peek_end;
                        tokens.push(Token::new(TokenType::Range, format!("{}:{}", ns, rhs_row)));
                        continue;
                    }
                }
                tokens.push(Token::new(TokenType::Number, ns));
                continue;
            }
        }

        // Identifier: cell ref, function, boolean, sheet ref, range
        if ch.is_alphabetic() || ch == '_' || ch == '$' {
            let start = i;
            while i < len
                && (chars[i].is_alphanumeric()
                    || chars[i] == '_'
                    || chars[i] == '$'
                    || chars[i] == '.')
            {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let stripped = strip_dollar(&word);

            // Boolean literals
            let mut next = i;
            while next < len && chars[next].is_whitespace() {
                next += 1;
            }
            let function_call = next < len && chars[next] == '(';
            if stripped.eq_ignore_ascii_case("TRUE") && !function_call {
                tokens.push(Token::new(TokenType::Bool, "TRUE"));
                continue;
            }
            if stripped.eq_ignore_ascii_case("FALSE") && !function_call {
                tokens.push(Token::new(TokenType::Bool, "FALSE"));
                continue;
            }

            // Unquoted sheet reference: SheetName!CellRef
            if i < len && chars[i] == '!' {
                let sheet_name = word.clone();
                i += 1; // skip !
                let (ref_part, new_i) = read_ref_part(&chars, i);
                i = new_i;
                let ref_clean = strip_dollar(&ref_part);
                if ref_clean.contains(':') {
                    tokens.push(Token::new(
                        TokenType::SheetRange,
                        format!("{}!{}", sheet_name, ref_clean),
                    ));
                } else {
                    tokens.push(Token::new(
                        TokenType::SheetCellRef,
                        format!("{}!{}", sheet_name, ref_clean.to_uppercase()),
                    ));
                }
                continue;
            }

            // Range like A1:B5
            if i < len && chars[i] == ':' && is_cell_ref(&stripped) {
                i += 1;
                let (rhs, new_i) = read_ref_part(&chars, i);
                i = new_i;
                tokens.push(Token::new(
                    TokenType::Range,
                    format!("{}:{}", stripped, strip_dollar(&rhs)),
                ));
                continue;
            }

            // Entire-column range like A:A or A:C
            if i < len && chars[i] == ':' && stripped.chars().all(|c| c.is_ascii_alphabetic()) {
                i += 1;
                let (rhs, new_i) = read_ref_part(&chars, i);
                i = new_i;
                let rhs_stripped = strip_dollar(&rhs);
                if rhs_stripped.chars().all(|c| c.is_ascii_alphabetic()) {
                    tokens.push(Token::new(
                        TokenType::Range,
                        format!("{}:{}", stripped, rhs_stripped),
                    ));
                    continue;
                }
            }

            // Function call
            if function_call && !is_cell_ref(&stripped) {
                let func_name = word.replace('.', "_").to_uppercase();
                tokens.push(Token::new(TokenType::Func, func_name));
                i = next;
                continue;
            }

            // Cell reference
            if is_cell_ref(&stripped) {
                tokens.push(Token::new(TokenType::CellRef, stripped.to_uppercase()));
                continue;
            }

            // Unknown identifier — treat as #NAME? error
            tokens.push(Token::new(TokenType::Error, "#NAME?".to_string()));
            continue;
        }

        // Error literal like #REF!, #N/A, #VALUE!
        if ch == '#' {
            let remaining: String = chars[i..].iter().collect();
            let error = [
                "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#NULL!", "#SPILL!",
                "#CALC!",
            ]
            .into_iter()
            .find(|error| remaining.starts_with(error))
            .ok_or_else(|| "Invalid error literal".to_string())?;
            i += error.len();
            tokens.push(Token::new(TokenType::Error, error));
            continue;
        }

        return Err(format!("Unexpected character '{}' at position {}", ch, i));
    }

    Ok(tokens)
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Parse a number (possibly negative/positive prefix) from the character stream.
fn parse_number_chars(chars: &[char], start: usize, pos: &mut usize) -> Option<String> {
    let mut i = start;
    if i >= chars.len() {
        return None;
    }
    // Sign
    if chars[i] == '-' || chars[i] == '+' {
        i += 1;
    }
    let mut has_digits = false;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
        has_digits = true;
    }
    if i < chars.len() && chars[i] == '.' {
        i += 1;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
            has_digits = true;
        }
    }
    if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
        i += 1;
        if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
            i += 1;
        }
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
    }
    if !has_digits {
        return None;
    }
    let ns: String = chars[start..i].iter().collect();
    *pos = i;
    Some(ns)
}

/// Read a reference part (cell ref or range) after '!' — stops at non-ref chars.
fn read_ref_part(chars: &[char], start: usize) -> (String, usize) {
    let mut i = start;
    while i < chars.len()
        && (chars[i].is_ascii_alphanumeric() || chars[i] == '$' || chars[i] == ':')
    {
        i += 1;
    }
    let part: String = chars[start..i].iter().collect();
    (part, i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_simple_arithmetic() {
        let tokens = tokenize("1+2*3").unwrap();
        assert_eq!(tokens.len(), 5);
        assert_eq!(tokens[0].tt, TokenType::Number);
        assert_eq!(tokens[1].tt, TokenType::Op);
        assert_eq!(tokens[2].tt, TokenType::Number);
        assert_eq!(tokens[3].tt, TokenType::Op);
        assert_eq!(tokens[4].tt, TokenType::Number);
    }

    #[test]
    fn test_tokenize_function() {
        let tokens = tokenize("SUM(A1:A3)").unwrap();
        assert_eq!(tokens[0].tt, TokenType::Func);
        assert_eq!(tokens[0].value, "SUM");
        assert_eq!(tokens[1].tt, TokenType::LParen);
        assert_eq!(tokens[2].tt, TokenType::Range);
    }

    #[test]
    fn test_tokenize_cell_ref() {
        let tokens = tokenize("A1+B2").unwrap();
        assert_eq!(tokens[0].tt, TokenType::CellRef);
        assert_eq!(tokens[0].value, "A1");
        assert_eq!(tokens[2].tt, TokenType::CellRef);
    }

    #[test]
    fn test_tokenize_sheet_ref() {
        let tokens = tokenize("Sheet1!A1").unwrap();
        assert_eq!(tokens[0].tt, TokenType::SheetCellRef);
        assert!(tokens[0].value.contains("Sheet1!"));
    }

    #[test]
    fn test_tokenize_string() {
        let tokens = tokenize("\"hello\"&\"world\"").unwrap();
        assert_eq!(tokens[0].tt, TokenType::String);
        assert_eq!(tokens[0].value, "hello");
    }

    #[test]
    fn test_tokenize_comparison() {
        let tokens = tokenize("A1>=5").unwrap();
        assert_eq!(tokens[1].tt, TokenType::Compare);
        assert_eq!(tokens[1].value, ">=");
    }
}
