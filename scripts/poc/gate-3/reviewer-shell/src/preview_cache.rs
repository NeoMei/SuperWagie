use lopdf::Document;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

const CACHE_DOMAIN: &[u8] = b"superwagie-preview-cache-v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RenderOptions(pub BTreeMap<String, String>);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CacheIdentity {
    pub source_content_hash: String,
    pub renderer_id: String,
    pub renderer_version: String,
    pub renderer_environment_hash: String,
    pub font_environment_hash: String,
    pub render_options: RenderOptions,
}

impl CacheIdentity {
    pub fn cache_key(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(CACHE_DOMAIN);
        hash_field(
            &mut hasher,
            b"source_content_hash",
            self.source_content_hash.as_bytes(),
        );
        hash_field(&mut hasher, b"renderer_id", self.renderer_id.as_bytes());
        hash_field(
            &mut hasher,
            b"renderer_version",
            self.renderer_version.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"renderer_environment_hash",
            self.renderer_environment_hash.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"font_environment_hash",
            self.font_environment_hash.as_bytes(),
        );
        hasher.update((self.render_options.0.len() as u64).to_be_bytes());
        for (key, value) in &self.render_options.0 {
            hash_field(&mut hasher, b"render_option_key", key.as_bytes());
            hash_field(&mut hasher, b"render_option_value", value.as_bytes());
        }
        encode_hex(&hasher.finalize())
    }

