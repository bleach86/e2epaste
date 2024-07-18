extern crate sled;
use rocket::tokio;
use serde::{Deserialize, Serialize};
use sled::{Db, Result, Tree};
use std::path::PathBuf;
use std::time::Duration;

use crate::paste_id::PasteId;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PasteData<'a> {
    pub content: String,
    pub iv: Vec<u8>,
    pub id: PasteId<'a>,
    pub timestamp: i64,
    pub expires: Option<u64>,
    pub views: u64,
    pub max_views: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SiteStats {
    pub pastes: u64,
    pub views: u64,
}

#[derive(Clone, Debug)]
pub struct PasteDB {
    pub paste_db: Tree,
    pub site_stats: Tree,
    pub expire_index: Tree,
    pub db: Db,
}

impl PasteDB {
    pub fn new() -> Self {
        let db_dir: std::path::PathBuf = PathBuf::from("paste_db");
        let db: Db = sled::Config::new()
            .path(&db_dir)
            .use_compression(true)
            .compression_factor(18)
            .open()
            .unwrap();
        let paste_db: Tree = db.open_tree(b"paste").unwrap();
        let site_stats: Tree = db.open_tree(b"site_stats").unwrap();
        let expire_index: Tree = db.open_tree(b"expire_index").unwrap();

        PasteDB {
            paste_db,
            site_stats,
            expire_index,
            db,
        }
    }

    pub fn set_paste(&self, paste_data: &PasteData<'_>) -> Result<()> {
        let id: PasteId<'_> = paste_data.id.clone();
        match paste_data.expires {
            Some(expires) => {
                self.set_expire_index(expires, &id.to_string())?;
            }
            None => {}
        }
        let content: Vec<u8> = serde_json::to_vec(&paste_data).unwrap();
        self.paste_db.insert(id.to_string().as_bytes(), content)?;
        Ok(())
    }

    pub fn get_paste(&self, id: String) -> Option<PasteData<'static>> {
        let content_opt: Option<sled::IVec> = self.paste_db.get(id.as_bytes()).unwrap();
        let content: sled::IVec = match content_opt {
            Some(content) => content,
            None => return None,
        };
        let paste_data: PasteData<'static> = serde_json::from_slice(&content).unwrap();
        Some(paste_data)
    }

    pub fn delete_paste(&self, id: String) -> Result<()> {
        self.paste_db.remove(id.as_bytes())?;
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
                    let id: String = String::from_utf8(id.to_vec()).unwrap();
                    let bytes: [u8; 8] = expires
                        .as_ref()
                        .try_into()
                        .expect("slice with incorrect length");
                    let expires = u64::from_be_bytes(bytes);
                    self.delete_paste(id).unwrap();
                    self.delete_expired_index(expires).unwrap();
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
        let content: Vec<u8> = serde_json::to_vec(&site_stats).unwrap();
        self.site_stats.insert(b"site_stats", content)?;
        Ok(())
    }

    pub fn get_site_stats(&self) -> SiteStats {
        let content_opt: Option<sled::IVec> = self.site_stats.get(b"site_stats").unwrap();
        let content: SiteStats = match content_opt {
            Some(content) => serde_json::from_slice(&content).unwrap(),
            None => {
                let site_stats: SiteStats = SiteStats {
                    pastes: 0,
                    views: 0,
                };

                self.set_site_stats(&site_stats).unwrap();
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
