#![allow(dead_code)]

#[path = "../artifact_store.rs"]
mod artifact_store;
#[path = "../preview_cache.rs"]
mod preview_cache;
#[path = "../review_state.rs"]
mod review_state;
#[path = "../wps_worker.rs"]
mod wps_worker;

use preview_cache::{validate_pdf, CacheIdentity, PreviewCache, RenderOptions};
use review_state::{AnnotationStatus, PreviewFidelity, RawReviewAnnotation, ReviewStateStore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use wps_worker::{HomeFeatureProbe, WpsBridgeEnvironment, WpsWorkerError, WpsWorkerRequest};

const ACCEPTED_PREVIEW: &str =
    "preview-sha256:1111111111111111111111111111111111111111111111111111111111111111";
const ARTIFACT_REVISION: &str =
    "artifact-sha256:2222222222222222222222222222222222222222222222222222222222222222";
const FIXED_WORKER_MARKER: &str = "fixed-worker.marker";

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).is_some_and(|value| {
        Path::new(value).file_name().and_then(|name| name.to_str()) == Some(FIXED_WORKER_MARKER)
    }) {
        fixed_worker(&args);
        return;
    }
    let scenario = args.get(1).map(String::as_str).unwrap_or_default();
    if args.len() != 2
        || !matches!(
            scenario,
            "wps-timeout" | "wps-crash" | "webview-restart" | "cache-corrupt"
        )
    {
        std::process::exit(64);
    }
    let root = env::current_dir().unwrap_or_else(|_| std::process::exit(70));
    let result = match scenario {
        "wps-timeout" => wps_failure(&root, "timeout"),
        "wps-crash" => wps_failure(&root, "crash"),
        "webview-restart" => webview_restart(&root),
        "cache-corrupt" => cache_corrupt(&root),
        _ => unreachable!(),
    };
    let outcome = result.unwrap_or_else(|error| {
        eprintln!("recovery harness error: {error}");
        std::process::exit(70)
    });
    let contract_sources = match scenario {
        "wps-timeout" | "wps-crash" => {
            json!(["preview_cache.rs", "review_state.rs", "wps_worker.rs"])
        }
        "webview-restart" => json!(["review_state.rs"]),
        "cache-corrupt" => json!(["preview_cache.rs", "review_state.rs"]),
        _ => unreachable!(),
    };
    println!(
        "{}",
        json!({
            "schema_id": "superwagie.recovery-rust-harness.v1",
            "schema_version": 1,
            "scenario": scenario,
            "contract_sources": contract_sources,
            "outcome": outcome
        })
    );
}

fn fixed_worker(args: &[String]) {
    let marker = PathBuf::from(&args[1]);
    let current = env::current_dir().unwrap_or_else(|_| std::process::exit(70));
    let canonical_current = fs::canonicalize(&current).unwrap_or_else(|_| std::process::exit(70));
    let canonical_marker = fs::canonicalize(&marker).unwrap_or_else(|_| std::process::exit(70));
    if !canonical_marker.starts_with(&canonical_current) {
        std::process::exit(70);
    }
    let output_index = args
        .iter()
        .position(|value| value == "--output")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::process::exit(70));
    let canonical_output_parent = output_index
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .unwrap_or_else(|| std::process::exit(70));
    if output_index.file_name().is_none()
        || !canonical_output_parent.starts_with(&canonical_current)
    {
        std::process::exit(70);
    }
    fs::write(&output_index, b"fixture-owned-partial-preview")
        .unwrap_or_else(|_| std::process::exit(70));
    match fs::read_to_string(canonical_marker)
        .unwrap_or_else(|_| std::process::exit(70))
        .as_str()
    {
        "timeout" => loop {
            thread::sleep(Duration::from_secs(60));
        },
        "crash" => std::process::exit(86),
        _ => std::process::exit(70),
    }
}

