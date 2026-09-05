use serde::Deserialize;
use serde_json::Value;
use std::fmt;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    EnvelopeTooLarge,
    InvalidJson,
    InvalidEnvelope,
    UnsupportedVersion,
    ShellOnlyCommand,
    UnknownCommand,
    UnknownQuery,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::EnvelopeTooLarge => "SW_PROTOCOL_ENVELOPE_TOO_LARGE",
            Self::InvalidJson => "SW_PROTOCOL_INVALID_JSON",
            Self::InvalidEnvelope => "SW_PROTOCOL_INVALID_ENVELOPE",
            Self::UnsupportedVersion => "SW_PROTOCOL_VERSION_UNSUPPORTED",
            Self::ShellOnlyCommand => "SW_PROTOCOL_SHELL_ONLY_COMMAND",
            Self::UnknownCommand => "SW_PROTOCOL_COMMAND_UNKNOWN",
            Self::UnknownQuery => "SW_PROTOCOL_QUERY_UNKNOWN",
        };
        formatter.write_str(code)
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellSelection {
    selected_root: Option<PathBuf>,
}

impl ShellSelection {
    pub fn selected(selected_root: PathBuf) -> Self {
        Self {
            selected_root: Some(selected_root),
        }
    }

    pub fn cancelled() -> Self {
        Self {
            selected_root: None,
        }
    }

    pub fn selected_root(&self) -> Option<&Path> {
        self.selected_root.as_deref()
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientIntent {
    protocol_version: u64,
    request_id: String,
    command_type: String,
    resource_refs: Vec<Value>,
    requested_permissions: Vec<String>,
    expected_revision: Option<u64>,
    payload: Value,
    issued_at: String,
    deadline_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyPayload {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectIdPayload {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentOpenPayload {
    document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveDocument {
    pub document_id: String,
    pub base_revision: String,
    pub draft_handle_id: String,
    pub change_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ConflictAction {
    Merge,
    KeepCurrent,
    UseDisk,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveConflictPayload {
    conflict_id: String,
    latest_revision: String,
    action: ConflictAction,
    draft_handle_id: Option<String>,
}

fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'A'..=b'Z' | b'a'..=b'z' => true,
            b'0'..=b'9' | b'.' | b'_' | b':' | b'-' => index > 0,
            _ => false,
        })
}

fn is_sha256_revision(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn parse_closed<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, ProtocolError> {
    serde_json::from_value(value).map_err(|_| ProtocolError::InvalidEnvelope)
}

pub fn validate_renderer_bytes(bytes: &[u8]) -> Result<(), ProtocolError> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(ProtocolError::EnvelopeTooLarge);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidJson)?;
    validate_renderer_payload(&value)
}

pub fn validate_renderer_payload(value: &Value) -> Result<(), ProtocolError> {
    let serialized = serde_json::to_vec(value).map_err(|_| ProtocolError::InvalidJson)?;
    if serialized.len() > MAX_ENVELOPE_BYTES {
        return Err(ProtocolError::EnvelopeTooLarge);
    }
    let intent: ClientIntent =
        serde_json::from_value(value.clone()).map_err(|_| ProtocolError::InvalidEnvelope)?;
    if intent.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }
    if !is_identifier(&intent.request_id)
        || intent.resource_refs.len() > 128
        || intent
            .requested_permissions
            .iter()
            .any(|permission| permission.is_empty())
        || intent.issued_at.is_empty()
        || intent.deadline_at.as_deref() == Some("")
    {
        return Err(ProtocolError::InvalidEnvelope);
    }
    let _ = intent.expected_revision;

    match intent.command_type.as_str() {
        "project.open_selected" => Err(ProtocolError::ShellOnlyCommand),
        "project.activate" | "project.revoke" => {
            let payload: ProjectIdPayload = parse_closed(intent.payload)?;
            if is_identifier(&payload.project_id) {
                Ok(())
            } else {
                Err(ProtocolError::InvalidEnvelope)
            }
        }
        "document.open" | "document.close" => {
            let payload: DocumentOpenPayload = parse_closed(intent.payload)?;
            if is_identifier(&payload.document_id) {
                Ok(())
            } else {
                Err(ProtocolError::InvalidEnvelope)
            }
        }
        "document.save" => {
            let payload: SaveDocument = parse_closed(intent.payload)?;
            if is_identifier(&payload.document_id)
                && is_identifier(&payload.draft_handle_id)
                && is_sha256_revision(&payload.base_revision)
            {
                Ok(())
            } else {
                Err(ProtocolError::InvalidEnvelope)
            }
        }
        "document.resolve_conflict" => {
            let payload: ResolveConflictPayload = parse_closed(intent.payload)?;
            let needs_draft = matches!(
                payload.action,
                ConflictAction::Merge | ConflictAction::KeepCurrent
            );
            if is_identifier(&payload.conflict_id)
                && is_sha256_revision(&payload.latest_revision)
                && (!needs_draft
                    || payload
                        .draft_handle_id
                        .as_deref()
                        .is_some_and(is_identifier))
            {
                Ok(())
            } else {
                Err(ProtocolError::InvalidEnvelope)
            }
        }
        _ => Err(ProtocolError::UnknownCommand),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryRequest {
    protocol_version: u64,
    message_type: String,
    request_id: String,
    query_id: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTreeParams {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentSnapshotParams {
    document_id: String,
}

pub fn validate_query_payload(value: &Value) -> Result<(), ProtocolError> {
    let request: QueryRequest =
        serde_json::from_value(value.clone()).map_err(|_| ProtocolError::InvalidEnvelope)?;
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }
    if request.message_type != "query.execute" || !is_identifier(&request.request_id) {
        return Err(ProtocolError::InvalidEnvelope);
    }
    match request.query_id.as_str() {
        "project.list" => {
            let _: EmptyPayload = parse_closed(request.params)?;
            Ok(())
        }
        "workspace.tree" => {
            let params: WorkspaceTreeParams = parse_closed(request.params)?;
            if is_identifier(&params.project_id) {
                Ok(())
            } else {
                Err(ProtocolError::InvalidEnvelope)
            }
        }
        "document.snapshot" => {
            let params: DocumentSnapshotParams = parse_closed(request.params)?;
            if is_identifier(&params.document_id) {
                Ok(())
            } else {
                Err(ProtocolError::InvalidEnvelope)
            }
        }
        _ => Err(ProtocolError::UnknownQuery),
    }
}

pub fn run_stdio() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        validate_renderer_bytes(line.as_bytes())?;
        println!("{{\"protocol_version\":1,\"status\":\"accepted\"}}");
    }
    Ok(())
}
