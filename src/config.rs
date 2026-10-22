//! Site settings, read from Rocket's config: `Rocket.toml`, overridden by
//! `ROCKET_<KEY>` environment variables (e.g. `ROCKET_SITE_URL`).

use std::path::{Path, PathBuf};

use rocket::figment::value::magic::RelativePathBuf;
use rocket::figment::Figment;
use rocket::http::uri::Absolute;
use serde::{Deserialize, Serialize};

use crate::padding;

#[derive(Debug, Deserialize)]
pub struct AppConfig {
    /// Public address of the site, e.g. `https://paste.example.com`. Used for
    /// canonical links, the sitemap and link previews.
    #[serde(default = "default_site_url")]
    pub site_url: String,
    /// The site's name, in page titles, the header and link previews.
    /// Defaults to site_url's host name, e.g. "paste.example.com".
    #[serde(default)]
    pub site_name: String,
    /// Where the "source code" links point: the code this site runs.
    #[serde(default = "default_source_url")]
    pub source_url: String,
    /// Holds `e2epaste.redb` (the database) and `file_store/` (attachments).
    #[serde(default = "default_data_dir")]
    pub data_dir: PathBuf,
    /// Served at /public. Must contain the webpack bundles in `js/dist/`.
    #[serde(default = "default_static_dir")]
    pub static_dir: PathBuf,
    /// The page templates. rocket_dyn_templates reads this setting itself;
    /// it's here only to check the directory exists before the server
    /// starts, since otherwise every page is a 500. When set in Rocket.toml,
    /// it's relative to that file.
    #[serde(default = "default_template_dir")]
    pub template_dir: RelativePathBuf,

    // What one paste can hold (see PasteLimits).
    /// Largest paste text, in KiB of UTF-8.
    #[serde(default = "default_max_paste_kib")]
    pub max_paste_kib: u64,
    /// Whether pastes can have an attachment.
    #[serde(default = "default_allow_files")]
    pub allow_files: bool,
    /// Largest attachment, in MiB.
    #[serde(default = "default_max_file_mib")]
    pub max_file_mib: u64,

    // Per-client limits (see rate_limit.rs). 0 turns a limit off.
    #[serde(default = "default_pastes_per_minute")]
    pub pastes_per_minute: u64,
    #[serde(default = "default_pastes_per_hour")]
    pub pastes_per_hour: u64,
    #[serde(default = "default_upload_mib_per_hour")]
    pub upload_mib_per_hour: u64,

    // Storage limits. 0 turns a limit off.
    /// New pastes are refused when the disk holding data_dir has less free.
    #[serde(default = "default_min_free_disk_mib")]
    pub min_free_disk_mib: u64,
    /// Cap on the total size of all attachments.
    #[serde(default)]
    pub max_attachment_storage_mib: u64,

    /// Failed attempts to open or delete a paste (wrong link, password or
    /// delete token) allowed per IP per hour.
    #[serde(default = "default_unlock_attempts_per_hour")]
    pub unlock_attempts_per_hour: u64,

    /// Enables /api/admin/ for the site's operator. Unset or empty: disabled.
    #[serde(default)]
    pub admin_token: Option<String>,
}

fn default_source_url() -> String {
    "https://github.com/bleach86/e2epaste".to_string()
}

/// Longest site_name accepted; it has to fit in the header on a phone.
const MAX_SITE_NAME_CHARS: usize = 40;

fn default_site_url() -> String {
    "http://localhost:8001".to_string()
}

fn default_data_dir() -> PathBuf {
    PathBuf::from(".")
}

fn default_static_dir() -> PathBuf {
    PathBuf::from("static")
}

fn default_template_dir() -> RelativePathBuf {
    RelativePathBuf::from("templates")
}

/// The most any setting in MiB can be: a settings value is multiplied by
/// MIB, which must not overflow.
const MAX_MIB_SETTING: u64 = 1 << 40;

fn default_max_paste_kib() -> u64 {
    1024
}

fn default_allow_files() -> bool {
    true
}

