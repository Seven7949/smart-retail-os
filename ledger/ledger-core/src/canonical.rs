//! Canonical JSON (docs/LEDGER_SPEC.md): sorted ASCII keys, no whitespace,
//! integers only, raw UTF-8 strings. Identical output to the TS and Python ports.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write;

/// Largest integer that survives a round trip through a JS `number`.
pub const MAX_SAFE_INTEGER: i64 = (1_i64 << 53) - 1;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CanonError {
    #[error("floating point numbers are not allowed")]
    Float,
    #[error("integer outside the JS safe range")]
    IntegerRange,
    #[error("object keys must be ASCII")]
    NonAsciiKey,
}

/// Serialise `value` to its canonical string.
pub fn canonical(value: &Value) -> Result<String, CanonError> {
    let mut out = String::with_capacity(256);
    write_value(value, &mut out)?;
    Ok(out)
}

/// Lower-case hex SHA-256 of the UTF-8 bytes of `text`.
pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn write_value(value: &Value, out: &mut String) -> Result<(), CanonError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(n, out)?,
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            if keys.iter().any(|k| !k.is_ascii()) {
                return Err(CanonError::NonAsciiKey);
            }
            // For ASCII keys byte order == code point order == UTF-16 order.
            keys.sort_unstable();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_value(&map[key.as_str()], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_number(n: &serde_json::Number, out: &mut String) -> Result<(), CanonError> {
    let int = if let Some(i) = n.as_i64() {
        i
    } else if n.as_u64().is_some() {
        return Err(CanonError::IntegerRange);
    } else {
        return Err(CanonError::Float);
    };
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&int) {
        return Err(CanonError::IntegerRange);
    }
    // Writing to a String cannot fail.
    let _ = write!(out, "{int}");
    Ok(())
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_huge_integers() {
        assert_eq!(
            canonical(&json!({"n": 1_u64 << 60})),
            Err(CanonError::IntegerRange)
        );
        assert_eq!(
            canonical(&json!({"n": -(1_i64 << 60)})),
            Err(CanonError::IntegerRange)
        );
    }

    #[test]
    fn rejects_non_ascii_keys() {
        assert_eq!(canonical(&json!({"नाम": 1})), Err(CanonError::NonAsciiKey));
    }

    #[test]
    fn escapes_backspace_and_formfeed_short_form() {
        assert_eq!(
            canonical(&json!("a\u{08}b\u{0c}c\r")).unwrap(),
            "\"a\\bb\\fc\\r\""
        );
    }

    #[test]
    fn scalars() {
        assert_eq!(canonical(&json!(null)).unwrap(), "null");
        assert_eq!(canonical(&json!([true, false])).unwrap(), "[true,false]");
    }
}
