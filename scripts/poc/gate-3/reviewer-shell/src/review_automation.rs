use crate::artifact_store::{ArtifactKind, ArtifactOpened, ArtifactStore, StoreError};
use crate::automation_replay::AutomationHandshakeSnapshot;
use crate::review_state::ReviewPerformanceSnapshot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const METRICS_FILE: &str = "review-automation-metrics.json";
const COMPLETE_FILE: &str = "automation-complete.json";
const FAILURE_FILE: &str = "automation-failure.json";
const HANDSHAKE_FILE: &str = "automation-handshake.json";
const ARTIFACT_RECEIPT_FILE: &str = "automation-artifact-receipt.json";

#[derive(Clone, Debug)]
pub struct ReviewAutomationConfig {
    pub session_id: String,
    pub manifest_sha256: String,
    pub evidence_dir: PathBuf,
    pub representative_machine: bool,
    pub renderer_environment_sha256: String,
    entries: Vec<AuditedFixture>,
    handshake: Arc<Mutex<AutomationHandshakeSnapshot>>,
    artifact_receipts: Arc<Mutex<AutomationArtifactReceiptSnapshot>>,
}

#[derive(Clone, Copy, Debug, Default)]
struct AutomationArtifactReceiptSnapshot {
    received: [bool; 3],
    buffer_complete: bool,
}

#[derive(Clone, Debug)]
struct AuditedFixture {
    path: PathBuf,
    display_name: String,
    format: String,
}

#[derive(Debug)]
pub enum AutomationError {
    Configuration,
    Manifest,
    Io,
    Artifact(StoreError),
    Metrics,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationArtifactOpened {
    #[serde(flatten)]
    pub opened: ArtifactOpened,
    pub automation_session_id: String,
    pub automation_index: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureManifest {
    fixture: String,
    provenance: String,
    redistributable: bool,
    files: Vec<FixtureEntry>,
    build_sources: Vec<BuildSource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureEntry {
    path: String,
    format: String,
    #[serde(default)]
    expected_pages: Option<u32>,
    #[serde(default)]
    expected_outcome: Option<String>,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildSource {
    path: String,
    role: String,
    #[serde(default)]
    executable: bool,
    sha256: String,
}

#[derive(Serialize)]
struct MetricsDocument<'a> {
    metrics: &'a crate::review_state::ReviewAutomationMetrics,
    provenance: MetricsProvenance<'a>,
}

#[derive(Serialize)]
struct MetricsProvenance<'a> {
    fixture: &'a str,
    session_id: &'a str,
    manifest_sha256: &'a str,
    captured_at: &'a str,
    representative_machine: bool,
    renderer_environment_sha256: &'a str,
    host_measurements: HostMeasurements,
    correctness_counters: CorrectnessCounters,
    samples: &'a crate::review_state::ReviewAutomationSamples,
}

#[derive(Serialize)]
struct HostMeasurements {
    source: &'static str,
    peak_rss_bytes: u64,
    cache_bytes: u64,
}

#[derive(Serialize)]
struct CorrectnessCounters {
    acceptance: bool,
    basis: &'static str,
}

#[derive(Serialize)]
struct AutomationComplete<'a> {
    session_id: &'a str,
    fixture: &'a str,
    manifest_sha256: &'a str,
    metrics_file: &'static str,
    completed_at: &'a str,
    preview_hashes: &'a [crate::review_state::ReviewPreviewHash],
}

#[derive(Serialize)]
struct AutomationHandshakeDocument<'a> {
    schema_id: &'static str,
    schema_version: u8,
    session_id: &'a str,
    fixture: &'static str,
    manifest_sha256: &'a str,
    renderer_environment_sha256: &'a str,
    updated_at: u64,
    setup_armed: bool,
    page_load: AutomationHandshakePageLoad,
    client_ready: AutomationHandshakeClientReady,
    released: bool,
    first_artifact_emitted: bool,
}

#[derive(Serialize)]
struct AutomationHandshakePageLoad {
    trusted_main_finished: bool,
    rejected_lifecycle: bool,
    rejected_label: bool,
    rejected_page: bool,
}

