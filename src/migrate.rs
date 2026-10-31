//! Database schema versions, and what to do with a sled database (`paste_db/`)
//! left by a release before redb.
//!
//! The schema version is kept in the `meta` table. At startup, every step in
//! MIGRATIONS newer than the database's version runs in order, each in one
//! transaction with its version bump, so a failed step leaves the database at
//! the previous version. To change the schema, append a step and bump
//! SCHEMA_VERSION. Never edit a step that has been released.

use std::path::{Path, PathBuf};

use redb::{Database, ReadableDatabase, TableDefinition, WriteTransaction};

use crate::paste_db::{DbError, Result, EXPIRY, PASTES, STATS, STAT_PASTES, UPLOAD_TOKENS};

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

// --- Databases from before redb ------------------------------------------------

/// The last commit that can import a sled database into redb.
const LAST_SLED_IMPORT: &str = "44e55db";

/// The error for a sled database that was never imported. This version can't
/// read it: an older one has to import it first.
pub fn unimported_sled(sled_dir: &Path) -> DbError {
    DbError::Setup(format!(
        "found a database from a version before redb in {sled_dir:?}, which this version can't \
         import. Start the last version that can (git commit {LAST_SLED_IMPORT}) once to import \
         it, then update to this one."
    ))
}

/// Whether the database at `db_path` has never held a paste: started once
/// before the old database was copied in next to it.
pub fn never_used(db_path: &Path) -> Result<bool> {
    use redb::{ReadableTableMetadata, TableError};

    let db = Database::open(db_path)?;
    let txn = db.begin_read()?;
    let created = match txn.open_table(STATS) {
        Ok(stats) => stats.get(STAT_PASTES)?.map_or(0, |v| v.value()),
        Err(TableError::TableDoesNotExist(_)) => 0,
        Err(e) => return Err(e.into()),
    };
    let stored = match txn.open_table(PASTES) {
        Ok(pastes) => pastes.len()?,
        Err(TableError::TableDoesNotExist(_)) => 0,
        Err(e) => return Err(e.into()),
    };
    Ok(created == 0 && stored == 0)
}

/// Renames an old-version database found next to an existing `db_path`, the
/// way the import did once it was done. That happens if an import was
/// interrupted between its two renames, or if a `paste_db/` was copied in by
/// hand after the new version had already taken pastes: either way it
/// shouldn't be checked again on every start.
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

    #[test]
    fn refuses_an_old_database_it_cant_import() {
        let dir = temp_dir();
        std::fs::create_dir(dir.join("paste_db")).unwrap();
        std::fs::write(dir.join("paste_db/db"), b"old").unwrap();

        let error = open(&dir).err().expect("refused").to_string();
        assert!(error.contains(LAST_SLED_IMPORT), "{error}");
        assert!(dir.join("paste_db/db").is_file(), "left as it was");
        assert!(!dir.join("e2epaste.redb").exists());

        // Nor over a database that has never held a paste.
        std::fs::remove_dir_all(dir.join("paste_db")).unwrap();
        drop(open(&dir).unwrap());
        std::fs::create_dir(dir.join("paste_db")).unwrap();
        assert!(open(&dir).is_err());
        assert!(dir.join("paste_db").is_dir());
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
