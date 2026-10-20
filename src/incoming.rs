//! New pastes as sent to /api/submit_paste, and the checks they must pass.
//!
//! The create page never sends anything that fails these. They stop other
//! clients from storing pastes the site promises can't exist: ones that never
//! expire, or that skip the access proof (see access.rs).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::secrets;

/// The longest a paste can live; the create page's longest choice.
pub const MAX_LIFETIME: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// The paste format new pastes must use (js/crypto.mjs PASTE_VERSION).
const CURRENT_VERSION: u32 = 3;
/// AES-GCM base IV, which v3 also uses as the key derivation salt.
const IV_BYTES: usize = 12;

// Size limits, in characters, each comfortably above what the create page
// sends: 1 MB of text compressed, encrypted and base64 encoded; a 64-character
// title and a file name, encrypted.
const MAX_CONTENT_CHARS: usize = 1_450_000;
const MAX_TITLE_CHARS: usize = 1024;
const MAX_FILE_NAME_CHARS: usize = 2048;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingPaste {
    pub content: String,
    pub iv: Vec<u8>,
    /// How long the paste lives, in seconds, capped at MAX_LIFETIME.
    #[serde(default)]
    pub expires_in: Option<u64>,
    /// Older clients: when it expires, in ms since the epoch. Capped the same
    /// way.
    #[serde(default)]
    pub expires: Option<u64>,
    pub max_views: Option<u64>,
    #[serde(default)]
    pub key_fragment: String,
    // Only v1 pastes had one.
    #[serde(default)]
    pub password_hash: Option<String>,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default = "crate::paste_db::legacy_version")]
    pub version: u32,
    pub title: String,
    pub syntax: String,
    pub file_name: Option<String>,
    /// Size of the encrypted attachment that will be uploaded. Older clients
    /// don't send it; they're allowed the maximum.
    #[serde(default)]
    pub file_size: Option<u64>,
    /// SHA-256 (hex) of the access proof the browser derived from the link.
    #[serde(default)]
    pub access_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingPasteRes {
    pub id: Option<String>,
    /// Only for pastes with an attachment: the one-time token for
    /// /api/upload-attachment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_token: Option<String>,
    /// For the creator's delete link (/delete/<id>#<token>).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_token: Option<String>,
}

impl IncomingPaste {
    /// Checks the paste and returns when it expires (ms since the epoch), or
    /// what's wrong with it.
    pub fn check(&self, now_ms: u64) -> Result<u64, &'static str> {
        if !test_legacy_pastes() {
            if self.version != CURRENT_VERSION {
                return Err("only the current paste format (version 3) can be created");
            }
            if !self
                .access_hash
                .as_deref()
                .is_some_and(secrets::is_sha256_hex)
            {
                return Err("access_hash is missing or malformed");
            }
            if !self.key_fragment.is_empty() || self.password_hash.is_some() {
                return Err("version 3 pastes don't store key material");
            }
        }

        if self.iv.len() != IV_BYTES {
            return Err("iv must be 12 bytes");
        }
        if self.content.is_empty() || self.content.len() > MAX_CONTENT_CHARS {
            return Err("content is empty or too large");
        }
        if self.title.len() > MAX_TITLE_CHARS {
            return Err("title is too long");
        }
        if self
            .file_name
            .as_ref()
            .is_some_and(|name| name.len() > MAX_FILE_NAME_CHARS)
        {
            return Err("file_name is too long");
        }
        if !crate::get_languages()
            .iter()
            .any(|(key, _)| *key == self.syntax)
        {
            return Err("unknown syntax");
        }
        if self.max_views == Some(0) {
            return Err("max_views must be at least 1");
        }

        let max_ms = MAX_LIFETIME.as_millis() as u64;
        let lifetime_ms = match (self.expires_in, self.expires) {
            (Some(seconds), _) => seconds.saturating_mul(1000),
            (None, Some(at)) => at.saturating_sub(now_ms),
            (None, None) => max_ms,
        };
        if lifetime_ms == 0 {
            return Err("the expiry time must be in the future");
        }
        Ok(now_ms + lifetime_ms.min(max_ms))
    }
}