fn wps_failure(root: &Path, mode: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let state_root = root.join("review-state");
    let store = ReviewStateStore::open(&state_root)?;
    store.accept_preview(ACCEPTED_PREVIEW, PreviewFidelity::Authoritative)?;
    let accepted_before = store.is_accepted(ACCEPTED_PREVIEW);

    let worker_root = root.join("worker");
    let composer_root = root.join("wpscomposer");
    let source = root.join("source.docx");
    let cache = PreviewCache::open(&root.join("preview-cache"))?;
    let identity = cache_identity(if mode == "timeout" {
        "failure-timeout"
    } else {
        "failure-crash"
    });
    let job_id = if mode == "timeout" {
        "44444444444444444444444444444444"
    } else {
        "55555555555555555555555555555555"
    };
    let staging = cache.prepare_job(job_id)?;
    let marker = worker_root.join(FIXED_WORKER_MARKER);
    fs::create_dir_all(&worker_root)?;
    fs::create_dir_all(&composer_root)?;
    fs::write(&source, b"fixture-owned-docx-source")?;
    fs::write(&marker, mode)?;
    let executable = env::current_exe()?;
    let request = WpsWorkerRequest {
        python_executable: executable.clone(),
        worker_script: marker,
        wpscomposer_root: composer_root,
        wps_application: executable,
        expected_wps_identity_json: format!(
            "{{\"target_kind\":\"windows-executable\",\"executable_sha256\":\"{}\",\"bundle_manifest_sha256\":\"{}\",\"bridge_sha256\":\"{}\"}}",
            "3".repeat(64),
            "4".repeat(64),
            "5".repeat(64)
        ),
        wps_bridge_relative_path: "skills/WPSComposer/__init__.py".into(),
        wps_executable_relative_path: None,
        source: source.clone(),
        output: staging.preview_pdf.clone(),
        expected_source_hash: sha256(&fs::read(&source)?),
        deadline: Duration::from_millis(75),
        job_temp_dir: worker_root,
        locale: Some("C.UTF-8".into()),
        bridge_environment: WpsBridgeEnvironment::default(),
        home_probe: HomeFeatureProbe::NotRequired,
    };
    let error = request.run().expect_err("fixed recovery worker must fail");
    let expected_error = if mode == "timeout" {
        WpsWorkerError::Render("WPS_RENDER_TIMEOUT".into())
    } else {
        WpsWorkerError::InvalidReceipt
    };
    if error != expected_error {
        return Err(format!("unexpected worker result: {error:?}").into());
    }
    let partial_sha256 = fs::read(&staging.preview_pdf)
        .ok()
        .map(|bytes| sha256(&bytes));
    let published = cache.load_validated(&identity)?.is_some();
    let publication_cache_bytes_after_error = cache.cache_bytes()?;
    drop(staging);
    let accepted_after = ReviewStateStore::open(&state_root)?.is_accepted(ACCEPTED_PREVIEW);
    let accepted_hash = sha256(ACCEPTED_PREVIEW.as_bytes());
    Ok(json!({
        "state": "failed_recoverable",
        "error_code": error.to_string(),
        "partial_preview_published": published,
        "partial_bytes_sha256": partial_sha256,
        "publication_cache_bytes_after_error": publication_cache_bytes_after_error,
        "prior_accepted_hash": if accepted_before { &accepted_hash } else { "" },
        "accepted_hash_after": if accepted_after { &accepted_hash } else { "" },
        "owned_child": {
            "started": true,
            "reaped": true,
            "termination": if mode == "timeout" { "deadline_kill_wait" } else { "exit_86" },
            "other_processes_inspected": false
        }
    }))
}

fn webview_restart(root: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let state_root = root.join("review-state");
    let annotation = RawReviewAnnotation {
        annotation_id: "annotation-12345678-1234-4123-8123-123456789abc".into(),
        artifact_revision_id: ARTIFACT_REVISION.into(),
        preview_revision_id: ACCEPTED_PREVIEW.into(),
        fidelity: PreviewFidelity::Authoritative,
        page_id: "page-2".into(),
        bbox: Some([0.1, 0.2, 0.3, 0.2]),
        selected_text: Some("fixture annotation".into()),
        before_context_hash: Some(format!("sha256:{}", "6".repeat(64))),
        after_context_hash: Some(format!("sha256:{}", "7".repeat(64))),
        semantic_object_id: Some("semantic-87654321-4321-4123-8123-cba987654321".into()),
        status: AnnotationStatus::Active,
    };
    let store = ReviewStateStore::open(&state_root)?;
    store.capture(annotation)?;
    store.accept_preview(ACCEPTED_PREVIEW, PreviewFidelity::Authoritative)?;
    let before_annotation = serde_json::to_vec(&store.annotations(ACCEPTED_PREVIEW)?[0])?;
    let before_state = fs::read(state_root.join("review-state.json"))?;
    let accepted_before = store.is_accepted(ACCEPTED_PREVIEW);
    drop(store);

    let restored = ReviewStateStore::open(&state_root)?;
    let after_annotation = serde_json::to_vec(&restored.annotations(ACCEPTED_PREVIEW)?[0])?;
    let after_state = fs::read(state_root.join("review-state.json"))?;
    let accepted_after = restored.is_accepted(ACCEPTED_PREVIEW);
    Ok(json!({
        "state_bytes_before_sha256": sha256(&before_state),
        "state_bytes_after_sha256": sha256(&after_state),
        "annotation_bytes_before_sha256": sha256(&before_annotation),
        "annotation_bytes_after_sha256": sha256(&after_annotation),
        "accepted_revision_before": if accepted_before { ACCEPTED_PREVIEW } else { "" },
        "accepted_revision_after": if accepted_after { ACCEPTED_PREVIEW } else { "" },
    }))
}