fn default_max_file_mib() -> u64 {
    25
}

/// The most max_paste_kib can be: a paste is sent as one JSON request and
/// held in memory.
const MAX_PASTE_KIB_LIMIT: u64 = 64 * 1024;
/// The most max_file_mib can be. Attachments are encrypted and uploaded in
/// chunks, but a download is put back together in the browser.
const MAX_FILE_MIB_LIMIT: u64 = 4096;
/// Above this, warn that downloads this large can fail on phones.
const LARGE_FILE_MIB: u64 = 1024;

fn default_pastes_per_minute() -> u64 {
    10
}

fn default_pastes_per_hour() -> u64 {
    60
}

fn default_upload_mib_per_hour() -> u64 {
    250
}

fn default_min_free_disk_mib() -> u64 {
    1024
}

fn default_unlock_attempts_per_hour() -> u64 {
    30
}

/// Shortest admin_token accepted; it's the only thing guarding admin actions.
const MIN_ADMIN_TOKEN_LEN: usize = 32;

pub const MIB: u64 = 1024 * 1024;

impl AppConfig {
    pub fn from_figment(figment: &Figment) -> Result<Self, String> {
        let mut config: AppConfig = figment.extract().map_err(|e| e.to_string())?;
        config.site_url = normalize_site_url(&config.site_url)?;
        config.site_name = site_name(&config.site_name, &config.site_url)?;
        let source_ok = Absolute::parse(&config.source_url)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https"));
        if !source_ok {
            return Err(format!(
                "source_url {:?} isn't an http(s) address",
                config.source_url
            ));
        }

        config.admin_token = config
            .admin_token
            .take()
            .filter(|token| !token.trim().is_empty());
        if config
            .admin_token
            .as_ref()
            .is_some_and(|token| token.len() < MIN_ADMIN_TOKEN_LEN)
        {
            return Err(format!(
                "admin_token must be at least {MIN_ADMIN_TOKEN_LEN} characters. Generate one with \
                 `openssl rand -hex 32`."
            ));
        }

        if !(1..=MAX_PASTE_KIB_LIMIT).contains(&config.max_paste_kib) {
            return Err(format!(
                "max_paste_kib is {}; it must be from 1 to {MAX_PASTE_KIB_LIMIT}",
                config.max_paste_kib
            ));
        }
        if config.allow_files && !(1..=MAX_FILE_MIB_LIMIT).contains(&config.max_file_mib) {
            return Err(format!(
                "max_file_mib is {}; it must be from 1 to {MAX_FILE_MIB_LIMIT}. To turn \
                 attachments off, set allow_files = false.",
                config.max_file_mib
            ));
        }
        // One attachment, encrypted and padded, must fit in an hour's
        // allowance, or it could never be uploaded.
        if let Some(stored) = config.paste_limits().max_stored_file {
            let needed = stored.div_ceil(MIB);
            if config.upload_mib_per_hour != 0 && config.upload_mib_per_hour < needed {
                return Err(format!(
                    "upload_mib_per_hour is {}, but one attachment can take up to {needed} MiB \
                     (max_file_mib, encrypted and padded). Set it to at least {needed}, or 0 for \
                     no limit.",
                    config.upload_mib_per_hour
                ));
            }
        }

        for (name, value) in [
            ("upload_mib_per_hour", config.upload_mib_per_hour),
            ("min_free_disk_mib", config.min_free_disk_mib),
            (
                "max_attachment_storage_mib",
                config.max_attachment_storage_mib,
            ),
        ] {
            if value > MAX_MIB_SETTING {
                return Err(format!(
                    "{name} is {value}; it must be at most {MAX_MIB_SETTING} (or 0 for no limit)"
                ));
            }
        }

        if !config.static_dir.join("js/dist").is_dir() {
            return Err(format!(
                "static_dir {:?} has no js/dist/ (the webpack bundles). Set static_dir to the \
                 project's static/ directory, or build the bundles with `cargo build`.",
                config.static_dir
            ));
        }
        let templates = config.template_dir.relative();
        if !templates.join("layout.html.j2").is_file() {
            return Err(format!(
                "template_dir {templates:?} has no layout.html.j2. Set template_dir to the \
                 project's templates/ directory."
            ));
        }
        Ok(config)
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("e2epaste.redb")
    }

