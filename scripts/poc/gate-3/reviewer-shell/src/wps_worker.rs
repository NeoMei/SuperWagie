use crate::preview_cache::{validate_pdf, ValidatedPdf};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const ALLOWED_BRIDGE_VARIABLES: &[&str] = &["WPSCOMPOSER_NODE"];
const MAX_RECEIPT_BYTES: u64 = 8 * 1024;
const MAX_DIAGNOSTIC_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WpsBridgeEnvironment(BTreeMap<String, String>);

impl WpsBridgeEnvironment {
    pub fn new(values: BTreeMap<String, String>) -> Result<Self, WpsWorkerError> {
        if values.iter().any(|(key, value)| {
            !ALLOWED_BRIDGE_VARIABLES.contains(&key.as_str())
                || value.is_empty()
                || value.chars().any(char::is_control)
                || !Path::new(value).is_absolute()
        }) {
            Err(WpsWorkerError::EnvironmentDenied)
        } else {
            Ok(Self(values))
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HomeFeatureProbe {
    NotRequired,
    Required(PathBuf),
}

pub fn worker_environment(
    job_temp_dir: &Path,
    locale: Option<&str>,
    bridge: &WpsBridgeEnvironment,
    home_probe: &HomeFeatureProbe,
) -> Result<BTreeMap<String, String>, WpsWorkerError> {
    if !job_temp_dir.is_absolute() || !job_temp_dir.is_dir() {
        return Err(WpsWorkerError::InvalidConfiguration);
    }
    let mut environment = BTreeMap::new();
    let temporary = path_text(job_temp_dir)?;
    #[cfg(unix)]
    environment.insert("TMPDIR".into(), temporary.to_owned());
    #[cfg(windows)]
    {
        environment.insert("TEMP".into(), temporary.to_owned());
        environment.insert("TMP".into(), temporary.to_owned());
    }
    if let Some(locale) = locale {
        if locale.is_empty() || locale.chars().any(char::is_control) {
            return Err(WpsWorkerError::EnvironmentDenied);
        }
        environment.insert("LANG".into(), locale.into());
        environment.insert("LC_ALL".into(), locale.into());
    }
    environment.extend(bridge.0.clone());
    if let HomeFeatureProbe::Required(home) = home_probe {
        if !home.is_absolute() {
            return Err(WpsWorkerError::InvalidConfiguration);
        }
        #[cfg(unix)]
        environment.insert("HOME".into(), path_text(home)?.into());
        #[cfg(windows)]
        environment.insert("USERPROFILE".into(), path_text(home)?.into());
    }
    #[cfg(target_os = "macos")]
    environment.insert("PATH".into(), probed_macos_system_path()?);
    Ok(environment)
}

#[cfg(target_os = "macos")]
fn probed_macos_system_path() -> Result<String, WpsWorkerError> {
    const OPEN_TOOL: &str = "/usr/bin/open";
    const PROCESS_TOOL: &str = "/bin/ps";
    let open_tool = Path::new(OPEN_TOOL);
    let process_tool = Path::new(PROCESS_TOOL);
    if [open_tool, process_tool]
        .iter()
        .any(|tool| !tool.is_absolute() || !tool.is_file())
    {
        return Err(WpsWorkerError::InvalidConfiguration);
    }
    Command::new(open_tool)
        .arg("-h")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| WpsWorkerError::InvalidConfiguration)?;
    let process_status = Command::new(process_tool)
        .arg("-p")
        .arg(std::process::id().to_string())
        .arg("-o")
        .arg("pid=")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| WpsWorkerError::InvalidConfiguration)?;
    if !process_status.success() {
        return Err(WpsWorkerError::InvalidConfiguration);
    }
    Ok("/usr/bin:/bin".into())
}

#[derive(Clone, Debug)]
pub struct WpsWorkerRequest {
    pub python_executable: PathBuf,
    pub worker_script: PathBuf,
    pub wpscomposer_root: PathBuf,
    pub wps_application: PathBuf,
    pub expected_wps_identity_json: String,
    pub wps_bridge_relative_path: String,
    pub wps_executable_relative_path: Option<String>,
    pub source: PathBuf,
    pub output: PathBuf,
    pub expected_source_hash: String,
    pub deadline: Duration,
    pub job_temp_dir: PathBuf,
    pub locale: Option<String>,
    pub bridge_environment: WpsBridgeEnvironment,
    pub home_probe: HomeFeatureProbe,
}

impl WpsWorkerRequest {
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn for_test(
        python_executable: PathBuf,
        worker_script: PathBuf,
        wpscomposer_root: PathBuf,
        source: PathBuf,
        output: PathBuf,
        expected_source_hash: String,
        deadline: Duration,
        job_temp_dir: PathBuf,
    ) -> Self {
        let wps_application = python_executable.clone();
        Self {
            python_executable,
            worker_script,
            wpscomposer_root,
            wps_application,
            expected_wps_identity_json: format!(
                "{{\"target_kind\":\"windows-executable\",\"executable_sha256\":\"{}\",\"bundle_manifest_sha256\":\"{}\",\"bridge_sha256\":\"{}\"}}",
                "1".repeat(64), "2".repeat(64), "3".repeat(64)
            ),
            wps_bridge_relative_path: "skills/WPSComposer/__init__.py".into(),
            wps_executable_relative_path: None,
            source,
            output,
            expected_source_hash,
            deadline,
            job_temp_dir,
            locale: Some("C.UTF-8".into()),
            bridge_environment: WpsBridgeEnvironment::default(),
            home_probe: HomeFeatureProbe::NotRequired,
        }
    }

