use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::protocol::{
    ProtocolError, ShellSelection, validate_query_payload, validate_renderer_payload,
};
use crate::store::OperationalStore;
use crate::workspace::{ConflictResolution, DraftHandle, SaveOutcome, Workspace, WorkspaceError};

type HmacSha256 = Hmac<Sha256>;
const RESOURCE_RANGE_LIMIT: usize = 256 * 1024;
const RESOURCE_TTL_SECONDS: u64 = 300;

#[derive(Debug)]
pub enum GatewayError {
    Protocol(ProtocolError),
    Workspace(WorkspaceError),
    InvalidRequest,
    ScopeMismatch,
    ResourceDenied,
    Io(std::io::Error),
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Protocol(error) => error.fmt(formatter),
            Self::Workspace(error) => error.fmt(formatter),
            Self::InvalidRequest => formatter.write_str("SW_GATEWAY_INVALID_REQUEST"),
            Self::ScopeMismatch => formatter.write_str("SW_GATEWAY_SCOPE_MISMATCH"),
            Self::ResourceDenied => formatter.write_str("SW_RESOURCE_DENIED"),
            Self::Io(_) => formatter.write_str("SW_GATEWAY_IO"),
        }
    }
}

impl std::error::Error for GatewayError {}

impl From<ProtocolError> for GatewayError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

impl From<WorkspaceError> for GatewayError {
    fn from(value: WorkspaceError) -> Self {
        Self::Workspace(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedProject {
    pub project_id: String,
    pub workspace_id: String,
}

struct ResourceRecord {
    document_id: String,
    revision: String,
    audience: String,
    expires_at_seconds: u64,
    size: usize,
}

struct DraftUpload {
    document_id: String,
    base_revision: String,
    expected_size: usize,
    expected_revision: String,
    change_generation: u64,
    bytes: Vec<u8>,
}

pub struct Gateway {
    state_root: PathBuf,
    workspace: Option<Workspace>,
    resource_key: [u8; 32],
    resources: HashMap<String, ResourceRecord>,
    draft_uploads: HashMap<String, DraftUpload>,
    snapshot_revision: u64,
    recovery_pending: usize,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_key() -> Result<[u8; 32], GatewayError> {
    let mut key = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut key))
        .map_err(GatewayError::Io)?;
    Ok(key)
}

fn rfc3339_utc(seconds: u64) -> Result<String, GatewayError> {
    let raw: libc::time_t = seconds
        .try_into()
        .map_err(|_| GatewayError::InvalidRequest)?;
    let mut value: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&raw, &mut value) }.is_null() {
        return Err(GatewayError::InvalidRequest);
    }
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.tm_year + 1900,
        value.tm_mon + 1,
        value.tm_mday,
        value.tm_hour,
        value.tm_min,
        value.tm_sec
    ))
}

fn parameter<'a>(request: &'a Value, name: &str) -> Result<&'a str, GatewayError> {
    request
        .get("params")
        .and_then(|params| params.get(name))
        .and_then(Value::as_str)
        .ok_or(GatewayError::InvalidRequest)
}

impl Gateway {
    pub fn open(state_root: &Path) -> Result<Self, GatewayError> {
        let persisted_root = OperationalStore::open(state_root)?.active_root()?;
        let workspace = persisted_root
            .as_deref()
            .map(|root| Workspace::open_authorized(root, state_root))
            .transpose()?;
        let recovery_pending = workspace
            .as_ref()
            .map(|active| active.recover())
            .transpose()?
            .map(|outcomes| {
                outcomes
                    .iter()
                    .filter(|outcome| {
                        matches!(outcome, crate::workspace::RecoveryOutcome::Conflicted { .. })
                    })
                    .count()
            })
            .unwrap_or(0);
        Ok(Self {
            state_root: state_root.to_owned(),
            workspace,
            resource_key: random_key()?,
            resources: HashMap::new(),
            draft_uploads: HashMap::new(),
            snapshot_revision: 0,
            recovery_pending,
        })
    }

    #[doc(hidden)]
    pub fn open_for_test(state_root: &Path) -> Result<Self, GatewayError> {
        if !cfg!(debug_assertions) {
            return Err(GatewayError::InvalidRequest);
        }
        Self::open(state_root)
    }

