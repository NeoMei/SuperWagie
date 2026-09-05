use super::state::ThreadState;
use crate::workspace::WorkspaceError;
use serde::{Deserialize, Serialize};

/// Core-internal command. No renderer/Worker transport accepts this type directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadCommand {
    pub project_id: String,
    pub thread_id: String,
    pub request_id: String,
    pub expected_revision: u64,
    pub action: ThreadAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadAction {
    Create,
    Start,
    Pause(ThreadState),
    Complete,
    Archive,
    RestoreArchive,
}

/// Local state checkpoint only: never an App Server cursor or execution authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateCheckpoint {
    pub checkpoint_id: String,
    pub turn: u64,
    pub revision: u64,
}

/// Operational record, not the public UI snapshot schema or a financial ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadRecord {
    pub project_id: String,
    pub thread_id: String,
    pub state: ThreadState,
    pub revision: u64,
    pub turn: u64,
    pub checkpoint: Option<StateCheckpoint>,
    pub archived_from: Option<ThreadState>,
    pub updated_at: String,
}

#[derive(Debug)]
pub enum ThreadError {
    Storage(WorkspaceError),
    Sql(rusqlite::Error),
    InvalidInput,
    ScopeDenied,
    NotFound,
    RevisionConflict,
    RequestIdReused,
    InvalidTransition,
    CheckpointRequired,
    CorruptState,
    UnsupportedSchema(i64),
}

impl std::fmt::Display for ThreadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Storage(_) | Self::Sql(_) => "SW_AGENT_STORE_FAILURE",
            Self::InvalidInput => "SW_AGENT_INVALID_INPUT",
            Self::ScopeDenied => "SW_AGENT_SCOPE_DENIED",
            Self::NotFound => "SW_AGENT_THREAD_NOT_FOUND",
            Self::RevisionConflict => "SW_AGENT_REVISION_CONFLICT",
            Self::RequestIdReused => "SW_AGENT_REQUEST_ID_REUSED",
            Self::InvalidTransition => "SW_AGENT_INVALID_TRANSITION",
            Self::CheckpointRequired => "SW_AGENT_CHECKPOINT_REQUIRED",
            Self::CorruptState => "SW_AGENT_CORRUPT_STATE",
            Self::UnsupportedSchema(_) => "SW_AGENT_SCHEMA_UNSUPPORTED",
        })
    }
}
impl std::error::Error for ThreadError {}
impl From<WorkspaceError> for ThreadError {
    fn from(value: WorkspaceError) -> Self {
        Self::Storage(value)
    }
}
impl From<rusqlite::Error> for ThreadError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value)
    }
}
impl From<std::io::Error> for ThreadError {
    fn from(value: std::io::Error) -> Self {
        Self::Storage(WorkspaceError::Io(value))
    }
}
impl From<serde_json::Error> for ThreadError {
    fn from(_: serde_json::Error) -> Self {
        Self::CorruptState
    }
}
