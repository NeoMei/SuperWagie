use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
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
                   ON documents(workspace_id, file_identity);",
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
}