fn cache_identity(version: &str) -> CacheIdentity {
    CacheIdentity {
        source_content_hash: "8".repeat(64),
        renderer_id: "wps-fixed-recovery".into(),
        renderer_version: version.into(),
        renderer_environment_hash: "9".repeat(64),
        font_environment_hash: "a".repeat(64),
        render_options: RenderOptions(BTreeMap::from([("quality".into(), "authoritative".into())])),
    }
}

fn stage_fixture(
    cache: &PreviewCache,
    job_id: &str,
) -> Result<(preview_cache::StagingPaths, String), Box<dyn std::error::Error>> {
    let staging = cache.prepare_job(job_id)?;
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-100p.pdf");
    fs::copy(fixture, &staging.preview_pdf)?;
    let expected = validate_pdf(&staging.preview_pdf)?.sha256;
    Ok((staging, expected))
}

fn cache_corrupt(root: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let store = ReviewStateStore::open(root.join("review-state"))?;
    store.accept_preview(ACCEPTED_PREVIEW, PreviewFidelity::Authoritative)?;
    let accepted_before = store.is_accepted(ACCEPTED_PREVIEW);
    let cache = PreviewCache::open(&root.join("preview-cache"))?;
    let target_identity = cache_identity("target");
    let clean_identity = cache_identity("clean");
    let (_target_stage, expected_hash) = stage_fixture(&cache, "11111111111111111111111111111111")?;
    let target = cache.publish(
        "11111111111111111111111111111111",
        &target_identity,
        &expected_hash,
    )?;
    let (_clean_stage, clean_hash) = stage_fixture(&cache, "22222222222222222222222222222222")?;
    cache.publish(
        "22222222222222222222222222222222",
        &clean_identity,
        &clean_hash,
    )?;
    let corrupt = b"fixture-owned-corrupt-cache";
    fs::write(target.entry_dir.join("preview.pdf"), corrupt)?;
    let rejected = cache.load_validated(&target_identity)?.is_none();
    let clean_preserved = cache.load_validated(&clean_identity)?.is_some();
    let (_replacement_stage, replacement_hash) =
        stage_fixture(&cache, "33333333333333333333333333333333")?;
    let replacement = cache.publish(
        "33333333333333333333333333333333",
        &target_identity,
        &replacement_hash,
    )?;
    let replacement_valid = cache.load_validated(&target_identity)?.is_some();
    let accepted_after =
        ReviewStateStore::open(root.join("review-state"))?.is_accepted(ACCEPTED_PREVIEW);
    let accepted_hash = sha256(ACCEPTED_PREVIEW.as_bytes());
    Ok(json!({
        "corrupt_entry_rejected": rejected,
        "clean_entry_preserved": clean_preserved,
        "rerendered": !replacement.reused && replacement_valid,
        "corrupt_bytes_sha256": sha256(corrupt),
        "replacement_bytes_sha256": replacement.manifest.output_sha256,
        "expected_bytes_sha256": expected_hash,
        "prior_accepted_hash": if accepted_before { &accepted_hash } else { "" },
        "accepted_hash_after": if accepted_after { &accepted_hash } else { "" }
    }))
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut value = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        write!(&mut value, "{byte:02x}").expect("hex write");
    }
    value
}
