//! Database schema versions, and the one-time import from the sled database
//! that releases before redb used.
//!
//! The schema version is kept in the `meta` table. At startup, every step in
//! MIGRATIONS newer than the database's version runs in order, each in one
//! transaction with its version bump, so a failed step leaves the database at
//! the previous version. To change the schema, append a step and bump
//! SCHEMA_VERSION. Never edit a step that has been released.

use std::path::{Path, PathBuf};

use redb::{Database, ReadableDatabase, TableDefinition, WriteTransaction};

use crate::paste_db::{DbError, Result, EXPIRY, PASTES, STATS, UPLOAD_TOKENS};

const META: TableDefinition<&str, u64> = TableDefinition::new("meta");
const SCHEMA_VERSION_KEY: &str = "schema_version";

/// The schema this build reads and writes: the last step in MIGRATIONS.
pub const SCHEMA_VERSION: u64 = 1;

struct Migration {
    version: u64,
    description: &'static str,
    apply: fn(&WriteTransaction) -> Result<()>,
}

/// The steps from an empty database to the current schema.
const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    description: "create the tables",
    apply: create_tables,
}];

fn create_tables(txn: &WriteTransaction) -> Result<()> {
    txn.open_table(PASTES)?;
    txn.open_table(EXPIRY)?;
    txn.open_table(UPLOAD_TOKENS)?;
    txn.open_table(STATS)?;
    Ok(())
}

/// Brings the database up to schema version `target`.
pub fn run(db: &Database, target: u64) -> Result<()> {
    let current = schema_version(db)?;
    if current > SCHEMA_VERSION {
        return Err(DbError::Setup(format!(
            "the database is at schema version {current}, but this build only knows versions up \
             to {SCHEMA_VERSION}. It was probably written by a newer release of e2ePaste: run \
             that release, or restore a backup."
        )));
    }

    for step in MIGRATIONS
        .iter()
        .filter(|m| m.version > current && m.version <= target)
    {
        let txn = db.begin_write()?;
        (step.apply)(&txn)?;
        txn.open_table(META)?
            .insert(SCHEMA_VERSION_KEY, step.version)?;
        txn.commit()?;
        // A new database runs every step; that's setup, not worth logging.
        if current > 0 {
            println!(
                "Database migrated to schema version {}: {}",
                step.version, step.description
            );
        }
    }
    Ok(())
}

/// 0 for a database with no tables yet.
pub fn schema_version(db: &Database) -> Result<u64> {
    let txn = db.begin_read()?;
    match txn.open_table(META) {
        Ok(table) => Ok(table.get(SCHEMA_VERSION_KEY)?.map_or(0, |v| v.value())),
        Err(redb::TableError::TableDoesNotExist(_)) => Ok(0),
        Err(e) => Err(e.into()),
    }
}

// --- Import from sled -----------------------------------------------------------

/// The schema version the sled import writes. Later steps then run on top of
/// it like on any other database.
#[cfg(feature = "sled-import")]
const SLED_IMPORT_SCHEMA: u64 = 1;

