extern crate sled;
use rocket::tokio;
use serde::{Deserialize, Serialize};
use sled::{Db, Result, Tree};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::paste_id::PasteId;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PasteData<'a> {
    pub content: String,
    pub iv: Vec<u8>,
    pub key_fragment: String,
    pub id: PasteId<'a>,
    pub timestamp: i64,
    pub expires: Option<u64>,
    pub views: u64,
    pub max_views: Option<u64>,
    // Only set on v1 pastes; never sent to the browser.
    pub password_hash: Option<String>,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default = "legacy_version")]
    pub version: u32,
    pub title: String,
    pub syntax: String,
    pub file_name: Option<String>,
}

/// Pastes stored before the `version` field existed use the v1 format.
pub fn legacy_version() -> u32 {
    1
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SiteStats {
    pub pastes: u64,
    pub views: u64,
}

#[derive(Clone, Debug)]
pub struct PasteDB {
    pub paste_db: Tree,
    pub site_stats: Tree,
    pub expire_index: Tree,
    /// Paste ID -> one-time token for uploading its attachment, followed by
    /// the attachment's maximum size (8 bytes, big endian). Kept out of
    /// PasteData so it's never sent to viewers.
    upload_tokens: Tree,
    pub db: Db,
    /// Where attachments are stored, one `<id>.bin` per paste.
    file_dir: PathBuf,
    /// Total size of the files in `file_dir`.
    attachment_bytes: Arc<AtomicU64>,
}

impl PasteDB {
    pub fn open(db_dir: &Path, file_dir: PathBuf) -> Result<Self> {
        let db: Db = sled::Config::new()
            .path(db_dir)
            .use_compression(true)
            .compression_factor(18)
            .open()?;
        let paste_db: Tree = db.open_tree(b"paste")?;
        let site_stats: Tree = db.open_tree(b"site_stats")?;
        let expire_index: Tree = db.open_tree(b"expire_index")?;
        let upload_tokens: Tree = db.open_tree(b"upload_tokens")?;
        let attachment_bytes = Arc::new(AtomicU64::new(dir_size(&file_dir)));

        Ok(PasteDB {
            paste_db,
            site_stats,
            expire_index,
            upload_tokens,
            db,
            file_dir,
            attachment_bytes,
        })
    }

    /// Total size of all stored attachments.
    pub fn attachment_storage_used(&self) -> u64 {
        self.attachment_bytes.load(Ordering::Relaxed)
    }

    /// Free space on the disk holding the attachments (and the database, when
    /// they share a data_dir).
    pub fn available_disk_space(&self) -> std::io::Result<u64> {
        fs4::available_space(&self.file_dir)
    }

    /// The attachment file for a paste (it may not exist).
    pub fn attachment_path(&self, id: &str) -> PathBuf {
        self.file_dir.join(format!("{id}.bin"))
    }

    /// Where an upload is written until it's complete and its token is used.
    pub fn partial_upload_path(&self, id: &str) -> PathBuf {
        let suffix: u64 = rand::random();
        self.file_dir.join(format!("{id}.{suffix:016x}.part"))
    }

    /// Deletes uploads left half-written by a crash or restart.
    pub fn remove_partial_uploads(&self) {
        let Ok(entries) = std::fs::read_dir(&self.file_dir) else {
            return;
        };
        for path in entries.filter_map(|e| e.ok()).map(|e| e.path()) {
            if path.extension().is_some_and(|ext| ext == "part") {
                if let Err(e) = std::fs::remove_file(&path) {
                    eprintln!("Error deleting partial upload {:?}: {:?}", path, e);
                }
            }
        }
    }

    /// Allows one attachment upload of at most `max_bytes` for the paste.
    pub fn set_upload_token(&self, id: &str, token: &str, max_bytes: u64) -> Result<()> {
        let mut record = token.as_bytes().to_vec();
        record.extend_from_slice(&max_bytes.to_be_bytes());
        self.upload_tokens.insert(id.as_bytes(), record)?;
        Ok(())
    }

    /// The upload's size limit, if `token` is the paste's unused upload token.
    pub fn upload_allowance(&self, id: &str, token: &str) -> Result<Option<u64>> {
        let Some(record) = self.upload_tokens.get(id.as_bytes())? else {
            return Ok(None);
        };
        Ok(parse_upload_record(&record, token))
    }

    /// Uses up the upload token. Atomic, so of several uploads with the right
    /// token only one gets `true`.
    pub fn consume_upload_token(&self, id: &str, token: &str) -> Result<bool> {
        let Some(record) = self.upload_tokens.get(id.as_bytes())? else {
            return Ok(false);
        };
        if parse_upload_record(&record, token).is_none() {
            return Ok(false);
        }
        let swapped = self.upload_tokens.compare_and_swap(
            id.as_bytes(),
            Some(record),
            None as Option<&[u8]>,
        )?;
        Ok(swapped.is_ok())
    }

    /// Counts a newly stored attachment towards the storage total.
    pub fn add_attachment_bytes(&self, bytes: u64) {
        self.attachment_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn set_paste(&self, paste_data: &PasteData<'_>) -> Result<()> {
        let id: PasteId<'_> = paste_data.id.clone();
        match paste_data.expires {
            Some(expires) => {
                self.set_expire_index(expires, &id.to_string())?;
            }
            None => {}
        }
        let content: Vec<u8> = match serde_json::to_vec(&paste_data) {
            Ok(content) => content,
            Err(e) => {
                eprintln!("Error serializing paste data: {:?}", e);
                return Err(sled::Error::Unsupported("Serialization error".into()));
            }
        };
        self.paste_db.insert(id.to_string().as_bytes(), content)?;
        Ok(())
    }

    pub fn get_paste(&self, id: String) -> Option<PasteData<'static>> {
        let content_opt: Option<sled::IVec> = match self.paste_db.get(id.as_bytes()) {
            Ok(content) => content,
            Err(e) => {
                eprintln!("Error retrieving paste: {:?}", e);
                return None;
            }
        };
        let content: sled::IVec = match content_opt {
            Some(content) => content,
            None => return None,
        };
        let paste_data: PasteData<'static> = match serde_json::from_slice(&content) {
            Ok(paste_data) => paste_data,
            Err(e) => {
                eprintln!("Error deserializing paste data: {:?}", e);
                return None;
            }
        };
        Some(paste_data)
    }

    pub async fn delete_paste(&self, id: String) -> Result<()> {
        self.paste_db.remove(id.as_bytes())?;
        self.upload_tokens.remove(id.as_bytes())?;

        // Only pastes with an attachment have a file, so a missing one is fine.
        let path = self.attachment_path(&id);
        let size = tokio::fs::metadata(&path).await.map_or(0, |m| m.len());
        match tokio::fs::remove_file(&path).await {
            Ok(_) => {
                // Subtract without wrapping below zero.
                let mut used = self.attachment_bytes.load(Ordering::Relaxed);
                while let Err(actual) = self.attachment_bytes.compare_exchange_weak(
                    used,
                    used.saturating_sub(size),
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    used = actual;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                eprintln!("Error deleting file: {:?}", e);
            }
        }

        Ok(())
    }

    pub fn set_expire_index(&self, expires: u64, id: &str) -> Result<()> {
        self.expire_index
            .insert(expires.to_be_bytes(), id.as_bytes())?;
        Ok(())
    }

    pub fn delete_expired_index(&self, expires: u64) -> Result<()> {
        self.expire_index.remove(expires.to_be_bytes())?;
        Ok(())
    }

    pub async fn remove_expired_paste(&self) -> Result<()> {
        let now: u64 = chrono::Utc::now().timestamp_millis() as u64;

        for result in self.expire_index.range(..=now.to_be_bytes()) {
            match result {
                Ok((expires, id)) => {
                    let id: String = match String::from_utf8(id.to_vec()) {
                        Ok(id) => id,
                        Err(e) => {
                            eprintln!("Error converting ID to string: {:?}", e);
                            continue;
                        }
                    };

                    let paste = match self.get_paste(id.clone()) {
                        Some(paste) => paste,
                        None => {
                            eprintln!("Error retrieving paste: {:?}", id);
                            continue;
                        }
                    };

                    let timestamp = paste.timestamp as u64 * 1000;
                    let duration = now.saturating_sub(timestamp);

                    let one_day = chrono::Duration::days(1).num_milliseconds() as u64;

                    if duration < one_day {
                        continue;
                    }

                    let bytes: [u8; 8] = expires
                        .as_ref()
                        .try_into()
                        .expect("slice with incorrect length");
                    let expires = u64::from_be_bytes(bytes);
                    match self.delete_paste(id).await {
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("Error deleting paste: {:?}", e);
                        }
                    };
                    match self.delete_expired_index(expires) {
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("Error deleting expired index: {:?}", e);
                        }
                    };
                }
                Err(e) => {
                    eprintln!("Error removing expired paste: {:?}", e);
                }
            }
            // It's possible there are a lot of expired pastes to remove, so
            // yield to the Tokio runtime to prevent blocking the event loop.
            tokio::time::sleep(Duration::ZERO).await;
        }

        Ok(())
    }

    pub fn set_site_stats(&self, site_stats: &SiteStats) -> Result<()> {
        let content: Vec<u8> = match serde_json::to_vec(&site_stats) {
            Ok(content) => content,
            Err(e) => {
                eprintln!("Error serializing site stats: {:?}", e);
                return Err(sled::Error::Unsupported("Serialization error".into()));
            }
        };
        self.site_stats.insert(b"site_stats", content)?;
        Ok(())
    }

    pub fn get_site_stats(&self) -> SiteStats {
        let content_opt: Option<sled::IVec> = match self.site_stats.get(b"site_stats") {
            Ok(content) => content,
            Err(e) => {
                eprintln!("Error retrieving site stats: {:?}", e);
                return SiteStats::default();
            }
        };
        let content: SiteStats = match content_opt {
            Some(content) => match serde_json::from_slice(&content) {
                Ok(content) => content,
                Err(e) => {
                    eprintln!("Error deserializing site stats: {:?}", e);
                    return SiteStats::default();
                }
            },
            None => {
                let site_stats: SiteStats = SiteStats {
                    pastes: 0,
                    views: 0,
                };

                match self.set_site_stats(&site_stats) {
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("Error setting site stats: {:?}", e);
                    }
                };
                site_stats
            }
        };

        content
    }

    pub fn increment_pastes(&self) -> Result<()> {
        let mut site_stats: SiteStats = self.get_site_stats();
        site_stats.pastes += 1;
        self.set_site_stats(&site_stats)?;
        Ok(())
    }

    pub fn increment_views(&self) -> Result<()> {
        let mut site_stats: SiteStats = self.get_site_stats();
        site_stats.views += 1;
        self.set_site_stats(&site_stats)?;
        Ok(())
    }
}

/// The size limit from an upload-token record, if its token is `token`.
fn parse_upload_record(record: &[u8], token: &str) -> Option<u64> {
    let (stored_token, size) = record.split_at_checked(record.len().checked_sub(8)?)?;
    let size = u64::from_be_bytes(size.try_into().ok()?);
    constant_time_eq(stored_token, token.as_bytes()).then_some(size)
}

/// Total size of the attachment files (`*.bin`) in `dir`.
fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|ext| ext == "bin"))
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}
