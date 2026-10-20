//! Random tokens and checks against stored hashes of secrets.

use sha2::{Digest, Sha256};

/// 256 random bits, hex encoded.
pub fn new_token() -> String {
    let bytes: [u8; 32] = rand::random();
    to_hex(&bytes)
}

pub fn sha256_hex(data: &[u8]) -> String {
    to_hex(&Sha256::digest(data))
}

/// What's stored for a hex secret (a token or access proof): the SHA-256 of
/// its bytes, as hex. `None` if it isn't hex.
pub fn hash_secret(secret_hex: &str) -> Option<String> {
    from_hex(secret_hex).map(|secret| sha256_hex(&secret))
}

/// Whether `secret` (hex) hashes to `stored_hash`, compared in constant time.
pub fn matches_hash(secret_hex: &str, stored_hash: &str) -> bool {
    hash_secret(secret_hex)
        .is_some_and(|hash| constant_time_eq(hash.as_bytes(), stored_hash.as_bytes()))
}

/// Whether `value` is a hex SHA-256 hash, as sent by the browser.
pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) || hex.len() > 256 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_secrets_against_hashes() {
        // SHA-256 of the bytes 01 02 03.
        let hash = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
        assert_eq!(sha256_hex(&[1, 2, 3]), hash);
        assert!(matches_hash("010203", hash));
        assert!(!matches_hash("010204", hash));
        assert!(!matches_hash("not hex", hash));
        assert!(!matches_hash("01020", hash));
        assert!(is_sha256_hex(hash));
        assert!(!is_sha256_hex(&hash.to_uppercase()));
        assert!(!is_sha256_hex("abc"));
        let token = new_token();
        assert_eq!(token.len(), 64);
        assert!(matches_hash(&token, &hash_secret(&token).unwrap()));
    }
}
