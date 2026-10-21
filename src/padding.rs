//! The padded sizes v4 pastes use (js/crypto.mjs `padme` and
//! `PART_PADDING`), so the server can refuse a paste whose parts aren't
//! padded: a client that skipped it would leak exact sizes.

/// AES-GCM's tag, added to every encrypted part.
const TAG_BYTES: u64 = 16;

/// How a part is padded before encryption.
#[derive(Clone, Copy)]
pub enum Padding {
    /// Padmé, from this size up.
    Min(u64),
    /// Always exactly this size.
    Fixed(u64),
}

pub const TEXT: Padding = Padding::Min(4096);
pub const FILE: Padding = Padding::Min(4096);
pub const FILE_NAME: Padding = Padding::Min(1024);
pub const TITLE: Padding = Padding::Fixed(512);

/// Padmé (Nikitin et al., 2019): `length` rounded up so only its top few
/// bits can vary.
pub fn padme(length: u64) -> u64 {
    if length < 2 {
        return length;
    }
    let exponent = 63 - u64::from(length.leading_zeros());
    let exponent_bits = 64 - u64::from(exponent.leading_zeros());
    let step = 1u64 << (exponent - exponent_bits);
    length.div_ceil(step) * step
}

/// Whether an encrypted part of `encrypted_len` bytes is padded as `padding`
/// says.
pub fn is_padded(encrypted_len: u64, padding: Padding) -> bool {
    let Some(len) = encrypted_len.checked_sub(TAG_BYTES) else {
        return false;
    };
    match padding {
        Padding::Fixed(size) => len == size,
        Padding::Min(min) => len >= min && padme(len) == len,
    }
}

/// The number of bytes standard base64 text decodes to, or `None` if it
/// can't be base64.
pub fn base64_len(text: &str) -> Option<u64> {
    let len = text.len() as u64;
    if !len.is_multiple_of(4) {
        return None;
    }
    let pad = text.bytes().rev().take_while(|&b| b == b'=').count() as u64;
    if pad > 2 {
        return None;
    }
    Some(len / 4 * 3 - pad)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn padme_matches_the_browser() {
        // From js/crypto.mjs padme (tests/unit/padding.test.mjs checks the
        // same values).
        for (length, padded) in [
            (0, 0),
            (1, 1),
            (2, 2),
            (3, 3),
            (9, 10),
            (100, 104),
            (4096, 4096),
            (4097, 4352),
            (5000, 5120),
            (300_000, 303_104),
            (1_000_000, 1_015_808),
            (26_214_404, 26_738_688),
        ] {
            assert_eq!(padme(length), padded, "padme({length})");
        }
    }

    #[test]
    fn padme_overhead_is_small_and_stable() {
        for length in (2..200_000).step_by(7) {
            let padded = padme(length);
            assert!(padded >= length);
            assert!(
                padded as f64 <= length as f64 * 1.12 + 1.0,
                "{length} -> {padded}"
            );
            assert_eq!(padme(padded), padded, "padding twice changes nothing");
        }
    }

    #[test]
    fn checks_padded_parts() {
        assert!(is_padded(4096 + 16, TEXT));
        assert!(is_padded(5120 + 16, TEXT));
        assert!(!is_padded(5000 + 16, TEXT), "not a Padmé size");
        assert!(!is_padded(1024 + 16, TEXT), "under the minimum");
        assert!(!is_padded(10, TEXT));
        assert!(is_padded(512 + 16, TITLE));
        assert!(!is_padded(1024 + 16, TITLE));
        assert!(is_padded(1024 + 16, FILE_NAME));
    }

    #[test]
    fn base64_lengths() {
        assert_eq!(base64_len(""), Some(0));
        assert_eq!(base64_len("YQ=="), Some(1));
        assert_eq!(base64_len("YWI="), Some(2));
        assert_eq!(base64_len("YWJj"), Some(3));
        assert_eq!(base64_len("YWJ"), None);
        assert_eq!(base64_len("Y==="), None);
    }
}
