use super::{OperationalStore, agent_migration};
use crate::agent::state::{ThreadState, archive_restore_target, can_transition};
use crate::agent::{StateCheckpoint, ThreadAction, ThreadCommand, ThreadError, ThreadRecord};
use crate::workspace::WorkspaceError;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;

/// Core-internal persistence facade. Opening/querying never starts or resumes work.
/// Future transport adapters must authenticate the caller before invoking it.
pub struct ThreadStore {
    store: OperationalStore,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic()
                || (index > 0 && (byte.is_ascii_digit() || b"._:-".contains(&byte)))
        })
}

fn ensure_scope(connection: &Connection, project: &str) -> Result<(), ThreadError> {
    if !identifier(project) {
        return Err(ThreadError::InvalidInput);
    }
    let active: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE project_id=?1 AND active=1)",
        [project],
        |r| r.get(0),
    )?;
    if !active {
        return Err(ThreadError::ScopeDenied);
    }
    Ok(())
}

fn decode(json: &str, project: &str, thread: &str) -> Result<ThreadRecord, ThreadError> {
    let record: ThreadRecord = serde_json::from_str(json)?;
    if record.project_id != project
        || record.thread_id != thread
        || record.revision == 0
        || record.revision > i64::MAX as u64
        || record.turn > i64::MAX as u64
        || record.updated_at.is_empty()
    {
        return Err(ThreadError::CorruptState);
    }
    Ok(record)
}

fn read_record(
    connection: &Connection,
    project: &str,
    thread: &str,
) -> Result<Option<ThreadRecord>, ThreadError> {
    let row: Option<(String, i64)> = connection
        .query_row(
            "SELECT record_json,revision FROM agent_threads WHERE project_id=?1 AND thread_id=?2",
            params![project, thread],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(json, revision)| {
        let record = decode(&json, project, thread)?;
        if i64::try_from(record.revision).ok() != Some(revision) {
            return Err(ThreadError::CorruptState);
        }
        Ok(record)
    })
    .transpose()
}

fn checkpoint(record: &ThreadRecord) -> StateCheckpoint {
    let bytes = serde_json::to_vec(&(
        &record.project_id,
        &record.thread_id,
        record.turn,
        record.revision,
    ))
    .expect("serializing identifiers and integer revisions cannot fail");
    StateCheckpoint {
        checkpoint_id: format!("checkpoint:{}", hex::encode(Sha256::digest(bytes))),
        turn: record.turn,
        revision: record.revision,
    }
}

fn advance(record: &mut ThreadRecord, action: &ThreadAction) -> Result<(), ThreadError> {
    use ThreadState::*;
    let previous = record.state;
    let target = match action {
        ThreadAction::Create => return Err(ThreadError::RevisionConflict),
        ThreadAction::Start => Running,
        ThreadAction::Pause(target)
            if matches!(
                target,
                AwaitingUser | UserStopped | CreditsBlocked | Disconnected | RecoverableFailed
            ) =>
        {
            *target
        }
        ThreadAction::Pause(_) => return Err(ThreadError::InvalidTransition),
        ThreadAction::Complete => Completed,
        ThreadAction::Archive => Archived,
        ThreadAction::RestoreArchive => {
            if previous != Archived {
                return Err(ThreadError::InvalidTransition);
            }
            archive_restore_target(record.archived_from.ok_or(ThreadError::CorruptState)?)
                .ok_or(ThreadError::CorruptState)?
        }
    };
    if !matches!(action, ThreadAction::RestoreArchive) && !can_transition(previous, target) {
        return Err(ThreadError::InvalidTransition);
    }
    if matches!(action, ThreadAction::Start) {
        if matches!(previous, Ready | Completed) {
            record.turn = record
                .turn
                .checked_add(1)
                .filter(|v| *v <= i64::MAX as u64)
                .ok_or(ThreadError::InvalidInput)?;
            record.checkpoint = None;
        } else {
            let cp = record
                .checkpoint
                .as_ref()
                .ok_or(ThreadError::CheckpointRequired)?;
            let mut source = record.clone();
            source.revision = cp.revision;
            if cp.turn != record.turn
                || cp.turn == 0
                || cp.revision > record.revision
                || cp.revision == 0
                || *cp != checkpoint(&source)
            {
                return Err(ThreadError::CheckpointRequired);
            }
        }
    }
    record.revision = record
        .revision
        .checked_add(1)
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or(ThreadError::InvalidInput)?;
    record.state = target;
    match action {
        ThreadAction::Pause(_) => record.checkpoint = Some(checkpoint(record)),
        ThreadAction::Archive => record.archived_from = Some(previous),
        ThreadAction::RestoreArchive => record.archived_from = None,
        ThreadAction::Complete => record.checkpoint = None,
        _ => {}
    }
    Ok(())
}