    fn validate(&self) -> Result<(), CacheError> {
        if !is_sha256(&self.source_content_hash)
            || !is_sha256(&self.renderer_environment_hash)
            || !is_sha256(&self.font_environment_hash)
            || self.renderer_id.is_empty()
            || self.renderer_version.is_empty()
            || self.renderer_id.chars().any(char::is_control)
            || self.renderer_version.chars().any(char::is_control)
            || self.render_options.0.iter().any(|(key, value)| {
                key.is_empty()
                    || key.chars().any(char::is_control)
                    || value.chars().any(char::is_control)
            })
        {
            Err(CacheError::InvalidIdentity)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PublishManifest {
    pub cache_key: String,
    pub source_content_hash: String,
    pub renderer_id: String,
    pub renderer_version: String,
    pub renderer_environment_hash: String,
    pub font_environment_hash: String,
    pub render_options: RenderOptions,
    pub output_sha256: String,
    pub page_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedPdf {
    pub sha256: String,
    pub page_count: u32,
}

#[derive(Debug, Eq, PartialEq)]
pub struct StagingPaths {
    pub job_dir: PathBuf,
    pub preview_pdf: PathBuf,
    staging_root: PathBuf,
}

impl Drop for StagingPaths {
    fn drop(&mut self) {
        let _ = remove_owned_directory(&self.job_dir, &self.staging_root);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishedPreview {
    pub entry_dir: PathBuf,
    pub manifest: PublishManifest,
    pub reused: bool,
}

#[derive(Clone, Debug)]
pub struct PreviewCache {
    staging_root: PathBuf,
    previews_root: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublishFault {
    None,
    PreRenameFailure,
    MutateStageAfterValidation,
}

impl PreviewCache {
    pub fn open(root: &Path) -> Result<Self, CacheError> {
        ensure_directory(root)?;
        let staging_root = root.join("staging");
        let previews_root = root.join("previews");
        ensure_directory(&staging_root)?;
        ensure_directory(&previews_root)?;
        recover_owned_orphans(&staging_root, &previews_root)?;
        sync_directory(root)?;
        Ok(Self {
            staging_root,
            previews_root,
        })
    }

    pub fn prepare_job(&self, job_id: &str) -> Result<StagingPaths, CacheError> {
        validate_job_id(job_id)?;
        let job_dir = self.staging_root.join(job_id);
        fs::create_dir(&job_dir).map_err(map_io)?;
        restrict_owner_access(&job_dir, true)?;
        sync_directory(&self.staging_root)?;
        Ok(StagingPaths {
            preview_pdf: job_dir.join("preview.pdf"),
            job_dir,
            staging_root: self.staging_root.clone(),
        })
    }

    pub fn cache_bytes(&self) -> Result<u64, CacheError> {
        directory_regular_bytes(&self.previews_root)
    }

    // The fixed recovery-contract binary exercises this production cache-read
    // seam; the interactive PoC binary currently only publishes entries.
    #[allow(dead_code)]
    pub fn load_validated(
        &self,
        identity: &CacheIdentity,
    ) -> Result<Option<PublishedPreview>, CacheError> {
        identity.validate()?;
        let cache_key = identity.cache_key();
        let entry_dir = self.previews_root.join(&cache_key);
        let metadata = match fs::symlink_metadata(&entry_dir) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(map_io(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(CacheError::Io);
        }

        let validated = (|| {
            validate_regular_file(&entry_dir.join("preview.pdf"))?;
            validate_regular_file(&entry_dir.join("manifest.json"))?;
            let manifest_bytes = fs::read(entry_dir.join("manifest.json")).map_err(map_io)?;
            let manifest: PublishManifest =
                serde_json::from_slice(&manifest_bytes).map_err(|_| CacheError::Manifest)?;
            if serde_json::to_vec(&manifest).map_err(|_| CacheError::Manifest)? != manifest_bytes
                || manifest.cache_key != cache_key
                || manifest.source_content_hash != identity.source_content_hash
                || manifest.renderer_id != identity.renderer_id
                || manifest.renderer_version != identity.renderer_version
                || manifest.renderer_environment_hash != identity.renderer_environment_hash
                || manifest.font_environment_hash != identity.font_environment_hash
                || manifest.render_options != identity.render_options
            {
                return Err(CacheError::ImmutableConflict);
            }
            let pdf = validate_pdf(&entry_dir.join("preview.pdf"))?;
            if pdf.sha256 != manifest.output_sha256 || pdf.page_count != manifest.page_count {
                return Err(CacheError::OutputHashMismatch);
            }
            Ok(PublishedPreview {
                entry_dir: entry_dir.clone(),
                manifest,
                reused: true,
            })
        })();

        match validated {
            Ok(entry) => Ok(Some(entry)),
            Err(_) => {
                remove_owned_directory(&entry_dir, &self.previews_root)?;
                Ok(None)
            }
        }
    }

    pub fn publish(
        &self,
        job_id: &str,
        identity: &CacheIdentity,
        expected_output_sha256: &str,
    ) -> Result<PublishedPreview, CacheError> {
        self.publish_inner(job_id, identity, expected_output_sha256, PublishFault::None)
    }

    #[cfg(test)]
    fn publish_with_pre_rename_failure_for_test(
        &self,
        job_id: &str,
        identity: &CacheIdentity,
        expected_output_sha256: &str,
    ) -> Result<PublishedPreview, CacheError> {
        self.publish_inner(
            job_id,
            identity,
            expected_output_sha256,
            PublishFault::PreRenameFailure,
        )
    }

    #[cfg(test)]
    fn publish_with_staged_mutation_for_test(
        &self,
        job_id: &str,
        identity: &CacheIdentity,
        expected_output_sha256: &str,
    ) -> Result<PublishedPreview, CacheError> {
        self.publish_inner(
            job_id,
            identity,
            expected_output_sha256,
            PublishFault::MutateStageAfterValidation,
        )
    }

    fn publish_inner(
        &self,
        job_id: &str,
        identity: &CacheIdentity,
        expected_output_sha256: &str,
        fault: PublishFault,
    ) -> Result<PublishedPreview, CacheError> {
        validate_job_id(job_id)?;
        identity.validate()?;
        if !is_sha256(expected_output_sha256) {
            return Err(CacheError::InvalidOutputHash);
        }
        let job_dir = self.staging_root.join(job_id);
        let staged_pdf = job_dir.join("preview.pdf");
        let validated = validate_pdf(&staged_pdf)?;
        if validated.sha256 != expected_output_sha256 {
            return Err(CacheError::OutputHashMismatch);
        }
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&staged_pdf)
            .and_then(|file| file.sync_all())
            .map_err(map_io)?;
        sync_directory(&job_dir)?;
        if fault == PublishFault::MutateStageAfterValidation {
            let mut staged = OpenOptions::new()
                .append(true)
                .open(&staged_pdf)
                .map_err(map_io)?;
            staged.write_all(b"\nmutation").map_err(map_io)?;
            staged.flush().map_err(map_io)?;
            staged.sync_all().map_err(map_io)?;
        }

        let cache_key = identity.cache_key();
        let manifest = PublishManifest {
            cache_key: cache_key.clone(),
            source_content_hash: identity.source_content_hash.clone(),
            renderer_id: identity.renderer_id.clone(),
            renderer_version: identity.renderer_version.clone(),
            renderer_environment_hash: identity.renderer_environment_hash.clone(),
            font_environment_hash: identity.font_environment_hash.clone(),
            render_options: identity.render_options.clone(),
            output_sha256: validated.sha256.clone(),
            page_count: validated.page_count,
        };
        let manifest_bytes = serde_json::to_vec(&manifest).map_err(|_| CacheError::Manifest)?;
        let entry_dir = self.previews_root.join(&cache_key);
        if entry_dir.exists() {
            let result = compare_existing(&entry_dir, &staged_pdf, &manifest_bytes, &manifest)?;
            remove_staging_job(&job_dir, &self.staging_root)?;
            return Ok(result);
        }

        let temporary_entry = self
            .previews_root
            .join(format!(".{cache_key}.{job_id}.publishing"));
        fs::create_dir(&temporary_entry).map_err(map_io)?;
        let mut temporary_owner =
            OwnedTemporaryEntry::new(temporary_entry.clone(), self.previews_root.clone());
        restrict_owner_access(&temporary_entry, true)?;
        let promoted_pdf = temporary_entry.join("preview.pdf");
        copy_exclusive(&staged_pdf, &promoted_pdf)?;
        let promoted = validate_pdf(&promoted_pdf)?;
        if promoted != validated {
            return Err(CacheError::OutputHashMismatch);
        }
        write_exclusive(&temporary_entry.join("manifest.json"), &manifest_bytes)?;
        sync_directory(&temporary_entry)?;

        if fault == PublishFault::PreRenameFailure {
            return Err(CacheError::InjectedPrePublishFailure);
        }

        match fs::rename(&temporary_entry, &entry_dir) {
            Ok(()) => {
                temporary_owner.disarm();
                sync_directory(&self.previews_root)?;
                remove_staging_job(&job_dir, &self.staging_root)?;
                Ok(PublishedPreview {
                    entry_dir,
                    manifest,
                    reused: false,
                })
            }
            Err(_) if entry_dir.exists() => {
                let result = compare_existing(&entry_dir, &staged_pdf, &manifest_bytes, &manifest);
                temporary_owner.cleanup()?;
                let result = result?;
                remove_staging_job(&job_dir, &self.staging_root)?;
                Ok(result)
            }
            Err(_) => Err(CacheError::Io),
        }
    }
}

struct OwnedTemporaryEntry {
    path: PathBuf,
    parent: PathBuf,
    armed: bool,
}

impl OwnedTemporaryEntry {
    fn new(path: PathBuf, parent: PathBuf) -> Self {
        Self {
            path,
            parent,
            armed: true,
        }
    }

    fn cleanup(&mut self) -> Result<(), CacheError> {
        if self.armed {
            remove_owned_directory(&self.path, &self.parent)?;
            self.armed = false;
        }
        Ok(())
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for OwnedTemporaryEntry {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

pub fn validate_pdf(path: &Path) -> Result<ValidatedPdf, CacheError> {
    let metadata = fs::symlink_metadata(path).map_err(map_io)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(CacheError::InvalidPdf);
    }
    let mut file = File::open(path).map_err(map_io)?;
    let mut magic = [0_u8; 5];
    file.read_exact(&mut magic)
        .map_err(|_| CacheError::InvalidPdf)?;
    if &magic != b"%PDF-" {
        return Err(CacheError::InvalidPdf);
    }
    file.rewind().map_err(map_io)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(map_io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let document = Document::load(path).map_err(|_| CacheError::InvalidPdf)?;
    let page_count =
        u32::try_from(document.get_pages().len()).map_err(|_| CacheError::InvalidPdf)?;
    if page_count == 0 {
        return Err(CacheError::PdfHasNoPages);
    }
    Ok(ValidatedPdf {
        sha256: encode_hex(&hasher.finalize()),
        page_count,
    })
}

fn compare_existing(
    entry_dir: &Path,
    staged_pdf: &Path,
    expected_manifest_bytes: &[u8],
    manifest: &PublishManifest,
) -> Result<PublishedPreview, CacheError> {
    validate_regular_file(&entry_dir.join("preview.pdf"))?;
    validate_regular_file(&entry_dir.join("manifest.json"))?;
    let existing_pdf = fs::read(entry_dir.join("preview.pdf")).map_err(map_io)?;
    let staged_pdf_bytes = fs::read(staged_pdf).map_err(map_io)?;
    let existing_manifest = fs::read(entry_dir.join("manifest.json")).map_err(map_io)?;
    if existing_pdf != staged_pdf_bytes || existing_manifest != expected_manifest_bytes {
        return Err(CacheError::ImmutableConflict);
    }
    Ok(PublishedPreview {
        entry_dir: entry_dir.to_path_buf(),
        manifest: manifest.clone(),
        reused: true,
    })
}

fn hash_field(hasher: &mut Sha256, tag: &[u8], value: &[u8]) {
    hasher.update((tag.len() as u64).to_be_bytes());
    hasher.update(tag);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn copy_exclusive(source: &Path, destination: &Path) -> Result<(), CacheError> {
    let mut source_file = File::open(source).map_err(map_io)?;
    let mut destination_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(map_io)?;
    restrict_owner_access(destination, false)?;
    std::io::copy(&mut source_file, &mut destination_file).map_err(map_io)?;
    destination_file.flush().map_err(map_io)?;
    destination_file.sync_all().map_err(map_io)
}

fn write_exclusive(path: &Path, bytes: &[u8]) -> Result<(), CacheError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(map_io)?;
    restrict_owner_access(path, false)?;
    file.write_all(bytes).map_err(map_io)?;
    file.flush().map_err(map_io)?;
    file.sync_all().map_err(map_io)
}

fn validate_regular_file(path: &Path) -> Result<(), CacheError> {
    let metadata = fs::symlink_metadata(path).map_err(map_io)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        Err(CacheError::ImmutableConflict)
    } else {
        Ok(())
    }
}

fn ensure_directory(path: &Path) -> Result<(), CacheError> {
    fs::create_dir_all(path).map_err(map_io)?;
    let metadata = fs::symlink_metadata(path).map_err(map_io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        Err(CacheError::Io)
    } else {
        restrict_owner_access(path, true)
    }
}

fn recover_owned_orphans(staging_root: &Path, previews_root: &Path) -> Result<(), CacheError> {
    for entry in fs::read_dir(staging_root).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let metadata = fs::symlink_metadata(entry.path()).map_err(map_io)?;
        if validate_job_id(&name).is_ok()
            && metadata.file_type().is_dir()
            && !metadata.file_type().is_symlink()
        {
            fs::remove_dir_all(entry.path()).map_err(map_io)?;
        }
    }
    for entry in fs::read_dir(previews_root).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let metadata = fs::symlink_metadata(entry.path()).map_err(map_io)?;
        if is_owned_publishing_name(&name)
            && metadata.file_type().is_dir()
            && !metadata.file_type().is_symlink()
        {
            fs::remove_dir_all(entry.path()).map_err(map_io)?;
        }
    }
    sync_directory(staging_root)?;
    sync_directory(previews_root)
}

fn is_owned_publishing_name(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix('.')
        .and_then(|value| value.strip_suffix(".publishing"))
    else {
        return false;
    };
    let mut fields = body.split('.');
    let Some(cache_key) = fields.next() else {
        return false;
    };
    let Some(job_id) = fields.next() else {
        return false;
    };
    fields.next().is_none() && is_sha256(cache_key) && validate_job_id(job_id).is_ok()
}

fn remove_owned_directory(path: &Path, parent: &Path) -> Result<(), CacheError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path).map_err(map_io)?;
            sync_directory(parent)
        }
        Ok(_) => Err(CacheError::Io),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_io(error)),
    }
}

fn remove_staging_job(job_dir: &Path, staging_root: &Path) -> Result<(), CacheError> {
    fs::remove_dir_all(job_dir).map_err(map_io)?;
    sync_directory(staging_root)
}

fn sync_directory(path: &Path) -> Result<(), CacheError> {
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

fn restrict_owner_access(path: &Path, directory: bool) -> Result<(), CacheError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if directory { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(map_io)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, directory);
        Ok(())
    }
}

fn validate_job_id(value: &str) -> Result<(), CacheError> {
    if value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(CacheError::InvalidJobId)
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn map_io(_error: std::io::Error) -> CacheError {
    CacheError::Io
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CacheError {
    InvalidJobId,
    InvalidIdentity,
    InvalidOutputHash,
    OutputHashMismatch,
    InvalidPdf,
    PdfHasNoPages,
    Manifest,
    ImmutableConflict,
    InjectedPrePublishFailure,
    Io,
}

impl std::fmt::Display for CacheError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            Self::InvalidJobId => "SW_REVIEW_JOB_INVALID",
            Self::InvalidIdentity => "SW_REVIEW_CACHE_IDENTITY_INVALID",
            Self::InvalidOutputHash => "SW_REVIEW_OUTPUT_HASH_INVALID",
            Self::OutputHashMismatch => "SW_REVIEW_OUTPUT_HASH_MISMATCH",
            Self::InvalidPdf => "SW_REVIEW_RENDERED_PDF_INVALID",
            Self::PdfHasNoPages => "SW_REVIEW_RENDERED_PDF_EMPTY",
            Self::Manifest => "SW_REVIEW_CACHE_MANIFEST_FAILED",
            Self::ImmutableConflict => "SW_REVIEW_CACHE_IMMUTABLE_CONFLICT",
            Self::InjectedPrePublishFailure => "SW_REVIEW_CACHE_PREPUBLISH_FAILED",
            Self::Io => "SW_REVIEW_CACHE_IO_FAILED",
        };
        formatter.write_str(code)
    }
}

