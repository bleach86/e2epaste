//! Paste storage: a redb database (`e2epaste.redb`) plus one file per
//! attachment. The table layout is versioned; see migrate.rs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition, WriteTransaction};
use rocket::tokio;
use serde::{Deserialize, Serialize};

use crate::migrate;
use crate::paste_id::PasteId;
use crate::secrets;

/// Paste ID -> the paste as JSON (`PasteData`).
pub(crate) const PASTES: TableDefinition<&str, &[u8]> = TableDefinition::new("pastes");
/// (expiry time in ms, paste ID), for finding expired pastes in order.
pub(crate) const EXPIRY: TableDefinition<(u64, &str), ()> = TableDefinition::new("expiry");
/// Paste ID -> (one-time attachment upload token, the attachment's maximum
/// size). Kept out of PasteData so it's never sent to viewers.
pub(crate) const UPLOAD_TOKENS: TableDefinition<&str, (&str, u64)> =
    TableDefinition::new("upload_tokens");
/// Site-wide counters: "pastes" and "views".
pub(crate) const STATS: TableDefinition<&str, u64> = TableDefinition::new("stats");

pub(crate) const STAT_PASTES: &str = "pastes";
pub(crate) const STAT_VIEWS: &str = "views";

/// After the last allowed view of a paste with an attachment, how long the
/// viewer has to download it. Pastes without one are deleted straight away.
pub const ATTACHMENT_WINDOW: Duration = Duration::from_secs(60 * 60);

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
    /// SHA-256 (hex) of the access proof, which the browser derives from the
    /// full link and the password. The paste is only sent to a browser that
    /// has it. Pastes from before it existed have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_hash: Option<String>,
    /// SHA-256 (hex) of the token in the creator's delete link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_hash: Option<String>,
    /// Seconds: once the first view is counted, the paste expires this long
    /// after it (or at its own expiry time, if that's sooner).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_after_open: Option<u64>,
}

impl PasteData<'_> {
    /// Whether the view limit has been reached.
    pub fn used_up(&self) -> bool {
        self.max_views.is_some_and(|max| self.views >= max)
    }

    pub fn expired(&self) -> bool {
        self.expires.is_some_and(|expires| now_millis() >= expires)
    }
}

/// What happened when a browser asked to open a paste.
pub enum Opened {
    /// Doesn't exist, has expired, or has no views left.
    NotFound,
    /// The access proof doesn't match: wrong link or wrong password.
    WrongProof,
    /// The view was counted. `paste` is as it was stored, with the new count.
    Paste {
        paste: Box<PasteData<'static>>,
        total_views: u64,
        last_view: bool,
    },
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

#[derive(Debug)]
pub enum DbError {
    Redb(redb::Error),
    Json(serde_json::Error),
    /// Opening or migrating the database failed, with an explanation.
    Setup(String),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Redb(e) => write!(f, "{e}"),
            DbError::Json(e) => write!(f, "invalid stored data: {e}"),
            DbError::Setup(message) => write!(f, "{message}"),
        }
    }
}

macro_rules! from_redb_errors {
    ($($error:ty),+) => {
        $(impl From<$error> for DbError {
            fn from(e: $error) -> Self {
                DbError::Redb(e.into())
            }
        })+
    };
}

from_redb_errors!(
    redb::Error,
    redb::DatabaseError,
    redb::TransactionError,
    redb::TableError,
    redb::StorageError,
    redb::CommitError
);

impl From<serde_json::Error> for DbError {
    fn from(e: serde_json::Error) -> Self {
        DbError::Json(e)
    }
}

pub type Result<T> = std::result::Result<T, DbError>;

pub struct PasteDB {
    db: Database,
    /// Where attachments are stored, one `<id>.bin` per paste.
    file_dir: PathBuf,
    /// Total size of the files in `file_dir`.
    attachment_bytes: AtomicU64,
}

impl PasteDB {
    /// Opens (or creates) the database at `db_path` and brings its tables up
    /// to date. If there's no database yet but there is one from an older
    /// version in `legacy_sled_dir`, that's imported first.
    pub fn open(db_path: &Path, legacy_sled_dir: &Path, file_dir: PathBuf) -> Result<Self> {
        if !db_path.exists() && legacy_sled_dir.exists() {
            migrate::import_sled(legacy_sled_dir, db_path)?;
        }

        let db = Database::create(db_path)?;
        migrate::run(&db, migrate::SCHEMA_VERSION)?;
        let attachment_bytes = AtomicU64::new(dir_size(&file_dir));

        Ok(PasteDB {
            db,
            file_dir,
            attachment_bytes,
        })
    }