/// Lets the browser tests create pastes the way older versions did (v1/v2,
/// or v3 without an access proof), to check they still open. Only in debug
/// builds, and only with the variable set: release builds don't contain it.
#[cfg(debug_assertions)]
fn test_legacy_pastes() -> bool {
    std::env::var_os("E2EPASTE_TEST_LEGACY_PASTES").is_some()
}

#[cfg(not(debug_assertions))]
fn test_legacy_pastes() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;
    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    fn paste() -> IncomingPaste {
        IncomingPaste {
            content: "Y2lwaGVydGV4dA==".into(),
            iv: vec![7; 12],
            expires_in: Some(3 * 24 * 60 * 60),
            expires: None,
            max_views: None,
            key_fragment: String::new(),
            password_hash: None,
            has_password: false,
            version: 3,
            title: "dGl0bGU=".into(),
            syntax: "auto".into(),
            file_name: None,
            file_size: None,
            access_hash: Some("ab".repeat(32)),
        }
    }

    #[test]
    fn accepts_what_the_create_page_sends() {
        assert_eq!(paste().check(NOW), Ok(NOW + 3 * DAY_MS));
    }

    #[test]
    fn caps_the_lifetime_at_a_year() {
        let max = NOW + MAX_LIFETIME.as_millis() as u64;
        let mut p = paste();
        p.expires_in = Some(u64::MAX);
        assert_eq!(p.check(NOW), Ok(max));
        p.expires_in = None;
        p.expires = Some(u64::MAX);
        assert_eq!(p.check(NOW), Ok(max), "older clients' absolute time too");
        p.expires = None;
        assert_eq!(p.check(NOW), Ok(max), "no expiry means the longest");
        p.expires = Some(NOW + DAY_MS);
        assert_eq!(p.check(NOW), Ok(NOW + DAY_MS));
    }

    #[test]
    fn refuses_expiry_in_the_past() {
        let mut p = paste();
        p.expires_in = Some(0);
        assert!(p.check(NOW).is_err());
        p.expires_in = None;
        p.expires = Some(NOW - 1);
        assert!(p.check(NOW).is_err());
    }

    #[test]
    fn refuses_old_formats_and_missing_proofs() {
        for version in [1, 2, 4] {
            let mut p = paste();
            p.version = version;
            assert!(p.check(NOW).is_err(), "version {version}");
        }
        let mut p = paste();
        p.access_hash = None;
        assert!(p.check(NOW).is_err());
        p.access_hash = Some("not a hash".into());
        assert!(p.check(NOW).is_err());
        let mut p = paste();
        p.key_fragment = "key".into();
        assert!(p.check(NOW).is_err());
        let mut p = paste();
        p.password_hash = Some("hash".into());
        assert!(p.check(NOW).is_err());
    }

    /// Makes a valid paste invalid in one way.
    type Spoil = fn(&mut IncomingPaste);

    #[test]
    fn refuses_bad_fields() {
        let cases: [(&str, Spoil); 7] = [
            ("short iv", |p| p.iv = vec![1; 8]),
            ("empty content", |p| p.content.clear()),
            ("huge content", |p| {
                p.content = "a".repeat(MAX_CONTENT_CHARS + 1)
            }),
            ("huge title", |p| p.title = "a".repeat(MAX_TITLE_CHARS + 1)),
            ("huge file name", |p| {
                p.file_name = Some("a".repeat(MAX_FILE_NAME_CHARS + 1))
            }),
            ("unknown syntax", |p| p.syntax = "<script>".into()),
            ("zero views", |p| p.max_views = Some(0)),
        ];
        for (label, spoil) in cases {
            let mut p = paste();
            spoil(&mut p);
            assert!(p.check(NOW).is_err(), "{label}");
        }
        let mut p = paste();
        p.syntax = "rust".into();
        p.max_views = Some(1);
        assert!(p.check(NOW).is_ok());
    }
}