#[derive(Serialize)]
struct AutomationHandshakeClientReady {
    received: bool,
    accepted: bool,
    rejected: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationArtifactReceiptReport {
    schema_version: u8,
    session_id: String,
    automation_index: usize,
    buffer_complete: bool,
}

#[derive(Serialize)]
struct AutomationArtifactReceiptDocument<'a> {
    schema_id: &'static str,
    schema_version: u8,
    session_id: &'a str,
    fixture: &'static str,
    manifest_sha256: &'a str,
    renderer_environment_sha256: &'a str,
    updated_at: u64,
    received: [bool; 3],
    buffer_complete: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum AutomationFailureKind {
    DependencyMissing,
    StagingFailed,
    SourceFailed,
    WorkerFailed,
    PublicationFailed,
    CacheImmutableConflict,
    PreviewRevisionInvalid,
    ClientBootstrap,
    ClientProgress,
    ClientPdfAuthoritative,
    ClientPdfAssetUrl,
    ClientPdfAssetFetch,
    ClientPdfDocumentLoad,
    ClientPdfManifestBuild,
    ClientPdfManifestPages,
    ClientPdfManifestSource,
    ClientPdfManifestHashes,
    ClientPdfManifestRevision,
    ClientPdfManifestRevisionId,
    ClientPdfManifestSession,
    ClientPdfPresent,
    ClientPdfCachedPage,
    ClientPdfActions,
    ClientDocxFast,
    ClientDocxAuthoritative,
    ClientPptxAuthoritative,
    ClientPersistence,
    ClientMetrics,
}

impl AutomationFailureKind {
    pub fn fields(self) -> (&'static str, &'static str) {
        match self {
            Self::DependencyMissing => {
                ("dependency_missing", "SW_REVIEW_RENDER_DEPENDENCY_MISSING")
            }
            Self::StagingFailed => ("failed_recoverable", "SW_REVIEW_RENDER_STAGING_FAILED"),
            Self::SourceFailed => ("failed_recoverable", "SW_REVIEW_RENDER_SOURCE_FAILED"),
            Self::WorkerFailed => ("failed_recoverable", "SW_REVIEW_RENDER_WORKER_FAILED"),
            Self::PublicationFailed => {
                ("failed_recoverable", "SW_REVIEW_RENDER_PUBLICATION_FAILED")
            }
            Self::CacheImmutableConflict => {
                ("failed_terminal", "SW_REVIEW_CACHE_IMMUTABLE_CONFLICT")
            }
            Self::PreviewRevisionInvalid => {
                ("failed_terminal", "SW_REVIEW_PREVIEW_REVISION_ID_INVALID")
            }
            Self::ClientBootstrap => ("failed_terminal", "SW_REVIEW_AUTOMATION_BOOTSTRAP_FAILED"),
            Self::ClientProgress => ("failed_terminal", "SW_REVIEW_AUTOMATION_PROGRESS_FAILED"),
            Self::ClientPdfAuthoritative => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_AUTHORITATIVE_FAILED",
            ),
            Self::ClientPdfAssetUrl => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_ASSET_URL_FAILED",
            ),
            Self::ClientPdfAssetFetch => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_ASSET_FETCH_FAILED",
            ),
            Self::ClientPdfDocumentLoad => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_DOCUMENT_LOAD_FAILED",
            ),
            Self::ClientPdfManifestBuild => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_BUILD_FAILED",
            ),
            Self::ClientPdfManifestPages => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_PAGES_FAILED",
            ),
            Self::ClientPdfManifestSource => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_SOURCE_FAILED",
            ),
            Self::ClientPdfManifestHashes => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_HASHES_FAILED",
            ),
            Self::ClientPdfManifestRevision => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_REVISION_FAILED",
            ),
            Self::ClientPdfManifestRevisionId => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_REVISION_ID_FAILED",
            ),
            Self::ClientPdfManifestSession => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_MANIFEST_SESSION_FAILED",
            ),
            Self::ClientPdfPresent => {
                ("failed_terminal", "SW_REVIEW_AUTOMATION_PDF_PRESENT_FAILED")
            }
            Self::ClientPdfCachedPage => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PDF_CACHED_PAGE_FAILED",
            ),
            Self::ClientPdfActions => {
                ("failed_terminal", "SW_REVIEW_AUTOMATION_PDF_ACTIONS_FAILED")
            }
            Self::ClientDocxFast => ("failed_terminal", "SW_REVIEW_AUTOMATION_DOCX_FAST_FAILED"),
            Self::ClientDocxAuthoritative => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_DOCX_AUTHORITATIVE_FAILED",
            ),
            Self::ClientPptxAuthoritative => (
                "failed_terminal",
                "SW_REVIEW_AUTOMATION_PPTX_AUTHORITATIVE_FAILED",
            ),
            Self::ClientPersistence => {
                ("failed_terminal", "SW_REVIEW_AUTOMATION_PERSISTENCE_FAILED")
            }
            Self::ClientMetrics => ("failed_terminal", "SW_REVIEW_AUTOMATION_METRICS_FAILED"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AutomationClientFailureStage {
    Bootstrap,
    Progress,
    PdfAuthoritative,
    PdfAssetUrl,
    PdfAssetFetch,
    PdfDocumentLoad,
    PdfManifestBuild,
    PdfManifestPages,
    PdfManifestSource,
    PdfManifestHashes,
    PdfManifestRevision,
    PdfManifestRevisionId,
    PdfManifestSession,
    PdfPresent,
    PdfCachedPage,
    PdfActions,
    DocxFast,
    DocxAuthoritative,
    PptxAuthoritative,
    Persistence,
    Metrics,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationClientFailureReport {
    session_id: String,
    stage: AutomationClientFailureStage,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum AutomationClientReadyState {
    ListenerInstalled,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationClientReadyReport {
    schema_version: u8,
    state: AutomationClientReadyState,
}

#[derive(Serialize)]
struct AutomationFailure<'a> {
    schema_id: &'static str,
    schema_version: u8,
    session_id: &'a str,
    fixture: &'static str,
    manifest_sha256: &'a str,
    renderer_environment_sha256: &'a str,
    failed_at: u64,
    state: &'static str,
    error_code: &'static str,
}

impl ReviewAutomationConfig {
    pub fn from_environment() -> Result<Option<Self>, AutomationError> {
        match std::env::var("SUPERWAGIE_REVIEW_AUTOMATION") {
            Err(std::env::VarError::NotPresent) => return Ok(None),
            Ok(value) if value == "1" => {}
            _ => return Err(AutomationError::Configuration),
        }
        let manifest = PathBuf::from(
            std::env::var_os("SUPERWAGIE_REVIEW_FIXTURE_MANIFEST")
                .ok_or(AutomationError::Configuration)?,
        );
        let expected_hash = std::env::var("SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256")
            .map_err(|_| AutomationError::Configuration)?;
        let session_id = std::env::var("SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID")
            .map_err(|_| AutomationError::Configuration)?;
        let evidence_dir = PathBuf::from(
            std::env::var_os("SUPERWAGIE_REVIEW_EVIDENCE_DIR")
                .ok_or(AutomationError::Configuration)?,
        );
        let mut config = Self::load(manifest, expected_hash, session_id, evidence_dir)?;
        config.representative_machine =
            match std::env::var("SUPERWAGIE_REVIEW_MACHINE_REPRESENTATIVE") {
                Ok(value) if value == "1" => true,
                Ok(value) if value == "0" => false,
                _ => return Err(AutomationError::Configuration),
            };
        config.renderer_environment_sha256 = std::env::var("SUPERWAGIE_REVIEW_PROVENANCE_SHA256")
            .map_err(|_| AutomationError::Configuration)?;
        if !is_lower_hex(&config.renderer_environment_sha256, 64) {
            return Err(AutomationError::Configuration);
        }
        Ok(Some(config))
    }

    pub fn load(
        fixture_manifest: PathBuf,
        expected_hash: String,
        session_id: String,
        evidence_dir: PathBuf,
    ) -> Result<Self, AutomationError> {
        if !fixture_manifest.is_absolute()
            || !evidence_dir.is_absolute()
            || !is_lower_hex(&expected_hash, 64)
            || !is_lower_hex(&session_id, 32)
        {
            return Err(AutomationError::Configuration);
        }
        let metadata = fs::symlink_metadata(&fixture_manifest).map_err(|_| AutomationError::Io)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AutomationError::Manifest);
        }
        let bytes = fs::read(&fixture_manifest).map_err(|_| AutomationError::Io)?;
        if lower_sha256(&bytes) != expected_hash {
            return Err(AutomationError::Manifest);
        }
        let manifest: FixtureManifest =
            serde_json::from_slice(&bytes).map_err(|_| AutomationError::Manifest)?;
        if manifest.fixture != "G3-REVIEW-001"
            || !manifest.redistributable
            || manifest.provenance.is_empty()
            || manifest.files.len() != 5
            || manifest.build_sources.len() != 8
        {
            return Err(AutomationError::Manifest);
        }
        let root = fixture_manifest.parent().ok_or(AutomationError::Manifest)?;
        let mut entries = Vec::new();
        for entry in manifest.files {
            let relative = safe_relative(&entry.path)?;
            let candidate = root.join(&relative);
            verify_file(&candidate, &entry.sha256)?;
            match entry.format.as_str() {
                "pdf" | "docx" | "pptx" => {
                    if entry.expected_pages.is_none() || entry.expected_outcome.is_some() {
                        return Err(AutomationError::Manifest);
                    }
                    entries.push(AuditedFixture {
                        display_name: candidate
                            .file_name()
                            .and_then(|value| value.to_str())
                            .ok_or(AutomationError::Manifest)?
                            .to_owned(),
                        path: candidate,
                        format: entry.format,
                    });
                }
                "pdf-corrupt" | "oversize" => {
                    if entry.expected_outcome.is_none() || entry.expected_pages.is_some() {
                        return Err(AutomationError::Manifest);
                    }
                }
                _ => return Err(AutomationError::Manifest),
            }
        }
        for source in manifest.build_sources {
            let relative = safe_relative(&source.path)?;
            verify_file(&root.join(relative), &source.sha256)?;
            if source.role.is_empty() {
                return Err(AutomationError::Manifest);
            }
            let _ = source.executable;
        }
        let expected = ["pdf", "docx", "pptx"];
        if entries.len() != expected.len()
            || expected.iter().any(|format| {
                entries
                    .iter()
                    .filter(|entry| entry.format == *format)
                    .count()
                    != 1
            })
        {
            return Err(AutomationError::Manifest);
        }
        fs::create_dir_all(&evidence_dir).map_err(|_| AutomationError::Io)?;
        let evidence_metadata =
            fs::symlink_metadata(&evidence_dir).map_err(|_| AutomationError::Io)?;
        if evidence_metadata.file_type().is_symlink() || !evidence_metadata.is_dir() {
            return Err(AutomationError::Configuration);
        }
        Ok(Self {
            session_id,
            manifest_sha256: expected_hash,
            evidence_dir,
            representative_machine: false,
            renderer_environment_sha256: lower_sha256(&bytes),
            entries,
            handshake: Arc::new(Mutex::new(AutomationHandshakeSnapshot::default())),
            artifact_receipts: Arc::new(Mutex::new(AutomationArtifactReceiptSnapshot::default())),
        })
    }

    pub fn authorize(
        &self,
        store: &ArtifactStore,
    ) -> Result<Vec<AutomationArtifactOpened>, AutomationError> {
        self.entries
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let opened = store
                    .authorize_path(&entry.path, ArtifactKind::Artifact)
                    .map_err(AutomationError::Artifact)?;
                if opened.display_name != entry.display_name {
                    return Err(AutomationError::Manifest);
                }
                Ok(AutomationArtifactOpened {
                    opened,
                    automation_session_id: self.session_id.clone(),
                    automation_index: index,
                })
            })
            .collect()
    }

    pub fn write_trusted_completion(
        &self,
        snapshot: &ReviewPerformanceSnapshot,
        peak_rss_bytes: u64,
        cache_bytes: u64,
    ) -> Result<bool, AutomationError> {
        snapshot.validate().map_err(|_| AutomationError::Metrics)?;
        let Some(browser_automation) = snapshot.automation.as_ref() else {
            return Ok(false);
        };
        browser_automation
            .validate()
            .map_err(|_| AutomationError::Metrics)?;
        let mut automation = browser_automation.clone();
        automation.representative_machine = self.representative_machine;
        automation.metrics.peak_rss_bytes = peak_rss_bytes as f64;
        automation.metrics.cache_bytes = cache_bytes as f64;
        if automation.session_id != self.session_id || automation.fixture != "G3-REVIEW-001" {
            return Err(AutomationError::Metrics);
        }
        let metrics = MetricsDocument {
            metrics: &automation.metrics,
            provenance: MetricsProvenance {
                fixture: &automation.fixture,
                session_id: &automation.session_id,
                manifest_sha256: &self.manifest_sha256,
                captured_at: &automation.captured_at,
                representative_machine: automation.representative_machine,
                renderer_environment_sha256: &self.renderer_environment_sha256,
                host_measurements: HostMeasurements {
                    source: "trusted-native-host",
                    peak_rss_bytes,
                    cache_bytes,
                },
                correctness_counters: CorrectnessCounters {
                    acceptance: false,
                    basis: "task-9-required",
                },
                samples: &automation.samples,
            },
        };
        write_json_atomic(&self.evidence_dir, METRICS_FILE, &metrics)?;
        let complete = AutomationComplete {
            session_id: &automation.session_id,
            fixture: &automation.fixture,
            manifest_sha256: &self.manifest_sha256,
            metrics_file: METRICS_FILE,
            completed_at: &automation.captured_at,
            preview_hashes: &automation.preview_hashes,
        };
        write_json_atomic(&self.evidence_dir, COMPLETE_FILE, &complete)?;
        Ok(true)
    }

    pub fn write_trusted_failure(
        &self,
        kind: AutomationFailureKind,
    ) -> Result<(), AutomationError> {
        let failed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AutomationError::Io)?
            .as_millis();
        let failed_at = u64::try_from(failed_at).map_err(|_| AutomationError::Io)?;
        let (state, error_code) = kind.fields();
        let failure = AutomationFailure {
            schema_id: "superwagie.review-automation-failure.v1",
            schema_version: 1,
            session_id: &self.session_id,
            fixture: "G3-REVIEW-001",
            manifest_sha256: &self.manifest_sha256,
            renderer_environment_sha256: &self.renderer_environment_sha256,
            failed_at,
            state,
            error_code,
        };
        write_json_atomic(&self.evidence_dir, FAILURE_FILE, &failure)
    }

    pub fn client_failure_kind(&self, payload: &str) -> Option<AutomationFailureKind> {
        let report: AutomationClientFailureReport = serde_json::from_str(payload).ok()?;
        if report.session_id != self.session_id {
            return None;
        }
        Some(match report.stage {
            AutomationClientFailureStage::Bootstrap => AutomationFailureKind::ClientBootstrap,
            AutomationClientFailureStage::Progress => AutomationFailureKind::ClientProgress,
            AutomationClientFailureStage::PdfAuthoritative => {
                AutomationFailureKind::ClientPdfAuthoritative
            }
            AutomationClientFailureStage::PdfAssetUrl => AutomationFailureKind::ClientPdfAssetUrl,
            AutomationClientFailureStage::PdfAssetFetch => {
                AutomationFailureKind::ClientPdfAssetFetch
            }
            AutomationClientFailureStage::PdfDocumentLoad => {
                AutomationFailureKind::ClientPdfDocumentLoad
            }
            AutomationClientFailureStage::PdfManifestBuild => {
                AutomationFailureKind::ClientPdfManifestBuild
            }
            AutomationClientFailureStage::PdfManifestPages => {
                AutomationFailureKind::ClientPdfManifestPages
            }
            AutomationClientFailureStage::PdfManifestSource => {
                AutomationFailureKind::ClientPdfManifestSource
            }
            AutomationClientFailureStage::PdfManifestHashes => {
                AutomationFailureKind::ClientPdfManifestHashes
            }
            AutomationClientFailureStage::PdfManifestRevision => {
                AutomationFailureKind::ClientPdfManifestRevision
            }
            AutomationClientFailureStage::PdfManifestRevisionId => {
                AutomationFailureKind::ClientPdfManifestRevisionId
            }
            AutomationClientFailureStage::PdfManifestSession => {
                AutomationFailureKind::ClientPdfManifestSession
            }
            AutomationClientFailureStage::PdfPresent => AutomationFailureKind::ClientPdfPresent,
            AutomationClientFailureStage::PdfCachedPage => {
                AutomationFailureKind::ClientPdfCachedPage
            }
            AutomationClientFailureStage::PdfActions => AutomationFailureKind::ClientPdfActions,
            AutomationClientFailureStage::DocxFast => AutomationFailureKind::ClientDocxFast,
            AutomationClientFailureStage::DocxAuthoritative => {
                AutomationFailureKind::ClientDocxAuthoritative
            }
            AutomationClientFailureStage::PptxAuthoritative => {
                AutomationFailureKind::ClientPptxAuthoritative
            }
            AutomationClientFailureStage::Persistence => AutomationFailureKind::ClientPersistence,
            AutomationClientFailureStage::Metrics => AutomationFailureKind::ClientMetrics,
        })
    }

    pub fn accepts_client_ready(&self, payload: &str) -> bool {
        matches!(
            serde_json::from_str::<AutomationClientReadyReport>(payload),
            Ok(AutomationClientReadyReport {
                schema_version: 1,
                state: AutomationClientReadyState::ListenerInstalled,
            })
        )
    }

    pub fn record_artifact_receipt(&self, payload: &str) -> Result<bool, AutomationError> {
        let report: AutomationArtifactReceiptReport = match serde_json::from_str(payload) {
            Ok(report) => report,
            Err(_) => return Ok(false),
        };
        if report.schema_version != 1
            || report.session_id != self.session_id
            || report.automation_index > 2
        {
            return Ok(false);
        }
        let mut accumulated = self
            .artifact_receipts
            .lock()
            .map_err(|_| AutomationError::Io)?;
        let mut candidate = *accumulated;
        candidate.received[report.automation_index] = true;
        candidate.buffer_complete = candidate.received.iter().all(|received| *received);
        if report.buffer_complete != candidate.buffer_complete {
            return Ok(false);
        }
        let updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AutomationError::Io)?
            .as_millis();
        let updated_at = u64::try_from(updated_at).map_err(|_| AutomationError::Io)?;
        let document = AutomationArtifactReceiptDocument {
            schema_id: "superwagie.review-automation-artifact-receipt.v1",
            schema_version: 1,
            session_id: &self.session_id,
            fixture: "G3-REVIEW-001",
            manifest_sha256: &self.manifest_sha256,
            renderer_environment_sha256: &self.renderer_environment_sha256,
            updated_at,
            received: candidate.received,
            buffer_complete: candidate.buffer_complete,
        };
        write_json_atomic(&self.evidence_dir, ARTIFACT_RECEIPT_FILE, &document)?;
        *accumulated = candidate;
        Ok(true)
    }

    pub fn write_handshake_diagnostics(
        &self,
        snapshot: AutomationHandshakeSnapshot,
    ) -> Result<(), AutomationError> {
        let mut accumulated = self.handshake.lock().map_err(|_| AutomationError::Io)?;
        accumulated.merge(snapshot);
        let updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AutomationError::Io)?
            .as_millis();
        let updated_at = u64::try_from(updated_at).map_err(|_| AutomationError::Io)?;
        let document = AutomationHandshakeDocument {
            schema_id: "superwagie.review-automation-handshake.v1",
            schema_version: 1,
            session_id: &self.session_id,
            fixture: "G3-REVIEW-001",
            manifest_sha256: &self.manifest_sha256,
            renderer_environment_sha256: &self.renderer_environment_sha256,
            updated_at,
            setup_armed: accumulated.setup_armed,
            page_load: AutomationHandshakePageLoad {
                trusted_main_finished: accumulated.trusted_main_finished,
                rejected_lifecycle: accumulated.rejected_lifecycle,
                rejected_label: accumulated.rejected_label,
                rejected_page: accumulated.rejected_page,
            },
            client_ready: AutomationHandshakeClientReady {
                received: accumulated.client_ready_received,
                accepted: accumulated.client_ready_accepted,
                rejected: accumulated.client_ready_rejected,
            },
            released: accumulated.released,
            first_artifact_emitted: accumulated.first_artifact_emitted,
        };
        write_json_atomic(&self.evidence_dir, HANDSHAKE_FILE, &document)
    }
}