    #[cfg(test)]
    pub(crate) fn raw_database(&self) -> &Database {
        &self.db
    }

    // --- Pastes ---------------------------------------------------------------

    pub fn paste_exists(&self, id: &str) -> Result<bool> {
        let txn = self.db.begin_read()?;
        Ok(txn.open_table(PASTES)?.get(id)?.is_some())
    }

    /// Stores a new paste and counts it in the site stats, with the upload
    /// token for its attachment (`(token, max_bytes)`) if it has one. Returns
    /// `false`, storing nothing, if the ID is already taken.
    pub fn create_paste(&self, paste: &PasteData<'_>, upload: Option<(&str, u64)>) -> Result<bool> {
        let id = paste.id.to_string();
        let txn = self.db.begin_write()?;
        if txn.open_table(PASTES)?.get(id.as_str())?.is_some() {
            return Ok(false);
        }
        write_paste(&txn, paste)?;
        if let Some((token, max_bytes)) = upload {
            txn.open_table(UPLOAD_TOKENS)?
                .insert(id.as_str(), (token, max_bytes))?;
        }
        add_to_stat(&txn, STAT_PASTES, 1)?;
        txn.commit()?;
        Ok(true)
    }

    /// The paste, or `None` if it doesn't exist (or can't be read, which is
    /// logged).
    pub fn get_paste(&self, id: &str) -> Option<PasteData<'static>> {
        let read = || -> Result<Option<PasteData<'static>>> {
            let txn = self.db.begin_read()?;
            let table = txn.open_table(PASTES)?;
            let Some(json) = table.get(id)? else {
                return Ok(None);
            };
            Ok(Some(serde_json::from_slice(json.value())?))
        };
        read().unwrap_or_else(|e| {
            eprintln!("Error reading paste {id}: {e}");
            None
        })
    }

    /// Counts a view and returns the paste, if it's still available and
    /// `proof` (hex) matches its access hash. On the last allowed view, a
    /// paste without an attachment is deleted at once; one with an attachment
    /// is kept for `ATTACHMENT_WINDOW` so it can be downloaded, but can't be
    /// opened again.
    pub fn open_paste(&self, id: &str, proof: Option<&str>) -> Result<Opened> {
        let txn = self.db.begin_write()?;
        let Some(mut paste) = read_paste(&txn, id)? else {
            return Ok(Opened::NotFound);
        };
        if paste.expired() || paste.used_up() {
            return Ok(Opened::NotFound);
        }
        if let Some(access_hash) = &paste.access_hash {
            if !proof.is_some_and(|proof| secrets::matches_hash(proof, access_hash)) {
                return Ok(Opened::WrongProof);
            }
        }

        paste.views += 1;
        let now = now_millis();
        let old_expires = paste.expires;
        // The first view starts the delete-after-opening timer.
        if paste.views == 1 {
            if let Some(seconds) = paste.delete_after_open {
                paste.expires = Some(soonest(paste.expires, now + seconds * 1000));
            }
        }
        let last_view = paste.used_up();
        if last_view && paste.file_name.is_some() {
            // Kept so the last viewer can download the attachment, but never
            // past when it would have expired anyway.
            paste.expires = Some(soonest(
                paste.expires,
                now + ATTACHMENT_WINDOW.as_millis() as u64,
            ));
        }
        if paste.expires != old_expires {
            if let Some(expires) = old_expires {
                txn.open_table(EXPIRY)?.remove((expires, id))?;
            }
        }
        if last_view {
            if paste.file_name.is_some() {
                write_paste(&txn, &paste)?;
            } else {
                if let Some(expires) = paste.expires {
                    txn.open_table(EXPIRY)?.remove((expires, id))?;
                }
                txn.open_table(PASTES)?.remove(id)?;
                txn.open_table(UPLOAD_TOKENS)?.remove(id)?;
            }
        } else {
            write_paste(&txn, &paste)?;
        }
        let total_views = add_to_stat(&txn, STAT_VIEWS, 1)?;
        txn.commit()?;
        Ok(Opened::Paste {
            paste: Box::new(paste),
            total_views,
            last_view,
        })
    }

    /// Deletes the paste, its expiry entry, its upload token and its
    /// attachment. Fine to call for a paste that's already gone.
    pub async fn delete_paste(&self, id: &str) -> Result<()> {
        let txn = self.db.begin_write()?;
        let stored = txn
            .open_table(PASTES)?
            .remove(id)?
            .and_then(|json| stored_expiry(json.value()));
        if let Some(expires) = stored {
            txn.open_table(EXPIRY)?.remove((expires, id))?;
        }
        txn.open_table(UPLOAD_TOKENS)?.remove(id)?;
        txn.commit()?;

        // An upload that was never finished.
        let _ = tokio::fs::remove_file(self.partial_upload_path(id)).await;

        // Only pastes with an attachment have a file, so a missing one is fine.
        let path = self.attachment_path(id);
        let size = tokio::fs::metadata(&path).await.map_or(0, |m| m.len());
        match tokio::fs::remove_file(&path).await {
            Ok(_) => self.subtract_attachment_bytes(size),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("Error deleting file: {:?}", e),
        }
        Ok(())
    }

    /// Deletes pastes whose expiry time has passed.
    pub async fn remove_expired_pastes(&self) -> Result<()> {
        let now = now_millis();

        // Every key with an expiry time up to and including `now`.
        let expired: Vec<(u64, String)> = {
            let txn = self.db.begin_read()?;
            let table = txn.open_table(EXPIRY)?;
            let range = table.range(..(now + 1, ""))?;
            range
                .map(|entry| entry.map(|(key, _)| (key.value().0, key.value().1.to_string())))
                .collect::<std::result::Result<_, _>>()?
        };

        for (expires, id) in expired {
            let stored = {
                let txn = self.db.begin_read()?;
                txn.open_table(PASTES)?.get(id.as_str())?.is_some()
            };
            match stored {
                // delete_paste reads only the expiry time, so this also
                // removes pastes in formats this version can't load.
                true => self.delete_paste(&id).await?,
                // An entry left behind by a paste that's gone.
                false => {
                    let txn = self.db.begin_write()?;
                    txn.open_table(EXPIRY)?.remove((expires, id.as_str()))?;
                    txn.commit()?;
                }
            }
            // There may be a lot to remove, so let other tasks run in between.
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    pub fn get_site_stats(&self) -> SiteStats {
        let read = || -> Result<SiteStats> {
            let txn = self.db.begin_read()?;
            let table = txn.open_table(STATS)?;
            let stat = |name| -> Result<u64> { Ok(table.get(name)?.map_or(0, |v| v.value())) };
            Ok(SiteStats {
                pastes: stat(STAT_PASTES)?,
                views: stat(STAT_VIEWS)?,
            })
        };
        read().unwrap_or_else(|e| {
            eprintln!("Error reading site stats: {e}");
            SiteStats::default()
        })
    }

    // --- Attachment uploads ---------------------------------------------------

    /// The upload's size limit, if `token` is the paste's unused upload token.
    pub fn upload_allowance(&self, id: &str, token: &str) -> Result<Option<u64>> {
        let txn = self.db.begin_read()?;
        let table = txn.open_table(UPLOAD_TOKENS)?;
        let Some(record) = table.get(id)? else {
            return Ok(None);
        };
        let (stored_token, max_bytes) = record.value();
        Ok(
            secrets::constant_time_eq(stored_token.as_bytes(), token.as_bytes())
                .then_some(max_bytes),
        )
    }

    /// Uses up the upload token. Write transactions run one at a time, so of
    /// several uploads with the right token only one gets `true`.
    pub fn consume_upload_token(&self, id: &str, token: &str) -> Result<bool> {
        let txn = self.db.begin_write()?;
        let matches = {
            let table = txn.open_table(UPLOAD_TOKENS)?;
            let record = table.get(id)?;
            record.is_some_and(|r| {
                secrets::constant_time_eq(r.value().0.as_bytes(), token.as_bytes())
            })
        };
        if !matches {
            return Ok(false);
        }
        txn.open_table(UPLOAD_TOKENS)?.remove(id)?;
        txn.commit()?;
        Ok(true)
    }

    // --- Attachment files -----------------------------------------------------

    /// Total size of all stored attachments.
    pub fn attachment_storage_used(&self) -> u64 {
        self.attachment_bytes.load(Ordering::Relaxed)
    }

    /// Counts a newly stored attachment towards the storage total.
    pub fn add_attachment_bytes(&self, bytes: u64) {
        self.attachment_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    fn subtract_attachment_bytes(&self, bytes: u64) {
        // Without wrapping below zero.
        let mut used = self.attachment_bytes.load(Ordering::Relaxed);
        while let Err(actual) = self.attachment_bytes.compare_exchange_weak(
            used,
            used.saturating_sub(bytes),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            used = actual;
        }
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

    /// Where an upload is written, chunk by chunk, until it's complete.
    pub fn partial_upload_path(&self, id: &str) -> PathBuf {
        self.file_dir.join(format!("{id}.part"))
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
}

/// The expiry time of a stored paste, read without the rest of it, so pastes
/// in formats this version can't load still get deleted when they expire.
fn stored_expiry(json: &[u8]) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_slice(json).ok()?;
    value["expires"].as_u64()
}

fn read_paste(txn: &WriteTransaction, id: &str) -> Result<Option<PasteData<'static>>> {
    let table = txn.open_table(PASTES)?;
    let Some(json) = table.get(id)? else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_slice(json.value())?))
}