    pub fn run(&self) -> Result<WpsWorkerSuccess, WpsWorkerError> {
        self.validate()?;
        let expected_component =
            source_component(&self.source).ok_or(WpsWorkerError::InvalidConfiguration)?;
        let environment = worker_environment(
            &self.job_temp_dir,
            self.locale.as_deref(),
            &self.bridge_environment,
            &self.home_probe,
        )?;
        let deadline_ms = u64::try_from(self.deadline.as_millis())
            .map_err(|_| WpsWorkerError::InvalidConfiguration)?;
        let stdout_path = self.job_temp_dir.join(".worker-stdout");
        let stderr_path = self.job_temp_dir.join(".worker-stderr");
        let stdout_file = create_capture_file(&stdout_path)?;
        let stderr_file = create_capture_file(&stderr_path)?;
        let mut command = Command::new(&self.python_executable);
        command
            .arg(&self.worker_script)
            .arg("--source")
            .arg(&self.source)
            .arg("--output")
            .arg(&self.output)
            .arg("--wpscomposer-root")
            .arg(&self.wpscomposer_root)
            .arg("--wps-application")
            .arg(&self.wps_application)
            .arg("--expected-wps-identity-json")
            .arg(&self.expected_wps_identity_json)
            .arg("--wps-bridge-relative-path")
            .arg(&self.wps_bridge_relative_path)
            .arg("--expected-source-sha256")
            .arg(&self.expected_source_hash)
            .arg("--deadline-ms")
            .arg(deadline_ms.to_string())
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout_file))
            .stderr(Stdio::from(stderr_file));
        if let Some(relative) = &self.wps_executable_relative_path {
            command.arg("--wps-executable-relative-path").arg(relative);
        }
        let mut child = command.spawn().map_err(|_| WpsWorkerError::SpawnFailed)?;
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|_| WpsWorkerError::WaitFailed)? {
                break status;
            }
            if capture_exceeds(&stdout_path, MAX_RECEIPT_BYTES)
                || capture_exceeds(&stderr_path, MAX_DIAGNOSTIC_BYTES)
            {
                child.kill().map_err(|_| WpsWorkerError::KillFailed)?;
                child.wait().map_err(|_| WpsWorkerError::WaitFailed)?;
                return Err(WpsWorkerError::CaptureTooLarge);
            }
            if started.elapsed() >= self.deadline {
                child.kill().map_err(|_| WpsWorkerError::KillFailed)?;
                child.wait().map_err(|_| WpsWorkerError::WaitFailed)?;
                return Err(WpsWorkerError::Render("WPS_RENDER_TIMEOUT".into()));
            }
            thread::sleep(Duration::from_millis(10));
        };
        let stdout = read_bounded(&stdout_path, MAX_RECEIPT_BYTES)?;
        let stderr = read_bounded(&stderr_path, MAX_DIAGNOSTIC_BYTES)?;
        if !stderr.is_empty() {
            eprint!("{}", String::from_utf8_lossy(&stderr));
        }
        let receipt = parse_single_receipt(&stdout)?;
        if receipt.component != expected_component {
            return Err(WpsWorkerError::InvalidReceipt);
        }
        if receipt.status != "success" {
            return Err(WpsWorkerError::Render(receipt.code));
        }
        if !status.success() || receipt.code != "OK" {
            return Err(WpsWorkerError::InvalidReceipt);
        }
        let receipt_hash = receipt
            .output_sha256
            .as_deref()
            .filter(|value| is_sha256(value))
            .ok_or(WpsWorkerError::InvalidReceipt)?;
        let validated_pdf = validate_pdf(&self.output).map_err(|_| WpsWorkerError::InvalidPdf)?;
        if validated_pdf.sha256 != receipt_hash {
            return Err(WpsWorkerError::OutputHashMismatch);
        }
        Ok(WpsWorkerSuccess {
            receipt,
            validated_pdf,
        })
    }

    fn validate(&self) -> Result<(), WpsWorkerError> {
        let absolute_paths = [
            &self.python_executable,
            &self.worker_script,
            &self.wpscomposer_root,
            &self.wps_application,
            &self.source,
            &self.output,
            &self.job_temp_dir,
        ];
        if absolute_paths.iter().any(|path| !path.is_absolute())
            || !self.python_executable.is_file()
            || !self.worker_script.is_file()
            || !self.wpscomposer_root.is_dir()
            || !self.wps_application.exists()
            || !self.source.is_file()
            || source_component(&self.source).is_none()
            || self.output.extension().and_then(|value| value.to_str()) != Some("pdf")
            || self.deadline.is_zero()
            || !is_sha256(&self.expected_source_hash)
            || !valid_wps_identity_json(&self.expected_wps_identity_json)
            || !valid_relative_identity(&self.wps_bridge_relative_path)
            || self
                .wps_executable_relative_path
                .as_deref()
                .is_some_and(|value| !valid_relative_identity(value))
        {
            Err(WpsWorkerError::InvalidConfiguration)
        } else {
            Ok(())
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedWpsIdentity {
    target_kind: String,
    executable_sha256: String,
    bundle_manifest_sha256: String,
    bridge_sha256: String,
}

fn valid_wps_identity_json(value: &str) -> bool {
    serde_json::from_str::<ExpectedWpsIdentity>(value).is_ok_and(|identity| {
        matches!(
            identity.target_kind.as_str(),
            "macos-app-bundle" | "windows-executable"
        ) && is_sha256(&identity.executable_sha256)
            && is_sha256(&identity.bundle_manifest_sha256)
            && is_sha256(&identity.bridge_sha256)
    })
}

fn valid_relative_identity(value: &str) -> bool {
    !value.is_empty()
        && !Path::new(value).is_absolute()
        && !value.chars().any(char::is_control)
        && !Path::new(value).components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
}

fn source_component(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "doc" | "docx" => Some("writer"),
        "ppt" | "pptx" => Some("presentation"),
        "xls" | "xlsx" => Some("spreadsheet"),
        _ => None,
    }
}

fn create_capture_file(path: &Path) -> Result<File, WpsWorkerError> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| WpsWorkerError::PipeReadFailed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| WpsWorkerError::PipeReadFailed)?;
    }
    Ok(file)
}