impl ThreadStore {
    pub fn open(state_root: &Path) -> Result<Self, ThreadError> {
        let store = OperationalStore::open(state_root)?;
        {
            let mut connection = store
                .connection
                .lock()
                .map_err(|_| WorkspaceError::StoreLock)?;
            connection.busy_timeout(Duration::from_secs(5))?;
            agent_migration::migrate(&mut connection, state_root)?;
        }
        Ok(Self { store })
    }

    pub fn get(&self, project_id: &str, thread_id: &str) -> Result<ThreadRecord, ThreadError> {
        if !identifier(thread_id) {
            return Err(ThreadError::InvalidInput);
        }
        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        let tx = connection.transaction()?;
        ensure_scope(&tx, project_id)?;
        let record = read_record(&tx, project_id, thread_id)?.ok_or(ThreadError::NotFound)?;
        tx.commit()?;
        Ok(record)
    }

    /// Running rows are observations needing supervisor reconciliation, not retry jobs.
    pub fn recovery_candidates(&self, project_id: &str) -> Result<Vec<ThreadRecord>, ThreadError> {
        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        let tx = connection.transaction()?;
        ensure_scope(&tx, project_id)?;
        let mut statement = tx.prepare(
            "SELECT thread_id FROM agent_threads WHERE project_id=?1 ORDER BY thread_id",
        )?;
        let ids = statement
            .query_map([project_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut result = Vec::new();
        for id in ids {
            let record = read_record(&tx, project_id, &id)?.ok_or(ThreadError::NotFound)?;
            if record.state == ThreadState::Running {
                result.push(record);
            }
        }
        tx.commit()?;
        Ok(result)
    }

    pub fn apply(&self, command: &ThreadCommand) -> Result<ThreadRecord, ThreadError> {
        if !identifier(&command.thread_id)
            || !identifier(&command.request_id)
            || command.expected_revision >= i64::MAX as u64
        {
            return Err(ThreadError::InvalidInput);
        }
        let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(command)?));
        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_scope(&tx, &command.project_id)?;
        let cached: Option<(String, String)> = tx.query_row(
            "SELECT fingerprint,result_json FROM agent_requests WHERE project_id=?1 AND request_id=?2",
            params![command.project_id, command.request_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        if let Some((previous, json)) = cached {
            if fingerprint != previous {
                return Err(ThreadError::RequestIdReused);
            }
            return decode(&json, &command.project_id, &command.thread_id);
        }
        let current = read_record(&tx, &command.project_id, &command.thread_id)?;
        let create = matches!(command.action, ThreadAction::Create);
        let mut record = if create {
            if command.expected_revision != 0 || current.is_some() {
                return Err(ThreadError::RevisionConflict);
            }
            ThreadRecord {
                project_id: command.project_id.clone(),
                thread_id: command.thread_id.clone(),
                state: ThreadState::Ready,
                revision: 1,
                turn: 0,
                checkpoint: None,
                archived_from: None,
                updated_at: String::new(),
            }
        } else {
            let mut record = current.ok_or(ThreadError::NotFound)?;
            if record.revision != command.expected_revision {
                return Err(ThreadError::RevisionConflict);
            }
            advance(&mut record, &command.action)?;
            record
        };
        record.updated_at =
            tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                r.get(0)
            })?;
        let json = serde_json::to_string(&record)?;
        let sql_revision = i64::try_from(record.revision).map_err(|_| ThreadError::InvalidInput)?;
        let expected_revision =
            i64::try_from(command.expected_revision).map_err(|_| ThreadError::InvalidInput)?;
        if create {
            tx.execute("INSERT INTO agent_threads(thread_id,project_id,revision,record_json) VALUES(?1,?2,?3,?4)",
                params![record.thread_id, record.project_id, sql_revision, json])?;
        } else {
            let changed = tx.execute("UPDATE agent_threads SET revision=?3,record_json=?4 WHERE thread_id=?1 AND project_id=?2 AND revision=?5",
                params![record.thread_id, record.project_id, sql_revision, json, expected_revision])?;
            if changed != 1 {
                return Err(ThreadError::RevisionConflict);
            }
        }
        tx.execute("INSERT INTO agent_events(thread_id,revision,request_id,record_json) VALUES(?1,?2,?3,?4)",
            params![record.thread_id, sql_revision, command.request_id, json])?;
        tx.execute("INSERT INTO agent_requests(project_id,request_id,fingerprint,result_json) VALUES(?1,?2,?3,?4)",
            params![record.project_id, command.request_id, fingerprint, json])?;
        tx.commit()?;
        Ok(record)
    }
}
