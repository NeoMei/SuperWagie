mod artifact_store;
mod automation_replay;
#[allow(dead_code)]
mod evidence_bundle;
mod preview_cache;
mod review_automation;
mod review_protocol;
mod review_state;
mod wps_worker;

use artifact_store::{
    ArtifactKind, ArtifactOpened, ArtifactStore, PlatformLauncher, StoreError, MAX_READ_RANGE,
};
use automation_replay::{replay_bounded, AutomationReplayGate};
use preview_cache::{
    CacheError, CacheIdentity, PreviewCache, PublishManifest, PublishedPreview, RenderOptions,
};
use review_automation::{AutomationArtifactOpened, AutomationFailureKind, ReviewAutomationConfig};
use review_protocol::{serve, ProtocolRequest, ProtocolResponse};
use review_state::{
    validate_artifact_revision_id, validate_preview_revision_id, PreviewFidelity,
    RawReviewAnnotation, ReviewPerformanceSnapshot, ReviewStateStore,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Listener, Manager};
use uuid::Uuid;
use wps_worker::{
    BoundedRenderJobs, HomeFeatureProbe, RenderJobStatus, WpsBridgeEnvironment, WpsWorkerError,
    WpsWorkerRequest,
};

const DEPENDENCY_MISSING_CODE: &str = "SW_REVIEW_RENDER_DEPENDENCY_MISSING";
const PREVIEW_REVISION_DOMAIN: &[u8] = b"superwagie.review.preview-revision.v1\0";
const AUTOMATION_CLIENT_FAILURE_EVENT: &str = "review-automation-client-failed";
const AUTOMATION_CLIENT_READY_EVENT: &str = "review-automation-ready";
const AUTOMATION_ARTIFACT_RECEIVED_EVENT: &str = "review-automation-artifact-received";

struct AppHostState {
    artifacts: ArtifactStore,
    review_state: ReviewStateStore,
    render_jobs: Arc<Mutex<BoundedRenderJobs>>,
    preview_cache: PreviewCache,
    render_config: Option<TruthRenderConfig>,
    preview_fidelities: Arc<Mutex<HashMap<String, PreviewFidelity>>>,
    controlled_copy_root: PathBuf,
    evidence_dir: Option<PathBuf>,
    automation: Option<ReviewAutomationConfig>,
}

trait ApplicationExit: Send + Sync {
    fn exit(&self, code: i32);
}

impl ApplicationExit for tauri::AppHandle {
    fn exit(&self, code: i32) {
        tauri::AppHandle::exit(self, code);
    }
}