fn safe_relative(value: &str) -> Result<PathBuf, AutomationError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || value.contains('\\')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AutomationError::Manifest);
    }
    Ok(path.to_path_buf())
}

fn verify_file(path: &Path, expected_hash: &str) -> Result<(), AutomationError> {
    if !is_lower_hex(expected_hash, 64) {
        return Err(AutomationError::Manifest);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| AutomationError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AutomationError::Manifest);
    }
    let bytes = fs::read(path).map_err(|_| AutomationError::Io)?;
    if lower_sha256(&bytes) != expected_hash {
        return Err(AutomationError::Manifest);
    }
    Ok(())
}

fn lower_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AtomicWriteStage {
    Open,
    Write,
    Flush,
    FileSync,
    PrecommitDirectorySync,
    Rename,
}

fn write_json_atomic<T: Serialize>(
    directory: &Path,
    name: &str,
    value: &T,
) -> Result<(), AutomationError> {
    write_json_atomic_with_hook(directory, name, value, |_| Ok(()))
}

fn write_json_atomic_with_hook<T: Serialize, F>(
    directory: &Path,
    name: &str,
    value: &T,
    mut stage_hook: F,
) -> Result<(), AutomationError>
where
    F: FnMut(AtomicWriteStage) -> Result<(), AutomationError>,
{
    let temporary = directory.join(format!(".{name}.{}.tmp", Uuid::new_v4().simple()));
    let final_path = directory.join(name);
    let result = (|| {
        stage_hook(AtomicWriteStage::Open)?;
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| AutomationError::Io)?;
        let mut writer = BufWriter::new(file);
        stage_hook(AtomicWriteStage::Write)?;
        serde_json::to_writer(&mut writer, value).map_err(|_| AutomationError::Io)?;
        writer.write_all(b"\n").map_err(|_| AutomationError::Io)?;
        stage_hook(AtomicWriteStage::Flush)?;
        writer.flush().map_err(|_| AutomationError::Io)?;
        stage_hook(AtomicWriteStage::FileSync)?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|_| AutomationError::Io)?;
        drop(writer);
        stage_hook(AtomicWriteStage::PrecommitDirectorySync)?;
        #[cfg(unix)]
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| AutomationError::Io)?;
        stage_hook(AtomicWriteStage::Rename)?;
        fs::rename(&temporary, &final_path).map_err(|_| AutomationError::Io)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

