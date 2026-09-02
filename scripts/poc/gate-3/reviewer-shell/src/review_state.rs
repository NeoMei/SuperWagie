use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const STATE_FILE: &str = "review-state.json";
const METRICS_FILE: &str = "review-performance.json";
const MAX_ID_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const SELECTED_TEXT_DOMAIN: &[u8] = b"superwagie.review.selected-text.v1\0";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewFidelity {
    Fast,
    Authoritative,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationStatus {
    Active,
    Stale,
    Unresolved,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawReviewAnnotation {
    pub annotation_id: String,
    pub artifact_revision_id: String,
    pub preview_revision_id: String,
    pub fidelity: PreviewFidelity,
    pub page_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_context_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_context_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_object_id: Option<String>,
    pub status: AnnotationStatus,
}

impl RawReviewAnnotation {
    pub fn validate(&self) -> Result<(), ReviewStateError> {
        validate_annotation_fields(AnnotationFields {
            annotation_id: &self.annotation_id,
            artifact_revision_id: &self.artifact_revision_id,
            preview_revision_id: &self.preview_revision_id,
            page_id: &self.page_id,
            before_context_hash: self.before_context_hash.as_deref(),
            after_context_hash: self.after_context_hash.as_deref(),
            semantic_object_id: self.semantic_object_id.as_deref(),
            bbox: self.bbox,
        })?;
        if self
            .selected_text
            .as_ref()
            .is_some_and(|text| text.len() > MAX_TEXT_BYTES)
        {
            return Err(ReviewStateError::InvalidAnnotation);
        }
        Ok(())
    }

    fn into_persisted(self) -> Result<PersistedReviewAnnotation, ReviewStateError> {
        self.validate()?;
        Ok(PersistedReviewAnnotation {
            annotation_id: self.annotation_id,
            artifact_revision_id: self.artifact_revision_id,
            preview_revision_id: self.preview_revision_id,
            fidelity: self.fidelity,
            page_id: self.page_id,
            bbox: self.bbox,
            selected_text: self.selected_text.as_deref().map(selected_text_fingerprint),
            before_context_hash: self.before_context_hash,
            after_context_hash: self.after_context_hash,
            semantic_object_id: self.semantic_object_id,
            status: self.status,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedReviewAnnotation {
    pub annotation_id: String,
    pub artifact_revision_id: String,
    pub preview_revision_id: String,
    pub fidelity: PreviewFidelity,
    pub page_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_context_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_context_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_object_id: Option<String>,
    pub status: AnnotationStatus,
}

impl PersistedReviewAnnotation {
    pub fn validate(&self) -> Result<(), ReviewStateError> {
        validate_annotation_fields(AnnotationFields {
            annotation_id: &self.annotation_id,
            artifact_revision_id: &self.artifact_revision_id,
            preview_revision_id: &self.preview_revision_id,
            page_id: &self.page_id,
            before_context_hash: self.before_context_hash.as_deref(),
            after_context_hash: self.after_context_hash.as_deref(),
            semantic_object_id: self.semantic_object_id.as_deref(),
            bbox: self.bbox,
        })?;
        if self
            .selected_text
            .as_deref()
            .is_some_and(|fingerprint| !is_context_digest(fingerprint))
        {
            return Err(ReviewStateError::InvalidAnnotation);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedReviewState {
    annotations: Vec<PersistedReviewAnnotation>,
    accepted_preview_ids: BTreeSet<String>,
}

#[derive(Clone)]
pub struct ReviewStateStore {
    root: Arc<PathBuf>,
    state: Arc<Mutex<PersistedReviewState>>,
    #[cfg(test)]
    temporary: Option<Arc<tempfile::TempDir>>,
}

impl ReviewStateStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, ReviewStateError> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root).map_err(map_io)?;
        let metadata = fs::symlink_metadata(&root).map_err(map_io)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ReviewStateError::UnsafeStateDirectory);
        }
        let state_path = root.join(STATE_FILE);
        let state: PersistedReviewState = match fs::read(&state_path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| ReviewStateError::InvalidStoredState)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                PersistedReviewState::default()
            }
            Err(error) => return Err(map_io(error)),
        };
        if state
            .annotations
            .iter()
            .any(|annotation| annotation.validate().is_err())
            || state
                .accepted_preview_ids
                .iter()
                .any(|preview_revision_id| !is_preview_revision_id(preview_revision_id))
        {
            return Err(ReviewStateError::InvalidStoredState);
        }
        Ok(Self {
            root: Arc::new(root),
            state: Arc::new(Mutex::new(state)),
            #[cfg(test)]
            temporary: None,
        })
    }

    #[cfg(test)]
    pub fn temporary() -> Self {
        let directory = Arc::new(tempfile::tempdir().expect("temporary review state"));
        let mut store = Self::open(directory.path()).expect("open temporary review state");
        store.temporary = Some(directory);
        store
    }

    pub fn capture(
        &self,
        annotation: RawReviewAnnotation,
    ) -> Result<PersistedReviewAnnotation, ReviewStateError> {
        let persisted = annotation.into_persisted()?;
        self.save_persisted(&persisted)?;
        Ok(persisted)
    }

    #[cfg(test)]
    pub fn save_trusted(
        &self,
        annotation: &PersistedReviewAnnotation,
    ) -> Result<(), ReviewStateError> {
        self.save_persisted(annotation)
    }

    fn save_persisted(
        &self,
        annotation: &PersistedReviewAnnotation,
    ) -> Result<(), ReviewStateError> {
        annotation.validate()?;
        let mut locked = self
            .state
            .lock()
            .map_err(|_| ReviewStateError::StatePoisoned)?;
        let mut next = locked.clone();
        if let Some(existing) = next
            .annotations
            .iter_mut()
            .find(|existing| existing.annotation_id == annotation.annotation_id)
        {
            *existing = annotation.clone();
        } else {
            next.annotations.push(annotation.clone());
        }
        write_json_atomic(&self.root, STATE_FILE, &next)?;
        *locked = next;
        Ok(())
    }

    pub fn annotations(
        &self,
        preview_revision_id: &str,
    ) -> Result<Vec<PersistedReviewAnnotation>, ReviewStateError> {
        validate_preview_revision_id(preview_revision_id)?;
        let locked = self
            .state
            .lock()
            .map_err(|_| ReviewStateError::StatePoisoned)?;
        Ok(locked
            .annotations
            .iter()
            .filter(|annotation| annotation.preview_revision_id == preview_revision_id)
            .cloned()
            .collect())
    }

    pub fn accept_preview(
        &self,
        preview_revision_id: &str,
        fidelity: PreviewFidelity,
    ) -> Result<(), ReviewStateError> {
        if fidelity != PreviewFidelity::Authoritative {
            return Err(ReviewStateError::NotAuthoritative);
        }
        validate_preview_revision_id(preview_revision_id)?;
        let mut locked = self
            .state
            .lock()
            .map_err(|_| ReviewStateError::StatePoisoned)?;
        let mut next = locked.clone();
        next.accepted_preview_ids
            .insert(preview_revision_id.to_owned());
        write_json_atomic(&self.root, STATE_FILE, &next)?;
        *locked = next;
        Ok(())
    }

    pub fn is_accepted(&self, preview_revision_id: &str) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.accepted_preview_ids.contains(preview_revision_id))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InteractionName {
    Scroll,
    Zoom,
    Page,
    Selection,
    Annotation,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionMetric {
    pub name: InteractionName,
    pub duration_ms: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewPerformanceSnapshot {
    pub progress_visible_ms: f64,
    pub first_page_ms: f64,
    pub interactions: Vec<InteractionMetric>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation: Option<ReviewAutomationSnapshot>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewAutomationSnapshot {
    pub session_id: String,
    pub fixture: String,
    pub captured_at: String,
    pub representative_machine: bool,
    pub preview_hashes: Vec<ReviewPreviewHash>,
    pub metrics: ReviewAutomationMetrics,
    pub samples: ReviewAutomationSamples,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewPreviewHash {
    pub page_id: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewAutomationMetrics {
    pub progress_visible_ms: f64,
    pub cached_first_page_p95_ms: f64,
    pub authoritative_first_reviewable_page_ms: f64,
    pub interaction_p95_ms: f64,
    pub peak_rss_bytes: f64,
    pub cache_bytes: f64,
    pub reanchor_resolved: f64,
    pub reanchor_unresolved: f64,
    pub reanchor_silent_misplaced: f64,
    pub visual_diff_ratio: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewAutomationSamples {
    pub progress: u64,
    pub cached_first_page: u64,
    pub authoritative_first_page: u64,
    pub interactions: u64,
}

impl ReviewAutomationSnapshot {
    pub fn validate(&self) -> Result<(), ReviewStateError> {
        let values = [
            self.metrics.progress_visible_ms,
            self.metrics.cached_first_page_p95_ms,
            self.metrics.authoritative_first_reviewable_page_ms,
            self.metrics.interaction_p95_ms,
            self.metrics.peak_rss_bytes,
            self.metrics.cache_bytes,
            self.metrics.reanchor_resolved,
            self.metrics.reanchor_unresolved,
            self.metrics.reanchor_silent_misplaced,
            self.metrics.visual_diff_ratio,
        ];
        if self.fixture != "G3-REVIEW-001"
            || !is_lower_hex(&self.session_id, 32)
            || self.captured_at.len() < 20
            || self.captured_at.len() > 40
            || !self.captured_at.ends_with('Z')
            || values.into_iter().any(|value| !valid_metric(value))
            || self.samples.progress == 0
            || self.samples.cached_first_page == 0
            || self.samples.authoritative_first_page == 0
            || self.samples.interactions == 0
            || self.preview_hashes.is_empty()
            || self.preview_hashes.iter().any(|record| {
                record.page_id.is_empty()
                    || record.page_id.len() > 128
                    || !is_lower_hex(&record.sha256, 64)
            })
            || self
                .preview_hashes
                .iter()
                .map(|record| &record.page_id)
                .collect::<BTreeSet<_>>()
                .len()
                != self.preview_hashes.len()
        {
            Err(ReviewStateError::InvalidMetrics)
        } else {
            Ok(())
        }
    }
}

impl ReviewPerformanceSnapshot {
    pub fn validate(&self) -> Result<(), ReviewStateError> {
        if !valid_metric(self.progress_visible_ms)
            || !valid_metric(self.first_page_ms)
            || self.interactions.len() > 100_000
            || self
                .interactions
                .iter()
                .any(|interaction| !valid_metric(interaction.duration_ms))
            || self
                .automation
                .as_ref()
                .is_some_and(|automation| automation.validate().is_err())
        {
            Err(ReviewStateError::InvalidMetrics)
        } else {
            Ok(())
        }
    }

    pub fn write_atomic(&self, evidence_dir: &Path) -> Result<(), ReviewStateError> {
        self.validate()?;
        fs::create_dir_all(evidence_dir).map_err(map_io)?;
        let metadata = fs::symlink_metadata(evidence_dir).map_err(map_io)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ReviewStateError::UnsafeStateDirectory);
        }
        write_json_atomic(evidence_dir, METRICS_FILE, self)
    }
}

fn valid_metric(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

struct AnnotationFields<'a> {
    annotation_id: &'a str,
    artifact_revision_id: &'a str,
    preview_revision_id: &'a str,
    page_id: &'a str,
    before_context_hash: Option<&'a str>,
    after_context_hash: Option<&'a str>,
    semantic_object_id: Option<&'a str>,
    bbox: Option<[f64; 4]>,
}

fn validate_annotation_fields(fields: AnnotationFields<'_>) -> Result<(), ReviewStateError> {
    if !is_uuid_prefixed(fields.annotation_id, "annotation-")
        || !is_artifact_revision_id(fields.artifact_revision_id)
        || !is_preview_revision_id(fields.preview_revision_id)
        || !is_page_id(fields.page_id)
        || fields
            .before_context_hash
            .is_some_and(|value| !is_context_digest(value))
        || fields
            .after_context_hash
            .is_some_and(|value| !is_context_digest(value))
        || fields
            .semantic_object_id
            .is_some_and(|value| !is_uuid_prefixed(value, "semantic-"))
    {
        return Err(ReviewStateError::InvalidAnnotation);
    }
    if let Some([x, y, width, height]) = fields.bbox {
        if ![x, y, width, height].into_iter().all(f64::is_finite)
            || x < 0.0
            || y < 0.0
            || width <= 0.0
            || height <= 0.0
            || x + width > 1.0
            || y + height > 1.0
        {
            return Err(ReviewStateError::InvalidAnnotation);
        }
    }
    Ok(())
}

fn selected_text_fingerprint(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SELECTED_TEXT_DOMAIN);
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_artifact_revision_id(value: &str) -> bool {
    value
        .strip_prefix("artifact-sha256:")
        .is_some_and(is_lower_sha256)
}

fn is_preview_revision_id(value: &str) -> bool {
    value
        .strip_prefix("preview-sha256:")
        .is_some_and(is_lower_sha256)
}

pub fn validate_artifact_revision_id(value: &str) -> Result<(), ReviewStateError> {
    if is_artifact_revision_id(value) {
        Ok(())
    } else {
        Err(ReviewStateError::InvalidAnnotation)
    }
}

pub fn validate_preview_revision_id(value: &str) -> Result<(), ReviewStateError> {
    if is_preview_revision_id(value) {
        Ok(())
    } else {
        Err(ReviewStateError::InvalidAnnotation)
    }
}

fn is_context_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(is_lower_sha256)
}

fn is_page_id(value: &str) -> bool {
    let Some(number) = value.strip_prefix("page-") else {
        return false;
    };
    !number.is_empty()
        && number.len() <= 6
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_uuid_prefixed(value: &str, prefix: &str) -> bool {
    let Some(raw_uuid) = value.strip_prefix(prefix) else {
        return false;
    };
    if value.len() > MAX_ID_BYTES {
        return false;
    }
    let Ok(uuid) = Uuid::parse_str(raw_uuid) else {
        return false;
    };
    uuid.get_version() == Some(uuid::Version::Random)
        && uuid.get_variant() == uuid::Variant::RFC4122
        && uuid.hyphenated().to_string() == raw_uuid
}

fn write_json_atomic<T: Serialize>(
    directory: &Path,
    name: &str,
    value: &T,
) -> Result<(), ReviewStateError> {
    let temporary_name = format!(".{name}.{}.tmp", Uuid::new_v4().simple());
    let temporary_path = directory.join(temporary_name);
    let final_path = directory.join(name);
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(map_io)?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, value).map_err(|_| ReviewStateError::SerializationFailed)?;
    writer.write_all(b"\n").map_err(map_io)?;
    writer.flush().map_err(map_io)?;
    writer.get_ref().sync_all().map_err(map_io)?;
    drop(writer);
    if let Err(error) = fs::rename(&temporary_path, &final_path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(map_io(error));
    }
    sync_directory(directory)
}

fn sync_directory(path: &Path) -> Result<(), ReviewStateError> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(map_io)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn map_io(_error: std::io::Error) -> ReviewStateError {
    ReviewStateError::Io
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewStateError {
    NotAuthoritative,
    InvalidAnnotation,
    InvalidMetrics,
    InvalidStoredState,
    UnsafeStateDirectory,
    SerializationFailed,
    StatePoisoned,
    Io,
}

impl ReviewStateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotAuthoritative => "SW_REVIEW_PREVIEW_NOT_AUTHORITATIVE",
            Self::InvalidAnnotation => "SW_REVIEW_ANNOTATION_INVALID",
            Self::InvalidMetrics => "SW_REVIEW_METRICS_INVALID",
            Self::InvalidStoredState => "SW_REVIEW_STATE_INVALID",
            Self::UnsafeStateDirectory => "SW_REVIEW_STATE_DIRECTORY_UNSAFE",
            Self::SerializationFailed => "SW_REVIEW_STATE_SERIALIZATION_FAILED",
            Self::StatePoisoned => "SW_REVIEW_HOST_STATE_UNAVAILABLE",
            Self::Io => "SW_REVIEW_HOST_IO_FAILED",
        }
    }
}

impl std::fmt::Display for ReviewStateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for ReviewStateError {}