    pub fn select(
        &mut self,
        selection: ShellSelection,
    ) -> Result<Option<SelectedProject>, GatewayError> {
        let Some(root) = selection.selected_root() else {
            return Ok(None);
        };
        let workspace = Workspace::open_authorized(root, &self.state_root)?;
        let selected = SelectedProject {
            project_id: workspace.project_id().to_owned(),
            workspace_id: workspace.workspace_id().to_owned(),
        };
        self.workspace = Some(workspace);
        self.resources.clear();
        self.draft_uploads.clear();
        self.snapshot_revision = self.snapshot_revision.saturating_add(1);
        self.recovery_pending = 0;
        Ok(Some(selected))
    }

    pub fn query(&mut self, request: &Value) -> Result<Value, GatewayError> {
        validate_query_payload(request)?;
        let request_id = request["request_id"]
            .as_str()
            .ok_or(GatewayError::InvalidRequest)?;
        let query_id = request["query_id"]
            .as_str()
            .ok_or(GatewayError::InvalidRequest)?;
        let payload = match query_id {
            "project.list" => {
                let items = self
                    .workspace
                    .as_ref()
                    .map(|workspace| {
                        vec![json!({
                            "project_id": workspace.project_id(),
                            "workspace_id": workspace.workspace_id(),
                            "status": "active",
                            "recovery_pending": self.recovery_pending
                        })]
                    })
                    .unwrap_or_default();
                json!({ "items": items })
            }
            "workspace.tree" => {
                let requested_project = parameter(request, "project_id")?;
                let workspace = self.workspace.as_ref().ok_or(GatewayError::ScopeMismatch)?;
                if workspace.project_id() != requested_project {
                    return Err(GatewayError::ScopeMismatch);
                }
                let items = workspace
                    .tree()?
                    .into_iter()
                    .map(|entry| {
                        json!({
                            "document_id": entry.document_id,
                            "file_identity": entry.file_identity,
                            "logical_path": entry.logical_path,
                            "kind": "markdown"
                        })
                    })
                    .collect::<Vec<_>>();
                json!({ "project_id": requested_project, "items": items })
            }
            "document.snapshot" => {
                let document_id = parameter(request, "document_id")?;
                let workspace = self.workspace.as_ref().ok_or(GatewayError::ScopeMismatch)?;
                let snapshot = workspace.read_by_id(document_id)?;
                let project_id = workspace.project_id().to_owned();
                let handle = self.issue_document_handle(&snapshot)?;
                json!({
                    "project_id": project_id,
                    "document_id": snapshot.document_id,
                    "file_identity": snapshot.file_identity,
                    "logical_path": snapshot.logical_path,
                    "revision": snapshot.revision,
                    "content_handle": handle
                })
            }
            _ => return Err(GatewayError::InvalidRequest),
        };
        self.snapshot_revision = self.snapshot_revision.saturating_add(1);
        Ok(json!({
            "protocol_version": 1,
            "message_type": "query.snapshot",
            "request_id": request_id,
            "query_id": query_id,
            "snapshot_revision": self.snapshot_revision,
            "projection_version": "workspace_projection:v1",
            "payload": payload
        }))
    }

    fn issue_document_handle(
        &mut self,
        snapshot: &crate::workspace::DocumentSnapshot,
    ) -> Result<Value, GatewayError> {
        let workspace = self.workspace.as_ref().ok_or(GatewayError::ScopeMismatch)?;
        let issued = now_seconds();
        let expires = issued + RESOURCE_TTL_SECONDS;
        let seed = format!(
            "{}\0{}\0{}\0{}",
            workspace.project_id(),
            snapshot.document_id,
            snapshot.revision,
            issued
        );
        let handle_id = format!(
            "handle:{}",
            hex::encode(&Sha256::digest(seed.as_bytes())[..16])
        );
        let mut mac = HmacSha256::new_from_slice(&self.resource_key)
            .map_err(|_| GatewayError::ResourceDenied)?;
        mac.update(seed.as_bytes());
        let auth_tag = hex::encode(mac.finalize().into_bytes());
        self.resources.insert(
            handle_id.clone(),
            ResourceRecord {
                document_id: snapshot.document_id.clone(),
                revision: snapshot.revision.clone(),
                audience: "app_ui".to_owned(),
                expires_at_seconds: expires,
                size: snapshot.content.len(),
            },
        );
        Ok(json!({
            "handle_id": handle_id,
            "resource_type": "workspace_file",
            "resource_id": snapshot.document_id,
            "resource_revision": snapshot.revision,
            "audience": {"kind": "surface", "id": "app_ui"},
            "allowed_operations": ["read", "range_read"],
            "project_id": workspace.project_id(),
            "owner_type": "project",
            "owner_id": workspace.project_id(),
            "media_type": "text/markdown",
            "size_limit_bytes": snapshot.content.len(),
            "range_limit_bytes": RESOURCE_RANGE_LIMIT,
            "issued_at": rfc3339_utc(issued)?,
            "expires_at": rfc3339_utc(expires)?,
            "one_shot": false,
            "auth_tag": auth_tag
        }))
    }

