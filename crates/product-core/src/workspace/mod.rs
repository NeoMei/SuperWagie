mod grant;
mod identity;
mod recovery;
mod secure_fs;
mod transaction;

use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::store::{DocumentRecord, OperationalStore};
use grant::WorkspaceGrant;
use secure_fs::SecureRead;

pub use recovery::RecoveryOutcome;
pub use transaction::{ConflictResolution, ConflictSnapshot, DraftHandle, SaveFault, SaveOutcome};

#[derive(Debug)]
pub enum WorkspaceError {
    InvalidLogicalPath,
    SymlinkDenied,
    NotRegularFile,
    FileTooLarge,
    InvalidUtf8,
    NotFound,
    HardlinkAlias,
    GrantRevoked,
    RootIdentityChanged,
    StoreLock,
    TestOnlyUnavailable,
    InjectedCrash,
    InjectedIoFailure,
    Io(std::io::Error),
    Store(rusqlite::Error),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidLogicalPath => "SW_WORKSPACE_INVALID_LOGICAL_PATH",
            Self::SymlinkDenied => "SW_WORKSPACE_SYMLINK_DENIED",
            Self::NotRegularFile => "SW_WORKSPACE_NOT_REGULAR_FILE",
            Self::FileTooLarge => "SW_WORKSPACE_FILE_TOO_LARGE",
            Self::InvalidUtf8 => "SW_WORKSPACE_INVALID_UTF8",
            Self::NotFound => "SW_WORKSPACE_NOT_FOUND",
            Self::HardlinkAlias => "SW_WORKSPACE_HARDLINK_ALIAS",
            Self::GrantRevoked => "SW_WORKSPACE_GRANT_REVOKED",
            Self::RootIdentityChanged => "SW_WORKSPACE_ROOT_IDENTITY_CHANGED",
            Self::StoreLock => "SW_WORKSPACE_STORE_LOCKED",
            Self::TestOnlyUnavailable => "SW_WORKSPACE_TEST_ONLY_UNAVAILABLE",
            Self::InjectedCrash => "SW_WORKSPACE_INJECTED_CRASH",
            Self::InjectedIoFailure => "SW_WORKSPACE_INJECTED_IO_FAILURE",
            Self::Io(_) => "SW_WORKSPACE_IO",
            Self::Store(_) => "SW_WORKSPACE_STORE",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for WorkspaceError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentSnapshot {
    pub document_id: String,
    pub file_identity: String,
    pub revision: String,
    pub content: String,
    pub logical_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationUpdate {
    pub document_id: String,
    pub old_logical_path: String,
    pub new_logical_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceTreeEntry {
    pub document_id: String,
    pub file_identity: String,
    pub logical_path: String,
}

pub struct Workspace {
    grant: WorkspaceGrant,
    store: OperationalStore,
    project_id: String,
    workspace_id: String,
    revoked: AtomicBool,
}

impl Workspace {
    #[doc(hidden)]
    pub fn open_for_test(root: &Path, state: &Path) -> Result<Self, WorkspaceError> {
        if !cfg!(debug_assertions) {
            return Err(WorkspaceError::TestOnlyUnavailable);
        }
        Self::open_authorized(root, state)
    }

    pub(crate) fn open_authorized(root: &Path, state: &Path) -> Result<Self, WorkspaceError> {
        let grant = WorkspaceGrant::open(root)?;
        let store = OperationalStore::open(state)?;
        let mount = store.authorize_mount(grant.root_identity(), root)?;
        Ok(Self {
            grant,
            store,
            project_id: mount.project_id,
            workspace_id: mount.workspace_id,
            revoked: AtomicBool::new(false),
        })
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }
    pub fn root_identity(&self) -> &str {
        self.grant.root_identity()
    }

    pub(crate) fn ensure_active(&self) -> Result<(), WorkspaceError> {
        if self.revoked.load(Ordering::Acquire) || !self.store.is_active(&self.workspace_id)? {
            return Err(WorkspaceError::GrantRevoked);
        }
        self.grant.verify_root_identity()
    }

    pub fn revoke(&self) -> Result<(), WorkspaceError> {
        self.store.revoke(&self.workspace_id)?;
        self.revoked.store(true, Ordering::Release);
        Ok(())
    }

    pub fn read(&self, logical_path: &str) -> Result<DocumentSnapshot, WorkspaceError> {
        self.ensure_active()?;
        let opened = self.grant.read_utf8(logical_path)?;
        let record = self.resolve_document(logical_path, &opened)?;
        let revision = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(opened.bytes.as_slice()))
        );
        self.store.remember_base(
            &self.workspace_id,
            &record.document_id,
            &revision,
            &opened.bytes,
        )?;
        let content = String::from_utf8(opened.bytes).map_err(|_| WorkspaceError::InvalidUtf8)?;
        Ok(DocumentSnapshot {
            document_id: record.document_id,
            file_identity: opened.file_identity,
            revision,
            content,
            logical_path: logical_path.to_owned(),
        })
    }

    fn resolve_document(
        &self,
        logical_path: &str,
        opened: &SecureRead,
    ) -> Result<DocumentRecord, WorkspaceError> {
        if let Some(mut record) = self
            .store
            .document_by_path(&self.workspace_id, logical_path)?
        {
            if record.file_identity != opened.file_identity {
                if self
                    .store
                    .document_by_identity(&self.workspace_id, &opened.file_identity)?
                    .is_some_and(|other| other.logical_path != logical_path)
                {
                    return Err(WorkspaceError::HardlinkAlias);
                }
                self.store.update_document_identity(
                    &self.workspace_id,
                    logical_path,
                    &opened.file_identity,
                )?;
                record.file_identity = opened.file_identity.clone();
            }
            return Ok(record);
        }
        if let Some(record) = self
            .store
            .document_by_identity(&self.workspace_id, &opened.file_identity)?
        {
            if self.grant.identity_if_present(&record.logical_path)?
                == Some(opened.file_identity.clone())
            {
                return Err(WorkspaceError::HardlinkAlias);
            }
            self.store.update_document_path(
                &self.workspace_id,
                &record.document_id,
                logical_path,
            )?;
            return Ok(DocumentRecord {
                logical_path: logical_path.to_owned(),
                ..record
            });
        }
        self.store
            .insert_document(&self.workspace_id, logical_path, &opened.file_identity)
    }

    pub fn reconcile(&self) -> Result<Vec<ReconciliationUpdate>, WorkspaceError> {
        self.ensure_active()?;
        let files = self.grant.list_markdown_files()?;
        let records = self.store.all_documents(&self.workspace_id)?;
        let mut updates = Vec::new();
        for record in records {
            if files
                .iter()
                .any(|entry| entry.logical_path == record.logical_path)
            {
                continue;
            }
            if let Some(found) = files
                .iter()
                .find(|entry| entry.file_identity == record.file_identity)
            {
                self.store.update_document_path(
                    &self.workspace_id,
                    &record.document_id,
                    &found.logical_path,
                )?;
                updates.push(ReconciliationUpdate {
                    document_id: record.document_id,
                    old_logical_path: record.logical_path,
                    new_logical_path: found.logical_path.clone(),
                });
            }
        }
        Ok(updates)
    }

    pub fn tree(&self) -> Result<Vec<WorkspaceTreeEntry>, WorkspaceError> {
        self.ensure_active()?;
        let entries = self.grant.list_markdown_files()?;
        let mut output = Vec::with_capacity(entries.len());
        for entry in entries {
            let snapshot = self.read(&entry.logical_path)?;
            output.push(WorkspaceTreeEntry {
                document_id: snapshot.document_id,
                file_identity: snapshot.file_identity,
                logical_path: snapshot.logical_path,
            });
        }
        Ok(output)
    }

    pub fn read_by_id(&self, document_id: &str) -> Result<DocumentSnapshot, WorkspaceError> {
        self.ensure_active()?;
        let mut document = self
            .store
            .document_by_id(&self.workspace_id, document_id)?
            .ok_or(WorkspaceError::NotFound)?;
        match self.read(&document.logical_path) {
            Ok(snapshot) => Ok(snapshot),
            Err(WorkspaceError::NotFound) => {
                self.reconcile()?;
                document = self
                    .store
                    .document_by_id(&self.workspace_id, document_id)?
                    .ok_or(WorkspaceError::NotFound)?;
                self.read(&document.logical_path)
            }
            Err(error) => Err(error),
        }
    }
}