impl std::error::Error for CacheError {}

fn directory_regular_bytes(root: &Path) -> Result<u64, CacheError> {
    let mut total = 0_u64;
    for entry in fs::read_dir(root).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(map_io)?;
        if metadata.file_type().is_symlink() {
            return Err(CacheError::Io);
        }
        if metadata.is_dir() {
            total = total
                .checked_add(directory_regular_bytes(&entry.path())?)
                .ok_or(CacheError::Io)?;
        } else if metadata.is_file() {
            total = total.checked_add(metadata.len()).ok_or(CacheError::Io)?;
        } else {
            return Err(CacheError::Io);
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::{
        validate_pdf, CacheError, CacheIdentity, PreviewCache, PublishManifest, RenderOptions,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fixture_pdf() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-100p.pdf")
    }

    fn identity(renderer_id: &str, renderer_version: &str) -> CacheIdentity {
        CacheIdentity {
            source_content_hash: "11".repeat(32),
            renderer_id: renderer_id.into(),
            renderer_version: renderer_version.into(),
            renderer_environment_hash: "22".repeat(32),
            font_environment_hash: "33".repeat(32),
            render_options: RenderOptions(BTreeMap::from([
                ("paper".into(), "source".into()),
                ("quality".into(), "authoritative".into()),
            ])),
        }
    }

    fn stage_fixture(cache: &PreviewCache, job_id: &str) -> super::StagingPaths {
        let paths = cache.prepare_job(job_id).unwrap();
        fs::copy(fixture_pdf(), &paths.preview_pdf).unwrap();
        paths
    }

    #[test]
    fn cache_identity_is_length_delimited_not_ambiguous_concatenation() {
        assert_ne!(
            identity("ab", "c").cache_key(),
            identity("a", "bc").cache_key()
        );
        assert_eq!(identity("ab", "c").cache_key().len(), 64);
    }

    #[test]
    fn audited_pdf_hash_magic_and_nonzero_page_count_are_validated() {
        let validated = validate_pdf(&fixture_pdf()).unwrap();
        assert_eq!(validated.page_count, 100);
        assert_eq!(validated.sha256.len(), 64);
    }

    #[test]
    fn zero_page_pdf_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty.pdf");
        let mut document = lopdf::Document::with_version("1.5");
        document.save(&path).unwrap();
        assert_eq!(validate_pdf(&path).unwrap_err(), CacheError::PdfHasNoPages);
    }

    #[test]
    fn immutable_publish_reuses_identical_entry_and_rejects_conflict() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(directory.path()).unwrap();
        let cache_identity = identity("wps", "1");
        let first_stage = stage_fixture(&cache, "11111111111111111111111111111111");
        let expected_hash = validate_pdf(&first_stage.preview_pdf).unwrap().sha256;
        let first = cache
            .publish(
                "11111111111111111111111111111111",
                &cache_identity,
                &expected_hash,
            )
            .unwrap();
        assert!(!first.reused);

        let _second_stage = stage_fixture(&cache, "22222222222222222222222222222222");
        let second = cache
            .publish(
                "22222222222222222222222222222222",
                &cache_identity,
                &expected_hash,
            )
            .unwrap();
        assert!(second.reused);
        assert_eq!(first.manifest, second.manifest);

        let third = cache
            .prepare_job("33333333333333333333333333333333")
            .unwrap();
        let mut conflicting = fs::read(fixture_pdf()).unwrap();
        conflicting.extend_from_slice(b"\n");
        fs::write(&third.preview_pdf, conflicting).unwrap();
        let conflicting_hash = validate_pdf(&third.preview_pdf).unwrap().sha256;
        assert_eq!(
            cache
                .publish(
                    "33333333333333333333333333333333",
                    &cache_identity,
                    &conflicting_hash,
                )
                .unwrap_err(),
            CacheError::ImmutableConflict
        );
        drop(third);
        assert!(!directory
            .path()
            .join("staging/33333333333333333333333333333333")
            .exists());
        assert_eq!(
            fs::read(first.entry_dir.join("preview.pdf")).unwrap(),
            fs::read(fixture_pdf()).unwrap()
        );
    }

    #[test]
    fn corrupt_entry_is_discarded_without_touching_clean_neighbor_and_can_be_rerendered() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(directory.path()).unwrap();
        let corrupt_identity = identity("wps", "corrupt-target");
        let clean_identity = identity("wps", "clean-neighbor");

        let corrupt_stage = stage_fixture(&cache, "11111111111111111111111111111111");
        let expected_hash = validate_pdf(&corrupt_stage.preview_pdf).unwrap().sha256;
        let corrupt_entry = cache
            .publish(
                "11111111111111111111111111111111",
                &corrupt_identity,
                &expected_hash,
            )
            .unwrap();
        let _clean_stage = stage_fixture(&cache, "22222222222222222222222222222222");
        cache
            .publish(
                "22222222222222222222222222222222",
                &clean_identity,
                &expected_hash,
            )
            .unwrap();
        fs::write(corrupt_entry.entry_dir.join("preview.pdf"), b"corrupt").unwrap();

        assert_eq!(cache.load_validated(&corrupt_identity).unwrap(), None);
        assert!(!corrupt_entry.entry_dir.exists());
        assert!(cache.load_validated(&clean_identity).unwrap().is_some());

        let _rerender_stage = stage_fixture(&cache, "33333333333333333333333333333333");
        let rerendered = cache
            .publish(
                "33333333333333333333333333333333",
                &corrupt_identity,
                &expected_hash,
            )
            .unwrap();
        assert!(!rerendered.reused);
        assert_eq!(rerendered.manifest.output_sha256, expected_hash);
    }

    #[test]
    fn failure_before_atomic_publication_leaves_previous_entry_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(directory.path()).unwrap();
        let cache_identity = identity("wps", "1");
        let first_stage = stage_fixture(&cache, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let expected_hash = validate_pdf(&first_stage.preview_pdf).unwrap().sha256;
        let published = cache
            .publish(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                &cache_identity,
                &expected_hash,
            )
            .unwrap();
        let before_pdf = fs::read(published.entry_dir.join("preview.pdf")).unwrap();
        let before_manifest = fs::read(published.entry_dir.join("manifest.json")).unwrap();

        let _failed_stage = stage_fixture(&cache, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let unpublished_identity = identity("wps", "2");
        assert_eq!(
            cache
                .publish_with_pre_rename_failure_for_test(
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    &unpublished_identity,
                    &expected_hash,
                )
                .unwrap_err(),
            CacheError::InjectedPrePublishFailure
        );
        drop(_failed_stage);
        assert!(!directory
            .path()
            .join("staging/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            .exists());
        assert!(!fs::read_dir(directory.path().join("previews"))
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".publishing")));
        assert_eq!(
            fs::read(published.entry_dir.join("preview.pdf")).unwrap(),
            before_pdf
        );
        assert_eq!(
            fs::read(published.entry_dir.join("manifest.json")).unwrap(),
            before_manifest
        );
    }

    #[test]
    fn bytes_promoted_are_revalidated_after_deterministic_staged_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(directory.path()).unwrap();
        let cache_identity = identity("wps", "destination-binding");
        let stage = stage_fixture(&cache, "dddddddddddddddddddddddddddddddd");
        let expected_hash = validate_pdf(&stage.preview_pdf).unwrap().sha256;
        let final_entry = directory
            .path()
            .join("previews")
            .join(cache_identity.cache_key());

        assert_eq!(
            cache
                .publish_with_staged_mutation_for_test(
                    "dddddddddddddddddddddddddddddddd",
                    &cache_identity,
                    &expected_hash,
                )
                .unwrap_err(),
            CacheError::OutputHashMismatch
        );
        assert!(!final_entry.exists());
    }

    #[test]
    fn owned_staging_jobs_cleanup_after_repeated_terminal_failures() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(directory.path()).unwrap();
        for job_id in [
            "10101010101010101010101010101010",
            "20202020202020202020202020202020",
            "30303030303030303030303030303030",
        ] {
            let owned = cache.prepare_job(job_id).unwrap();
            fs::write(owned.job_dir.join("source.docx"), b"host-private").unwrap();
            fs::write(&owned.preview_pdf, b"failed-render").unwrap();
            drop(owned);
        }

        assert_eq!(
            fs::read_dir(directory.path().join("staging"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn cache_open_removes_only_strictly_validated_owned_orphans() {
        let directory = tempfile::tempdir().unwrap();
        let staging_root = directory.path().join("staging");
        let previews_root = directory.path().join("previews");
        fs::create_dir_all(&staging_root).unwrap();
        fs::create_dir_all(&previews_root).unwrap();
        let owned_job = staging_root.join("40404040404040404040404040404040");
        let invalid_job = staging_root.join("user-data");
        fs::create_dir(&owned_job).unwrap();
        fs::create_dir(&invalid_job).unwrap();
        let cache_key = "55".repeat(32);
        let publishing = previews_root.join(format!(
            ".{cache_key}.60606060606060606060606060606060.publishing"
        ));
        let invalid_publishing = previews_root.join(".not-owned.publishing");
        let immutable_entry = previews_root.join(&cache_key);
        fs::create_dir(&publishing).unwrap();
        fs::create_dir(&invalid_publishing).unwrap();
        fs::create_dir(&immutable_entry).unwrap();
        #[cfg(unix)]
        let symlink_job = {
            use std::os::unix::fs::symlink;
            let path = staging_root.join("70707070707070707070707070707070");
            symlink(directory.path(), &path).unwrap();
            path
        };

        PreviewCache::open(directory.path()).unwrap();

        assert!(!owned_job.exists());
        assert!(!publishing.exists());
        assert!(invalid_job.exists());
        assert!(invalid_publishing.exists());
        assert!(immutable_entry.exists());
        #[cfg(unix)]
        assert!(fs::symlink_metadata(symlink_job)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn post_publish_authorization_failure_keeps_immutable_entry_and_no_job_data() {
        use crate::artifact_store::{ArtifactKind, ArtifactStore, StoreError};

        let directory = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(directory.path()).unwrap();
        let cache_identity = identity("wps", "authorization-failure");
        let stage = stage_fixture(&cache, "80808080808080808080808080808080");
        let expected_hash = validate_pdf(&stage.preview_pdf).unwrap().sha256;
        let published = cache
            .publish(
                "80808080808080808080808080808080",
                &cache_identity,
                &expected_hash,
            )
            .unwrap();
        let before = fs::read(published.entry_dir.join("preview.pdf")).unwrap();

        assert_eq!(
            ArtifactStore::with_max_size(1)
                .authorize_path(
                    &published.entry_dir.join("preview.pdf"),
                    ArtifactKind::Preview,
                )
                .unwrap_err(),
            StoreError::TooLarge
        );
        assert_eq!(
            fs::read(published.entry_dir.join("preview.pdf")).unwrap(),
            before
        );
        assert_eq!(
            fs::read_dir(directory.path().join("staging"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn manifest_is_path_free_and_binds_all_cache_identity_fields() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(directory.path()).unwrap();
        let cache_identity = identity("wps", "12.1");
        let stage = stage_fixture(&cache, "cccccccccccccccccccccccccccccccc");
        let expected_hash = validate_pdf(&stage.preview_pdf).unwrap().sha256;
        let published = cache
            .publish(
                "cccccccccccccccccccccccccccccccc",
                &cache_identity,
                &expected_hash,
            )
            .unwrap();
        let manifest: PublishManifest =
            serde_json::from_slice(&fs::read(published.entry_dir.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest.cache_key, cache_identity.cache_key());
        assert_eq!(manifest.page_count, 100);
        let serialized = serde_json::to_string(&manifest).unwrap();
        assert!(!serialized.contains(directory.path().to_string_lossy().as_ref()));
        assert!(!serialized.contains("staging"));
        assert!(cache.cache_bytes().unwrap() > 0);
    }
}