    pub fn read_resource(
        &self,
        handle_id: &str,
        audience: &str,
        offset: usize,
        length: usize,
    ) -> Result<Vec<u8>, GatewayError> {
        let record = self
            .resources
            .get(handle_id)
            .ok_or(GatewayError::ResourceDenied)?;
        if record.audience != audience
            || record.expires_at_seconds < now_seconds()
            || length > RESOURCE_RANGE_LIMIT
            || offset > record.size
            || length > record.size.saturating_sub(offset)
        {
            return Err(GatewayError::ResourceDenied);
        }
        let workspace = self.workspace.as_ref().ok_or(GatewayError::ScopeMismatch)?;
        let snapshot = workspace.read_by_id(&record.document_id)?;
        if snapshot.revision != record.revision {
            return Err(GatewayError::ResourceDenied);
        }
        Ok(snapshot.content.as_bytes()[offset..offset + length].to_vec())
    }

    pub fn begin_draft_upload(
        &mut self,
        document_id: &str,
        base_revision: &str,
        expected_size: usize,
        expected_revision: &str,
        change_generation: u64,
    ) -> Result<String, GatewayError> {
        const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
        if expected_size > MAX_DOCUMENT_BYTES
            || !expected_revision.starts_with("sha256:")
            || expected_revision.len() != 71
        {
            return Err(GatewayError::InvalidRequest);
        }
        let workspace = self.workspace.as_ref().ok_or(GatewayError::ScopeMismatch)?;
        workspace.read_by_id(document_id)?;
        let seed = format!(
            "{}\0{}\0{}\0{}\0{}",
            workspace.project_id(),
            document_id,
            base_revision,
            expected_revision,
            change_generation
        );
        let upload_id = format!(
            "upload:{}",
            hex::encode(&Sha256::digest(seed.as_bytes())[..16])
        );
        self.draft_uploads.insert(
            upload_id.clone(),
            DraftUpload {
                document_id: document_id.to_owned(),
                base_revision: base_revision.to_owned(),
                expected_size,
                expected_revision: expected_revision.to_owned(),
                change_generation,
                bytes: Vec::with_capacity(expected_size),
            },
        );
        Ok(upload_id)
    }

    pub fn append_draft_upload(
        &mut self,
        upload_id: &str,
        offset: usize,
        bytes: &[u8],
    ) -> Result<(), GatewayError> {
        let upload = self
            .draft_uploads
            .get_mut(upload_id)
            .ok_or(GatewayError::ResourceDenied)?;
        if offset != upload.bytes.len()
            || bytes.len() > RESOURCE_RANGE_LIMIT
            || bytes.len() > upload.expected_size.saturating_sub(offset)
        {
            return Err(GatewayError::ResourceDenied);
        }
        upload.bytes.extend_from_slice(bytes);
        Ok(())
    }