/// Copies the sled database in `sled_dir` into a new redb database at
/// `db_path`, then renames `sled_dir` to keep it as a backup.
///
/// The import is built in a temporary file that only becomes `db_path` once
/// it's complete, so if it's interrupted, the next start simply runs it again.
#[cfg(feature = "sled-import")]
pub fn import_sled(sled_dir: &Path, db_path: &Path) -> Result<()> {
    println!("Importing the database from an older version in {sled_dir:?} into {db_path:?}...");
    let partial = db_path.with_extension("redb.importing");
    if partial.exists() {
        std::fs::remove_file(&partial).map_err(|e| setup_io("remove", &partial, e))?;
    }

    let report = {
        // The same settings the old version wrote it with.
        let sled_db = sled::Config::new()
            .path(sled_dir)
            .use_compression(true)
            .compression_factor(18)
            .open()
            .map_err(|e| {
                DbError::Setup(format!("can't open the old database in {sled_dir:?}: {e}"))
            })?;
        let db = Database::create(&partial)?;
        run(&db, SLED_IMPORT_SCHEMA)?;
        let txn = db.begin_write()?;
        let report = sled_import::copy(&sled_db, &txn)?;
        txn.commit()?;
        report
        // Both databases are closed here.
    };

    std::fs::rename(&partial, db_path).map_err(|e| setup_io("rename", &partial, e))?;
    let backup = backup_path(sled_dir);
    std::fs::rename(sled_dir, &backup).map_err(|e| setup_io("rename", sled_dir, e))?;

    let mut notes = String::new();
    if report.unloadable > 0 {
        notes += &format!(
            " {} of the pastes are in a format from before 2024 that this version can't open; \
             they were copied as they were and will be deleted when they expire.",
            report.unloadable
        );
    }
    if report.skipped > 0 {
        notes += &format!(
            " Skipped {} entries that weren't valid (logged above).",
            report.skipped
        );
    }
    println!(
        "Imported {} pastes, {} pending attachment uploads and the site stats.{notes} The old \
         database was kept as {backup:?}: delete it once everything looks right.",
        report.pastes, report.upload_tokens,
    );
    Ok(())
}

#[cfg(not(feature = "sled-import"))]
pub fn import_sled(sled_dir: &Path, _db_path: &Path) -> Result<()> {
    Err(DbError::Setup(format!(
        "found a database from an older version in {sled_dir:?}, but this build can't import it. \
         Build with the default \"sled-import\" feature and start once to import it."
    )))
}

/// Renames an old-version database found next to an existing `db_path`, the
/// way `import_sled` would have. That happens if the import was interrupted
/// between its two renames, or if a `paste_db/` was copied in by hand after
/// the move to redb: either way it isn't imported, since the database is
/// already there, and it shouldn't be checked again on every start.
pub fn set_aside_sled(sled_dir: &Path, db_path: &Path) -> Result<()> {
    let backup = backup_path(sled_dir);
    std::fs::rename(sled_dir, &backup).map_err(|e| setup_io("rename", sled_dir, e))?;
    println!(
        "Found an old-version database in {sled_dir:?} next to {db_path:?}. It wasn't imported, \
         as the database is already there; it was kept as {backup:?}."
    );
    Ok(())
}

/// `paste_db.sled-backup` next to `sled_dir`, or a dated name if that's taken.
fn backup_path(sled_dir: &Path) -> PathBuf {
    let backup = sled_dir.with_file_name("paste_db.sled-backup");
    if !backup.exists() {
        return backup;
    }
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    sled_dir.with_file_name(format!("paste_db.sled-backup-{stamp}"))
}

fn setup_io(action: &str, path: &Path, e: std::io::Error) -> DbError {
    DbError::Setup(format!("can't {action} {path:?}: {e}"))
}

#[cfg(feature = "sled-import")]
mod sled_import {
    use redb::WriteTransaction;

    use crate::paste_db::{
        DbError, PasteData, Result, SiteStats, EXPIRY, PASTES, STATS, STAT_PASTES, STAT_VIEWS,
        UPLOAD_TOKENS,
    };

    pub struct Report {
        pub pastes: u64,
        /// Copied, but in a format this version can't load (from before 2024).
        pub unloadable: u64,
        /// Not JSON at all, so not copied.
        pub skipped: u64,
        pub upload_tokens: u64,
    }

    fn sled_error(e: sled::Error) -> DbError {
        DbError::Setup(format!("can't read the old database: {e}"))
    }