impl std::fmt::Display for AutomationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            Self::Configuration => "SW_REVIEW_AUTOMATION_CONFIGURATION_INVALID",
            Self::Manifest => "SW_REVIEW_AUTOMATION_MANIFEST_INVALID",
            Self::Io => "SW_REVIEW_AUTOMATION_IO_FAILED",
            Self::Artifact(error) => error.code(),
            Self::Metrics => "SW_REVIEW_AUTOMATION_METRICS_INVALID",
        };
        formatter.write_str(code)
    }
}

impl std::error::Error for AutomationError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_state::{
        ReviewAutomationMetrics, ReviewAutomationSamples, ReviewAutomationSnapshot,
    };

    #[test]
    fn checked_in_manifest_is_hash_bound_and_yields_three_audited_primary_files() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json")
            .canonicalize()
            .unwrap();
        let hash = lower_sha256(&fs::read(&manifest).unwrap());
        let evidence = tempfile::tempdir().unwrap();
        let config = ReviewAutomationConfig::load(
            manifest,
            hash,
            "ab".repeat(16),
            evidence.path().to_path_buf(),
        )
        .unwrap();
        assert_eq!(config.entries.len(), 3);
        assert_eq!(
            config
                .entries
                .iter()
                .map(|entry| entry.format.as_str())
                .collect::<Vec<_>>(),
            vec!["docx", "pptx", "pdf"]
        );
        let event = config
            .authorize(&ArtifactStore::default())
            .unwrap()
            .remove(0);
        let payload = serde_json::to_value(event).unwrap();
        assert!(payload.get("displayName").is_some());
        assert!(payload.get("mediaType").is_some());
        assert!(payload.get("revisionHash").is_some());
        assert!(payload.get("automationSessionId").is_some());
        assert!(payload.get("automationIndex").is_some());
        for forbidden in [
            "display_name",
            "media_type",
            "revision_hash",
            "automation_session_id",
            "automation_index",
        ] {
            assert!(payload.get(forbidden).is_none());
        }
    }

    #[test]
    fn manifest_hash_mismatch_and_relative_native_path_fail_before_fixture_access() {
        let evidence = tempfile::tempdir().unwrap();
        assert!(matches!(
            ReviewAutomationConfig::load(
                PathBuf::from("relative-manifest.json"),
                "00".repeat(32),
                "ab".repeat(16),
                evidence.path().to_path_buf(),
            ),
            Err(AutomationError::Configuration)
        ));
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json")
            .canonicalize()
            .unwrap();
        assert!(matches!(
            ReviewAutomationConfig::load(
                manifest,
                "00".repeat(32),
                "ab".repeat(16),
                evidence.path().to_path_buf(),
            ),
            Err(AutomationError::Manifest)
        ));
    }

    #[test]
    fn client_artifact_receipt_is_exact_session_bound_and_accumulates_three_indexes() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json")
            .canonicalize()
            .unwrap();
        let hash = lower_sha256(&fs::read(&manifest).unwrap());
        let evidence = tempfile::tempdir().unwrap();
        let config = ReviewAutomationConfig::load(
            manifest,
            hash,
            "ab".repeat(16),
            evidence.path().to_path_buf(),
        )
        .unwrap();

        for payload in [
            "not-json",
            r#"{"schemaVersion":2,"sessionId":"abababababababababababababababab","automationIndex":0,"bufferComplete":false}"#,
            r#"{"schemaVersion":1,"sessionId":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","automationIndex":0,"bufferComplete":false}"#,
            r#"{"schemaVersion":1,"sessionId":"abababababababababababababababab","automationIndex":3,"bufferComplete":false}"#,
            r#"{"schemaVersion":1,"sessionId":"abababababababababababababababab","automationIndex":0,"bufferComplete":false,"path":"/tmp/leak"}"#,
        ] {
            assert!(!config.record_artifact_receipt(payload).unwrap());
        }
        assert!(!evidence.path().join(ARTIFACT_RECEIPT_FILE).exists());

        for (index, complete) in [(0, false), (1, false), (2, true)] {
            let payload = serde_json::json!({
                "schemaVersion": 1,
                "sessionId": "ab".repeat(16),
                "automationIndex": index,
                "bufferComplete": complete,
            });
            assert!(config
                .record_artifact_receipt(&serde_json::to_string(&payload).unwrap())
                .unwrap());
        }
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(evidence.path().join(ARTIFACT_RECEIPT_FILE)).unwrap())
                .unwrap();
        assert_eq!(
            document["schema_id"],
            "superwagie.review-automation-artifact-receipt.v1"
        );
        assert_eq!(document["session_id"], "ab".repeat(16));
        assert_eq!(document["received"], serde_json::json!([true, true, true]));
        assert_eq!(document["buffer_complete"], true);
        let serialized = serde_json::to_string(&document).unwrap();
        assert!(!serialized.contains(evidence.path().to_str().unwrap()));
        assert!(!serialized.contains("/tmp/leak"));
    }

    #[test]
    fn trusted_completion_requires_matching_session_and_writes_metrics_before_completion() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json")
            .canonicalize()
            .unwrap();
        let hash = lower_sha256(&fs::read(&manifest).unwrap());
        let evidence = tempfile::tempdir().unwrap();
        let config = ReviewAutomationConfig::load(
            manifest,
            hash.clone(),
            "ab".repeat(16),
            evidence.path().to_path_buf(),
        )
        .unwrap();
        let snapshot = fixture_snapshot("ab".repeat(16));
        assert!(config
            .write_trusted_completion(&snapshot, 123, 456)
            .unwrap());
        let metrics: serde_json::Value =
            serde_json::from_slice(&fs::read(evidence.path().join(METRICS_FILE)).unwrap()).unwrap();
        let complete: serde_json::Value =
            serde_json::from_slice(&fs::read(evidence.path().join(COMPLETE_FILE)).unwrap())
                .unwrap();
        assert_eq!(metrics["provenance"]["manifest_sha256"], hash);
        assert_eq!(metrics["metrics"]["peak_rss_bytes"], 123.0);
        assert_eq!(metrics["metrics"]["cache_bytes"], 456.0);
        assert_eq!(metrics["provenance"]["representative_machine"], false);
        assert_eq!(
            metrics["provenance"]["host_measurements"]["source"],
            "trusted-native-host"
        );
        assert_eq!(metrics["provenance"]["samples"]["cachedFirstPage"], 5);
        assert_eq!(
            metrics["provenance"]["samples"]["authoritativeFirstPage"],
            2
        );
        assert!(metrics["provenance"]["samples"]["cached_first_page"].is_null());
        assert_eq!(complete["metrics_file"], METRICS_FILE);
        assert_eq!(complete["preview_hashes"][0]["pageId"], "pdf:page-1");
        assert!(complete["preview_hashes"][0]["page_id"].is_null());
        let mut wrong = snapshot;
        wrong.automation.as_mut().unwrap().session_id = "cd".repeat(16);
        assert!(matches!(
            config.write_trusted_completion(&wrong, 123, 456),
            Err(AutomationError::Metrics)
        ));
    }

    #[test]
    fn atomic_json_rename_is_the_only_commit_point_under_every_stage_fault() {
        let stages = [
            AtomicWriteStage::Open,
            AtomicWriteStage::Write,
            AtomicWriteStage::Flush,
            AtomicWriteStage::FileSync,
            AtomicWriteStage::PrecommitDirectorySync,
            AtomicWriteStage::Rename,
        ];
        for failed_stage in stages {
            let evidence = tempfile::tempdir().unwrap();
            let result = write_json_atomic_with_hook(
                evidence.path(),
                "automation-failure.json",
                &serde_json::json!({"committed": true}),
                |stage| {
                    if stage == failed_stage {
                        Err(AutomationError::Io)
                    } else {
                        Ok(())
                    }
                },
            );

            assert!(matches!(result, Err(AutomationError::Io)));
            assert!(!evidence.path().join("automation-failure.json").exists());
            assert_eq!(fs::read_dir(evidence.path()).unwrap().count(), 0);
        }

        let evidence = tempfile::tempdir().unwrap();
        let mut observed = Vec::new();
        write_json_atomic_with_hook(
            evidence.path(),
            "automation-failure.json",
            &serde_json::json!({"committed": true}),
            |stage| {
                observed.push(stage);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(observed, stages);
        assert_eq!(
            fs::read(evidence.path().join("automation-failure.json")).unwrap(),
            b"{\"committed\":true}\n"
        );
        assert_eq!(fs::read_dir(evidence.path()).unwrap().count(), 1);
    }

    fn fixture_snapshot(session_id: String) -> ReviewPerformanceSnapshot {
        ReviewPerformanceSnapshot {
            progress_visible_ms: 1.0,
            first_page_ms: 2.0,
            interactions: vec![],
            automation: Some(ReviewAutomationSnapshot {
                session_id,
                fixture: "G3-REVIEW-001".into(),
                captured_at: "2026-08-31T00:00:00.000Z".into(),
                representative_machine: true,
                preview_hashes: vec![crate::review_state::ReviewPreviewHash {
                    page_id: "pdf:page-1".into(),
                    sha256: "44".repeat(32),
                }],
                metrics: ReviewAutomationMetrics {
                    progress_visible_ms: 1.0,
                    cached_first_page_p95_ms: 2.0,
                    authoritative_first_reviewable_page_ms: 3.0,
                    interaction_p95_ms: 4.0,
                    peak_rss_bytes: 5.0,
                    cache_bytes: 6.0,
                    reanchor_resolved: 1.0,
                    reanchor_unresolved: 0.0,
                    reanchor_silent_misplaced: 0.0,
                    visual_diff_ratio: 0.0,
                },
                samples: ReviewAutomationSamples {
                    progress: 1,
                    cached_first_page: 5,
                    authoritative_first_page: 2,
                    interactions: 5,
                },
            }),
        }
    }
}
