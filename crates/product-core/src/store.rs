mod agent_migration;
pub(crate) mod threads;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::workspace::WorkspaceError;

pub(crate) struct OperationalStore {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone)]
pub(crate) struct MountRecord {
    pub project_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct DocumentRecord {
    pub document_id: String,
    pub logical_path: String,
    pub file_identity: String,
}

#[derive(Debug, Clone)]
pub(crate) struct DraftRecord {
    pub handle_id: String,
    pub document_id: String,
    pub logical_path: String,
    pub base_revision: String,
    pub proposed: Vec<u8>,
    pub proposed_revision: String,
    pub change_generation: u64,
    pub status: String,
    pub conflict_id: Option<String>,
    pub current_content: Option<Vec<u8>>,
    pub staging_path: Option<String>,
}

fn stable_id(prefix: &str, seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    format!("{prefix}:{}", hex::encode(&digest[..16]))
}

impl OperationalStore {
    pub(crate) fn open(state_root: &Path) -> Result<Self, WorkspaceError> {
        fs::create_dir_all(state_root).map_err(WorkspaceError::Io)?;
        fs::set_permissions(state_root, fs::Permissions::from_mode(0o700))
            .map_err(WorkspaceError::Io)?;
        let path = state_root.join("operational.sqlite3");
        let connection = Connection::open(&path).map_err(WorkspaceError::Store)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(WorkspaceError::Io)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=FULL;
                 PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS workspaces (
                   root_identity TEXT PRIMARY KEY,
                   root_path TEXT NOT NULL,
                   project_id TEXT NOT NULL UNIQUE,
                   workspace_id TEXT NOT NULL UNIQUE,
                   active INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS documents (
                   workspace_id TEXT NOT NULL,
                   logical_path TEXT NOT NULL,
                   document_id TEXT NOT NULL,
                   file_identity TEXT NOT NULL,
                   PRIMARY KEY (workspace_id, logical_path),
                   UNIQUE (workspace_id, document_id)
                 );
                 CREATE INDEX IF NOT EXISTS documents_by_identity
                   ON documents(workspace_id, file_identity);
                 CREATE TABLE IF NOT EXISTS document_bases (
                   workspace_id TEXT NOT NULL,
                   document_id TEXT NOT NULL,
                   revision TEXT NOT NULL,
                   content BLOB NOT NULL,
                   PRIMARY KEY (workspace_id, document_id, revision)
                 );
                 CREATE TABLE IF NOT EXISTS drafts (
                   handle_id TEXT PRIMARY KEY,
                   workspace_id TEXT NOT NULL,
                   document_id TEXT NOT NULL,
                   logical_path TEXT NOT NULL,
                   base_revision TEXT NOT NULL,
                   proposed BLOB NOT NULL,
                   proposed_revision TEXT NOT NULL,
                   change_generation INTEGER NOT NULL,
                   status TEXT NOT NULL,
                   conflict_id TEXT,
                   current_content BLOB,
                   staging_path TEXT
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS drafts_by_conflict
                   ON drafts(conflict_id) WHERE conflict_id IS NOT NULL;",
            )
            .map_err(WorkspaceError::Store)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub(crate) fn authorize_mount(
        &self,
        root_identity: &str,
        root_path: &Path,
    ) -> Result<MountRecord, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .execute("UPDATE workspaces SET active = 0", [])
            .map_err(WorkspaceError::Store)?;
        let existing = connection
            .query_row(
                "SELECT project_id, workspace_id FROM workspaces WHERE root_identity = ?1",
                [root_identity],
                |row| {
                    Ok(MountRecord {
                        project_id: row.get(0)?,
                        workspace_id: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(WorkspaceError::Store)?;
        if let Some(record) = existing {
            connection
                .execute(
                    "UPDATE workspaces SET active = 1, root_path = ?2 WHERE root_identity = ?1",
                    params![root_identity, root_path.to_string_lossy()],
                )
                .map_err(WorkspaceError::Store)?;
            return Ok(record);
        }
        let workspace_id = stable_id("workspace", root_identity);
        let project_id = stable_id("project", root_identity);
        connection
            .execute(
                "INSERT INTO workspaces(root_identity, root_path, project_id, workspace_id, active)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                params![
                    root_identity,
                    root_path.to_string_lossy(),
                    project_id,
                    workspace_id
                ],
            )
            .map_err(WorkspaceError::Store)?;
        Ok(MountRecord {
            project_id,
            workspace_id,
        })
    }

    pub(crate) fn active_root(&self) -> Result<Option<PathBuf>, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .query_row(
                "SELECT root_path FROM workspaces WHERE active = 1 LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|path| path.map(PathBuf::from))
            .map_err(WorkspaceError::Store)
    }

    pub(crate) fn is_active(&self, workspace_id: &str) -> Result<bool, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .query_row(
                "SELECT active FROM workspaces WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value == Some(1))
            .map_err(WorkspaceError::Store)
    }

    pub(crate) fn revoke(&self, workspace_id: &str) -> Result<(), WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .execute(
                "UPDATE workspaces SET active = 0 WHERE workspace_id = ?1",
                [workspace_id],
            )
            .map_err(WorkspaceError::Store)?;
        Ok(())
    }

    pub(crate) fn document_by_path(
        &self,
        workspace_id: &str,
        logical_path: &str,
    ) -> Result<Option<DocumentRecord>, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .query_row(
                "SELECT document_id, logical_path, file_identity FROM documents
                 WHERE workspace_id = ?1 AND logical_path = ?2",
                params![workspace_id, logical_path],
                |row| {
                    Ok(DocumentRecord {
                        document_id: row.get(0)?,
                        logical_path: row.get(1)?,
                        file_identity: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(WorkspaceError::Store)
    }

    pub(crate) fn document_by_identity(
        &self,
        workspace_id: &str,
        file_identity: &str,
    ) -> Result<Option<DocumentRecord>, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .query_row(
                "SELECT document_id, logical_path, file_identity FROM documents
                 WHERE workspace_id = ?1 AND file_identity = ?2 LIMIT 1",
                params![workspace_id, file_identity],
                |row| {
                    Ok(DocumentRecord {
                        document_id: row.get(0)?,
                        logical_path: row.get(1)?,
                        file_identity: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(WorkspaceError::Store)
    }

    pub(crate) fn document_by_id(
        &self,
        workspace_id: &str,
        document_id: &str,
    ) -> Result<Option<DocumentRecord>, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .query_row(
                "SELECT document_id, logical_path, file_identity FROM documents
                 WHERE workspace_id = ?1 AND document_id = ?2",
                params![workspace_id, document_id],
                |row| {
                    Ok(DocumentRecord {
                        document_id: row.get(0)?,
                        logical_path: row.get(1)?,
                        file_identity: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(WorkspaceError::Store)
    }

    pub(crate) fn insert_document(
        &self,
        workspace_id: &str,
        logical_path: &str,
        file_identity: &str,
    ) -> Result<DocumentRecord, WorkspaceError> {
        let document_id = stable_id(
            "document",
            &format!("{workspace_id}\0{logical_path}\0{file_identity}"),
        );
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .execute(
                "INSERT INTO documents(workspace_id, logical_path, document_id, file_identity)
                 VALUES (?1, ?2, ?3, ?4)",
                params![workspace_id, logical_path, document_id, file_identity],
            )
            .map_err(WorkspaceError::Store)?;
        Ok(DocumentRecord {
            document_id,
            logical_path: logical_path.to_owned(),
            file_identity: file_identity.to_owned(),
        })
    }

    pub(crate) fn update_document_identity(
        &self,
        workspace_id: &str,
        logical_path: &str,
        file_identity: &str,
    ) -> Result<(), WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .execute(
                "UPDATE documents SET file_identity = ?3
                 WHERE workspace_id = ?1 AND logical_path = ?2",
                params![workspace_id, logical_path, file_identity],
            )
            .map_err(WorkspaceError::Store)?;
        Ok(())
    }

    pub(crate) fn update_document_path(
        &self,
        workspace_id: &str,
        document_id: &str,
        logical_path: &str,
    ) -> Result<(), WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .execute(
                "UPDATE documents SET logical_path = ?3
                 WHERE workspace_id = ?1 AND document_id = ?2",
                params![workspace_id, document_id, logical_path],
            )
            .map_err(WorkspaceError::Store)?;
        Ok(())
    }

    pub(crate) fn all_documents(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<DocumentRecord>, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        let mut statement = connection
            .prepare(
                "SELECT document_id, logical_path, file_identity FROM documents
                 WHERE workspace_id = ?1 ORDER BY logical_path",
            )
            .map_err(WorkspaceError::Store)?;
        let records = statement
            .query_map([workspace_id], |row| {
                Ok(DocumentRecord {
                    document_id: row.get(0)?,
                    logical_path: row.get(1)?,
                    file_identity: row.get(2)?,
                })
            })
            .map_err(WorkspaceError::Store)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(WorkspaceError::Store)?;
        Ok(records)
    }

    pub(crate) fn remember_base(
        &self,
        workspace_id: &str,
        document_id: &str,
        revision: &str,
        content: &[u8],
    ) -> Result<(), WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .execute(
                "INSERT OR IGNORE INTO document_bases(workspace_id, document_id, revision, content)
                 VALUES (?1, ?2, ?3, ?4)",
                params![workspace_id, document_id, revision, content],
            )
            .map_err(WorkspaceError::Store)?;
        Ok(())
    }

    pub(crate) fn base_content(
        &self,
        workspace_id: &str,
        document_id: &str,
        revision: &str,
    ) -> Result<Option<Vec<u8>>, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .query_row(
                "SELECT content FROM document_bases
                 WHERE workspace_id = ?1 AND document_id = ?2 AND revision = ?3",
                params![workspace_id, document_id, revision],
                |row| row.get(0),
            )
            .optional()
            .map_err(WorkspaceError::Store)
    }

    pub(crate) fn put_draft(
        &self,
        workspace_id: &str,
        draft: &DraftRecord,
    ) -> Result<(), WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .execute(
                "INSERT INTO drafts(
                   handle_id, workspace_id, document_id, logical_path, base_revision, proposed,
                   proposed_revision, change_generation, status, conflict_id,
                   current_content, staging_path
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(handle_id) DO UPDATE SET
                   proposed = excluded.proposed,
                   proposed_revision = excluded.proposed_revision,
                   change_generation = excluded.change_generation",
                params![
                    draft.handle_id,
                    workspace_id,
                    draft.document_id,
                    draft.logical_path,
                    draft.base_revision,
                    draft.proposed,
                    draft.proposed_revision,
                    draft.change_generation as i64,
                    draft.status,
                    draft.conflict_id,
                    draft.current_content,
                    draft.staging_path,
                ],
            )
            .map_err(WorkspaceError::Store)?;
        Ok(())
    }

    pub(crate) fn draft_by_handle(
        &self,
        workspace_id: &str,
        handle_id: &str,
    ) -> Result<Option<DraftRecord>, WorkspaceError> {
        self.query_draft(
            "SELECT handle_id, document_id, logical_path, base_revision, proposed, proposed_revision,
                    change_generation, status, conflict_id, current_content, staging_path
             FROM drafts WHERE workspace_id = ?1 AND handle_id = ?2",
            workspace_id,
            handle_id,
        )
    }

    pub(crate) fn draft_by_conflict(
        &self,
        workspace_id: &str,
        conflict_id: &str,
    ) -> Result<Option<DraftRecord>, WorkspaceError> {
        self.query_draft(
            "SELECT handle_id, document_id, logical_path, base_revision, proposed, proposed_revision,
                    change_generation, status, conflict_id, current_content, staging_path
             FROM drafts WHERE workspace_id = ?1 AND conflict_id = ?2",
            workspace_id,
            conflict_id,
        )
    }

    fn query_draft(
        &self,
        sql: &str,
        workspace_id: &str,
        key: &str,
    ) -> Result<Option<DraftRecord>, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .query_row(sql, params![workspace_id, key], |row| {
                Ok(DraftRecord {
                    handle_id: row.get(0)?,
                    document_id: row.get(1)?,
                    logical_path: row.get(2)?,
                    base_revision: row.get(3)?,
                    proposed: row.get(4)?,
                    proposed_revision: row.get(5)?,
                    change_generation: row.get::<_, i64>(6)? as u64,
                    status: row.get(7)?,
                    conflict_id: row.get(8)?,
                    current_content: row.get(9)?,
                    staging_path: row.get(10)?,
                })
            })
            .optional()
            .map_err(WorkspaceError::Store)
    }

    pub(crate) fn update_draft_state(
        &self,
        workspace_id: &str,
        handle_id: &str,
        status: &str,
        conflict_id: Option<&str>,
        current_content: Option<&[u8]>,
        staging_path: Option<&str>,
    ) -> Result<(), WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .execute(
                "UPDATE drafts SET status = ?3, conflict_id = COALESCE(?4, conflict_id),
                   current_content = COALESCE(?5, current_content),
                   staging_path = COALESCE(?6, staging_path)
                 WHERE workspace_id = ?1 AND handle_id = ?2",
                params![
                    workspace_id,
                    handle_id,
                    status,
                    conflict_id,
                    current_content,
                    staging_path
                ],
            )
            .map_err(WorkspaceError::Store)?;
        Ok(())
    }

    pub(crate) fn pending_drafts(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<DraftRecord>, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        let mut statement = connection
            .prepare(
                "SELECT handle_id, document_id, logical_path, base_revision, proposed, proposed_revision,
                        change_generation, status, conflict_id, current_content, staging_path
                 FROM drafts WHERE workspace_id = ?1 AND status IN ('staged', 'prepared')
                 ORDER BY rowid",
            )
            .map_err(WorkspaceError::Store)?;
        statement
            .query_map([workspace_id], |row| {
                Ok(DraftRecord {
                    handle_id: row.get(0)?,
                    document_id: row.get(1)?,
                    logical_path: row.get(2)?,
                    base_revision: row.get(3)?,
                    proposed: row.get(4)?,
                    proposed_revision: row.get(5)?,
                    change_generation: row.get::<_, i64>(6)? as u64,
                    status: row.get(7)?,
                    conflict_id: row.get(8)?,
                    current_content: row.get(9)?,
                    staging_path: row.get(10)?,
                })
            })
            .map_err(WorkspaceError::Store)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(WorkspaceError::Store)
    }

    pub(crate) fn pending_draft_count(&self, workspace_id: &str) -> Result<u64, WorkspaceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkspaceError::StoreLock)?;
        connection
            .query_row(
                "SELECT COUNT(*) FROM drafts WHERE workspace_id = ?1
                 AND status IN ('staged', 'prepared', 'conflicted')",
                [workspace_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count as u64)
            .map_err(WorkspaceError::Store)
    }
}