    /// Copies everything the old version stored. Its expiry index isn't
    /// copied: it could hold only one paste per expiry time, so it's rebuilt
    /// from the pastes instead.
    pub fn copy(sled_db: &sled::Db, txn: &WriteTransaction) -> Result<Report> {
        let mut report = Report {
            pastes: 0,
            unloadable: 0,
            skipped: 0,
            upload_tokens: 0,
        };

        let mut pastes = txn.open_table(PASTES)?;
        let mut expiry = txn.open_table(EXPIRY)?;
        for entry in sled_db.open_tree(b"paste").map_err(sled_error)?.iter() {
            let (key, json) = entry.map_err(sled_error)?;
            let id = String::from_utf8_lossy(&key);
            let value: serde_json::Value = match serde_json::from_slice(&json) {
                Ok(value) => value,
                Err(e) => {
                    eprintln!("Skipping paste {id}, which isn't valid JSON: {e}");
                    report.skipped += 1;
                    continue;
                }
            };
            // Copied exactly as it was, even if this version can't load it,
            // so nothing is lost.
            if serde_json::from_value::<PasteData>(value.clone()).is_err() {
                report.unloadable += 1;
            }
            pastes.insert(id.as_ref(), json.as_ref())?;
            if let Some(expires) = value["expires"].as_u64() {
                expiry.insert((expires, id.as_ref()), ())?;
            }
            report.pastes += 1;
        }

        // Token bytes followed by the size limit (8 bytes, big endian).
        let mut tokens = txn.open_table(UPLOAD_TOKENS)?;
        for entry in sled_db
            .open_tree(b"upload_tokens")
            .map_err(sled_error)?
            .iter()
        {
            let (key, record) = entry.map_err(sled_error)?;
            let Some(split) = record.len().checked_sub(8) else {
                continue;
            };
            let (token, size) = record.split_at(split);
            let (Ok(id), Ok(token)) = (std::str::from_utf8(&key), std::str::from_utf8(token))
            else {
                continue;
            };
            let max_bytes = u64::from_be_bytes(size.try_into().expect("8 bytes"));
            tokens.insert(id, (token, max_bytes))?;
            report.upload_tokens += 1;
        }

        let stats_tree = sled_db.open_tree(b"site_stats").map_err(sled_error)?;
        if let Some(json) = stats_tree.get(b"site_stats").map_err(sled_error)? {
            let stats: SiteStats = serde_json::from_slice(&json)?;
            let mut table = txn.open_table(STATS)?;
            table.insert(STAT_PASTES, stats.pastes)?;
            table.insert(STAT_VIEWS, stats.views)?;
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paste_db::tests::{open, temp_dir};

    #[test]
    fn refuses_a_newer_schema() {
        let dir = temp_dir();
        let db = open(&dir).unwrap();
        assert_eq!(schema_version(db.raw_database()).unwrap(), SCHEMA_VERSION);
        drop(db);

        let raw = Database::create(dir.join("e2epaste.redb")).unwrap();
        let txn = raw.begin_write().unwrap();
        txn.open_table(META)
            .unwrap()
            .insert(SCHEMA_VERSION_KEY, SCHEMA_VERSION + 1)
            .unwrap();
        txn.commit().unwrap();
        drop(raw);

        let error = open(&dir).err().expect("refused").to_string();
        assert!(error.contains("newer release"), "{error}");
    }

    /// Writes a sled database the way the version before redb did.
    #[cfg(feature = "sled-import")]
    fn write_old_database(dir: &Path) {
        let sled_db = sled::Config::new()
            .path(dir.join("paste_db"))
            .use_compression(true)
            .compression_factor(18)
            .open()
            .unwrap();
        let pastes = sled_db.open_tree(b"paste").unwrap();
        let paste = |id: &str, expires: u64, extra: &str| {
            format!(
                r#"{{"content":"c-{id}","iv":[1],"key_fragment":"k","id":"{id}","timestamp":1700000000,
                "expires":{expires},"views":3,"max_views":null,"password_hash":null,"title":"t",
                "syntax":"rust","file_name":null{extra}}}"#
            )
        };
        // A v1 paste (no version field), and a v3 one with the same expiry time.
        pastes
            .insert("v1Paste1", paste("v1Paste1", 4000000000000, "").as_bytes())
            .unwrap();
        pastes
            .insert(
                "v3Paste1",
                paste(
                    "v3Paste1",
                    4000000000000,
                    r#","version":3,"has_password":true"#,
                )
                .as_bytes(),
            )
            .unwrap();
        pastes.insert("broken11", &b"not json"[..]).unwrap();
        // From before titles existed: copied, though this version can't load it.
        pastes
            .insert(
                "noTitle1",
                &br#"{"content":"c","iv":[1],"expires":4000000000000,"timestamp":1600000000}"#[..],
            )
            .unwrap();

        // The old index kept one ID per expiry time.
        let index = sled_db.open_tree(b"expire_index").unwrap();
        index
            .insert(4000000000000u64.to_be_bytes(), &b"v3Paste1"[..])
            .unwrap();

        let mut token = b"tok".to_vec();
        token.extend_from_slice(&777u64.to_be_bytes());
        sled_db
            .open_tree(b"upload_tokens")
            .unwrap()
            .insert("v3Paste1", token)
            .unwrap();

        let stats = sled_db.open_tree(b"site_stats").unwrap();
        stats
            .insert(b"site_stats", &br#"{"pastes":41,"views":99}"#[..])
            .unwrap();
        sled_db.flush().unwrap();
    }

    #[cfg(feature = "sled-import")]
    #[test]
    fn imports_the_sled_database() {
        use redb::ReadableTableMetadata;

        let dir = temp_dir();
        write_old_database(&dir);
        // Left over from an interrupted import.
        std::fs::write(dir.join("e2epaste.redb.importing"), b"half written").unwrap();

        let db = open(&dir).unwrap();

        let v1 = db.get_paste("v1Paste1").unwrap();
        assert_eq!(
            (v1.version, v1.views, v1.content.as_str()),
            (1, 3, "c-v1Paste1")
        );
        let v3 = db.get_paste("v3Paste1").unwrap();
        assert!(v3.has_password && v3.version == 3);
        assert!(db.get_paste("broken11").is_none(), "not JSON, so skipped");
        assert!(db.get_paste("noTitle1").is_none(), "can't be loaded...");

        assert_eq!(db.upload_allowance("v3Paste1", "tok").unwrap(), Some(777));
        let stats = db.get_site_stats();
        assert_eq!((stats.pastes, stats.views), (41, 99));

        // Both pastes are in the rebuilt expiry index, not just the one the
        // old index held.
        let txn = db.raw_database().begin_read().unwrap();
        assert_eq!(txn.open_table(EXPIRY).unwrap().len().unwrap(), 3);
        assert!(
            txn.open_table(PASTES)
                .unwrap()
                .get("noTitle1")
                .unwrap()
                .is_some(),
            "...but is kept"
        );
        assert!(txn
            .open_table(PASTES)
            .unwrap()
            .get("broken11")
            .unwrap()
            .is_none());
        drop(txn);

        assert!(!dir.join("paste_db").exists());
        assert!(dir.join("paste_db.sled-backup").is_dir());
        assert!(!dir.join("e2epaste.redb.importing").exists());

        // Reopening doesn't import again.
        drop(db);
        let db = open(&dir).unwrap();
        assert_eq!(db.get_site_stats().pastes, 41);
    }

    #[cfg(feature = "sled-import")]
    #[test]
    fn keeps_an_earlier_backup() {
        let dir = temp_dir();
        std::fs::create_dir(dir.join("paste_db.sled-backup")).unwrap();
        write_old_database(&dir);
        open(&dir).unwrap();
        let backups = std::fs::read_dir(&*dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("paste_db.sled-backup")
            })
            .count();
        assert_eq!(backups, 2);
    }

    #[test]
    fn sets_aside_a_leftover_old_database() {
        let dir = temp_dir();
        // As if the import had been interrupted after promoting the new
        // database but before renaming the old one.
        let db = open(&dir).unwrap();
        db.create_paste(
            &crate::paste_db::tests::sample_paste("kept1234", None, None),
            None,
        )
        .unwrap();
        drop(db);
        std::fs::create_dir(dir.join("paste_db")).unwrap();
        std::fs::write(dir.join("paste_db/db"), b"old").unwrap();

        let db = open(&dir).unwrap();
        assert!(
            db.get_paste("kept1234").is_some(),
            "the new database is kept"
        );
        assert!(!dir.join("paste_db").exists());
        assert!(dir.join("paste_db.sled-backup/db").is_file());
    }
}
