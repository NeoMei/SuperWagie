use crate::agent::ThreadError;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn version(connection: &Connection) -> Result<Option<i64>, ThreadError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_schema')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let version = connection.query_row(
        "SELECT version FROM agent_schema WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    Ok(Some(version))
}

pub(super) fn migrate(connection: &mut Connection, state_root: &Path) -> Result<(), ThreadError> {
    match version(connection)? {
        Some(1) => return Ok(()),
        Some(other) => return Err(ThreadError::UnsupportedSchema(other)),
        None => {}
    }
    // A fresh private directory makes the backup target exclusive and non-overwriting.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ThreadError::InvalidInput)?
        .as_nanos();
    let backup_dir = state_root.join(format!("agent-pre-v1-{}-{nonce}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&backup_dir)?;
    let backup = backup_dir.join("snapshot.sqlite3");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&backup)?;
    let backup_path = backup.to_str().ok_or(ThreadError::InvalidInput)?;
    // VACUUM INTO accepts an existing empty file and includes committed WAL contents.
    // An incomplete backup is never registered as a successful migration.
    connection.execute("VACUUM main INTO ?1", [backup_path])?;
    let copied = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity: String = copied.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(ThreadError::CorruptState);
    }
    drop(copied);
    file.sync_all()?;
    File::open(&backup_dir)?.sync_all()?;
    File::open(state_root)?.sync_all()?;

    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Another connection may have completed the additive migration while we backed up.
    match version(&tx)? {
        Some(1) => return Ok(()),
        Some(other) => return Err(ThreadError::UnsupportedSchema(other)),
        None => {}
    }
    tx.execute_batch(
        "CREATE TABLE agent_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, backup_path TEXT NOT NULL);
         CREATE TABLE agent_threads(
           thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES workspaces(project_id),
           revision INTEGER NOT NULL CHECK(revision>0), record_json TEXT NOT NULL);
         CREATE INDEX agent_threads_project ON agent_threads(project_id);
         CREATE TABLE agent_events(
           thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id), revision INTEGER NOT NULL,
           request_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(thread_id,revision));
         CREATE TABLE agent_requests(
           project_id TEXT NOT NULL REFERENCES workspaces(project_id), request_id TEXT NOT NULL,
           fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id,request_id));"
    )?;
    tx.execute(
        "INSERT INTO agent_schema VALUES(1,1,?1)",
        params![backup_path],
    )?;
    tx.commit()?;
    Ok(())
}