    /// The sled database used before redb, imported on the first start.
    pub fn legacy_sled_dir(&self) -> PathBuf {
        self.data_dir.join("paste_db")
    }

    pub fn file_dir(&self) -> PathBuf {
        self.data_dir.join("file_store")
    }

    pub fn dist_dir(&self) -> PathBuf {
        self.static_dir.join("js/dist")
    }

    pub fn paste_limits(&self) -> PasteLimits {
        PasteLimits::new(
            self.max_paste_kib * 1024,
            self.allow_files.then_some(self.max_file_mib * MIB),
        )
    }

    /// Problems worth logging that don't stop the server.
    pub fn warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        let local = is_local(&self.site_url);
        if !local && self.site_url.starts_with("http://") {
            warnings.push(format!(
                "site_url {} is plain HTTP. Browsers only allow encryption on HTTPS pages, so \
                 serve the site over HTTPS and set site_url to its https:// address.",
                self.site_url
            ));
        }
        if local && cfg!(not(debug_assertions)) {
            warnings.push(format!(
                "site_url is {}. Set it to your public address (site_url in Rocket.toml or \
                 ROCKET_SITE_URL) so canonical links, the sitemap and link previews point there.",
                self.site_url
            ));
        }
        if self.allow_files && self.max_file_mib > LARGE_FILE_MIB {
            warnings.push(format!(
                "max_file_mib is {}. Downloads are put back together in the browser, so \
                 attachments this large may fail to download on phones.",
                self.max_file_mib
            ));
        }
        warnings
    }
}

/// What one paste can hold, from max_paste_kib, max_file_mib and
/// allow_files. The browser limits apply before encryption; the server
/// checks the encrypted sizes, which allow for compression and padding.
#[derive(Clone, Debug, Serialize)]
pub struct PasteLimits {
    /// Paste text, in bytes of UTF-8.
    pub max_paste_bytes: u64,
    /// An attachment, in bytes. `None` when attachments are off.
    pub max_file_bytes: Option<u64>,
    /// The paste text's largest encrypted size.
    pub max_stored_paste: u64,
    /// An attachment's largest encrypted size.
    pub max_stored_file: Option<u64>,
    /// For people: "1 MB", "512 KB".
    pub max_paste_label: String,
    pub max_file_label: Option<String>,
}

impl PasteLimits {
    pub fn new(max_paste_bytes: u64, max_file_bytes: Option<u64>) -> Self {
        PasteLimits {
            max_paste_bytes,
            max_file_bytes,
            max_stored_paste: padding::max_encrypted_len(max_paste_bytes, padding::TEXT),
            max_stored_file: max_file_bytes.map(padding::encrypted_file_len),
            max_paste_label: size_label(max_paste_bytes),
            max_file_label: max_file_bytes.map(size_label),
        }
    }

    /// The largest JSON request a new paste can need: its text base64
    /// encoded, plus the title, file name and the rest.
    pub fn max_request_bytes(&self) -> u64 {
        self.max_stored_paste.div_ceil(3) * 4 + 64 * 1024
    }
}

/// "25 MB", "1 MB", "512 KB". Sizes here are in powers of 1024 but shown as
/// MB and KB, like most file managers.
fn size_label(bytes: u64) -> String {
    if bytes >= MIB && bytes.is_multiple_of(MIB) {
        format!("{} MB", bytes / MIB)
    } else if bytes >= MIB {
        format!("{:.1} MB", bytes as f64 / MIB as f64)
    } else {
        format!("{} KB", bytes.div_ceil(1024))
    }
}

