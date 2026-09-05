use sha2::{Digest, Sha256};

use crate::store::DraftRecord;

use super::{DocumentSnapshot, Workspace, WorkspaceError};

const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftHandle {
    pub handle_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveOutcome {
    Committed {
        revision: String,
        change_generation: u64,
    },
    Conflict {
        conflict_id: String,
    },
    DiskKept {
        revision: String,
        change_generation: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveFault {
    CrashAfterPrepared,
    CrashAfterPublish,
    ExternalWriteAfterCompare(Vec<u8>),
    ExternalRenameBeforeCompare(String),
    FailBeforePublish,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictResolution {
    Merge(Vec<u8>),
    KeepCurrent,
    UseDisk,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictSnapshot {
    pub conflict_id: String,
    pub draft_handle_id: String,
    pub document_id: String,
    pub change_generation: u64,
    pub base_revision: String,
    pub current_revision: String,
    pub proposed_revision: String,
    pub base: Vec<u8>,
    pub current: Vec<u8>,
    pub proposed: Vec<u8>,
}

pub(super) fn revision(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn stable_token(prefix: &str, parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    format!("{prefix}:{}", hex::encode(&digest.finalize()[..16]))
}

fn validate_proposed(bytes: &[u8]) -> Result<(), WorkspaceError> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(WorkspaceError::FileTooLarge);
    }
    std::str::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidUtf8)?;
    Ok(())
}

impl Workspace {
    pub fn stage_draft(
        &self,
        document_id: &str,
        base_revision: &str,
        proposed: &[u8],
        change_generation: u64,
    ) -> Result<DraftHandle, WorkspaceError> {
        self.ensure_active()?;
        validate_proposed(proposed)?;
        let document = self
            .store
            .document_by_id(&self.workspace_id, document_id)?
            .ok_or(WorkspaceError::NotFound)?;
        if self
            .store
            .base_content(&self.workspace_id, document_id, base_revision)?
            .is_none()
        {
            return Err(WorkspaceError::NotFound);
        }
        let proposed_revision = revision(proposed);
        let generation = change_generation.to_string();
        let handle_id = stable_token(
            "draft",
            &[document_id, base_revision, &proposed_revision, &generation],
        );
        self.store.put_draft(
            &self.workspace_id,
            &DraftRecord {
                handle_id: handle_id.clone(),
                document_id: document_id.to_owned(),
                logical_path: document.logical_path,
                base_revision: base_revision.to_owned(),
                proposed: proposed.to_vec(),
                proposed_revision,
                change_generation,
                status: "staged".to_owned(),
                conflict_id: None,
                current_content: None,
                staging_path: None,
            },
        )?;
        Ok(DraftHandle { handle_id })
    }

    pub fn save(
        &self,
        document_id: &str,
        base_revision: &str,
        proposed: &[u8],
        change_generation: u64,
    ) -> Result<SaveOutcome, WorkspaceError> {
        let handle = self.stage_draft(document_id, base_revision, proposed, change_generation)?;
        self.save_staged(&handle.handle_id)
    }

    pub fn save_with_fault(
        &self,
        document_id: &str,
        base_revision: &str,
        proposed: &[u8],
        change_generation: u64,
        fault: SaveFault,
    ) -> Result<SaveOutcome, WorkspaceError> {
        let handle = self.stage_draft(document_id, base_revision, proposed, change_generation)?;
        self.commit_staged(&handle.handle_id, Some(fault))
    }

    pub fn save_staged(&self, handle_id: &str) -> Result<SaveOutcome, WorkspaceError> {
        self.commit_staged(handle_id, None)
    }

    pub fn save_staged_bound(
        &self,
        handle_id: &str,
        document_id: &str,
        base_revision: &str,
        change_generation: u64,
    ) -> Result<SaveOutcome, WorkspaceError> {
        self.ensure_active()?;
        let draft = self
            .store
            .draft_by_handle(&self.workspace_id, handle_id)?
            .ok_or(WorkspaceError::NotFound)?;
        if draft.document_id != document_id
            || draft.base_revision != base_revision
            || draft.change_generation != change_generation
        {
            return Err(WorkspaceError::NotFound);
        }
        self.commit_staged(handle_id, None)
    }

    pub fn staged_proposed_bound(
        &self,
        handle_id: &str,
        document_id: &str,
        base_revision: &str,
        change_generation: u64,
    ) -> Result<Vec<u8>, WorkspaceError> {
        self.ensure_active()?;
        let draft = self
            .store
            .draft_by_handle(&self.workspace_id, handle_id)?
            .ok_or(WorkspaceError::NotFound)?;
        if draft.document_id != document_id
            || draft.base_revision != base_revision
            || draft.change_generation != change_generation
        {
            return Err(WorkspaceError::NotFound);
        }
        Ok(draft.proposed)
    }

    pub fn staged_proposed_for_resolution(
        &self,
        handle_id: &str,
        document_id: &str,
        base_revision: &str,
    ) -> Result<(Vec<u8>, u64), WorkspaceError> {
        self.ensure_active()?;
        let draft = self
            .store
            .draft_by_handle(&self.workspace_id, handle_id)?
            .ok_or(WorkspaceError::NotFound)?;
        if draft.document_id != document_id || draft.base_revision != base_revision {
            return Err(WorkspaceError::NotFound);
        }
        Ok((draft.proposed, draft.change_generation))
    }

    pub(super) fn current_for_document(
        &self,
        document_id: &str,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        self.read_by_id(document_id)
    }

    pub(super) fn mark_conflict(
        &self,
        draft: &DraftRecord,
        current: &DocumentSnapshot,
        staging_path: Option<&str>,
    ) -> Result<SaveOutcome, WorkspaceError> {
        let conflict_id = stable_token(
            "conflict",
            &[&draft.handle_id, &current.revision, &current.logical_path],
        );
        self.store.update_draft_state(
            &self.workspace_id,
            &draft.handle_id,
            "conflicted",
            Some(&conflict_id),
            Some(current.content.as_bytes()),
            staging_path,
        )?;
        Ok(SaveOutcome::Conflict { conflict_id })
    }

    fn commit_staged(
        &self,
        handle_id: &str,
        fault: Option<SaveFault>,
    ) -> Result<SaveOutcome, WorkspaceError> {
        self.ensure_active()?;
        let draft = self
            .store
            .draft_by_handle(&self.workspace_id, handle_id)?
            .ok_or(WorkspaceError::NotFound)?;
        if draft.status == "committed" {
            return Ok(SaveOutcome::Committed {
                revision: draft.proposed_revision,
                change_generation: draft.change_generation,
            });
        }
        if draft.status == "conflicted" {
            return Ok(SaveOutcome::Conflict {
                conflict_id: draft.conflict_id.ok_or(WorkspaceError::NotFound)?,
            });
        }

        if let Some(SaveFault::ExternalRenameBeforeCompare(ref new_path)) = fault {
            self.grant.rename_for_fault(&draft.logical_path, new_path)?;
        }

        let current = self.current_for_document(&draft.document_id)?;
        if current.logical_path != draft.logical_path || current.revision != draft.base_revision {
            return self.mark_conflict(&draft, &current, None);
        }
        self.store.update_draft_state(
            &self.workspace_id,
            &draft.handle_id,
            "prepared",
            None,
            Some(current.content.as_bytes()),
            None,
        )?;

        match fault {
            Some(SaveFault::CrashAfterPrepared) => return Err(WorkspaceError::InjectedCrash),
            Some(SaveFault::FailBeforePublish) => {
                return Err(WorkspaceError::InjectedIoFailure);
            }
            Some(SaveFault::ExternalWriteAfterCompare(ref bytes)) => {
                validate_proposed(bytes)?;
                self.grant.overwrite_for_fault(&draft.logical_path, bytes)?;
            }
            Some(SaveFault::ExternalRenameBeforeCompare(_)) | None => {}
            Some(SaveFault::CrashAfterPublish) => {}
        }

        let evidence =
            self.grant
                .atomic_publish(&draft.logical_path, &draft.proposed, &draft.handle_id)?;
        self.store.update_draft_state(
            &self.workspace_id,
            &draft.handle_id,
            "prepared",
            None,
            None,
            Some(&evidence.staging_path),
        )?;
        if evidence.published_bytes != draft.proposed {
            return Err(WorkspaceError::InjectedIoFailure);
        }
        if evidence.previous_bytes != current.content.as_bytes() {
            let restored = self.grant.restore_previous_if_target_matches(
                &draft.logical_path,
                &evidence.staging_path,
                &draft.proposed,
            )?;
            let latest = self.current_for_document(&draft.document_id)?;
            let outcome = self.mark_conflict(&draft, &latest, Some(&evidence.staging_path))?;
            if restored {
                self.grant.remove_staging(&evidence.staging_path)?;
            }
            return Ok(outcome);
        }

        if matches!(fault, Some(SaveFault::CrashAfterPublish)) {
            return Err(WorkspaceError::InjectedCrash);
        }
        self.store.update_draft_state(
            &self.workspace_id,
            &draft.handle_id,
            "committed",
            None,
            None,
            Some(&evidence.staging_path),
        )?;
        self.store.remember_base(
            &self.workspace_id,
            &draft.document_id,
            &draft.proposed_revision,
            &draft.proposed,
        )?;
        self.grant.remove_staging(&evidence.staging_path)?;
        Ok(SaveOutcome::Committed {
            revision: draft.proposed_revision,
            change_generation: draft.change_generation,
        })
    }

    pub fn resolve_conflict(
        &self,
        conflict_id: &str,
        latest_revision: &str,
        resolution: ConflictResolution,
        change_generation: u64,
    ) -> Result<SaveOutcome, WorkspaceError> {
        self.ensure_active()?;
        let draft = self
            .store
            .draft_by_conflict(&self.workspace_id, conflict_id)?
            .ok_or(WorkspaceError::NotFound)?;
        let current = self.current_for_document(&draft.document_id)?;
        if current.revision != latest_revision {
            let handle = self.stage_draft(
                &draft.document_id,
                latest_revision,
                &draft.proposed,
                change_generation,
            )?;
            let replacement = self
                .store
                .draft_by_handle(&self.workspace_id, &handle.handle_id)?
                .ok_or(WorkspaceError::NotFound)?;
            return self.mark_conflict(&replacement, &current, None);
        }
        if matches!(resolution, ConflictResolution::UseDisk) {
            self.store.update_draft_state(
                &self.workspace_id,
                &draft.handle_id,
                "resolved_disk",
                None,
                Some(current.content.as_bytes()),
                None,
            )?;
            return Ok(SaveOutcome::DiskKept {
                revision: current.revision,
                change_generation,
            });
        }
        let proposed = match resolution {
            ConflictResolution::Merge(bytes) => bytes,
            ConflictResolution::KeepCurrent => draft.proposed.clone(),
            ConflictResolution::UseDisk => unreachable!(),
        };
        self.store.update_draft_state(
            &self.workspace_id,
            &draft.handle_id,
            "resolved_local",
            None,
            Some(current.content.as_bytes()),
            None,
        )?;
        self.save(
            &draft.document_id,
            &current.revision,
            &proposed,
            change_generation,
        )
    }

    pub fn conflict_snapshot(&self, conflict_id: &str) -> Result<ConflictSnapshot, WorkspaceError> {
        self.ensure_active()?;
        let draft = self
            .store
            .draft_by_conflict(&self.workspace_id, conflict_id)?
            .ok_or(WorkspaceError::NotFound)?;
        let base = self
            .store
            .base_content(&self.workspace_id, &draft.document_id, &draft.base_revision)?
            .ok_or(WorkspaceError::NotFound)?;
        let current = draft.current_content.ok_or(WorkspaceError::NotFound)?;
        Ok(ConflictSnapshot {
            conflict_id: conflict_id.to_owned(),
            draft_handle_id: draft.handle_id,
            document_id: draft.document_id,
            change_generation: draft.change_generation,
            base_revision: draft.base_revision,
            current_revision: revision(&current),
            proposed_revision: draft.proposed_revision,
            base,
            current,
            proposed: draft.proposed,
        })
    }

    pub fn pending_draft_count(&self) -> Result<u64, WorkspaceError> {
        self.ensure_active()?;
        self.store.pending_draft_count(&self.workspace_id)
    }
}
