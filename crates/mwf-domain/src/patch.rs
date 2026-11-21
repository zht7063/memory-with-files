use crate::error::{DomainError, field};

/// Replaces the single occurrence of `old` in `body` with `new` (ADR 0023). Occurrences are
/// counted at every position, so overlapping matches such as `aa` in `aaa` count twice.
/// An empty `old` is an `INVALID_FIELD` error.
pub fn apply_patch(body: &str, old: &str, new: &str) -> Result<String, DomainError> {
    if old.is_empty() {
        return Err(field("old", "must not be empty"));
    }
    let at = body.find(old).ok_or(DomainError::PatchNoMatch)?;
    // Count further matches starting one character after each previous match.
    let step = |i: usize| i + body[i..].chars().next().map_or(1, char::len_utf8);
    let mut matches = 1;
    let mut from = step(at);
    while let Some(i) = body[from..].find(old) {
        matches += 1;
        from = step(from + i);
    }
    if matches > 1 {
        return Err(DomainError::PatchAmbiguous { matches });
    }
    let mut out = String::with_capacity(body.len() - old.len() + new.len());
    out.push_str(&body[..at]);
    out.push_str(new);
    out.push_str(&body[at + old.len()..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_a_unique_match() {
        assert_eq!(apply_patch("a b c", "b", "B").unwrap(), "a B c");
        assert_eq!(apply_patch("x\ny\n", "x\ny", "z").unwrap(), "z\n");
        assert_eq!(apply_patch("abc", "abc", "").unwrap(), "");
        assert_eq!(apply_patch("中文页面", "页", "頁").unwrap(), "中文頁面");
    }

    #[test]
    fn no_match() {
        assert_eq!(
            apply_patch("abc", "abd", "x"),
            Err(DomainError::PatchNoMatch)
        );
        assert_eq!(apply_patch("", "a", "x"), Err(DomainError::PatchNoMatch));
        assert_eq!(apply_patch("ABC", "b", "x"), Err(DomainError::PatchNoMatch));
    }

    #[test]
    fn ambiguous_counts_every_match_including_overlaps() {
        assert_eq!(
            apply_patch("b b b", "b", "x"),
            Err(DomainError::PatchAmbiguous { matches: 3 })
        );
        assert_eq!(
            apply_patch("aaa", "aa", "x"),
            Err(DomainError::PatchAmbiguous { matches: 2 })
        );
    }

    #[test]
    fn empty_old_is_rejected() {
        assert!(matches!(
            apply_patch("abc", "", "x"),
            Err(DomainError::InvalidField { field, .. }) if field == "old"
        ));
    }
}
