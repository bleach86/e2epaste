//! Site settings, read from Rocket's config: `Rocket.toml`, overridden by
//! `ROCKET_<KEY>` environment variables (e.g. `ROCKET_SITE_URL`).

use std::path::{Path, PathBuf};

use rocket::figment::Figment;
use rocket::http::uri::Absolute;
use serde::Deserialize;

/// Largest attachment upload. The browser allows 25 MiB; this leaves room for
/// the encryption and compression overhead.
pub const MAX_ATTACHMENT_MIB: u64 = 26;

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

        if config.upload_mib_per_hour != 0 && config.upload_mib_per_hour < MAX_ATTACHMENT_MIB {
            return Err(format!(
                "upload_mib_per_hour is {}, but one attachment can be up to {MAX_ATTACHMENT_MIB} \
                 MiB. Set it to at least {MAX_ATTACHMENT_MIB}, or 0 for no limit.",
                config.upload_mib_per_hour
            ));
        }

        if !config.static_dir.join("js/dist").is_dir() {
            return Err(format!(
                "static_dir {:?} has no js/dist/ (the webpack bundles). Set static_dir to the \
                 project's static/ directory, or build the bundles with `cargo build`.",
                config.static_dir
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
        warnings
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
    if parsed.authority().is_none_or(|a| a.host().is_empty()) {
        return invalid("has no host name");
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
    fn site_name_must_fit() {
        assert!(site_name(&"a".repeat(MAX_SITE_NAME_CHARS), "https://x.example").is_ok());
        assert!(site_name(&"a".repeat(MAX_SITE_NAME_CHARS + 1), "https://x.example").is_err());
        assert!(site_name("two\nlines", "https://x.example").is_err());
    }
}