/// Checks the URL is a bare http(s) origin and drops any trailing slash, so
/// paths can be appended directly.
fn normalize_site_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    let invalid = |why: &str| {
        Err(format!(
            "site_url {raw:?} {why}. Use the site's address, like https://paste.example.com"
        ))
    };

    let parsed = match Absolute::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => return invalid("isn't a valid URL"),
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return invalid("must start with https:// or http://");
    }
    let Some(authority) = parsed.authority().filter(|a| !a.host().is_empty()) else {
        return invalid("has no host name");
    };
    // It's printed into every page, the sitemap and robots.txt.
    if authority.user_info().is_some() {
        return invalid("can't have a user name or password");
    }
    // Pages link to /public/... and /s/..., so the site must be at the root.
    if !parsed.path().is_empty() || parsed.query().is_some() {
        return invalid("can't have a path or query string");
    }
    Ok(url.to_string())
}

/// The configured name, or the host name from site_url ("e2ePaste" for a
/// local address, where the host name means nothing to anyone).
fn site_name(configured: &str, site_url: &str) -> Result<String, String> {
    let name = configured.trim();
    if name.is_empty() {
        return Ok(match is_local(site_url) {
            true => "e2ePaste".to_string(),
            false => host(site_url),
        });
    }
    if name.chars().count() > MAX_SITE_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(format!(
            "site_name {name:?} must be at most {MAX_SITE_NAME_CHARS} characters, on one line"
        ));
    }
    Ok(name.to_string())
}

fn host(site_url: &str) -> String {
    Absolute::parse(site_url)
        .ok()
        .and_then(|url| url.authority().map(|a| a.host().to_string()))
        .unwrap_or_default()
}

fn is_local(site_url: &str) -> bool {
    let host = host(site_url);
    host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

/// Creates the data directories if they don't exist yet.
pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("can't create {path:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_name_defaults_to_the_host() {
        assert_eq!(
            site_name("", "https://paste.example.com").unwrap(),
            "paste.example.com"
        );
        assert_eq!(
            site_name("  ", "https://paste.example.com").unwrap(),
            "paste.example.com"
        );
        assert_eq!(site_name("", "http://localhost:8001").unwrap(), "e2ePaste");
        assert_eq!(
            site_name(" My Paste ", "https://x.example").unwrap(),
            "My Paste"
        );
    }

    #[test]
    fn size_labels() {
        assert_eq!(size_label(MIB), "1 MB");
        assert_eq!(size_label(25 * MIB), "25 MB");
        assert_eq!(size_label(512 * 1024), "512 KB");
        assert_eq!(size_label(1536 * 1024), "1.5 MB");
    }

    #[test]
    fn default_limits() {
        let limits = PasteLimits::new(1024 * 1024, Some(25 * MIB));
        assert_eq!(limits.max_paste_label, "1 MB");
        assert_eq!(limits.max_file_label.as_deref(), Some("25 MB"));
        // Room for the worst case of 1 MiB of text that won't compress.
        assert!(limits.max_stored_paste > 1024 * 1024);
        assert!(limits.max_request_bytes() < 2 * MIB);
        let no_files = PasteLimits::new(8 * 1024, None);
        assert!(no_files.max_stored_file.is_none() && no_files.max_file_label.is_none());
    }

    #[test]
    fn site_url_is_a_bare_origin() {
        assert_eq!(
            normalize_site_url("https://paste.example.com/").unwrap(),
            "https://paste.example.com"
        );
        assert_eq!(
            normalize_site_url("http://localhost:8001").unwrap(),
            "http://localhost:8001"
        );
        for bad in [
            "paste.example.com",
            "ftp://paste.example.com",
            "https://paste.example.com/pastes",
            "https://paste.example.com?x=1",
            "https://user:secret@paste.example.com",
            "https://",
        ] {
            assert!(normalize_site_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn site_name_must_fit() {
        assert!(site_name(&"a".repeat(MAX_SITE_NAME_CHARS), "https://x.example").is_ok());
        assert!(site_name(&"a".repeat(MAX_SITE_NAME_CHARS + 1), "https://x.example").is_err());
        assert!(site_name("two\nlines", "https://x.example").is_err());
    }
}