    pub fn finish_draft_upload(&mut self, upload_id: &str) -> Result<DraftHandle, GatewayError> {
        let upload = self
            .draft_uploads
            .remove(upload_id)
            .ok_or(GatewayError::ResourceDenied)?;
        let actual_revision = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(upload.bytes.as_slice()))
        );
        if upload.bytes.len() != upload.expected_size || actual_revision != upload.expected_revision
        {
            return Err(GatewayError::ResourceDenied);
        }
        let workspace = self.workspace.as_ref().ok_or(GatewayError::ScopeMismatch)?;
        workspace
            .stage_draft(
                &upload.document_id,
                &upload.base_revision,
                &upload.bytes,
                upload.change_generation,
            )
            .map_err(GatewayError::from)
    }

    pub fn command(&mut self, intent: &Value) -> Result<Value, GatewayError> {
        validate_renderer_payload(intent)?;
        let command_type = intent["command_type"]
            .as_str()
            .ok_or(GatewayError::InvalidRequest)?;
        let payload = &intent["payload"];
        let workspace = self.workspace.as_ref().ok_or(GatewayError::ScopeMismatch)?;
        match command_type {
            "project.activate" => {
                if payload["project_id"].as_str() != Some(workspace.project_id()) {
                    return Err(GatewayError::ScopeMismatch);
                }
                Ok(json!({"status": "active", "project_id": workspace.project_id()}))
            }
            "project.revoke" => {
                if payload["project_id"].as_str() != Some(workspace.project_id()) {
                    return Err(GatewayError::ScopeMismatch);
                }
                workspace.revoke()?;
                self.resources.clear();
                self.draft_uploads.clear();
                Ok(json!({"status": "revoked"}))
            }
            "document.open" | "document.close" => {
                let document_id = payload["document_id"]
                    .as_str()
                    .ok_or(GatewayError::InvalidRequest)?;
                workspace.read_by_id(document_id)?;
                Ok(json!({"status": "accepted", "document_id": document_id}))
            }
            "document.save" => {
                let document_id = payload["document_id"]
                    .as_str()
                    .ok_or(GatewayError::InvalidRequest)?;
                let base_revision = payload["base_revision"]
                    .as_str()
                    .ok_or(GatewayError::InvalidRequest)?;
                let handle_id = payload["draft_handle_id"]
                    .as_str()
                    .ok_or(GatewayError::InvalidRequest)?;
                let generation = payload["change_generation"]
                    .as_u64()
                    .ok_or(GatewayError::InvalidRequest)?;
                let outcome = workspace.save_staged_bound(
                    handle_id,
                    document_id,
                    base_revision,
                    generation,
                )?;
                Ok(save_outcome_json(outcome))
            }
            "document.resolve_conflict" => {
                let conflict_id = payload["conflict_id"]
                    .as_str()
                    .ok_or(GatewayError::InvalidRequest)?;
                let latest_revision = payload["latest_revision"]
                    .as_str()
                    .ok_or(GatewayError::InvalidRequest)?;
                let snapshot = workspace.conflict_snapshot(conflict_id)?;
                let mut generation = snapshot.change_generation.saturating_add(1);
                let resolution = match payload["action"].as_str() {
                    Some("use_disk") => ConflictResolution::UseDisk,
                    Some("keep_current") => {
                        if payload["draft_handle_id"].as_str()
                            != Some(snapshot.draft_handle_id.as_str())
                        {
                            return Err(GatewayError::ResourceDenied);
                        }
                        ConflictResolution::KeepCurrent
                    }
                    Some("merge") => {
                        let handle_id = payload["draft_handle_id"]
                            .as_str()
                            .ok_or(GatewayError::InvalidRequest)?;
                        let (proposed, uploaded_generation) = workspace.staged_proposed_for_resolution(
                            handle_id,
                            &snapshot.document_id,
                            latest_revision,
                        )?;
                        generation = uploaded_generation;
                        ConflictResolution::Merge(proposed)
                    }
                    _ => return Err(GatewayError::InvalidRequest),
                };
                Ok(save_outcome_json(workspace.resolve_conflict(
                    conflict_id,
                    latest_revision,
                    resolution,
                    generation,
                )?))
            }
            _ => Err(GatewayError::InvalidRequest),
        }
    }
}

fn save_outcome_json(outcome: SaveOutcome) -> Value {
    match outcome {
        SaveOutcome::Committed {
            revision,
            change_generation,
        } => json!({
            "status": "committed",
            "revision": revision,
            "change_generation": change_generation
        }),
        SaveOutcome::Conflict { conflict_id } => {
            json!({"status": "conflict", "conflict_id": conflict_id})
        }
        SaveOutcome::DiskKept {
            revision,
            change_generation,
        } => json!({
            "status": "disk_kept",
            "revision": revision,
            "change_generation": change_generation
        }),
    }
}
