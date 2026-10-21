//! The e2ePaste v4 paste format's sizes, shared by the server (which
//! refuses pastes that aren't padded: a client that skipped it would leak
//! exact sizes) and the `e2ep` client (which pads). They match js/crypto.mjs
//! `padme`, `PART_PADDING` and the attachment layout; tests on both sides
//! check the same values.

/// The paste format version these rules are for (js/crypto.mjs
/// PASTE_VERSION).
pub const FORMAT_VERSION: u32 = 4;

/// AES-GCM's tag, added to every encrypted part.
pub const TAG_BYTES: u64 = 16;

/// How a part is padded before encryption.
#[derive(Clone, Copy)]
pub enum Padding {
    /// Padmé, from this size up.
    Min(u64),
    /// Always exactly this size.
    Fixed(u64),
}

pub const TEXT: Padding = Padding::Min(4096);
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

/// The length prefix in front of each part's data.
pub const LENGTH_BYTES: u64 = 4;

/// The padded size, before encryption, of a part holding `len` bytes of
/// (compressed) data, with its length prefix; `None` if it doesn't fit a
/// fixed size.
pub fn padded_len(len: u64, padding: Padding) -> Option<u64> {
    let framed = LENGTH_BYTES + len;
    match padding {
        Padding::Fixed(size) => (framed <= size).then_some(size),
        Padding::Min(min) => Some(padme(min.max(framed))),
    }
}

/// The most `len` bytes can grow when deflated: zlib's deflateBound (data
/// that won't compress is stored in blocks with a few bytes of framing),
/// with some room to spare.
fn deflate_bound(len: u64) -> u64 {
    len + (len >> 12) + (len >> 14) + (len >> 25) + 64
}

/// The largest encrypted size a part holding up to `len` bytes can have:
/// compressed (at worst growing slightly), length-prefixed, padded and
/// encrypted.
pub fn max_encrypted_len(len: u64, padding: Padding) -> u64 {
    let padded = match padding {
        Padding::Fixed(size) => size,
        Padding::Min(min) => padme(min.max(LENGTH_BYTES + deflate_bound(len))),
    };
    padded + TAG_BYTES
}

// --- Attachments ---------------------------------------------------------------
//
// Encrypted in chunks (js/crypto.mjs encryptFile): the stream [8-byte
// size][file][zeros] is padded to a Padmé size of at least 4 KiB, then cut
// into 1 MiB chunks, each stored with its own tag.

/// One chunk of an attachment, before encryption.
pub const FILE_CHUNK_BYTES: u64 = 1 << 20;
/// One chunk as uploaded and stored.
pub const ENCRYPTED_CHUNK_BYTES: u64 = FILE_CHUNK_BYTES + TAG_BYTES;
/// The file's size, in front of it in the stream.
pub const FILE_SIZE_BYTES: u64 = 8;
const FILE_MIN_PADDED: u64 = 4096;

/// The padded size of a file of `size` bytes, before encryption: the length
/// of the stream that's cut into chunks.
pub fn padded_file_len(size: u64) -> u64 {
    padme(FILE_MIN_PADDED.max(FILE_SIZE_BYTES + size))
}

fn encrypted_file_len_from_padded(padded: u64) -> u64 {
    padded + TAG_BYTES * padded.div_ceil(FILE_CHUNK_BYTES)
}

/// What a file of `size` bytes is stored as, encrypted.
pub fn encrypted_file_len(size: u64) -> u64 {
    encrypted_file_len_from_padded(padded_file_len(size))
}

/// Whether `len` is the encrypted size of some padded file.
pub fn is_encrypted_file_len(len: u64) -> bool {
    let chunks = len.div_ceil(ENCRYPTED_CHUNK_BYTES);
    let Some(padded) = len.checked_sub(TAG_BYTES * chunks) else {
        return false;
    };
    padded >= FILE_MIN_PADDED
        && padme(padded) == padded
        && encrypted_file_len_from_padded(padded) == len
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
        assert!(!is_padded(4096 + 16, TITLE));
        assert!(!is_padded(1024 + 16, TITLE));
        assert!(is_padded(1024 + 16, FILE_NAME));
    }

    #[test]
    fn attachment_sizes() {
        // Matching js/crypto.mjs encryptedFileLength (tests/unit/
        // attachments.test.mjs checks real uploads against it).
        assert_eq!(encrypted_file_len(0), 4096 + 16);
        assert_eq!(encrypted_file_len(6000), 6144 + 16);
        assert_eq!(encrypted_file_len(1 << 20), 1_081_344 + 2 * 16);
        assert_eq!(encrypted_file_len(25 << 20), 26_738_688 + 26 * 16);
        for size in (0..3_000_000)
            .step_by(997)
            .chain([1 << 20, (1 << 20) - 8, 100 << 20])
        {
            let len = encrypted_file_len(size);
            assert!(is_encrypted_file_len(len), "{size} -> {len}");
            assert!(!is_encrypted_file_len(len + 1), "{size} -> {len} + 1");
        }
        assert!(!is_encrypted_file_len(0));
        assert!(!is_encrypted_file_len(5000 + 16), "not a Padmé size");
        assert!(!is_encrypted_file_len(2048 + 16), "under the minimum");
        // A whole chunk's padded size with the wrong number of tags.
        assert!(!is_encrypted_file_len(1_081_344 + 16));
    }

    #[test]
    fn worst_case_sizes() {
        // The default: 1 MiB of text.
        assert_eq!(max_encrypted_len(1 << 20, TEXT), 1_081_344 + 16);
        assert_eq!(max_encrypted_len(10, TEXT), 4096 + 16);
        assert_eq!(max_encrypted_len(10, TITLE), 512 + 16);
        // Never less than what the data can actually take.
        for len in [0, 1, 4000, 65_535, 65_536, 1 << 20, 100 << 20] {
            let stored = max_encrypted_len(len, TEXT) - TAG_BYTES;
            assert!(stored >= len + LENGTH_BYTES + 11, "{len}");
            assert!(is_padded(stored + TAG_BYTES, TEXT), "{len} -> {stored}");
        }
    }

    #[test]
    fn padded_lengths() {
        assert_eq!(padded_len(0, TEXT), Some(4096));
        assert_eq!(padded_len(4996, TEXT), Some(5120));
        assert_eq!(padded_len(508, TITLE), Some(512));
        assert_eq!(padded_len(509, TITLE), None);
        assert_eq!(padded_file_len(6000), 6144);
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