/// Inserts or replaces the paste and its expiry entry. When replacing, the
/// caller removes the old expiry entry if the expiry time changed.
pub(crate) fn write_paste(txn: &WriteTransaction, paste: &PasteData<'_>) -> Result<()> {
    let id = paste.id.to_string();
    let json = serde_json::to_vec(paste)?;
    txn.open_table(PASTES)?
        .insert(id.as_str(), json.as_slice())?;
    if let Some(expires) = paste.expires {
        txn.open_table(EXPIRY)?.insert((expires, id.as_str()), ())?;
    }
    Ok(())
}

/// Adds `amount` to a site stat and returns the new value.
pub(crate) fn add_to_stat(txn: &WriteTransaction, name: &str, amount: u64) -> Result<u64> {
    let mut table = txn.open_table(STATS)?;
    let value = table.get(name)?.map_or(0, |v| v.value()) + amount;
    table.insert(name, value)?;
    Ok(value)
}

/// The earlier of an expiry time (`None`: never) and `at`.
fn soonest(expires: Option<u64>, at: u64) -> u64 {
    expires.map_or(at, |expires| expires.min(at))
}

fn now_millis() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A new empty directory for one test, deleted when dropped.
    pub struct TempDir(PathBuf);

    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn temp_dir() -> TempDir {
        let dir =
            std::env::temp_dir().join(format!("e2epaste-test-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(dir.join("file_store")).unwrap();
        TempDir(dir)
    }

    pub fn open(dir: &Path) -> Result<PasteDB> {
        PasteDB::open(
            &dir.join("e2epaste.redb"),
            &dir.join("paste_db"),
            dir.join("file_store"),
        )
    }

    pub fn sample_paste(
        id: &str,
        expires: Option<u64>,
        max_views: Option<u64>,
    ) -> PasteData<'static> {
        PasteData {
            content: "ciphertext".into(),
            iv: vec![1, 2, 3],
            key_fragment: String::new(),
            id: serde_json::from_value(serde_json::Value::String(id.into())).unwrap(),
            timestamp: chrono::Utc::now().timestamp(),
            expires,
            views: 0,
            max_views,
            password_hash: None,
            has_password: false,
            version: 3,
            title: "title".into(),
            syntax: "rust".into(),
            file_name: None,
            access_hash: None,
            delete_hash: None,
            delete_after_open: None,
        }
    }

    fn expiry_entries(db: &PasteDB) -> Vec<(u64, String)> {
        let txn = db.db.begin_read().unwrap();
        let table = txn.open_table(EXPIRY).unwrap();
        table
            .iter()
            .unwrap()
            .map(|e| {
                let (key, _) = e.unwrap();
                (key.value().0, key.value().1.to_string())
            })
            .collect()
    }

    #[test]
    fn creates_and_reads_pastes() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let paste = sample_paste("abcdEFGH", Some(123), None);

        assert!(db.create_paste(&paste, None).unwrap());
        assert!(!db.create_paste(&paste, None).unwrap(), "the ID is taken");
        let stored = db.get_paste("abcdEFGH").unwrap();
        assert_eq!(stored.content, "ciphertext");
        assert_eq!(stored.expires, Some(123));
        assert!(db.get_paste("missing1").is_none());
        assert_eq!(
            db.get_site_stats().pastes,
            1,
            "the refused duplicate isn't counted"
        );
        assert_eq!(expiry_entries(&db), vec![(123, "abcdEFGH".to_string())]);

        // Still there after reopening.
        drop(db);
        let db = open(&dir).unwrap();
        assert!(db.get_paste("abcdEFGH").is_some());
        assert_eq!(db.get_site_stats().pastes, 1);
    }

    fn opened(result: Opened) -> (PasteData<'static>, u64, bool) {
        match result {
            Opened::Paste {
                paste,
                total_views,
                last_view,
            } => (*paste, total_views, last_view),
            Opened::NotFound => panic!("not found"),
            Opened::WrongProof => panic!("wrong proof"),
        }
    }

    #[test]
    fn opening_needs_the_access_proof() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let mut paste = sample_paste("guarded1", None, None);
        paste.access_hash = Some(secrets::sha256_hex(&[0xab; 32]));
        db.create_paste(&paste, None).unwrap();
        let proof = "ab".repeat(32);

        assert!(matches!(
            db.open_paste("guarded1", None).unwrap(),
            Opened::WrongProof
        ));
        assert!(matches!(
            db.open_paste("guarded1", Some(&"cd".repeat(32))).unwrap(),
            Opened::WrongProof
        ));
        assert_eq!(
            db.get_paste("guarded1").unwrap().views,
            0,
            "failed attempts use no views"
        );

        let (paste, total_views, last_view) =
            opened(db.open_paste("guarded1", Some(&proof)).unwrap());
        assert_eq!((paste.views, total_views, last_view), (1, 1, false));
        assert_eq!(paste.content, "ciphertext");

        // Pastes from before access proofs open without one.
        db.create_paste(&sample_paste("legacy11", None, None), None)
            .unwrap();
        assert_eq!(opened(db.open_paste("legacy11", None).unwrap()).0.views, 1);
        assert!(matches!(
            db.open_paste("missing1", None).unwrap(),
            Opened::NotFound
        ));
    }

    #[test]
    fn last_view_deletes_the_paste() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let expires = now_millis() + 1_000_000;
        db.create_paste(&sample_paste("twoViews", Some(expires), Some(2)), None)
            .unwrap();

        assert!(!opened(db.open_paste("twoViews", None).unwrap()).2);
        let (paste, _, last_view) = opened(db.open_paste("twoViews", None).unwrap());
        assert!(last_view);
        assert_eq!(paste.content, "ciphertext", "the last viewer still gets it");
        assert!(db.get_paste("twoViews").is_none(), "and then it's gone");
        assert!(expiry_entries(&db).is_empty());
        assert!(matches!(
            db.open_paste("twoViews", None).unwrap(),
            Opened::NotFound
        ));
        assert_eq!(db.get_site_stats().views, 2);
    }

    #[test]
    fn last_view_keeps_an_attachment_for_a_while() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let day = 24 * 60 * 60 * 1000;
        let mut paste = sample_paste("burnFile", Some(now_millis() + day), Some(1));
        paste.file_name = Some("encrypted name".into());
        db.create_paste(&paste, None).unwrap();

        assert!(opened(db.open_paste("burnFile", None).unwrap()).2);
        let kept = db.get_paste("burnFile").expect("kept for the download");
        assert!(kept.used_up());
        let window = ATTACHMENT_WINDOW.as_millis() as u64;
        let expires = kept.expires.unwrap();
        assert!(expires <= now_millis() + window && expires > now_millis() + window - 5_000);
        assert_eq!(expiry_entries(&db), vec![(expires, "burnFile".to_string())]);
        assert!(
            matches!(db.open_paste("burnFile", None).unwrap(), Opened::NotFound),
            "no more views"
        );
    }

    #[test]
    fn first_view_starts_the_delete_after_opening_timer() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let day = 24 * 60 * 60 * 1000;
        let mut paste = sample_paste("timer123", Some(now_millis() + day), None);
        paste.delete_after_open = Some(600);
        db.create_paste(&paste, None).unwrap();

        let before = now_millis();
        let (first, _, _) = opened(db.open_paste("timer123", None).unwrap());
        let expires = first.expires.unwrap();
        assert!(expires >= before + 600_000 && expires <= now_millis() + 600_000);
        assert_eq!(
            expiry_entries(&db),
            vec![(expires, "timer123".to_string())],
            "the expiry index moved with it"
        );
        let (second, _, _) = opened(db.open_paste("timer123", None).unwrap());
        assert_eq!(
            second.expires,
            Some(expires),
            "later views don't restart it"
        );

        // A paste due to expire sooner keeps its own time.
        let mut soon = sample_paste("timer456", Some(now_millis() + 60_000), None);
        soon.delete_after_open = Some(3600);
        db.create_paste(&soon, None).unwrap();
        let (opened_soon, _, _) = opened(db.open_paste("timer456", None).unwrap());
        assert_eq!(opened_soon.expires, soon.expires);
    }

    #[test]
    fn attachment_window_never_extends_a_paste() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let expires = now_millis() + 60_000;
        let mut paste = sample_paste("soonFile", Some(expires), Some(1));
        paste.file_name = Some("encrypted name".into());
        db.create_paste(&paste, None).unwrap();

        assert!(opened(db.open_paste("soonFile", None).unwrap()).2);
        assert_eq!(db.get_paste("soonFile").unwrap().expires, Some(expires));
        assert_eq!(expiry_entries(&db), vec![(expires, "soonFile".to_string())]);
    }

    #[test]
    fn expired_pastes_dont_open() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        db.create_paste(
            &sample_paste("expired1", Some(now_millis() - 1), None),
            None,
        )
        .unwrap();
        assert!(matches!(
            db.open_paste("expired1", None).unwrap(),
            Opened::NotFound
        ));
    }

    #[rocket::async_test]
    async fn removes_expired_pastes() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let past = now_millis() - 1000;
        let two_days_ago = chrono::Utc::now().timestamp() - 2 * 24 * 60 * 60;

        // Two with the same expiry time: the old index could only hold one.
        for id in ["oldOne11", "oldTwo22"] {
            let mut paste = sample_paste(id, Some(past), None);
            paste.timestamp = two_days_ago;
            db.create_paste(&paste, None).unwrap();
        }
        // Expired a moment ago, from a paste created just now.
        db.create_paste(&sample_paste("youngEx1", Some(past), None), None)
            .unwrap();
        // Not expired.
        db.create_paste(
            &sample_paste("current1", Some(now_millis() + 60_000), None),
            None,
        )
        .unwrap();

        db.remove_expired_pastes().await.unwrap();
        assert!(db.get_paste("oldOne11").is_none());
        assert!(db.get_paste("oldTwo22").is_none());
        assert!(db.get_paste("youngEx1").is_none());
        assert!(db.get_paste("current1").is_some());
        assert_eq!(expiry_entries(&db).len(), 1);
    }

    #[rocket::async_test]
    async fn removes_expired_pastes_it_cant_load() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let past = now_millis() - 1000;
        let txn = db.db.begin_write().unwrap();
        let old = format!(r#"{{"content":"c","expires":{past},"timestamp":1600000000}}"#);
        txn.open_table(PASTES)
            .unwrap()
            .insert("noTitle1", old.as_bytes())
            .unwrap();
        txn.open_table(EXPIRY)
            .unwrap()
            .insert((past, "noTitle1"), ())
            .unwrap();
        txn.commit().unwrap();

        db.remove_expired_pastes().await.unwrap();
        let txn = db.db.begin_read().unwrap();
        assert!(txn
            .open_table(PASTES)
            .unwrap()
            .get("noTitle1")
            .unwrap()
            .is_none());
        assert!(expiry_entries(&db).is_empty());
    }

    #[rocket::async_test]
    async fn deletes_everything_for_a_paste() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        let mut paste = sample_paste("withFile", Some(5000), None);
        paste.file_name = Some("encrypted name".into());
        db.create_paste(&paste, Some(("token", 100))).unwrap();
        std::fs::write(db.attachment_path("withFile"), b"0123456789").unwrap();
        db.add_attachment_bytes(10);

        db.delete_paste("withFile").await.unwrap();
        assert!(db.get_paste("withFile").is_none());
        assert!(expiry_entries(&db).is_empty());
        assert_eq!(db.upload_allowance("withFile", "token").unwrap(), None);
        assert!(!db.attachment_path("withFile").exists());
        assert_eq!(db.attachment_storage_used(), 0);
        // Deleting again is fine.
        db.delete_paste("withFile").await.unwrap();
    }

    #[test]
    fn upload_tokens_work_once() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        db.create_paste(
            &sample_paste("upload11", None, None),
            Some(("secret", 4096)),
        )
        .unwrap();

        assert_eq!(
            db.upload_allowance("upload11", "secret").unwrap(),
            Some(4096)
        );
        assert_eq!(db.upload_allowance("upload11", "wrong").unwrap(), None);
        assert!(!db.consume_upload_token("upload11", "wrong").unwrap());
        assert!(db.consume_upload_token("upload11", "secret").unwrap());
        assert!(
            !db.consume_upload_token("upload11", "secret").unwrap(),
            "only once"
        );
        assert_eq!(db.upload_allowance("upload11", "secret").unwrap(), None);
    }
}
