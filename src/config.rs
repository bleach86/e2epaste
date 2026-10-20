//! Site settings, read from Rocket's config: `Rocket.toml`, overridden by
//! `ROCKET_<KEY>` environment variables (e.g. `ROCKET_SITE_URL`).

use std::path::{Path, PathBuf};

use rocket::figment::Figment;
use rocket::http::uri::Absolute;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AppConfig {
    /// Public address of the site, e.g. `https://paste.example.com`. Used for
    /// canonical links, the sitemap and link previews.
    #[serde(default = "default_site_url")]
    pub site_url: String,
    /// Holds `paste_db/` (the database) and `file_store/` (attachments).
    #[serde(default = "default_data_dir")]
    pub data_dir: PathBuf,
    /// Served at /public. Must contain the webpack bundles in `js/dist/`.
    #[serde(default = "default_static_dir")]
    pub static_dir: PathBuf,
}

fn default_site_url() -> String {
    "http://localhost:8001".to_string()
}

fn default_data_dir() -> PathBuf {
    PathBuf::from(".")
}

fn default_static_dir() -> PathBuf {
    PathBuf::from("static")
}

impl AppConfig {
    pub fn from_figment(figment: &Figment) -> Result<Self, String> {
        let mut config: AppConfig = figment.extract().map_err(|e| e.to_string())?;
        config.site_url = normalize_site_url(&config.site_url)?;

        if !config.static_dir.join("js/dist").is_dir() {
            return Err(format!(
                "static_dir {:?} has no js/dist/ (the webpack bundles). Set static_dir to the \
                 project's static/ directory, or build the bundles with `cargo build`.",
                config.static_dir
            ));
        }
        Ok(config)
    }

    pub fn db_dir(&self) -> PathBuf {
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
    if parsed.authority().map_or(true, |a| a.host().is_empty()) {
        return invalid("has no host name");
    }
    // Pages link to /public/... and /s/..., so the site must be at the root.
    if !parsed.path().is_empty() || parsed.query().is_some() {
        return invalid("can't have a path or query string");
    }
    Ok(url.to_string())
}

fn is_local(site_url: &str) -> bool {
    let host = Absolute::parse(site_url)
        .ok()
        .and_then(|url| url.authority().map(|a| a.host().to_string()))
        .unwrap_or_default();
    host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

/// Creates the data directories if they don't exist yet.
pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("can't create {path:?}: {e}"))
}