#[derive(Clone, Debug)]
struct TruthRenderConfig {
    python_executable: PathBuf,
    worker_script: PathBuf,
    wpscomposer_root: PathBuf,
    wps_application: PathBuf,
    expected_wps_identity_json: String,
    wps_bridge_relative_path: String,
    wps_executable_relative_path: Option<String>,
    renderer_id: String,
    renderer_version: String,
    renderer_environment_hash: String,
    font_environment_hash: String,
    render_options: RenderOptions,
    locale: Option<String>,
    bridge_environment: WpsBridgeEnvironment,
    home_probe: HomeFeatureProbe,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartTruthRenderReceipt {
    job_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostPreviewStatus {
    job_id: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview_revision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeDropError {
    error_code: &'static str,
}

struct SafeDropEvent {
    name: &'static str,
    payload: serde_json::Value,
}

fn safe_drop_event(result: Result<ArtifactOpened, StoreError>) -> SafeDropEvent {
    match result {
        Ok(opened) => SafeDropEvent {
            name: "artifact-opened",
            payload: serde_json::to_value(opened)
                .expect("ArtifactOpened serialization cannot fail"),
        },
        Err(error) => SafeDropEvent {
            name: "artifact-open-error",
            payload: serde_json::to_value(SafeDropError {
                error_code: error.code(),
            })
            .expect("SafeDropError serialization cannot fail"),
        },
    }
}

#[tauri::command]
fn asset_url(
    handle: String,
    kind: String,
    state: tauri::State<'_, AppHostState>,
) -> Result<String, String> {
    let kind = ArtifactKind::parse(&kind).map_err(error_code)?;
    state
        .artifacts
        .validate_kind(&handle, kind)
        .map_err(error_code)?;
    state
        .artifacts
        .public_metadata(&handle)
        .map_err(error_code)?;
    Ok(format!(
        "reviewasset://localhost/{kind}/{handle}",
        kind = kind_name(kind)
    ))
}

#[tauri::command]
fn start_truth_render(
    handle: String,
    artifact_revision_id: String,
    deadline_ms: u64,
    state: tauri::State<'_, AppHostState>,
    app: tauri::AppHandle,
) -> Result<StartTruthRenderReceipt, String> {
    start_truth_render_inner(
        handle,
        artifact_revision_id,
        deadline_ms,
        &state,
        Arc::new(app),
    )
}

fn start_truth_render_inner(
    handle: String,
    artifact_revision_id: String,
    deadline_ms: u64,
    state: &AppHostState,
    app_exit: Arc<dyn ApplicationExit>,
) -> Result<StartTruthRenderReceipt, String> {
    state
        .artifacts
        .validate_kind(&handle, ArtifactKind::Artifact)
        .map_err(error_code)?;
    validate_artifact_revision_id(&artifact_revision_id)
        .map_err(|_| "SW_REVIEW_ARTIFACT_REVISION_ID_INVALID".to_owned())?;
    let host_revision_hash = state
        .artifacts
        .public_metadata(&handle)
        .map_err(error_code)?
        .revision_hash;
    if artifact_revision_id != format!("artifact-sha256:{host_revision_hash}") {
        return Err("SW_REVIEW_ARTIFACT_REVISION_MISMATCH".into());
    }
    if deadline_ms == 0 {
        return Err("SW_REVIEW_DEADLINE_INVALID".into());
    }
    let job_id = Uuid::new_v4().simple().to_string();
    state
        .render_jobs
        .lock()
        .map_err(|_| "SW_REVIEW_HOST_STATE_UNAVAILABLE".to_owned())?
        .insert_running(&job_id)
        .map_err(error_code)?;

    let Some(config) = state.render_config.clone() else {
        let exit_requested = record_automation_failure(
            state.automation.as_ref(),
            AutomationFailureKind::DependencyMissing,
        );
        complete_job(
            &state.render_jobs,
            &job_id,
            RenderJobStatus::failed(&job_id, "dependency_missing", DEPENDENCY_MISSING_CODE),
        );
        if exit_requested {
            app_exit.exit(2);
        }
        return Ok(StartTruthRenderReceipt { job_id });
    };
    let staging = match state.preview_cache.prepare_job(&job_id) {
        Ok(staging) => staging,
        Err(error) => {
            let exit_requested = record_automation_failure(
                state.automation.as_ref(),
                AutomationFailureKind::StagingFailed,
            );
            complete_job(
                &state.render_jobs,
                &job_id,
                RenderJobStatus::failed(&job_id, "failed_recoverable", &error.to_string()),
            );
            if exit_requested {
                app_exit.exit(2);
            }
            return Ok(StartTruthRenderReceipt { job_id });
        }
    };
    let staged_source = match stage_render_source(&state.artifacts, &handle, &staging.job_dir) {
        Ok(source) => source,
        Err(error) => {
            drop(staging);
            let exit_requested = record_automation_failure(
                state.automation.as_ref(),
                AutomationFailureKind::SourceFailed,
            );
            complete_job(
                &state.render_jobs,
                &job_id,
                RenderJobStatus::failed(&job_id, "failed_recoverable", &error.to_string()),
            );
            if exit_requested {
                app_exit.exit(2);
            }
            return Ok(StartTruthRenderReceipt { job_id });
        }
    };
    let jobs = Arc::clone(&state.render_jobs);
    let cache = state.preview_cache.clone();
    let artifacts = state.artifacts.clone();
    let preview_fidelities = Arc::clone(&state.preview_fidelities);
    let automation = state.automation.clone();
    let render_job_id = job_id.clone();
    std::thread::spawn(move || {
        let identity = CacheIdentity {
            source_content_hash: staged_source.source_content_hash.clone(),
            renderer_id: config.renderer_id.clone(),
            renderer_version: config.renderer_version.clone(),
            renderer_environment_hash: config.renderer_environment_hash.clone(),
            font_environment_hash: config.font_environment_hash.clone(),
            render_options: config.render_options.clone(),
        };
        let ready_from_published = |published: PublishedPreview| {
            let preview_revision_id = derive_authoritative_preview_revision_id(
                &artifact_revision_id,
                &published.manifest,
            )
            .map_err(|_| RenderPipelineError::PreviewRevision)?;
            let opened = artifacts
                .authorize_path(
                    &published.entry_dir.join("preview.pdf"),
                    ArtifactKind::Preview,
                )
                .map_err(RenderPipelineError::Store)?;
            let status =
                RenderJobStatus::ready(&render_job_id, preview_revision_id.clone(), opened.handle)
                    .map_err(RenderPipelineError::Worker)?;
            preview_fidelities
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(preview_revision_id, PreviewFidelity::Authoritative);
            Ok::<_, RenderPipelineError>(status)
        };
        let result = match cache
            .load_validated(&identity)
            .map_err(RenderPipelineError::Cache)
        {
            Ok(Some(published)) => ready_from_published(published),
            Ok(None) => {
                let request = WpsWorkerRequest {
                    python_executable: config.python_executable,
                    worker_script: config.worker_script,
                    wpscomposer_root: config.wpscomposer_root,
                    wps_application: config.wps_application,
                    expected_wps_identity_json: config.expected_wps_identity_json,
                    wps_bridge_relative_path: config.wps_bridge_relative_path,
                    wps_executable_relative_path: config.wps_executable_relative_path,
                    source: staged_source.path,
                    output: staging.preview_pdf.clone(),
                    expected_source_hash: staged_source.source_content_hash,
                    deadline: Duration::from_millis(deadline_ms),
                    job_temp_dir: staging.job_dir.clone(),
                    locale: config.locale,
                    bridge_environment: config.bridge_environment,
                    home_probe: config.home_probe,
                };
                request
                    .run()
                    .map_err(RenderPipelineError::Worker)
                    .and_then(|success| {
                        cache
                            .publish(&render_job_id, &identity, &success.validated_pdf.sha256)
                            .map_err(RenderPipelineError::Cache)
                    })
                    .and_then(ready_from_published)
            }
            Err(error) => Err(error),
        };
        let (status, exit_requested) = match result {
            Ok(status) => (status, false),
            Err(error) => {
                let kind = automation_failure_kind(&error);
                let exit_requested = record_automation_failure(automation.as_ref(), kind);
                (render_failure_status(&render_job_id, error), exit_requested)
            }
        };
        drop(staging);
        complete_job(&jobs, &render_job_id, status);
        if exit_requested {
            app_exit.exit(2);
        }
    });
    Ok(StartTruthRenderReceipt { job_id })
}

struct StagedRenderSource {
    path: PathBuf,
    source_content_hash: String,
}

fn derive_authoritative_preview_revision_id(
    artifact_revision_id: &str,
    manifest: &PublishManifest,
) -> Result<String, ()> {
    validate_artifact_revision_id(artifact_revision_id).map_err(|_| ())?;
    if !is_sha256(&manifest.cache_key)
        || !is_sha256(&manifest.source_content_hash)
        || !is_sha256(&manifest.renderer_environment_hash)
        || !is_sha256(&manifest.font_environment_hash)
        || !is_sha256(&manifest.output_sha256)
        || manifest.page_count == 0
        || manifest.renderer_id.is_empty()
        || manifest.renderer_version.is_empty()
        || manifest.renderer_id.chars().any(char::is_control)
        || manifest.renderer_version.chars().any(char::is_control)
        || manifest.render_options.0.iter().any(|(key, value)| {
            key.is_empty()
                || key.chars().any(char::is_control)
                || value.chars().any(char::is_control)
        })
    {
        return Err(());
    }

    let mut hasher = Sha256::new();
    hasher.update(PREVIEW_REVISION_DOMAIN);
    hash_preview_revision_field(
        &mut hasher,
        b"artifact_revision_id",
        artifact_revision_id.as_bytes(),
    );
    hash_preview_revision_field(&mut hasher, b"fidelity", b"authoritative");
    hash_preview_revision_field(
        &mut hasher,
        b"source_content_hash",
        manifest.source_content_hash.as_bytes(),
    );
    hash_preview_revision_field(&mut hasher, b"renderer_id", manifest.renderer_id.as_bytes());
    hash_preview_revision_field(
        &mut hasher,
        b"renderer_version",
        manifest.renderer_version.as_bytes(),
    );
    hash_preview_revision_field(
        &mut hasher,
        b"renderer_environment_hash",
        manifest.renderer_environment_hash.as_bytes(),
    );
    hash_preview_revision_field(
        &mut hasher,
        b"font_environment_hash",
        manifest.font_environment_hash.as_bytes(),
    );
    hash_preview_revision_field(
        &mut hasher,
        b"render_options_count",
        &(manifest.render_options.0.len() as u64).to_be_bytes(),
    );
    for (key, value) in &manifest.render_options.0 {
        hash_preview_revision_field(&mut hasher, b"render_option_key", key.as_bytes());
        hash_preview_revision_field(&mut hasher, b"render_option_value", value.as_bytes());
    }
    hash_preview_revision_field(&mut hasher, b"cache_key", manifest.cache_key.as_bytes());
    hash_preview_revision_field(
        &mut hasher,
        b"output_sha256",
        manifest.output_sha256.as_bytes(),
    );
    hash_preview_revision_field(
        &mut hasher,
        b"page_count",
        &manifest.page_count.to_be_bytes(),
    );
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let preview_revision_id = format!("preview-sha256:{digest}");
    validate_preview_revision_id(&preview_revision_id).map_err(|_| ())?;
    Ok(preview_revision_id)
}

fn hash_preview_revision_field(hasher: &mut Sha256, tag: &[u8], value: &[u8]) {
    hasher.update((tag.len() as u64).to_be_bytes());
    hasher.update(tag);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn stage_render_source(
    artifacts: &ArtifactStore,
    handle: &str,
    job_dir: &Path,
) -> Result<StagedRenderSource, StoreError> {
    artifacts.validate_kind(handle, ArtifactKind::Artifact)?;
    let metadata = artifacts.public_metadata(handle)?;
    let extension = Path::new(&metadata.display_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or(StoreError::UnsupportedExtension)?;
    if !matches!(extension.as_str(), "docx" | "pptx") {
        return Err(StoreError::ControlledCopyUnsupported);
    }
    let job_metadata = fs::symlink_metadata(job_dir).map_err(|_| StoreError::Io)?;
    if job_metadata.file_type().is_symlink() {
        return Err(StoreError::Symlink);
    }
    if !job_metadata.is_dir() {
        return Err(StoreError::NotRegularFile);
    }
    let path = job_dir.join(format!("source.{extension}"));
    let mut destination = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|_| StoreError::Io)?;
    restrict_owner_file(&path)?;
    let size = usize::try_from(metadata.size).map_err(|_| StoreError::TooLarge)?;
    let mut offset = 0_usize;
    let mut hasher = Sha256::new();
    while offset < size {
        let length = (size - offset).min(MAX_READ_RANGE);
        let bytes = artifacts.read_range(handle, offset, length)?;
        if bytes.len() != length {
            return Err(StoreError::FileChangedDuringAuthorization);
        }
        destination.write_all(&bytes).map_err(|_| StoreError::Io)?;
        hasher.update(&bytes);
        offset += bytes.len();
    }
    destination.flush().map_err(|_| StoreError::Io)?;
    destination.sync_all().map_err(|_| StoreError::Io)?;
    drop(destination);
    sync_host_directory(job_dir)?;
    let copied_hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if copied_hash != metadata.revision_hash {
        return Err(StoreError::CopyVerificationFailed);
    }
    Ok(StagedRenderSource {
        path,
        source_content_hash: metadata.revision_hash,
    })
}

fn restrict_owner_file(path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| StoreError::Io)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn sync_host_directory(path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| StoreError::Io)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[tauri::command]
fn preview_status(
    job_id: String,
    state: tauri::State<'_, AppHostState>,
) -> Result<HostPreviewStatus, String> {
    preview_status_inner(job_id, &state)
}

fn preview_status_inner(job_id: String, state: &AppHostState) -> Result<HostPreviewStatus, String> {
    validate_handle(&job_id)?;
    let status = state
        .render_jobs
        .lock()
        .map_err(|_| "SW_REVIEW_HOST_STATE_UNAVAILABLE".to_owned())?
        .status(&job_id)
        .map_err(error_code)?;
    match (
        status.state.as_str(),
        status.preview_revision_id.as_deref(),
        status.preview_handle.as_deref(),
        status.error_code.as_deref(),
    ) {
        ("authoritative_ready", Some(preview_revision_id), Some(preview_handle), None) => {
            validate_preview_revision_id(preview_revision_id)
                .map_err(|_| "SW_REVIEW_STATUS_IDENTITY_INVALID".to_owned())?;
            validate_handle(preview_handle)
                .map_err(|_| "SW_REVIEW_STATUS_IDENTITY_INVALID".to_owned())?;
        }
        ("authoritative_ready", _, _, _) => {
            return Err("SW_REVIEW_STATUS_IDENTITY_INVALID".into());
        }
        (_, None, None, _) => {}
        _ => return Err("SW_REVIEW_STATUS_IDENTITY_INVALID".into()),
    }
    Ok(HostPreviewStatus {
        job_id: status.job_id,
        state: status.state,
        preview_revision_id: status.preview_revision_id,
        preview_handle: status.preview_handle,
        error_code: status.error_code,
    })
}

enum RenderPipelineError {
    Worker(WpsWorkerError),
    Cache(CacheError),
    Store(StoreError),
    PreviewRevision,
}

fn automation_failure_kind(error: &RenderPipelineError) -> AutomationFailureKind {
    match error {
        RenderPipelineError::Worker(error) if error.to_string() == "WPS_RUNTIME_MISSING" => {
            AutomationFailureKind::DependencyMissing
        }
        RenderPipelineError::Worker(_) => AutomationFailureKind::WorkerFailed,
        RenderPipelineError::Cache(CacheError::ImmutableConflict) => {
            AutomationFailureKind::CacheImmutableConflict
        }
        RenderPipelineError::Cache(_) | RenderPipelineError::Store(_) => {
            AutomationFailureKind::PublicationFailed
        }
        RenderPipelineError::PreviewRevision => AutomationFailureKind::PreviewRevisionInvalid,
    }
}

fn record_automation_failure(
    automation: Option<&ReviewAutomationConfig>,
    kind: AutomationFailureKind,
) -> bool {
    let Some(automation) = automation else {
        return false;
    };
    let _ = automation.write_trusted_failure(kind);
    true
}

fn record_client_automation_failure(
    automation: Option<&ReviewAutomationConfig>,
    payload: &str,
    accepted: &AtomicBool,
    exit: &dyn ApplicationExit,
) -> bool {
    let Some(automation) = automation else {
        return false;
    };
    let Some(kind) = automation.client_failure_kind(payload) else {
        return false;
    };
    if accepted
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }
    let _ = automation.write_trusted_failure(kind);
    exit.exit(2);
    true
}

fn accept_client_automation_ready<T>(
    automation: Option<&ReviewAutomationConfig>,
    payload: &str,
    gate: &AutomationReplayGate<T>,
) -> Option<Vec<T>> {
    let automation = automation?;
    if !automation.accepts_client_ready(payload) {
        gate.record_rejected_client_ready();
        let _ = automation.write_handshake_diagnostics(gate.diagnostics());
        return None;
    }
    let events = gate.take_for_client_ready();
    let _ = automation.write_handshake_diagnostics(gate.diagnostics());
    events
}

impl From<WpsWorkerError> for RenderPipelineError {
    fn from(error: WpsWorkerError) -> Self {
        Self::Worker(error)
    }
}

fn render_failure_status(job_id: &str, error: RenderPipelineError) -> RenderJobStatus {
    match error {
        RenderPipelineError::Worker(error) => {
            let code = error.to_string();
            if code == "WPS_RUNTIME_MISSING" {
                RenderJobStatus::failed(job_id, "dependency_missing", DEPENDENCY_MISSING_CODE)
            } else {
                RenderJobStatus::failed(job_id, "failed_recoverable", &code)
            }
        }
        RenderPipelineError::Cache(CacheError::ImmutableConflict) => RenderJobStatus::failed(
            job_id,
            "failed_terminal",
            "SW_REVIEW_CACHE_IMMUTABLE_CONFLICT",
        ),
        RenderPipelineError::Cache(error) => {
            RenderJobStatus::failed(job_id, "failed_recoverable", &error.to_string())
        }
        RenderPipelineError::Store(error) => {
            RenderJobStatus::failed(job_id, "failed_recoverable", &error.to_string())
        }
        RenderPipelineError::PreviewRevision => RenderJobStatus::failed(
            job_id,
            "failed_terminal",
            "SW_REVIEW_PREVIEW_REVISION_ID_INVALID",
        ),
    }
}

fn complete_job(jobs: &Arc<Mutex<BoundedRenderJobs>>, job_id: &str, status: RenderJobStatus) {
    jobs.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .complete(job_id, status);
}

#[tauri::command]
fn save_annotation(
    annotation: RawReviewAnnotation,
    state: tauri::State<'_, AppHostState>,
) -> Result<(), String> {
    save_annotation_inner(annotation, &state)
}

fn save_annotation_inner(
    annotation: RawReviewAnnotation,
    state: &AppHostState,
) -> Result<(), String> {
    let persisted_annotation = state.review_state.capture(annotation).map_err(error_code)?;
    let persisted = state
        .review_state
        .annotations(&persisted_annotation.preview_revision_id)
        .map_err(error_code)?;
    if persisted
        .iter()
        .any(|candidate| candidate.annotation_id == persisted_annotation.annotation_id)
    {
        Ok(())
    } else {
        Err("SW_REVIEW_ANNOTATION_PERSISTENCE_FAILED".into())
    }
}

#[tauri::command]
fn accept_preview(
    preview_revision_id: String,
    state: tauri::State<'_, AppHostState>,
) -> Result<(), String> {
    accept_preview_inner(preview_revision_id, &state)
}

fn accept_preview_inner(preview_revision_id: String, state: &AppHostState) -> Result<(), String> {
    validate_preview_revision_id(&preview_revision_id)
        .map_err(|_| "SW_REVIEW_PREVIEW_REVISION_ID_INVALID".to_owned())?;
    let fidelity = state
        .preview_fidelities
        .lock()
        .map_err(|_| "SW_REVIEW_HOST_STATE_UNAVAILABLE".to_owned())?
        .get(&preview_revision_id)
        .copied()
        .ok_or_else(|| "SW_REVIEW_PREVIEW_NOT_FOUND".to_owned())?;
    state
        .review_state
        .accept_preview(&preview_revision_id, fidelity)
        .map_err(error_code)?;
    if state.review_state.is_accepted(&preview_revision_id) {
        Ok(())
    } else {
        Err("SW_REVIEW_ACCEPTANCE_PERSISTENCE_FAILED".into())
    }
}

#[tauri::command]
fn open_controlled_copy(
    handle: String,
    state: tauri::State<'_, AppHostState>,
) -> Result<artifact_store::ControlledCopyReceipt, String> {
    state
        .artifacts
        .open_controlled_copy_with(&handle, &state.controlled_copy_root, &PlatformLauncher)
        .map_err(error_code)
}

#[tauri::command]
fn record_metrics(
    snapshot: ReviewPerformanceSnapshot,
    state: tauri::State<'_, AppHostState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let evidence_dir = state
        .evidence_dir
        .as_deref()
        .ok_or_else(|| "SW_REVIEW_EVIDENCE_DIR_MISSING".to_owned())?;
    snapshot.write_atomic(evidence_dir).map_err(error_code)?;
    if let Some(automation) = state.automation.as_ref() {
        let cache_bytes = state.preview_cache.cache_bytes().map_err(error_code)?;
        let peak_rss_bytes = process_peak_rss_bytes()?;
        if automation
            .write_trusted_completion(&snapshot, peak_rss_bytes, cache_bytes)
            .map_err(|error| error.to_string())?
        {
            app.exit(0);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn process_peak_rss_bytes() -> Result<u64, String> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage initializes the provided rusage for the current process.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return Err("SW_REVIEW_HOST_METRICS_UNAVAILABLE".into());
    }
    // SAFETY: successful getrusage initialized the value.
    let maximum = unsafe { usage.assume_init() }.ru_maxrss;
    if maximum <= 0 {
        return Err("SW_REVIEW_HOST_METRICS_UNAVAILABLE".into());
    }
    #[cfg(target_os = "macos")]
    let bytes = maximum as u64;
    #[cfg(not(target_os = "macos"))]
    let bytes = (maximum as u64).saturating_mul(1024);
    Ok(bytes)
}

#[cfg(windows)]
fn process_peak_rss_bytes() -> Result<u64, String> {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut counters = std::mem::MaybeUninit::<PROCESS_MEMORY_COUNTERS>::zeroed();
    // SAFETY: the pseudo-handle is valid for the current process and the API
    // initializes the complete fixed-size PROCESS_MEMORY_COUNTERS value.
    let succeeded = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            counters.as_mut_ptr(),
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if succeeded == 0 {
        return Err("SW_REVIEW_HOST_METRICS_UNAVAILABLE".into());
    }
    // SAFETY: a nonzero API result initialized counters.
    let peak = unsafe { counters.assume_init() }.PeakWorkingSetSize as u64;
    if peak == 0 {
        Err("SW_REVIEW_HOST_METRICS_UNAVAILABLE".into())
    } else {
        Ok(peak)
    }
}

#[cfg(not(any(unix, windows)))]
fn process_peak_rss_bytes() -> Result<u64, String> {
    Err("SW_REVIEW_HOST_METRICS_UNAVAILABLE".into())
}

fn main() {
    let automation_replay = Arc::new(AutomationReplayGate::new(Vec::new()));
    let setup_automation_replay = Arc::clone(&automation_replay);
    let page_load_automation_replay = Arc::clone(&automation_replay);
    tauri::Builder::default()
        .setup(move |app| {
            let data_root = app.path().app_data_dir()?.join("reviewer-poc");
            let review_state = ReviewStateStore::open(data_root.join("state"))?;
            let automation = ReviewAutomationConfig::from_environment()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let artifacts = ArtifactStore::default();
            let automation_events = automation
                .as_ref()
                .map(|config| config.authorize(&artifacts))
                .transpose()
                .map_err(|error| std::io::Error::other(error.to_string()))?
                .unwrap_or_default();
            if let Some(client_automation) = automation.clone() {
                let app_handle = app.handle().clone();
                let accepted = Arc::new(AtomicBool::new(false));
                app.listen_any(AUTOMATION_CLIENT_FAILURE_EVENT, move |event| {
                    let _ = record_client_automation_failure(
                        Some(&client_automation),
                        event.payload(),
                        accepted.as_ref(),
                        &app_handle,
                    );
                });
            }
            if let Some(ready_automation) = automation.clone() {
                let app_handle = app.handle().clone();
                let ready_gate = Arc::clone(&setup_automation_replay);
                app.listen_any(AUTOMATION_CLIENT_READY_EVENT, move |event| {
                    let Some(events) = accept_client_automation_ready(
                        Some(&ready_automation),
                        event.payload(),
                        ready_gate.as_ref(),
                    ) else {
                        return;
                    };
                    let Some(webview) = app_handle.get_webview_window("main") else {
                        return;
                    };
                    let webview = webview.as_ref().clone();
                    let emit_gate = Arc::clone(&ready_gate);
                    let emit_automation = ready_automation.clone();
                    std::thread::spawn(move || {
                        emit_automation_artifacts(webview, events, emit_gate, Some(emit_automation))
                    });
                });
            }
            if let Some(receipt_automation) = automation.clone() {
                app.listen_any(AUTOMATION_ARTIFACT_RECEIVED_EVENT, move |event| {
                    let _ = receipt_automation.record_artifact_receipt(event.payload());
                });
            }
            let diagnostic_automation = automation.clone();
            app.manage(AppHostState {
                artifacts,
                review_state,
                render_jobs: Arc::new(Mutex::new(BoundedRenderJobs::new(64))),
                preview_cache: PreviewCache::open(&data_root.join("preview-cache"))?,
                render_config: truth_render_config_from_environment(),
                preview_fidelities: Arc::new(Mutex::new(HashMap::new())),
                controlled_copy_root: data_root.join("controlled-copies"),
                evidence_dir: std::env::var_os("SUPERWAGIE_REVIEW_EVIDENCE_DIR").map(PathBuf::from),
                automation,
            });
            let arm_result = setup_automation_replay.arm(automation_events);
            if let Some(automation) = diagnostic_automation.as_ref() {
                let _ =
                    automation.write_handshake_diagnostics(setup_automation_replay.diagnostics());
            }
            match arm_result {
                Ok(Some(events)) => {
                    let webview = app
                        .get_webview_window("main")
                        .ok_or("main reviewer webview unavailable")?;
                    let webview = webview.as_ref().clone();
                    let emit_gate = Arc::clone(&setup_automation_replay);
                    std::thread::spawn(move || {
                        emit_automation_artifacts(webview, events, emit_gate, diagnostic_automation)
                    });
                }
                Ok(None) => {}
                Err(()) => {
                    return Err(std::io::Error::other("automation replay state unavailable").into())
                }
            }
            Ok(())
        })
        .on_page_load(move |webview, payload| {
            let events = page_load_automation_replay.take_for_page_load(
                webview.label(),
                payload.url(),
                payload.event(),
            );
            let automation = webview
                .try_state::<AppHostState>()
                .and_then(|state| state.automation.clone());
            if let Some(automation) = automation.as_ref() {
                let _ = automation
                    .write_handshake_diagnostics(page_load_automation_replay.diagnostics());
            }
            let Some(events) = events else {
                return;
            };
            let webview = webview.clone();
            let emit_gate = Arc::clone(&page_load_automation_replay);
            std::thread::spawn(move || {
                emit_automation_artifacts(webview, events, emit_gate, automation)
            });
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state = window.state::<AppHostState>();
                for path in paths {
                    let event = safe_drop_event(
                        state.artifacts.authorize_path(path, ArtifactKind::Artifact),
                    );
                    let _ = window.emit(event.name, event.payload);
                }
            }
        })
        .register_uri_scheme_protocol("reviewasset", |context, request| {
            let logical_uri = logical_uri_from_tauri(request.uri().to_string());
            let ranges = request
                .headers()
                .get_all("range")
                .iter()
                .map(|value| value.to_str().map(str::to_owned))
                .collect::<Result<Vec<_>, _>>();
            let response = match ranges {
                Ok(range_headers) => serve(
                    &context.app_handle().state::<AppHostState>().artifacts,
                    ProtocolRequest::new(request.method().as_str(), logical_uri)
                        .with_ranges(range_headers),
                ),
                Err(_) => ProtocolResponse {
                    status: 416,
                    headers: std::collections::BTreeMap::from([(
                        "content-length".into(),
                        "0".into(),
                    )]),
                    body: Vec::new(),
                },
            };
            tauri_response(response)
        })
        .invoke_handler(tauri::generate_handler![
            asset_url,
            start_truth_render,
            preview_status,
            save_annotation,
            accept_preview,
            open_controlled_copy,
            record_metrics,
        ])
        .run(tauri::generate_context!())
        .expect("SuperWagie Reviewer PoC failed");
}

fn emit_automation_artifacts(
    webview: tauri::Webview,
    events: Vec<AutomationArtifactOpened>,
    gate: Arc<AutomationReplayGate<AutomationArtifactOpened>>,
    automation: Option<ReviewAutomationConfig>,
) {
    // Finished anchors the one-shot replay window to the actual WebView lifecycle.
    // The existing session/index contract de-duplicates the bounded event replays.
    let mut first_emitted = false;
    replay_bounded(&events, std::thread::sleep, |event| {
        if webview.emit("artifact-opened", event).is_ok() && !first_emitted {
            first_emitted = true;
            gate.mark_first_artifact_emitted();
            if let Some(automation) = automation.as_ref() {
                let _ = automation.write_handshake_diagnostics(gate.diagnostics());
            }
        }
    });
}

fn truth_render_config_from_environment() -> Option<TruthRenderConfig> {
    let python_executable = PathBuf::from(std::env::var_os("SUPERWAGIE_WPS_PYTHON")?);
    let wpscomposer_root = PathBuf::from(std::env::var_os("SUPERWAGIE_WPSCOMPOSER_ROOT")?);
    let wps_application = PathBuf::from(std::env::var_os("SUPERWAGIE_WPS_APPLICATION")?);
    let expected_wps_identity_json = std::env::var("SUPERWAGIE_WPS_APPLICATION_IDENTITY").ok()?;
    let wps_bridge_relative_path = std::env::var("SUPERWAGIE_WPS_BRIDGE_RELATIVE_PATH").ok()?;
    let wps_executable_relative_path =
        std::env::var("SUPERWAGIE_WPS_EXECUTABLE_RELATIVE_PATH").ok();
    let renderer_version = std::env::var("SUPERWAGIE_WPS_RENDERER_VERSION").ok()?;
    let renderer_environment_hash = std::env::var("SUPERWAGIE_WPS_RENDERER_ENV_HASH").ok()?;
    let font_environment_hash = std::env::var("SUPERWAGIE_WPS_FONT_ENV_HASH").ok()?;
    let worker_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../wps-render-worker.py")
        .canonicalize()
        .ok()?;
    if !python_executable.is_absolute()
        || !python_executable.is_file()
        || !wpscomposer_root.is_absolute()
        || !wpscomposer_root.is_dir()
        || !wps_application.is_absolute()
        || !wps_application.exists()
        || expected_wps_identity_json.is_empty()
        || wps_bridge_relative_path.is_empty()
        || renderer_version.is_empty()
        || !is_sha256(&renderer_environment_hash)
        || !is_sha256(&font_environment_hash)
    {
        return None;
    }
    let bridge_environment = match std::env::var("SUPERWAGIE_WPS_NODE") {
        Ok(node) => {
            WpsBridgeEnvironment::new(BTreeMap::from([("WPSCOMPOSER_NODE".into(), node)])).ok()?
        }
        Err(_) => WpsBridgeEnvironment::default(),
    };
    let home_probe = match std::env::var("SUPERWAGIE_WPS_CONTAINER_HOME_PROBE") {
        Ok(value) if value == "required" => {
            let home = PathBuf::from(std::env::var_os("SUPERWAGIE_WPS_PROBED_HOME")?);
            if !home.is_absolute() || !home.is_dir() {
                return None;
            }
            HomeFeatureProbe::Required(home)
        }
        Ok(value) if value == "not-required" => HomeFeatureProbe::NotRequired,
        Ok(_) => return None,
        Err(_) => HomeFeatureProbe::NotRequired,
    };
    Some(TruthRenderConfig {
        python_executable,
        worker_script,
        wpscomposer_root,
        wps_application,
        expected_wps_identity_json,
        wps_bridge_relative_path,
        wps_executable_relative_path,
        renderer_id: "wpscomposer-explicit-source".into(),
        renderer_version,
        renderer_environment_hash,
        font_environment_hash,
        render_options: RenderOptions(BTreeMap::from([("quality".into(), "authoritative".into())])),
        locale: Some("C.UTF-8".into()),
        bridge_environment,
        home_probe,
    })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn tauri_response(response: ProtocolResponse) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder()
        .status(response.status)
        .header("access-control-allow-origin", reviewer_app_origin())
        .header("access-control-allow-methods", "GET, HEAD")
        .header("access-control-allow-headers", "Range")
        .header(
            "access-control-expose-headers",
            "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag",
        );
    for (name, value) in response.headers {
        builder = builder.header(name, value);
    }
    builder
        .body(response.body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

#[cfg(target_os = "windows")]
fn reviewer_app_origin() -> &'static str {
    "http://tauri.localhost"
}

#[cfg(not(target_os = "windows"))]
fn reviewer_app_origin() -> &'static str {
    "tauri://localhost"
}

fn logical_uri_from_tauri(uri: String) -> String {
    #[cfg(target_os = "windows")]
    if let Some(path) = uri.strip_prefix("http://reviewasset.localhost/") {
        return format!("reviewasset://localhost/{path}");
    }
    uri
}

fn validate_handle(value: &str) -> Result<(), String> {
    if value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("SW_REVIEW_HANDLE_INVALID".into())
    }
}

fn kind_name(kind: ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::Artifact => "artifact",
        ArtifactKind::Preview => "preview",
    }
}

fn error_code<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::artifact_store::{
        ArtifactKind, ArtifactOpened, ArtifactStore, ControlledCopyLauncher, StoreError,
    };
    use super::review_protocol::{serve, ProtocolRequest};
    use super::review_state::{
        AnnotationStatus, InteractionMetric, InteractionName, PersistedReviewAnnotation,
        PreviewFidelity, RawReviewAnnotation, ReviewPerformanceSnapshot, ReviewStateError,
        ReviewStateStore,
    };
    use super::wps_worker::{BoundedRenderJobs, HomeFeatureProbe, WpsBridgeEnvironment};
    use sha2::{Digest, Sha256};
    use std::collections::{BTreeMap, HashMap};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    const MAX_RANGE: usize = 8 * 1024 * 1024;

