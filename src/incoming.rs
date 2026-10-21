//! New pastes as sent to /api/submit_paste, and the checks they must pass.
//!
//! The create page never sends anything that fails these. They stop other
//! clients from storing pastes the site promises can't exist: ones that never
//! expire, that skip the access proof (see access.rs), or that tell the
//! server more than v4 pastes do (exact sizes, the language, whether there's
//! a password).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::PasteLimits;
use crate::padding::{self, Padding};
use crate::secrets;

/// The longest a paste can live; the create page's longest choice.
pub const MAX_LIFETIME: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// The paste format new pastes must use (js/crypto.mjs PASTE_VERSION).
const CURRENT_VERSION: u32 = 4;
/// AES-GCM base IV, which v3 also uses as the key derivation salt.
const IV_BYTES: usize = 12;

// Size limits, in characters, each above what the create page sends: the
// padded title and file name, encrypted and base64 encoded. The text's limit
// is a setting (PasteLimits).
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
    /// Checks the paste against the site's limits, and returns when it
    /// expires (ms since the epoch) or what's wrong with it.
    pub fn check(&self, now_ms: u64, limits: &PasteLimits) -> Result<u64, &'static str> {
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
                return Err("pastes don't store key material");
            }
        }
        // Also in the browser tests' legacy mode, which creates v4 pastes too.
        if self.version >= CURRENT_VERSION {
            self.check_v4_privacy()?;
        }

        if self.iv.len() != IV_BYTES {
            return Err("iv must be 12 bytes");
        }
        match padding::base64_len(&self.content) {
            Some(0) | None => return Err("content is empty or isn't base64"),
            Some(len) if len > limits.max_stored_paste => {
                return Err("content is larger than this site allows")
            }
            Some(_) => {}
        }
        if self.file_name.is_some() && limits.max_file_bytes.is_none() {
            return Err("this site doesn't accept attachments");
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

impl IncomingPaste {
    /// v4 pastes keep the language and the password flag encrypted or in the
    /// link, and pad every part (see padding.rs).
    fn check_v4_privacy(&self) -> Result<(), &'static str> {
        if self.syntax != "auto" {
            return Err("the language is encrypted with the title");
        }
        if self.has_password {
            return Err("whether there's a password is in the link");
        }
        let padded = |base64: &str, padding: Padding| {
            padding::base64_len(base64).is_some_and(|len| padding::is_padded(len, padding))
        };
        if !padded(&self.content, padding::TEXT) {
            return Err("content isn't padded");
        }
        if !padded(&self.title, padding::TITLE) {
            return Err("title isn't padded");
        }
        match (&self.file_name, self.file_size) {
            (None, _) => Ok(()),
            (Some(_), None) => Err("file_size is required with an attachment"),
            (Some(name), Some(size))
                if padded(name, padding::FILE_NAME) && padding::is_encrypted_file_len(size) =>
            {
                Ok(())
            }
            (Some(_), Some(_)) => Err("the attachment's name or size isn't padded"),
        }
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

    fn limits() -> PasteLimits {
        PasteLimits::new(1024 * 1024, Some(25 * 1024 * 1024))
    }

    /// Base64 text that decodes to `bytes` bytes.
    fn base64_of(bytes: usize) -> String {
        let tail = ["", "AA==", "AAA="][bytes % 3];
        "A".repeat(bytes / 3 * 4) + tail
    }

    /// As the create page sends it: every part padded, plus the 16-byte tag.
    fn paste() -> IncomingPaste {
        IncomingPaste {
            content: base64_of(4096 + 16),
            iv: vec![7; 12],
            expires_in: Some(3 * 24 * 60 * 60),
            expires: None,
            max_views: None,
            key_fragment: String::new(),
            password_hash: None,
            has_password: false,
            version: 4,
            title: base64_of(512 + 16),
            syntax: "auto".into(),
            file_name: None,
            file_size: None,
            access_hash: Some("ab".repeat(32)),
        }
    }

    #[test]
    fn accepts_what_the_create_page_sends() {
        assert_eq!(paste().check(NOW, &limits()), Ok(NOW + 3 * DAY_MS));
    }

    #[test]
    fn caps_the_lifetime_at_a_year() {
        let max = NOW + MAX_LIFETIME.as_millis() as u64;
        let mut p = paste();
        p.expires_in = Some(u64::MAX);
        assert_eq!(p.check(NOW, &limits()), Ok(max));
        p.expires_in = None;
        p.expires = Some(u64::MAX);
        assert_eq!(
            p.check(NOW, &limits()),
            Ok(max),
            "older clients' absolute time too"
        );
        p.expires = None;
        assert_eq!(
            p.check(NOW, &limits()),
            Ok(max),
            "no expiry means the longest"
        );
        p.expires = Some(NOW + DAY_MS);
        assert_eq!(p.check(NOW, &limits()), Ok(NOW + DAY_MS));
    }

    #[test]
    fn refuses_expiry_in_the_past() {
        let mut p = paste();
        p.expires_in = Some(0);
        assert!(p.check(NOW, &limits()).is_err());
        p.expires_in = None;
        p.expires = Some(NOW - 1);
        assert!(p.check(NOW, &limits()).is_err());
    }

    #[test]
    fn refuses_old_formats_and_missing_proofs() {
        for version in [1, 2, 3, 5] {
            let mut p = paste();
            p.version = version;
            assert!(p.check(NOW, &limits()).is_err(), "version {version}");
        }
        let mut p = paste();
        p.access_hash = None;
        assert!(p.check(NOW, &limits()).is_err());
        p.access_hash = Some("not a hash".into());
        assert!(p.check(NOW, &limits()).is_err());
        let mut p = paste();
        p.key_fragment = "key".into();
        assert!(p.check(NOW, &limits()).is_err());
        let mut p = paste();
        p.password_hash = Some("hash".into());
        assert!(p.check(NOW, &limits()).is_err());
    }

    /// Makes a valid paste invalid in one way.
    type Spoil = fn(&mut IncomingPaste);

    #[test]
    fn refuses_bad_fields() {
        let cases: [(&str, Spoil); 7] = [
            ("short iv", |p| p.iv = vec![1; 8]),
            ("empty content", |p| p.content.clear()),
            ("huge content", |p| {
                p.content = base64_of(1_081_344 + 16 + 1)
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
            assert!(p.check(NOW, &limits()).is_err(), "{label}");
        }
        let mut p = paste();
        p.max_views = Some(1);
        assert!(p.check(NOW, &limits()).is_ok());
    }

    #[test]
    fn refuses_what_v4_keeps_from_the_server() {
        let cases: [(&str, Spoil); 7] = [
            ("a chosen language", |p| p.syntax = "rust".into()),
            ("the password flag", |p| p.has_password = true),
            ("unpadded content", |p| p.content = base64_of(5000 + 16)),
            ("content under the minimum", |p| {
                p.content = base64_of(1024 + 16)
            }),
            ("unpadded title", |p| p.title = base64_of(100)),
            ("an attachment without its size", |p| {
                p.file_name = Some(base64_of(1024 + 16))
            }),
            ("an unpadded attachment", |p| {
                p.file_name = Some(base64_of(1024 + 16));
                p.file_size = Some(5000 + 16);
            }),
        ];
        for (label, spoil) in cases {
            let mut p = paste();
            spoil(&mut p);
            assert!(p.check(NOW, &limits()).is_err(), "{label}");
        }
        let mut p = paste();
        p.file_name = Some(base64_of(1024 + 16));
        p.file_size = Some(5120 + 16);
        p.content = base64_of(303_104 + 16);
        assert!(
            p.check(NOW, &limits()).is_ok(),
            "padded parts of other sizes"
        );
    }

    #[test]
    fn follows_the_sites_limits() {
        let small = PasteLimits::new(8 * 1024, None);
        assert!(paste().check(NOW, &small).is_ok());
        let mut p = paste();
        p.content = base64_of(16_384 + 16);
        assert!(p.check(NOW, &small).is_err(), "over max_paste_kib");
        assert!(p.check(NOW, &limits()).is_ok());
        let mut p = paste();
        p.file_name = Some(base64_of(1024 + 16));
        p.file_size = Some(4096 + 16);
        assert!(p.check(NOW, &limits()).is_ok());
        assert_eq!(
            p.check(NOW, &small),
            Err("this site doesn't accept attachments")
        );
    }
}