fn capture_exceeds(path: &Path, limit: u64) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.len() > limit)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, WpsWorkerError> {
    if capture_exceeds(path, limit) {
        return Err(WpsWorkerError::CaptureTooLarge);
    }
    let file = File::open(path).map_err(|_| WpsWorkerError::PipeReadFailed)?;
    let mut bytes = Vec::with_capacity(usize::try_from(limit).unwrap_or(0));
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| WpsWorkerError::PipeReadFailed)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        Err(WpsWorkerError::CaptureTooLarge)
    } else {
        Ok(bytes)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WpsRenderReceipt {
    pub status: String,
    pub code: String,
    pub component: String,
    pub backend: String,
    pub output_sha256: Option<String>,
}

pub fn parse_single_receipt(stdout: &[u8]) -> Result<WpsRenderReceipt, WpsWorkerError> {
    let text = std::str::from_utf8(stdout).map_err(|_| WpsWorkerError::InvalidReceipt)?;
    let without_newline = text.strip_suffix('\n').unwrap_or(text);
    let one_line = without_newline
        .strip_suffix('\r')
        .unwrap_or(without_newline);
    if one_line.is_empty() || one_line.contains(['\n', '\r']) {
        return Err(WpsWorkerError::InvalidReceipt);
    }
    let receipt: WpsRenderReceipt =
        serde_json::from_str(one_line).map_err(|_| WpsWorkerError::InvalidReceipt)?;
    let stable_status_code = matches!(
        (receipt.status.as_str(), receipt.code.as_str()),
        ("success", "OK")
            | ("dependency_missing", "WPS_RUNTIME_MISSING")
            | ("failed", "SOURCE_HASH_MISMATCH")
            | ("failed", "WPS_INTERACTIVE_INPUT_REQUIRED")
            | ("failed", "WPS_RENDER_TIMEOUT")
            | ("failed", "WPS_RENDER_FAILED")
    );
    let stable_output_hash = if receipt.status == "success" {
        receipt.output_sha256.as_deref().is_some_and(is_sha256)
    } else {
        receipt.output_sha256.is_none()
    };
    let stable_component = matches!(
        receipt.component.as_str(),
        "writer" | "presentation" | "spreadsheet" | "unknown"
    );
    if !stable_status_code
        || !stable_output_hash
        || !stable_component
        || receipt.backend != "wpscomposer-explicit-source"
    {
        return Err(WpsWorkerError::InvalidReceipt);
    }
    Ok(receipt)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WpsWorkerSuccess {
    pub receipt: WpsRenderReceipt,
    pub validated_pdf: ValidatedPdf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderJobStatus {
    pub job_id: String,
    pub state: String,
    pub preview_revision_id: Option<String>,
    pub preview_handle: Option<String>,
    pub error_code: Option<String>,
}

impl RenderJobStatus {
    pub fn rendering(job_id: &str) -> Self {
        Self {
            job_id: job_id.into(),
            state: "rendering_authoritative".into(),
            preview_revision_id: None,
            preview_handle: None,
            error_code: None,
        }
    }

    pub fn ready(
        job_id: &str,
        preview_revision_id: String,
        preview_handle: String,
    ) -> Result<Self, WpsWorkerError> {
        if !is_preview_revision_id(&preview_revision_id) || !is_handle(&preview_handle) {
            return Err(WpsWorkerError::InvalidStatusIdentity);
        }
        Ok(Self {
            job_id: job_id.into(),
            state: "authoritative_ready".into(),
            preview_revision_id: Some(preview_revision_id),
            preview_handle: Some(preview_handle),
            error_code: None,
        })
    }

    pub fn failed(job_id: &str, state: &str, error_code: &str) -> Self {
        Self {
            job_id: job_id.into(),
            state: state.into(),
            preview_revision_id: None,
            preview_handle: None,
            error_code: Some(error_code.into()),
        }
    }

    fn is_terminal(&self) -> bool {
        self.state != "rendering_authoritative"
    }
}

#[derive(Debug)]
pub struct BoundedRenderJobs {
    capacity: usize,
    entries: HashMap<String, RenderJobStatus>,
    insertion_order: VecDeque<String>,
}

impl BoundedRenderJobs {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: HashMap::new(),
            insertion_order: VecDeque::new(),
        }
    }

    pub fn insert_running(&mut self, job_id: &str) -> Result<(), WpsWorkerError> {
        while self.entries.len() >= self.capacity {
            let terminal = self
                .insertion_order
                .iter()
                .find(|id| {
                    self.entries
                        .get(*id)
                        .is_some_and(RenderJobStatus::is_terminal)
                })
                .cloned();
            if let Some(id) = terminal {
                self.entries.remove(&id);
                self.insertion_order.retain(|candidate| candidate != &id);
            } else {
                return Err(WpsWorkerError::JobRegistryFull);
            }
        }
        self.entries
            .insert(job_id.into(), RenderJobStatus::rendering(job_id));
        self.insertion_order.push_back(job_id.into());
        Ok(())
    }

    pub fn complete(&mut self, job_id: &str, status: RenderJobStatus) {
        if self.entries.contains_key(job_id) {
            self.entries.insert(job_id.into(), status);
        }
    }

    pub fn status(&mut self, job_id: &str) -> Result<RenderJobStatus, WpsWorkerError> {
        let status = self
            .entries
            .get(job_id)
            .cloned()
            .ok_or(WpsWorkerError::JobNotFound)?;
        if status.is_terminal() {
            self.entries.remove(job_id);
            self.insertion_order.retain(|candidate| candidate != job_id);
        }
        Ok(status)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

fn path_text(path: &Path) -> Result<&str, WpsWorkerError> {
    path.to_str().ok_or(WpsWorkerError::InvalidConfiguration)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_preview_revision_id(value: &str) -> bool {
    value.strip_prefix("preview-sha256:").is_some_and(is_sha256)
}

fn is_handle(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WpsWorkerError {
    InvalidConfiguration,
    EnvironmentDenied,
    SpawnFailed,
    WaitFailed,
    KillFailed,
    PipeReadFailed,
    CaptureTooLarge,
    InvalidReceipt,
    InvalidPdf,
    OutputHashMismatch,
    Render(String),
    JobNotFound,
    JobRegistryFull,
    InvalidStatusIdentity,
}

impl std::fmt::Display for WpsWorkerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Render(code) => formatter.write_str(code),
            Self::InvalidConfiguration => formatter.write_str("WPS_WORKER_CONFIG_INVALID"),
            Self::EnvironmentDenied => formatter.write_str("WPS_WORKER_ENV_DENIED"),
            Self::SpawnFailed => formatter.write_str("WPS_RUNTIME_MISSING"),
            Self::WaitFailed | Self::KillFailed => formatter.write_str("WPS_RENDER_FAILED"),
            Self::PipeReadFailed | Self::InvalidReceipt => {
                formatter.write_str("WPS_RENDER_PROTOCOL_INVALID")
            }
            Self::CaptureTooLarge => formatter.write_str("WPS_RENDER_CAPTURE_TOO_LARGE"),
            Self::InvalidPdf => formatter.write_str("WPS_RENDER_FAILED"),
            Self::OutputHashMismatch => formatter.write_str("WPS_RENDER_OUTPUT_HASH_MISMATCH"),
            Self::JobNotFound => formatter.write_str("SW_REVIEW_JOB_NOT_FOUND"),
            Self::JobRegistryFull => formatter.write_str("SW_REVIEW_RENDER_BUSY"),
            Self::InvalidStatusIdentity => formatter.write_str("SW_REVIEW_STATUS_IDENTITY_INVALID"),
        }
    }
}

impl std::error::Error for WpsWorkerError {}

#[cfg(test)]
mod tests {
    use super::{
        parse_single_receipt, worker_environment, BoundedRenderJobs, HomeFeatureProbe,
        RenderJobStatus, WpsBridgeEnvironment, WpsRenderReceipt, WpsWorkerError, WpsWorkerRequest,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    fn python() -> PathBuf {
        PathBuf::from("/Users/neomei/项目/codexprojects/WpsComposer/.venv/bin/python")
    }

    fn fixture_pdf() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-100p.pdf")
    }

    #[test]
    fn worker_environment_is_exact_allowlist_and_never_inherits_agent_state() {
        let temporary = tempfile::tempdir().unwrap();
        let bridge = WpsBridgeEnvironment::new(BTreeMap::from([(
            "WPSCOMPOSER_NODE".into(),
            "/explicit/node".into(),
        )]))
        .unwrap();
        let environment = worker_environment(
            temporary.path(),
            Some("zh_CN.UTF-8"),
            &bridge,
            &HomeFeatureProbe::NotRequired,
        )
        .unwrap();
        assert_eq!(
            environment.get("LANG").map(String::as_str),
            Some("zh_CN.UTF-8")
        );
        assert_eq!(
            environment.get("LC_ALL").map(String::as_str),
            Some("zh_CN.UTF-8")
        );
        assert_eq!(
            environment.get("WPSCOMPOSER_NODE").map(String::as_str),
            Some("/explicit/node")
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            environment.get("PATH").map(String::as_str),
            Some("/usr/bin:/bin")
        );
        #[cfg(not(target_os = "macos"))]
        assert!(!environment.contains_key("PATH"));
        assert!(!environment.contains_key("CODEX_HOME"));
        assert!(!environment.keys().any(|key| key.starts_with("OPENAI_")));
        assert!(!environment.contains_key("HOME"));
    }

    #[test]
    fn home_is_added_only_after_explicit_container_probe_requires_it() {
        let temporary = tempfile::tempdir().unwrap();
        let environment = worker_environment(
            temporary.path(),
            None,
            &WpsBridgeEnvironment::default(),
            &HomeFeatureProbe::Required(PathBuf::from("/explicit/probed-home")),
        )
        .unwrap();
        #[cfg(unix)]
        assert_eq!(
            environment.get("HOME").map(String::as_str),
            Some("/explicit/probed-home")
        );
    }

    #[test]
    fn unknown_bridge_environment_variable_is_rejected() {
        assert_eq!(
            WpsBridgeEnvironment::new(BTreeMap::from([
                ("CODEX_HOME".into(), "/forbidden".into(),)
            ]))
            .unwrap_err(),
            WpsWorkerError::EnvironmentDenied
        );
        assert_eq!(
            WpsBridgeEnvironment::new(BTreeMap::from([(
                "WPSCOMPOSER_NODE".into(),
                "relative/node".into(),
            )]))
            .unwrap_err(),
            WpsWorkerError::EnvironmentDenied
        );
    }

    #[test]
    fn receipt_parser_requires_exactly_one_json_object() {
        let line = b"{\"status\":\"success\",\"code\":\"OK\",\"component\":\"writer\",\"backend\":\"wpscomposer-explicit-source\",\"output_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n";
        assert!(matches!(
            parse_single_receipt(line).unwrap(),
            WpsRenderReceipt { code, .. } if code == "OK"
        ));
        let two = [line.as_slice(), line.as_slice()].concat();
        assert_eq!(
            parse_single_receipt(&two).unwrap_err(),
            WpsWorkerError::InvalidReceipt
        );
        let arbitrary = b"{\"status\":\"failed\",\"code\":\"ARBITRARY_PRIVATE_ERROR\",\"component\":\"writer\",\"backend\":\"wpscomposer-explicit-source\"}\n";
        assert_eq!(
            parse_single_receipt(arbitrary).unwrap_err(),
            WpsWorkerError::InvalidReceipt
        );
        let success_without_hash = b"{\"status\":\"success\",\"code\":\"OK\",\"component\":\"writer\",\"backend\":\"wpscomposer-explicit-source\"}\n";
        assert_eq!(
            parse_single_receipt(success_without_hash).unwrap_err(),
            WpsWorkerError::InvalidReceipt
        );
        let error_with_hash = b"{\"status\":\"failed\",\"code\":\"WPS_RENDER_FAILED\",\"component\":\"writer\",\"backend\":\"wpscomposer-explicit-source\",\"output_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n";
        assert_eq!(
            parse_single_receipt(error_with_hash).unwrap_err(),
            WpsWorkerError::InvalidReceipt
        );
        let private_component = b"{\"status\":\"failed\",\"code\":\"WPS_RENDER_FAILED\",\"component\":\"host-private-component\",\"backend\":\"wpscomposer-explicit-source\"}\n";
        assert_eq!(
            parse_single_receipt(private_component).unwrap_err(),
            WpsWorkerError::InvalidReceipt
        );
    }

    #[test]
    fn owned_worker_timeout_is_bounded_and_returns_stable_code() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.py");
        fs::write(&script, "import time\ntime.sleep(30)\n").unwrap();
        let source = directory.path().join("source.docx");
        fs::write(&source, b"source").unwrap();
        let request = WpsWorkerRequest::for_test(
            python(),
            script,
            directory.path().to_path_buf(),
            source,
            directory.path().join("preview.pdf"),
            "41cf6794ba4200b839dc76f3b74bda77fd199a92d7b0b74c8d8e8a091a357269".into(),
            Duration::from_millis(100),
            directory.path().to_path_buf(),
        );
        let started = Instant::now();
        assert_eq!(
            request.run().unwrap_err(),
            WpsWorkerError::Render("WPS_RENDER_TIMEOUT".into())
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn timeout_does_not_wait_for_descendant_inherited_output_or_kill_unrelated_process() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.py");
        fs::write(
            &script,
            "import subprocess, sys, time\nsubprocess.Popen([sys.executable, '-c', 'import time; time.sleep(4)'])\ntime.sleep(30)\n",
        )
        .unwrap();
        let source = directory.path().join("source.docx");
        fs::write(&source, b"source").unwrap();
        let request = WpsWorkerRequest::for_test(
            python(),
            script,
            directory.path().to_path_buf(),
            source,
            directory.path().join("preview.pdf"),
            "41cf6794ba4200b839dc76f3b74bda77fd199a92d7b0b74c8d8e8a091a357269".into(),
            Duration::from_millis(500),
            directory.path().to_path_buf(),
        );
        let mut sentinel = std::process::Command::new(python())
            .arg("-c")
            .arg("import time; time.sleep(30)")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();

        let started = Instant::now();
        let result = request.run();
        let elapsed = started.elapsed();
        let sentinel_was_alive = sentinel.try_wait().unwrap().is_none();
        sentinel.kill().unwrap();
        sentinel.wait().unwrap();

        assert_eq!(
            result.unwrap_err(),
            WpsWorkerError::Render("WPS_RENDER_TIMEOUT".into())
        );
        assert!(
            elapsed < Duration::from_millis(1_500),
            "elapsed={elapsed:?}"
        );
        assert!(sentinel_was_alive);
    }

    #[test]
    fn oversized_stdout_receipt_is_rejected_with_bounded_capture() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.py");
        fs::write(&script, "import sys\nsys.stdout.write('x' * 100000)\n").unwrap();
        let source = directory.path().join("source.docx");
        fs::write(&source, b"source").unwrap();
        let request = WpsWorkerRequest::for_test(
            python(),
            script,
            directory.path().to_path_buf(),
            source,
            directory.path().join("preview.pdf"),
            "41cf6794ba4200b839dc76f3b74bda77fd199a92d7b0b74c8d8e8a091a357269".into(),
            Duration::from_secs(10),
            directory.path().to_path_buf(),
        );

        assert_eq!(
            request.run().unwrap_err().to_string(),
            "WPS_RENDER_CAPTURE_TOO_LARGE"
        );
    }

    #[test]
    fn oversized_stderr_is_rejected_with_bounded_capture() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.py");
        fs::write(
            &script,
            "import json, sys\nsys.stderr.write('x' * 100000)\nprint(json.dumps({'status':'failed','code':'WPS_RENDER_FAILED','component':'writer','backend':'wpscomposer-explicit-source'}))\nraise SystemExit(1)\n",
        )
        .unwrap();
        let source = directory.path().join("source.docx");
        fs::write(&source, b"source").unwrap();
        let request = WpsWorkerRequest::for_test(
            python(),
            script,
            directory.path().to_path_buf(),
            source,
            directory.path().join("preview.pdf"),
            "41cf6794ba4200b839dc76f3b74bda77fd199a92d7b0b74c8d8e8a091a357269".into(),
            Duration::from_secs(10),
            directory.path().to_path_buf(),
        );

        assert_eq!(
            request.run().unwrap_err().to_string(),
            "WPS_RENDER_CAPTURE_TOO_LARGE"
        );
    }

    #[test]
    fn rust_rejects_receipt_hash_that_does_not_match_staged_pdf() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.py");
        let script_body = format!(
            "import json, shutil, sys\nout = sys.argv[sys.argv.index('--output') + 1]\nshutil.copyfile({fixture:?}, out)\nprint(json.dumps({{'status':'success','code':'OK','component':'writer','backend':'wpscomposer-explicit-source','output_sha256':'{}'}}))\n",
            "0".repeat(64),
            fixture = fixture_pdf().to_string_lossy(),
        );
        fs::write(&script, script_body).unwrap();
        let source = directory.path().join("source.docx");
        fs::write(&source, b"source").unwrap();
        let request = WpsWorkerRequest::for_test(
            python(),
            script,
            directory.path().to_path_buf(),
            source,
            directory.path().join("preview.pdf"),
            "41cf6794ba4200b839dc76f3b74bda77fd199a92d7b0b74c8d8e8a091a357269".into(),
            Duration::from_secs(10),
            directory.path().to_path_buf(),
        );
        assert_eq!(
            request.run().unwrap_err(),
            WpsWorkerError::OutputHashMismatch
        );
    }

    #[test]
    fn success_receipt_component_must_match_validated_source_extension() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.py");
        let fixture = fixture_pdf();
        let fixture_hash = super::validate_pdf(&fixture).unwrap().sha256;
        fs::write(
            &script,
            format!(
                "import json, shutil, sys\nout = sys.argv[sys.argv.index('--output') + 1]\nshutil.copyfile({fixture:?}, out)\nprint(json.dumps({{'status':'success','code':'OK','component':'presentation','backend':'wpscomposer-explicit-source','output_sha256':{hash:?}}}))\n",
                fixture = fixture.to_string_lossy(),
                hash = fixture_hash,
            ),
        )
        .unwrap();
        let source = directory.path().join("source.docx");
        fs::write(&source, b"source").unwrap();
        let request = WpsWorkerRequest::for_test(
            python(),
            script,
            directory.path().to_path_buf(),
            source,
            directory.path().join("preview.pdf"),
            "41cf6794ba4200b839dc76f3b74bda77fd199a92d7b0b74c8d8e8a091a357269".into(),
            Duration::from_secs(10),
            directory.path().to_path_buf(),
        );

        assert_eq!(request.run().unwrap_err(), WpsWorkerError::InvalidReceipt);
    }

    #[test]
    fn failure_receipt_component_must_match_validated_source_extension() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.py");
        fs::write(
            &script,
            "import json\nprint(json.dumps({'status':'failed','code':'WPS_RENDER_FAILED','component':'presentation','backend':'wpscomposer-explicit-source'}))\nraise SystemExit(1)\n",
        )
        .unwrap();
        let source = directory.path().join("source.docx");
        fs::write(&source, b"source").unwrap();
        let request = WpsWorkerRequest::for_test(
            python(),
            script,
            directory.path().to_path_buf(),
            source,
            directory.path().join("preview.pdf"),
            "41cf6794ba4200b839dc76f3b74bda77fd199a92d7b0b74c8d8e8a091a357269".into(),
            Duration::from_secs(10),
            directory.path().to_path_buf(),
        );

        assert_eq!(request.run().unwrap_err(), WpsWorkerError::InvalidReceipt);
    }

    #[test]
    fn terminal_jobs_are_consumed_and_the_registry_is_strictly_bounded() {
        let mut jobs = BoundedRenderJobs::new(2);
        jobs.insert_running("11111111111111111111111111111111")
            .unwrap();
        jobs.complete(
            "11111111111111111111111111111111",
            RenderJobStatus::failed(
                "11111111111111111111111111111111",
                "dependency_missing",
                "SW_REVIEW_RENDER_DEPENDENCY_MISSING",
            ),
        );
        jobs.insert_running("22222222222222222222222222222222")
            .unwrap();
        jobs.insert_running("33333333333333333333333333333333")
            .unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(
            jobs.status("11111111111111111111111111111111").unwrap_err(),
            WpsWorkerError::JobNotFound
        );

        jobs.complete(
            "22222222222222222222222222222222",
            RenderJobStatus::failed(
                "22222222222222222222222222222222",
                "failed_recoverable",
                "WPS_RENDER_FAILED",
            ),
        );
        let terminal = jobs.status("22222222222222222222222222222222").unwrap();
        assert_eq!(terminal.state, "failed_recoverable");
        assert_eq!(jobs.len(), 1);
        assert_eq!(
            jobs.status("22222222222222222222222222222222").unwrap_err(),
            WpsWorkerError::JobNotFound
        );
    }

    #[test]
    fn authoritative_ready_status_requires_exact_revision_and_handle_formats() {
        let job_id = "11111111111111111111111111111111";
        let revision = format!("preview-sha256:{}", "22".repeat(32));
        let handle = "33333333333333333333333333333333".to_owned();

        let ready = RenderJobStatus::ready(job_id, revision.clone(), handle.clone()).unwrap();
        assert_eq!(
            ready.preview_revision_id.as_deref(),
            Some(revision.as_str())
        );
        assert_eq!(ready.preview_handle.as_deref(), Some(handle.as_str()));
        assert!(RenderJobStatus::ready(job_id, handle.clone(), handle.clone()).is_err());
        assert!(RenderJobStatus::ready(job_id, revision, "not-a-handle".into()).is_err());

        let failed = RenderJobStatus::failed(job_id, "failed_recoverable", "WPS_RENDER_FAILED");
        assert!(failed.preview_revision_id.is_none());
        assert!(failed.preview_handle.is_none());
    }
}
