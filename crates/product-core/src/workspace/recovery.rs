use super::{SaveOutcome, Workspace, WorkspaceError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryOutcome {
    Committed {
        handle_id: String,
        revision: String,
    },
    Conflicted {
        handle_id: String,
        conflict_id: String,
    },
}

impl Workspace {
    pub fn recover(&self) -> Result<Vec<RecoveryOutcome>, WorkspaceError> {
        self.ensure_active()?;
        let drafts = self.store.pending_drafts(&self.workspace_id)?;
        let mut outcomes = Vec::with_capacity(drafts.len());
        for draft in drafts {
            let current = self.current_for_document(&draft.document_id)?;
            let outcome = if current.logical_path != draft.logical_path {
                self.mark_conflict(&draft, &current, draft.staging_path.as_deref())?
            } else if current.revision == draft.proposed_revision {
                self.store.update_draft_state(
                    &self.workspace_id,
                    &draft.handle_id,
                    "committed",
                    None,
                    None,
                    draft.staging_path.as_deref(),
                )?;
                self.store.remember_base(
                    &self.workspace_id,
                    &draft.document_id,
                    &draft.proposed_revision,
                    &draft.proposed,
                )?;
                if let Some(staging_path) = draft.staging_path.as_deref() {
                    self.grant.remove_staging(staging_path)?;
                }
                SaveOutcome::Committed {
                    revision: draft.proposed_revision.clone(),
                    change_generation: draft.change_generation,
                }
            } else if current.revision == draft.base_revision {
                self.save_staged(&draft.handle_id)?
            } else {
                self.mark_conflict(&draft, &current, draft.staging_path.as_deref())?
            };
            outcomes.push(match outcome {
                SaveOutcome::Committed { revision, .. } => RecoveryOutcome::Committed {
                    handle_id: draft.handle_id,
                    revision,
                },
                SaveOutcome::Conflict { conflict_id } => RecoveryOutcome::Conflicted {
                    handle_id: draft.handle_id,
                    conflict_id,
                },
                SaveOutcome::DiskKept { revision, .. } => RecoveryOutcome::Committed {
                    handle_id: draft.handle_id,
                    revision,
                },
            });
        }
        Ok(outcomes)
    }
}