    #[derive(Default)]
    struct TestExit {
        codes: Mutex<Vec<i32>>,
    }

    impl super::ApplicationExit for TestExit {
        fn exit(&self, code: i32) {
            self.codes.lock().unwrap().push(code);
        }
    }

    fn test_exit() -> Arc<TestExit> {
        Arc::new(TestExit::default())
    }

    fn test_python_executable() -> PathBuf {
        for variable in ["SUPERWAGIE_TEST_PYTHON", "PYTHON"] {
            if let Some(candidate) = std::env::var_os(variable).map(PathBuf::from) {
                if candidate.is_absolute() && candidate.is_file() {
                    return candidate.canonicalize().unwrap();
                }
            }
        }
        for command in ["python3", "python"] {
            let output = Command::new(command)
                .args(["-c", "import sys; print(sys.executable)"])
                .output();
            if let Ok(output) = output {
                if output.status.success() {
                    let candidate = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
                    if candidate.is_absolute() && candidate.is_file() {
                        return candidate.canonicalize().unwrap();
                    }
                }
            }
        }
        panic!("an absolute Python interpreter is required for this test");
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_peak_rss_is_available_for_trusted_completion() {
        assert!(super::process_peak_rss_bytes().unwrap() > 0);
    }

    fn minimal_pdf(payload: &[u8]) -> Vec<u8> {
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let catalog_offset = bytes.len();
        bytes.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        let pages_offset = bytes.len();
        bytes.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n%");
        bytes.extend_from_slice(payload);
        bytes.push(b'\n');
        let xref = bytes.len();
        bytes.extend_from_slice(
            format!(
                "xref\n0 3\n0000000000 65535 f \n{catalog_offset:010} 00000 n \n{pages_offset:010} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
            )
            .as_bytes(),
        );
        bytes
    }

    fn fixture_store(bytes: &[u8]) -> (tempfile::TempDir, ArtifactStore, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.pdf");
        fs::write(&path, minimal_pdf(bytes)).unwrap();
        let store = ArtifactStore::default();
        let opened = store.authorize_path(&path, ArtifactKind::Artifact).unwrap();
        (dir, store, opened.handle)
    }

    fn fixture_raw_annotation(selected_text: Option<&str>) -> RawReviewAnnotation {
        RawReviewAnnotation {
            annotation_id: "annotation-123e4567-e89b-42d3-a456-426614174000".into(),
            artifact_revision_id: format!("artifact-sha256:{}", "11".repeat(32)),
            preview_revision_id: format!("preview-sha256:{}", "22".repeat(32)),
            fidelity: PreviewFidelity::Authoritative,
            page_id: "page-1".into(),
            bbox: Some([0.1, 0.2, 0.3, 0.4]),
            selected_text: selected_text.map(str::to_owned),
            before_context_hash: Some(format!("sha256:{}", "33".repeat(32))),
            after_context_hash: Some(format!("sha256:{}", "44".repeat(32))),
            semantic_object_id: Some("semantic-223e4567-e89b-42d3-a456-426614174000".into()),
            status: AnnotationStatus::Active,
        }
    }

    fn host_state(artifacts: ArtifactStore, data_root: &Path) -> super::AppHostState {
        super::AppHostState {
            artifacts,
            review_state: ReviewStateStore::open(data_root.join("state")).unwrap(),
            render_jobs: Arc::new(Mutex::new(BoundedRenderJobs::new(4))),
            preview_cache: super::PreviewCache::open(&data_root.join("preview-cache")).unwrap(),
            render_config: None,
            preview_fidelities: Arc::new(Mutex::new(HashMap::new())),
            controlled_copy_root: data_root.join("controlled-copies"),
            evidence_dir: None,
            automation: None,
        }
    }

    fn automation_config(evidence_dir: PathBuf) -> super::ReviewAutomationConfig {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json")
            .canonicalize()
            .unwrap();
        let manifest_hash = Sha256::digest(fs::read(&manifest).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut config = super::ReviewAutomationConfig::load(
            manifest,
            manifest_hash,
            "ab".repeat(16),
            evidence_dir,
        )
        .unwrap();
        config.renderer_environment_sha256 = "55".repeat(32);
        config
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & (0_u32.wrapping_sub(crc & 1)));
            }
        }
        !crc
    }

    fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut central = Vec::new();
        for (name, body) in entries {
            let offset = u32::try_from(bytes.len()).unwrap();
            let crc = crc32(body);
            bytes.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
            bytes.extend_from_slice(&20_u16.to_le_bytes());
            bytes.extend_from_slice(&0_u16.to_le_bytes());
            bytes.extend_from_slice(&0_u16.to_le_bytes());
            bytes.extend_from_slice(&[0; 4]);
            bytes.extend_from_slice(&crc.to_le_bytes());
            bytes.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
            bytes.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
            bytes.extend_from_slice(&u16::try_from(name.len()).unwrap().to_le_bytes());
            bytes.extend_from_slice(&0_u16.to_le_bytes());
            bytes.extend_from_slice(name.as_bytes());
            bytes.extend_from_slice(body);

            central.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
            central.extend_from_slice(&20_u16.to_le_bytes());
            central.extend_from_slice(&20_u16.to_le_bytes());
            central.extend_from_slice(&0_u16.to_le_bytes());
            central.extend_from_slice(&0_u16.to_le_bytes());
            central.extend_from_slice(&[0; 4]);
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
            central.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
            central.extend_from_slice(&u16::try_from(name.len()).unwrap().to_le_bytes());
            central.extend_from_slice(&0_u16.to_le_bytes());
            central.extend_from_slice(&0_u16.to_le_bytes());
            central.extend_from_slice(&0_u16.to_le_bytes());
            central.extend_from_slice(&0_u16.to_le_bytes());
            central.extend_from_slice(&0_u32.to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let central_offset = u32::try_from(bytes.len()).unwrap();
        let central_size = u32::try_from(central.len()).unwrap();
        bytes.extend_from_slice(&central);
        bytes.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&u16::try_from(entries.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(&u16::try_from(entries.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(&central_size.to_le_bytes());
        bytes.extend_from_slice(&central_offset.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes
    }

    fn fixture_office(
        extension: &str,
        primary_part: &str,
    ) -> (tempfile::TempDir, PathBuf, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let bytes = stored_zip(&[
            (
                "[Content_Types].xml",
                br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#,
            ),
            (primary_part, b"<document/>")
        ]);
        let path = dir.path().join(format!("fixture.{extension}"));
        fs::write(&path, &bytes).unwrap();
        (dir, path, bytes)
    }

    fn fixture_large_office() -> (tempfile::TempDir, ArtifactStore, String, usize) {
        let dir = tempfile::tempdir().unwrap();
        let document = vec![b'x'; MAX_RANGE + 1];
        let bytes = stored_zip(&[
            (
                "[Content_Types].xml",
                br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#,
            ),
            ("word/document.xml", &document),
        ]);
        let path = dir.path().join("large.docx");
        fs::write(&path, &bytes).unwrap();
        let store = ArtifactStore::default();
        let opened = store.authorize_path(&path, ArtifactKind::Artifact).unwrap();
        (dir, store, opened.handle, bytes.len())
    }

    #[test]
    fn unknown_handle_is_not_found() {
        let store = ArtifactStore::default();
        assert_eq!(store.resolve("missing").unwrap_err(), StoreError::NotFound);
    }

    #[test]
    fn range_is_clamped_to_authorized_file() {
        let (_dir, store, handle) = fixture_store(b"0123456789");
        assert_eq!(store.read_range(&handle, 0, 4).unwrap(), b"%PDF");
        assert!(store.read_range(&handle, 0, MAX_RANGE + 1).is_err());
    }

    #[test]
    fn public_metadata_never_contains_absolute_path() {
        let (_dir, store, handle) = fixture_store(b"x");
        let meta = store.public_metadata(&handle).unwrap();
        assert!(!serde_json::to_string(&meta).unwrap().contains("/tmp/"));
    }

    #[test]
    fn authorized_revision_is_immutable_after_source_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mutable.pdf");
        let original = minimal_pdf(b"original");
        fs::write(&path, &original).unwrap();
        let store = ArtifactStore::default();
        let opened = store.authorize_path(&path, ArtifactKind::Artifact).unwrap();
        let replacement = vec![b'X'; original.len()];
        fs::write(&path, replacement).unwrap();
        assert_eq!(
            store.read_range(&opened.handle, 0, original.len()).unwrap(),
            original
        );
    }

    #[test]
    fn fast_preview_cannot_be_accepted() {
        let state = ReviewStateStore::temporary();
        let result = state.accept_preview(
            &format!("preview-sha256:{}", "77".repeat(32)),
            PreviewFidelity::Fast,
        );
        assert_eq!(result.unwrap_err(), ReviewStateError::NotAuthoritative);
    }

    #[test]
    fn public_annotation_capture_hashes_exact_raw_utf8_before_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let state = host_state(ArtifactStore::default(), dir.path());
        let raw = fixture_raw_annotation(Some("逐字保留的批注"));

        super::save_annotation_inner(raw.clone(), &state).unwrap();

        let persisted = state
            .review_state
            .annotations(&raw.preview_revision_id)
            .unwrap();
        assert_eq!(persisted.len(), 1);
        assert_eq!(
            persisted[0].selected_text.as_deref(),
            Some("sha256:64b0cc3b72867c5040f6c3de87f63709a5a6eb0b72f09cd45c05863cfdc5b061")
        );
        assert!(
            !fs::read_to_string(dir.path().join("state/review-state.json"))
                .unwrap()
                .contains("逐字保留的批注")
        );
    }

    #[test]
    fn public_annotation_capture_double_hashes_literal_and_forged_fingerprints() {
        let dir = tempfile::tempdir().unwrap();
        let state = host_state(ArtifactStore::default(), dir.path());
        let literal = format!("sha256:{}", "ab".repeat(32));
        let mut literal_raw = fixture_raw_annotation(Some(&literal));
        super::save_annotation_inner(literal_raw.clone(), &state).unwrap();
        let literal_persisted = state
            .review_state
            .annotations(&literal_raw.preview_revision_id)
            .unwrap();
        assert_eq!(
            literal_persisted[0].selected_text.as_deref(),
            Some("sha256:ff77c443b58e37e595711c4c003a01856e9460cf161f873bebdc3216162f942d")
        );
        assert_ne!(
            literal_persisted[0].selected_text.as_deref(),
            Some(literal.as_str())
        );

        let forged = "sha256:b230b0bea78b8cb14623db1df1ae60da017f36bf756eb8a35ac233eaea980225";
        literal_raw.annotation_id = "annotation-323e4567-e89b-42d3-a456-426614174000".into();
        literal_raw.selected_text = Some(forged.into());
        super::save_annotation_inner(literal_raw.clone(), &state).unwrap();
        let forged_persisted = state
            .review_state
            .annotations(&literal_raw.preview_revision_id)
            .unwrap()
            .into_iter()
            .find(|annotation| annotation.annotation_id == literal_raw.annotation_id)
            .unwrap();
        assert_eq!(
            forged_persisted.selected_text.as_deref(),
            Some("sha256:8eab33bf76744072f878a54e9e2eee156b8a6af56c0f5221a63e921219d0f897")
        );
        assert_ne!(forged_persisted.selected_text.as_deref(), Some(forged));
    }

    #[test]
    fn trusted_fingerprint_record_survives_store_reopen_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let raw = fixture_raw_annotation(None);
        let trusted = PersistedReviewAnnotation {
            annotation_id: raw.annotation_id,
            artifact_revision_id: raw.artifact_revision_id,
            preview_revision_id: raw.preview_revision_id.clone(),
            fidelity: raw.fidelity,
            page_id: raw.page_id,
            bbox: raw.bbox,
            selected_text: Some(format!("sha256:{}", "55".repeat(32))),
            before_context_hash: raw.before_context_hash,
            after_context_hash: raw.after_context_hash,
            semantic_object_id: raw.semantic_object_id,
            status: raw.status,
        };
        ReviewStateStore::open(dir.path())
            .unwrap()
            .save_trusted(&trusted)
            .unwrap();
        let reopened = ReviewStateStore::open(dir.path()).unwrap();
        assert_eq!(
            reopened.annotations(&trusted.preview_revision_id).unwrap(),
            vec![trusted]
        );
    }

    #[test]
    fn public_annotation_ipc_rejects_sensitive_probes_in_every_persisted_id_field() {
        let probes = [
            "OpenAI-gpt-5".to_owned(),
            "sk-proj-1234567890abcdef".to_owned(),
            "/private/tmp/review.docx".to_owned(),
            "66".repeat(32),
            "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo".to_owned(),
        ];
        for probe in probes {
            for field in 0..7 {
                let data = tempfile::tempdir().unwrap();
                let state = host_state(ArtifactStore::default(), data.path());
                let mut raw = fixture_raw_annotation(Some("safe ephemeral selection"));
                match field {
                    0 => raw.annotation_id = probe.clone(),
                    1 => raw.artifact_revision_id = probe.clone(),
                    2 => raw.preview_revision_id = probe.clone(),
                    3 => raw.page_id = probe.clone(),
                    4 => raw.before_context_hash = Some(probe.clone()),
                    5 => raw.after_context_hash = Some(probe.clone()),
                    6 => raw.semantic_object_id = Some(probe.clone()),
                    _ => unreachable!(),
                }
                assert_eq!(
                    super::save_annotation_inner(raw, &state).unwrap_err(),
                    "SW_REVIEW_ANNOTATION_INVALID",
                    "probe unexpectedly accepted in field {field}"
                );
                assert!(!data.path().join("state/review-state.json").exists());
            }
        }
    }

    #[test]
    fn protocol_rejects_encoded_traversal_before_lookup() {
        let (_dir, store, _handle) = fixture_store(b"payload");
        let response = serve(
            &store,
            ProtocolRequest::get("reviewasset://localhost/artifact/%2e%2e"),
        );
        assert_eq!(response.status, 400);
    }

    #[test]
    fn protocol_head_range_has_headers_and_no_body() {
        let (_dir, store, handle) = fixture_store(b"payload");
        let response = serve(
            &store,
            ProtocolRequest::head(format!("reviewasset://localhost/artifact/{handle}"))
                .with_range("bytes=0-3"),
        );
        assert_eq!(response.status, 206);
        assert_eq!(response.header("content-length"), Some("4"));
        assert!(response
            .header("content-range")
            .unwrap()
            .starts_with("bytes 0-3/"));
        assert!(response.body.is_empty());
    }

    #[test]
    fn protocol_large_no_range_head_reports_size_while_get_stays_capped() {
        let (_dir, store, handle, size) = fixture_large_office();
        let uri = format!("reviewasset://localhost/artifact/{handle}");

        let head = serve(&store, ProtocolRequest::head(&uri));
        assert_eq!(head.status, 200);
        assert_eq!(
            head.header("content-length"),
            Some(size.to_string().as_str())
        );
        assert!(head.body.is_empty());

        let get = serve(&store, ProtocolRequest::get(uri));
        assert_eq!(get.status, 416);
        assert!(get.body.is_empty());
    }

    #[test]
    fn metrics_reject_non_finite_duration() {
        let snapshot = ReviewPerformanceSnapshot {
            progress_visible_ms: 1.0,
            first_page_ms: 2.0,
            interactions: vec![InteractionMetric {
                name: InteractionName::Scroll,
                duration_ms: f64::NAN,
            }],
            automation: None,
        };
        assert_eq!(
            snapshot.validate().unwrap_err(),
            ReviewStateError::InvalidMetrics
        );
    }

    #[test]
    fn metrics_write_only_snapshot_to_selected_directory() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = ReviewPerformanceSnapshot {
            progress_visible_ms: 12.0,
            first_page_ms: 34.0,
            interactions: vec![InteractionMetric {
                name: InteractionName::Zoom,
                duration_ms: 5.0,
            }],
            automation: None,
        };
        snapshot.write_atomic(dir.path()).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("review-performance.json")).unwrap())
                .unwrap();
        assert_eq!(value["progressVisibleMs"], 12.0);
        assert!(value.get("path").is_none());
        assert!(value.get("evidenceDir").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn authorization_rejects_symlink_before_following_it() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.pdf");
        let link = dir.path().join("link.pdf");
        fs::write(&real, minimal_pdf(b"real")).unwrap();
        symlink(&real, &link).unwrap();
        assert_eq!(
            ArtifactStore::default()
                .authorize_path(&link, ArtifactKind::Artifact)
                .unwrap_err(),
            StoreError::Symlink
        );
    }

    #[test]
    fn malformed_pdf_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake.pdf");
        fs::write(&path, b"not a pdf").unwrap();
        assert_eq!(
            ArtifactStore::default()
                .authorize_path(&path, ArtifactKind::Artifact)
                .unwrap_err(),
            StoreError::InvalidFormat
        );
    }

    #[test]
    fn pdf_eof_scan_accepts_crlf_and_permitted_trailing_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        let mut crlf = minimal_pdf(b"crlf");
        assert_eq!(crlf.pop(), Some(b'\n'));
        crlf.extend_from_slice(b"\r\n");
        let mut whitespace = minimal_pdf(b"whitespace");
        assert_eq!(whitespace.pop(), Some(b'\n'));
        whitespace.extend_from_slice(b"\x00\t\n\x0c\r ");

        for (name, bytes) in [("crlf.pdf", crlf), ("whitespace.pdf", whitespace)] {
            let path = dir.path().join(name);
            fs::write(&path, bytes).unwrap();
            ArtifactStore::default()
                .authorize_path(&path, ArtifactKind::Artifact)
                .unwrap();
        }
    }

    #[test]
    fn pdf_eof_scan_rejects_trailing_junk_and_missing_marker() {
        let dir = tempfile::tempdir().unwrap();
        let mut junk = minimal_pdf(b"junk");
        junk.extend_from_slice(b"not-pdf-whitespace");
        let mut missing = minimal_pdf(b"missing");
        let marker = missing
            .windows(b"%%EOF".len())
            .rposition(|window| window == b"%%EOF")
            .unwrap();
        missing.truncate(marker);

        for (name, bytes) in [("junk.pdf", junk), ("missing.pdf", missing)] {
            let path = dir.path().join(name);
            fs::write(&path, bytes).unwrap();
            assert_eq!(
                ArtifactStore::default()
                    .authorize_path(&path, ArtifactKind::Artifact)
                    .unwrap_err(),
                StoreError::InvalidFormat
            );
        }
    }

    #[test]
    fn ooxml_extension_must_match_package_type() {
        let (_dir, path, _bytes) = fixture_office("docx", "ppt/presentation.xml");
        assert_eq!(
            ArtifactStore::default()
                .authorize_path(&path, ArtifactKind::Artifact)
                .unwrap_err(),
            StoreError::InvalidFormat
        );
    }

    #[test]
    fn configured_size_limit_is_enforced() {
        let (_dir, path, _bytes) = fixture_office("docx", "word/document.xml");
        assert_eq!(
            ArtifactStore::with_max_size(16)
                .authorize_path(&path, ArtifactKind::Artifact)
                .unwrap_err(),
            StoreError::TooLarge
        );
    }

    #[test]
    fn protocol_fails_closed_for_malformed_origins_paths_and_methods() {
        let (_dir, store, handle) = fixture_store(b"protocol");
        let cases = [
            ("GET", format!("reviewasset://evil/artifact/{handle}"), 400),
            (
                "GET",
                format!("reviewasset://user@localhost/artifact/{handle}"),
                400,
            ),
            (
                "GET",
                format!("reviewasset://localhost:80/artifact/{handle}"),
                400,
            ),
            (
                "GET",
                format!("reviewasset://localhost/artifact/{handle}/extra"),
                400,
            ),
            (
                "GET",
                format!("reviewasset://localhost/artifact/../{handle}"),
                400,
            ),
            (
                "GET",
                format!("reviewasset://localhost/artifact/%2e%2e/{handle}"),
                400,
            ),
            (
                "GET",
                format!("reviewasset://localhost/artifact\\{handle}"),
                400,
            ),
            (
                "GET",
                format!("reviewasset://localhost/wrong/{handle}"),
                400,
            ),
            (
                "GET",
                "reviewasset://localhost/artifact/not-a-handle".into(),
                400,
            ),
            (
                "GET",
                format!("reviewasset://localhost/artifact/{handle}?x=1"),
                400,
            ),
            (
                "GET",
                format!("reviewasset://localhost/artifact/{handle}#x"),
                400,
            ),
            (
                "POST",
                format!("reviewasset://localhost/artifact/{handle}"),
                405,
            ),
        ];
        for (method, uri, expected) in cases {
            let response = serve(&store, ProtocolRequest::new(method, uri));
            assert_eq!(response.status, expected, "unexpected status for request");
        }
    }

    #[test]
    fn protocol_rejects_multiple_invalid_and_overflowing_ranges() {
        let (_dir, store, handle) = fixture_store(b"range");
        let uri = format!("reviewasset://localhost/artifact/{handle}");
        for ranges in [
            vec!["bytes=0-1".into(), "bytes=2-3".into()],
            vec!["bytes=0-1,2-3".into()],
            vec!["bytes=-4".into()],
            vec!["bytes=4-".into()],
            vec!["bytes=9-2".into()],
            vec!["bytes=0-999999999999999999999999".into()],
            vec![format!("bytes=0-{MAX_RANGE}")],
        ] {
            let response = serve(
                &store,
                ProtocolRequest::new("GET", &uri).with_ranges(ranges),
            );
            assert_eq!(response.status, 416);
        }
    }

    #[test]
    fn protocol_returns_strong_revision_etag_and_immutable_private_cache() {
        let (_dir, store, handle) = fixture_store(b"etag");
        let response = serve(
            &store,
            ProtocolRequest::get(format!("reviewasset://localhost/artifact/{handle}")),
        );
        assert_eq!(response.status, 200);
        let etag = response.header("etag").unwrap();
        assert!(etag.starts_with('"') && etag.ends_with('"'));
        assert_eq!(response.header("cache-control"), Some("private, immutable"));
        assert_eq!(
            response.body,
            store.read_range(&handle, 0, response.body.len()).unwrap()
        );
    }

    #[derive(Default)]
    struct InspectingLauncher {
        launched: Mutex<Vec<(PathBuf, Vec<u8>)>>,
    }

    impl ControlledCopyLauncher for InspectingLauncher {
        fn launch(&self, path: &Path) -> Result<(), StoreError> {
            self.launched
                .lock()
                .unwrap()
                .push((path.to_path_buf(), fs::read(path).unwrap()));
            Ok(())
        }
    }

    #[test]
    fn controlled_copy_launches_verified_job_copy_and_preserves_original() {
        let (_source_dir, source, source_bytes) = fixture_office("docx", "word/document.xml");
        let store = ArtifactStore::default();
        let opened = store
            .authorize_path(&source, ArtifactKind::Artifact)
            .unwrap();
        let jobs = tempfile::tempdir().unwrap();
        let launcher = InspectingLauncher::default();
        let receipt = store
            .open_controlled_copy_with(&opened.handle, jobs.path(), &launcher)
            .unwrap();
        assert_eq!(receipt.receipt_id.len(), 32);
        assert_eq!(fs::read(&source).unwrap(), source_bytes);
        let launched = launcher.launched.lock().unwrap();
        assert_eq!(launched.len(), 1);
        assert!(launched[0].0.starts_with(jobs.path()));
        assert_ne!(launched[0].0, source);
        assert_eq!(launched[0].1, source_bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(launched[0].0.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
            assert_eq!(
                fs::metadata(&launched[0].0).unwrap().permissions().mode() & 0o077,
                0
            );
        }
    }

    #[test]
    fn controlled_copy_is_disabled_for_pdf() {
        let (_source_dir, store, handle) = fixture_store(b"pdf");
        let jobs = tempfile::tempdir().unwrap();
        let launcher = InspectingLauncher::default();
        assert_eq!(
            store
                .open_controlled_copy_with(&handle, jobs.path(), &launcher)
                .unwrap_err(),
            StoreError::ControlledCopyUnsupported
        );
        assert!(launcher.launched.lock().unwrap().is_empty());
    }

    #[test]
    fn controlled_copy_denies_preview_kind_office_handles_before_launch() {
        for (extension, primary_part) in [
            ("docx", "word/document.xml"),
            ("pptx", "ppt/presentation.xml"),
        ] {
            let (_source_dir, source, _source_bytes) = fixture_office(extension, primary_part);
            let store = ArtifactStore::default();
            let opened = store
                .authorize_path(&source, ArtifactKind::Preview)
                .unwrap();
            let jobs = tempfile::tempdir().unwrap();
            let launcher = InspectingLauncher::default();

            assert_eq!(
                store
                    .open_controlled_copy_with(&opened.handle, jobs.path(), &launcher)
                    .unwrap_err(),
                StoreError::KindMismatch
            );
            assert!(launcher.launched.lock().unwrap().is_empty());
            assert_eq!(fs::read_dir(jobs.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn active_capability_is_seven_commands_plus_narrow_event_handshake() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();
        let actual: Vec<&str> = permissions
            .iter()
            .map(|permission| permission.as_str().unwrap())
            .collect();
        assert_eq!(
            actual,
            vec![
                "allow-asset-url",
                "allow-start-truth-render",
                "allow-preview-status",
                "allow-save-annotation",
                "allow-accept-preview",
                "allow-open-controlled-copy",
                "allow-record-metrics",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "core:event:allow-emit",
            ]
        );
    }

    #[test]
    fn native_drop_events_serialize_only_consumable_safe_payloads() {
        let opened = ArtifactOpened {
            handle: "0123456789abcdef0123456789abcdef".into(),
            display_name: "review.docx".into(),
            media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                .into(),
            size: 42,
            revision_hash: "revision-hash".into(),
        };
        let success = super::safe_drop_event(Ok(opened));
        assert_eq!(success.name, "artifact-opened");
        assert_eq!(
            success.payload,
            serde_json::json!({
                "handle": "0123456789abcdef0123456789abcdef",
                "displayName": "review.docx",
                "mediaType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "size": 42,
                "revisionHash": "revision-hash"
            })
        );

        let failure = super::safe_drop_event(Err(StoreError::Symlink));
        assert_eq!(failure.name, "artifact-open-error");
        assert_eq!(
            failure.payload,
            serde_json::json!({"errorCode": "SW_REVIEW_ARTIFACT_SYMLINK_DENIED"})
        );
        let serialized = format!("{}{}", success.payload, failure.payload);
        assert!(!serialized.contains("path"));
        assert!(!serialized.contains("/tmp/"));
    }

    #[test]
    fn custom_review_protocol_response_allows_only_the_embedded_app_origin() {
        let response = super::tauri_response(super::ProtocolResponse {
            status: 200,
            headers: std::collections::BTreeMap::from([
                ("content-length".into(), "4".into()),
                ("content-type".into(), "application/pdf".into()),
            ]),
            body: b"%PDF".to_vec(),
        });
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            super::reviewer_app_origin()
        );
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-methods")
                .unwrap(),
            "GET, HEAD"
        );
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-headers")
                .unwrap(),
            "Range"
        );
        assert_eq!(response.body(), b"%PDF");
    }

    #[test]
    fn ipc_structs_reject_unknown_fields_and_negative_metrics() {
        assert!(serde_json::from_str::<RawReviewAnnotation>(
            r#"{"annotationId":"a","artifactRevisionId":"r","previewRevisionId":"p","fidelity":"authoritative","pageId":"1","status":"active","path":"/tmp/leak"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<ReviewPerformanceSnapshot>(
            r#"{"progressVisibleMs":1,"firstPageMs":2,"interactions":[],"extra":3}"#
        )
        .is_err());
        let negative: ReviewPerformanceSnapshot =
            serde_json::from_str(r#"{"progressVisibleMs":-1,"firstPageMs":2,"interactions":[]}"#)
                .unwrap();
        assert_eq!(
            negative.validate().unwrap_err(),
            ReviewStateError::InvalidMetrics
        );
    }

    #[test]
    fn authoritative_acceptance_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        ReviewStateStore::open(dir.path())
            .unwrap()
            .accept_preview(
                &format!("preview-sha256:{}", "88".repeat(32)),
                PreviewFidelity::Authoritative,
            )
            .unwrap();
        assert!(ReviewStateStore::open(dir.path())
            .unwrap()
            .is_accepted(&format!("preview-sha256:{}", "88".repeat(32))));
    }

    #[test]
    fn render_source_is_a_verified_job_owned_copy_of_the_authorized_revision() {
        let (_source_dir, source, expected_bytes) = fixture_office("docx", "word/document.xml");
        let store = ArtifactStore::default();
        let opened = store
            .authorize_path(&source, ArtifactKind::Artifact)
            .unwrap();
        fs::write(&source, vec![b'X'; expected_bytes.len()]).unwrap();
        let job = tempfile::tempdir().unwrap();

        let staged = super::stage_render_source(&store, &opened.handle, job.path()).unwrap();

        assert_eq!(fs::read(&staged.path).unwrap(), expected_bytes);
        assert_eq!(staged.source_content_hash, opened.revision_hash);
        assert_eq!(staged.path.file_name().unwrap(), "source.docx");
    }

    #[test]
    fn truth_render_missing_config_without_automation_does_not_write_failure_or_accumulate() {
        let (_source_dir, artifacts, handle) = fixture_store(b"placeholder");
        let data = tempfile::tempdir().unwrap();
        let state = host_state(artifacts, data.path());
        let revision_hash = state
            .artifacts
            .public_metadata(&handle)
            .unwrap()
            .revision_hash;
        let exit = test_exit();
        let receipt = super::start_truth_render_inner(
            handle,
            format!("artifact-sha256:{revision_hash}"),
            5_000,
            &state,
            exit.clone(),
        )
        .unwrap();
        let status = super::preview_status_inner(receipt.job_id, &state).unwrap();
        assert_eq!(status.state, "dependency_missing");
        assert_eq!(
            status.error_code.as_deref(),
            Some(super::DEPENDENCY_MISSING_CODE)
        );
        assert!(status.preview_revision_id.is_none());
        assert!(status.preview_handle.is_none());
        assert_eq!(state.render_jobs.lock().unwrap().len(), 0);
        assert_eq!(
            super::preview_status_inner(status.job_id, &state).unwrap_err(),
            "SW_REVIEW_JOB_NOT_FOUND"
        );
        assert!(!data
            .path()
            .join("evidence/automation-failure.json")
            .exists());
        assert!(exit.codes.lock().unwrap().is_empty());
    }

    #[test]
    fn automation_missing_render_config_writes_exact_host_failure_artifact() {
        let (_source_dir, artifacts, handle) = fixture_store(b"placeholder");
        let data = tempfile::tempdir().unwrap();
        let evidence = data.path().join("evidence");
        let mut state = host_state(artifacts, data.path());
        state.automation = Some(automation_config(evidence.clone()));
        let revision_hash = state
            .artifacts
            .public_metadata(&handle)
            .unwrap()
            .revision_hash;
        let exit = test_exit();

        super::start_truth_render_inner(
            handle,
            format!("artifact-sha256:{revision_hash}"),
            5_000,
            &state,
            exit.clone(),
        )
        .unwrap();

        let failure: serde_json::Value =
            serde_json::from_slice(&fs::read(evidence.join("automation-failure.json")).unwrap())
                .unwrap();
        assert_eq!(
            failure
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            [
                "error_code",
                "failed_at",
                "fixture",
                "manifest_sha256",
                "renderer_environment_sha256",
                "schema_id",
                "schema_version",
                "session_id",
                "state",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        );
        assert_eq!(
            failure["schema_id"],
            "superwagie.review-automation-failure.v1"
        );
        assert_eq!(failure["schema_version"], 1);
        assert_eq!(failure["session_id"], "ab".repeat(16));
        assert_eq!(failure["fixture"], "G3-REVIEW-001");
        assert_eq!(failure["renderer_environment_sha256"], "55".repeat(32));
        assert!(failure["failed_at"].as_u64().unwrap() > 0);
        assert_eq!(failure["state"], "dependency_missing");
        assert_eq!(failure["error_code"], super::DEPENDENCY_MISSING_CODE);
        assert!(!serde_json::to_string(&failure)
            .unwrap()
            .contains(data.path().to_str().unwrap()));
        assert_eq!(
            fs::read_dir(&evidence)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>(),
            vec![std::ffi::OsString::from("automation-failure.json")]
        );
        assert_eq!(*exit.codes.lock().unwrap(), vec![2]);
    }

    #[test]
    fn automation_failure_artifact_write_failure_still_requests_fast_exit() {
        let (_source_dir, artifacts, handle) = fixture_store(b"placeholder");
        let data = tempfile::tempdir().unwrap();
        let evidence = data.path().join("evidence");
        let mut state = host_state(artifacts, data.path());
        state.automation = Some(automation_config(evidence.clone()));
        fs::remove_dir(&evidence).unwrap();
        fs::write(&evidence, b"not-a-directory").unwrap();
        let revision_hash = state
            .artifacts
            .public_metadata(&handle)
            .unwrap()
            .revision_hash;
        let exit = test_exit();

        super::start_truth_render_inner(
            handle,
            format!("artifact-sha256:{revision_hash}"),
            5_000,
            &state,
            exit.clone(),
        )
        .unwrap();

        assert!(evidence.is_file());
        assert_eq!(*exit.codes.lock().unwrap(), vec![2]);
    }

    #[test]
    fn automation_client_failure_is_exact_session_bound_and_one_shot() {
        let data = tempfile::tempdir().unwrap();
        let evidence = data.path().join("evidence");
        let config = automation_config(evidence.clone());
        let accepted = AtomicBool::new(false);
        let exit = test_exit();
        let session_id = "ab".repeat(16);

        assert!(config.accepts_client_ready(r#"{"schemaVersion":1,"state":"listener_installed"}"#));
        for payload in [
            "not-json",
            r#"{"schemaVersion":2,"state":"listener_installed"}"#,
            r#"{"schemaVersion":1,"state":"unknown"}"#,
            r#"{"schemaVersion":1,"state":"listener_installed","path":"/tmp"}"#,
        ] {
            assert!(!config.accepts_client_ready(payload));
        }
        let ready_gate = super::AutomationReplayGate::new(vec![1, 2, 3]);
        let ready_url = "tauri://localhost".parse().unwrap();
        assert_eq!(
            ready_gate.take_for_page_load(
                "main",
                &ready_url,
                tauri::webview::PageLoadEvent::Finished,
            ),
            None
        );
        assert_eq!(
            super::accept_client_automation_ready(
                Some(&config),
                r#"{"schemaVersion":1,"state":"unknown"}"#,
                &ready_gate,
            ),
            None
        );
        assert!(ready_gate.diagnostics().client_ready_rejected);
        assert_eq!(
            super::accept_client_automation_ready(
                Some(&config),
                r#"{"schemaVersion":1,"state":"listener_installed"}"#,
                &ready_gate,
            ),
            Some(vec![1, 2, 3])
        );
        ready_gate.mark_first_artifact_emitted();
        config
            .write_handshake_diagnostics(ready_gate.diagnostics())
            .unwrap();
        let diagnostics: serde_json::Value =
            serde_json::from_slice(&fs::read(evidence.join("automation-handshake.json")).unwrap())
                .unwrap();
        assert_eq!(
            diagnostics
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            [
                "client_ready",
                "first_artifact_emitted",
                "fixture",
                "manifest_sha256",
                "page_load",
                "released",
                "renderer_environment_sha256",
                "schema_id",
                "schema_version",
                "session_id",
                "setup_armed",
                "updated_at",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        );
        assert_eq!(
            diagnostics["schema_id"],
            "superwagie.review-automation-handshake.v1"
        );
        assert_eq!(diagnostics["schema_version"], 1);
        assert_eq!(diagnostics["setup_armed"], true);
        assert_eq!(diagnostics["released"], true);
        assert_eq!(diagnostics["first_artifact_emitted"], true);
        assert_eq!(diagnostics["page_load"]["trusted_main_finished"], true);
        assert_eq!(diagnostics["client_ready"]["received"], true);
        assert_eq!(diagnostics["client_ready"]["accepted"], true);
        assert_eq!(diagnostics["client_ready"]["rejected"], true);
        let serialized = serde_json::to_string(&diagnostics).unwrap();
        assert!(!serialized.contains(data.path().to_str().unwrap()));
        assert!(!serialized.contains("tauri://"));

        let stale = super::automation_replay::AutomationHandshakeSnapshot {
            setup_armed: true,
            ..super::automation_replay::AutomationHandshakeSnapshot::default()
        };
        config.write_handshake_diagnostics(stale).unwrap();
        let after_stale: serde_json::Value =
            serde_json::from_slice(&fs::read(evidence.join("automation-handshake.json")).unwrap())
                .unwrap();
        assert_eq!(after_stale["released"], true);
        assert_eq!(after_stale["first_artifact_emitted"], true);
        assert_eq!(
            super::accept_client_automation_ready(
                Some(&config),
                r#"{"schemaVersion":1,"state":"listener_installed"}"#,
                &ready_gate,
            ),
            None
        );
        let normal_gate = super::AutomationReplayGate::new(vec![4, 5, 6]);
        assert_eq!(
            super::accept_client_automation_ready(
                None,
                r#"{"schemaVersion":1,"state":"listener_installed"}"#,
                &normal_gate,
            ),
            None
        );

        for (stage, code) in [
            ("bootstrap", "SW_REVIEW_AUTOMATION_BOOTSTRAP_FAILED"),
            ("progress", "SW_REVIEW_AUTOMATION_PROGRESS_FAILED"),
            (
                "pdf_authoritative",
                "SW_REVIEW_AUTOMATION_PDF_AUTHORITATIVE_FAILED",
            ),
            ("pdf_asset_url", "SW_REVIEW_AUTOMATION_PDF_ASSET_URL_FAILED"),
            (
                "pdf_asset_fetch",
                "SW_REVIEW_AUTOMATION_PDF_ASSET_FETCH_FAILED",
            ),
            (
                "pdf_document_load",
                "SW_REVIEW_AUTOMATION_PDF_DOCUMENT_LOAD_FAILED",
            ),
            (
                "pdf_manifest_build",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_BUILD_FAILED",
            ),
            (
                "pdf_manifest_pages",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_PAGES_FAILED",
            ),
            (
                "pdf_manifest_source",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_SOURCE_FAILED",
            ),
            (
                "pdf_manifest_hashes",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_HASHES_FAILED",
            ),
            (
                "pdf_manifest_revision",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_REVISION_FAILED",
            ),
            (
                "pdf_manifest_revision_id",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_REVISION_ID_FAILED",
            ),
            (
                "pdf_manifest_session",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_SESSION_FAILED",
            ),
            ("pdf_present", "SW_REVIEW_AUTOMATION_PDF_PRESENT_FAILED"),
            (
                "pdf_cached_page",
                "SW_REVIEW_AUTOMATION_PDF_CACHED_PAGE_FAILED",
            ),
            ("pdf_actions", "SW_REVIEW_AUTOMATION_PDF_ACTIONS_FAILED"),
            ("docx_fast", "SW_REVIEW_AUTOMATION_DOCX_FAST_FAILED"),
            (
                "docx_authoritative",
                "SW_REVIEW_AUTOMATION_DOCX_AUTHORITATIVE_FAILED",
            ),
            (
                "pptx_authoritative",
                "SW_REVIEW_AUTOMATION_PPTX_AUTHORITATIVE_FAILED",
            ),
            ("persistence", "SW_REVIEW_AUTOMATION_PERSISTENCE_FAILED"),
            ("metrics", "SW_REVIEW_AUTOMATION_METRICS_FAILED"),
        ] {
            let payload = format!(r#"{{"sessionId":"{session_id}","stage":"{stage}"}}"#);
            assert_eq!(
                config.client_failure_kind(&payload).unwrap().fields(),
                ("failed_terminal", code)
            );
        }

        for payload in [
            "not-json".to_owned(),
            format!(r#"{{"sessionId":"{session_id}","stage":"unknown"}}"#),
            format!(
                r#"{{"sessionId":"{}","stage":"docx_authoritative"}}"#,
                "cd".repeat(16)
            ),
            format!(
                r#"{{"sessionId":"{session_id}","stage":"docx_authoritative","error":"native path"}}"#
            ),
        ] {
            assert!(!super::record_client_automation_failure(
                Some(&config),
                &payload,
                &accepted,
                exit.as_ref()
            ));
        }
        assert!(!evidence.join("automation-failure.json").exists());
        assert!(exit.codes.lock().unwrap().is_empty());

        let payload = format!(r#"{{"sessionId":"{session_id}","stage":"docx_authoritative"}}"#);
        assert!(super::record_client_automation_failure(
            Some(&config),
            &payload,
            &accepted,
            exit.as_ref()
        ));
        let first = fs::read(evidence.join("automation-failure.json")).unwrap();
        let failure: serde_json::Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(failure["state"], "failed_terminal");
        assert_eq!(
            failure["error_code"],
            "SW_REVIEW_AUTOMATION_DOCX_AUTHORITATIVE_FAILED"
        );

        assert!(!super::record_client_automation_failure(
            Some(&config),
            &payload,
            &accepted,
            exit.as_ref()
        ));
        assert_eq!(
            fs::read(evidence.join("automation-failure.json")).unwrap(),
            first
        );
        assert_eq!(*exit.codes.lock().unwrap(), vec![2]);

        let without_automation = AtomicBool::new(false);
        let no_automation_exit = test_exit();
        assert!(!super::record_client_automation_failure(
            None,
            &payload,
            &without_automation,
            no_automation_exit.as_ref()
        ));
        assert!(no_automation_exit.codes.lock().unwrap().is_empty());
    }

    #[test]
    fn automation_background_worker_runtime_missing_writes_host_failure_artifact() {
        let (_source_dir, source, _bytes) = fixture_office("docx", "word/document.xml");
        let artifacts = ArtifactStore::default();
        let opened = artifacts
            .authorize_path(&source, ArtifactKind::Artifact)
            .unwrap();
        let data = tempfile::tempdir().unwrap();
        let evidence = data.path().join("evidence");
        let worker_script = data.path().join("missing-worker.py");
        fs::write(
            &worker_script,
            "import json\nprint(json.dumps({'status':'dependency_missing','code':'WPS_RUNTIME_MISSING','component':'writer','backend':'wpscomposer-explicit-source'}))\nraise SystemExit(1)\n",
        )
        .unwrap();
        let python_executable = test_python_executable();
        let mut state = host_state(artifacts, data.path());
        state.automation = Some(automation_config(evidence.clone()));
        state.render_config = Some(super::TruthRenderConfig {
            python_executable: python_executable.clone(),
            worker_script,
            wpscomposer_root: data.path().to_path_buf(),
            wps_application: python_executable,
            expected_wps_identity_json: format!(
                "{{\"target_kind\":\"windows-executable\",\"executable_sha256\":\"{}\",\"bundle_manifest_sha256\":\"{}\",\"bridge_sha256\":\"{}\"}}",
                "1".repeat(64), "2".repeat(64), "3".repeat(64)
            ),
            wps_bridge_relative_path: "skills/WPSComposer/__init__.py".into(),
            wps_executable_relative_path: None,
            renderer_id: "wpscomposer-explicit-source".into(),
            renderer_version: "fake-1".into(),
            renderer_environment_hash: "22".repeat(32),
            font_environment_hash: "33".repeat(32),
            render_options: super::RenderOptions(BTreeMap::from([(
                "quality".into(),
                "authoritative".into(),
            )])),
            locale: Some("C.UTF-8".into()),
            bridge_environment: WpsBridgeEnvironment::default(),
            home_probe: HomeFeatureProbe::NotRequired,
        });

        let exit = test_exit();
        let receipt = super::start_truth_render_inner(
            opened.handle,
            format!("artifact-sha256:{}", opened.revision_hash),
            10_000,
            &state,
            exit.clone(),
        )
        .unwrap();
        loop {
            let status = super::preview_status_inner(receipt.job_id.clone(), &state).unwrap();
            if status.state != "rendering_authoritative" {
                assert_eq!(status.state, "dependency_missing");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let failure: serde_json::Value =
            serde_json::from_slice(&fs::read(evidence.join("automation-failure.json")).unwrap())
                .unwrap();
        assert_eq!(failure["state"], "dependency_missing");
        assert_eq!(failure["error_code"], super::DEPENDENCY_MISSING_CODE);
        assert_eq!(*exit.codes.lock().unwrap(), vec![2]);
    }

    #[test]
    fn truth_render_status_identity_acceptance_and_reopen_use_one_real_pipeline() {
        let (_source_dir, source, _bytes) = fixture_office("docx", "word/document.xml");
        let artifacts = ArtifactStore::default();
        let opened = artifacts
            .authorize_path(&source, ArtifactKind::Artifact)
            .unwrap();
        let data = tempfile::tempdir().unwrap();
        let worker_script = data.path().join("fake-worker.py");
        let python_executable = test_python_executable();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-100p.pdf");
        let worker_invocations = data.path().join("worker-invocations.txt");
        let fixture_hash = Sha256::digest(fs::read(&fixture).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        fs::write(
            &worker_script,
            format!(
                "import json, pathlib, shutil, sys\nassert sys.argv[sys.argv.index('--wps-application') + 1] == {target:?}\nassert sys.argv[sys.argv.index('--wps-bridge-relative-path') + 1] == 'skills/WPSComposer/__init__.py'\nassert json.loads(sys.argv[sys.argv.index('--expected-wps-identity-json') + 1])['target_kind'] == 'windows-executable'\ncounter = pathlib.Path({counter:?})\ncount = int(counter.read_text()) + 1 if counter.exists() else 1\ncounter.write_text(str(count))\nout = sys.argv[sys.argv.index('--output') + 1]\nshutil.copyfile({fixture:?}, out)\nprint(json.dumps({{'status':'success','code':'OK','component':'writer','backend':'wpscomposer-explicit-source','output_sha256':{hash:?}}}))\n",
                fixture = fixture.to_string_lossy(),
                hash = fixture_hash,
                target = python_executable.to_string_lossy(),
                counter = worker_invocations.to_string_lossy(),
            ),
        )
        .unwrap();
        let mut state = host_state(artifacts, data.path());
        state.render_config = Some(super::TruthRenderConfig {
            python_executable: python_executable.clone(),
            worker_script,
            wpscomposer_root: data.path().to_path_buf(),
            wps_application: python_executable,
            expected_wps_identity_json: format!(
                "{{\"target_kind\":\"windows-executable\",\"executable_sha256\":\"{}\",\"bundle_manifest_sha256\":\"{}\",\"bridge_sha256\":\"{}\"}}",
                "1".repeat(64), "2".repeat(64), "3".repeat(64)
            ),
            wps_bridge_relative_path: "skills/WPSComposer/__init__.py".into(),
            wps_executable_relative_path: None,
            renderer_id: "wpscomposer-explicit-source".into(),
            renderer_version: "fake-1".into(),
            renderer_environment_hash: "22".repeat(32),
            font_environment_hash: "33".repeat(32),
            render_options: super::RenderOptions(BTreeMap::from([(
                "quality".into(),
                "authoritative".into(),
            )])),
            locale: Some("C.UTF-8".into()),
            bridge_environment: WpsBridgeEnvironment::default(),
            home_probe: HomeFeatureProbe::NotRequired,
        });
        let artifact_revision_id = format!("artifact-sha256:{}", opened.revision_hash);
        let receipt = super::start_truth_render_inner(
            opened.handle.clone(),
            artifact_revision_id.clone(),
            10_000,
            &state,
            test_exit(),
        )
        .unwrap();
        let status = loop {
            let status = super::preview_status_inner(receipt.job_id.clone(), &state).unwrap();
            if status.state == "authoritative_ready" {
                break status;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let preview_revision_id = status.preview_revision_id.unwrap();
        let preview_handle = status.preview_handle.unwrap();
        assert!(preview_revision_id.starts_with("preview-sha256:"));
        assert_eq!(preview_revision_id.len(), "preview-sha256:".len() + 64);
        assert_eq!(preview_handle.len(), 32);
        assert!(state
            .artifacts
            .validate_kind(&preview_handle, ArtifactKind::Preview)
            .is_ok());
        assert_eq!(
            state
                .preview_fidelities
                .lock()
                .unwrap()
                .get(&preview_revision_id),
            Some(&PreviewFidelity::Authoritative)
        );
        assert!(!state
            .preview_fidelities
            .lock()
            .unwrap()
            .contains_key(&preview_handle));

        let reopened = super::start_truth_render_inner(
            opened.handle,
            artifact_revision_id,
            10_000,
            &state,
            test_exit(),
        )
        .unwrap();
        let reopened_status = loop {
            let status = super::preview_status_inner(reopened.job_id.clone(), &state).unwrap();
            if status.state == "authoritative_ready" {
                break status;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            reopened_status.preview_revision_id.as_deref(),
            Some(preview_revision_id.as_str())
        );
        assert_eq!(fs::read_to_string(worker_invocations).unwrap(), "1");

        super::accept_preview_inner(preview_revision_id.clone(), &state).unwrap();
        assert!(ReviewStateStore::open(data.path().join("state"))
            .unwrap()
            .is_accepted(&preview_revision_id));
        assert_eq!(state.render_jobs.lock().unwrap().len(), 0);
    }

    #[test]
    fn truth_render_rejects_webview_asserted_artifact_revision() {
        let (_source_dir, source, _bytes) = fixture_office("docx", "word/document.xml");
        let artifacts = ArtifactStore::default();
        let opened = artifacts
            .authorize_path(&source, ArtifactKind::Artifact)
            .unwrap();
        let data = tempfile::tempdir().unwrap();
        let state = host_state(artifacts, data.path());

        let result = super::start_truth_render_inner(
            opened.handle,
            format!("artifact-sha256:{}", "11".repeat(32)),
            10_000,
            &state,
            test_exit(),
        );
        assert_eq!(
            result.err().as_deref(),
            Some("SW_REVIEW_ARTIFACT_REVISION_MISMATCH")
        );
    }

    #[test]
    fn preview_revision_derivation_is_domain_separated_and_binds_every_truth_input() {
        let artifact_revision_id = format!("artifact-sha256:{}", "11".repeat(32));
        let manifest = super::preview_cache::PublishManifest {
            cache_key: "55".repeat(32),
            source_content_hash: "22".repeat(32),
            renderer_id: "wps".into(),
            renderer_version: "1.2".into(),
            renderer_environment_hash: "33".repeat(32),
            font_environment_hash: "44".repeat(32),
            render_options: super::RenderOptions(BTreeMap::from([
                ("paper".into(), "source".into()),
                ("quality".into(), "authoritative".into()),
            ])),
            output_sha256: "66".repeat(32),
            page_count: 100,
        };
        let expected =
            "preview-sha256:a21089373b64a1780013fb0b04fb42e074304e933b85599e6f506204556eb25f";
        assert_eq!(
            super::derive_authoritative_preview_revision_id(&artifact_revision_id, &manifest)
                .unwrap(),
            expected
        );

        let mut variants = Vec::new();
        let mut changed = manifest.clone();
        changed.cache_key = "77".repeat(32);
        variants.push(changed);
        let mut changed = manifest.clone();
        changed.output_sha256 = "88".repeat(32);
        variants.push(changed);
        let mut changed = manifest.clone();
        changed.page_count = 99;
        variants.push(changed);
        let mut changed = manifest.clone();
        changed.renderer_id = "wps-next".into();
        variants.push(changed);
        let mut changed = manifest.clone();
        changed.renderer_version = "1.3".into();
        variants.push(changed);
        let mut changed = manifest.clone();
        changed.renderer_environment_hash = "99".repeat(32);
        variants.push(changed);
        let mut changed = manifest.clone();
        changed.font_environment_hash = "aa".repeat(32);
        variants.push(changed);
        let mut changed = manifest.clone();
        changed.source_content_hash = "bb".repeat(32);
        variants.push(changed);
        let mut changed = manifest.clone();
        changed
            .render_options
            .0
            .insert("quality".into(), "different".into());
        variants.push(changed);
        for changed in variants {
            assert_ne!(
                super::derive_authoritative_preview_revision_id(&artifact_revision_id, &changed)
                    .unwrap(),
                expected
            );
        }
        assert_ne!(
            super::derive_authoritative_preview_revision_id(
                &format!("artifact-sha256:{}", "cc".repeat(32)),
                &manifest
            )
            .unwrap(),
            expected
        );
    }

    #[test]
    fn acceptance_uses_host_owned_fidelity_not_webview_input() {
        let data = tempfile::tempdir().unwrap();
        let state = host_state(ArtifactStore::default(), data.path());
        state.preview_fidelities.lock().unwrap().insert(
            format!("preview-sha256:{}", "99".repeat(32)),
            PreviewFidelity::Fast,
        );
        assert_eq!(
            super::accept_preview_inner(format!("preview-sha256:{}", "99".repeat(32)), &state,)
                .unwrap_err(),
            "SW_REVIEW_PREVIEW_NOT_AUTHORITATIVE"
        );
        state.preview_fidelities.lock().unwrap().insert(
            format!("preview-sha256:{}", "aa".repeat(32)),
            PreviewFidelity::Authoritative,
        );
        let authoritative = format!("preview-sha256:{}", "aa".repeat(32));
        super::accept_preview_inner(authoritative.clone(), &state).unwrap();
        assert!(state.review_state.is_accepted(&authoritative));
    }

    #[test]
    fn acceptance_ipc_rejects_non_preview_revision_transport_before_map_lookup() {
        let data = tempfile::tempdir().unwrap();
        let state = host_state(ArtifactStore::default(), data.path());
        assert_eq!(
            super::accept_preview_inner("OpenAI-gpt-5".into(), &state).unwrap_err(),
            "SW_REVIEW_PREVIEW_REVISION_ID_INVALID"
        );
        assert_eq!(
            super::accept_preview_inner("0123456789abcdef0123456789abcdef".into(), &state)
                .unwrap_err(),
            "SW_REVIEW_PREVIEW_REVISION_ID_INVALID"
        );
        assert_eq!(
            super::accept_preview_inner(format!("preview-sha256:{}", "ff".repeat(32)), &state,)
                .unwrap_err(),
            "SW_REVIEW_PREVIEW_NOT_FOUND"
        );
    }

    fn _path_type_check(_: &Path) {}
}
