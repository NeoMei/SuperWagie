use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, RwLock};
use uuid::Uuid;

pub const DEFAULT_MAX_ARTIFACT_SIZE: u64 = 128 * 1024 * 1024;
pub const MAX_READ_RANGE: usize = 8 * 1024 * 1024;
const PDF_EOF_SCAN_LIMIT: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Artifact,
    Preview,
}

impl ArtifactKind {
    pub fn parse(value: &str) -> Result<Self, StoreError> {
        match value {
            "artifact" => Ok(Self::Artifact),
            "preview" => Ok(Self::Preview),
            _ => Err(StoreError::InvalidKind),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactOpened {
    pub handle: String,
    pub display_name: String,
    pub media_type: String,
    pub size: u64,
    pub revision_hash: String,
}

#[derive(Clone)]
pub(crate) struct AuthorizedArtifact {
    pub(crate) handle: String,
    pub(crate) kind: ArtifactKind,
    pub(crate) display_name: String,
    pub(crate) media_type: String,
    pub(crate) size: u64,
    pub(crate) revision_hash: String,
    pub(crate) extension: String,
    bytes: Arc<[u8]>,
}

impl std::fmt::Debug for AuthorizedArtifact {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthorizedArtifact")
            .field("handle", &self.handle)
            .field("kind", &self.kind)
            .field("display_name", &self.display_name)
            .field("media_type", &self.media_type)
            .field("size", &self.size)
            .field("revision_hash", &self.revision_hash)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct ArtifactStore {
    artifacts: Arc<RwLock<HashMap<String, AuthorizedArtifact>>>,
    max_size: u64,
}

impl Default for ArtifactStore {
    fn default() -> Self {
        Self::with_max_size(DEFAULT_MAX_ARTIFACT_SIZE)
    }
}

impl ArtifactStore {
    pub fn with_max_size(max_size: u64) -> Self {
        Self {
            artifacts: Arc::new(RwLock::new(HashMap::new())),
            max_size,
        }
    }

    pub fn authorize_path(
        &self,
        path: &Path,
        kind: ArtifactKind,
    ) -> Result<ArtifactOpened, StoreError> {
        let initial = fs::symlink_metadata(path).map_err(map_io)?;
        if initial.file_type().is_symlink() {
            return Err(StoreError::Symlink);
        }
        if !initial.file_type().is_file() {
            return Err(StoreError::NotRegularFile);
        }
        if initial.len() > self.max_size {
            return Err(StoreError::TooLarge);
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .ok_or(StoreError::UnsupportedExtension)?;
        if !matches!(extension.as_str(), "pdf" | "docx" | "pptx") {
            return Err(StoreError::UnsupportedExtension);
        }

        let mut file = OpenOptions::new().read(true).open(path).map_err(map_io)?;
        let opened = file.metadata().map_err(map_io)?;
        let after_open = fs::symlink_metadata(path).map_err(map_io)?;
        if after_open.file_type().is_symlink() {
            return Err(StoreError::Symlink);
        }
        if !opened.is_file() || !after_open.is_file() {
            return Err(StoreError::NotRegularFile);
        }
        if opened.len() != initial.len() || after_open.len() != initial.len() {
            return Err(StoreError::FileChangedDuringAuthorization);
        }
        if !same_file_identity(&initial, &opened) || !same_file_identity(&opened, &after_open) {
            return Err(StoreError::FileChangedDuringAuthorization);
        }

        let mut bytes =
            Vec::with_capacity(usize::try_from(opened.len()).map_err(|_| StoreError::TooLarge)?);
        file.read_to_end(&mut bytes).map_err(map_io)?;
        if u64::try_from(bytes.len()).map_err(|_| StoreError::TooLarge)? != opened.len() {
            return Err(StoreError::FileChangedDuringAuthorization);
        }
        validate_format(&extension, &bytes)?;
        let revision_hash = hex_digest(&bytes);

        let handle = Uuid::new_v4().simple().to_string();
        let display_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact")
            .to_owned();
        let media_type = media_type_for(&extension).to_owned();
        let artifact = AuthorizedArtifact {
            handle: handle.clone(),
            kind,
            display_name: display_name.clone(),
            media_type: media_type.clone(),
            size: opened.len(),
            revision_hash: revision_hash.clone(),
            extension,
            bytes: Arc::from(bytes),
        };
        self.artifacts
            .write()
            .map_err(|_| StoreError::StorePoisoned)?
            .insert(handle.clone(), artifact);

        Ok(ArtifactOpened {
            handle,
            display_name,
            media_type,
            size: opened.len(),
            revision_hash,
        })
    }

    pub(crate) fn resolve(&self, handle: &str) -> Result<AuthorizedArtifact, StoreError> {
        self.artifacts
            .read()
            .map_err(|_| StoreError::StorePoisoned)?
            .get(handle)
            .cloned()
            .ok_or(StoreError::NotFound)
    }

    pub fn public_metadata(&self, handle: &str) -> Result<ArtifactOpened, StoreError> {
        let artifact = self.resolve(handle)?;
        Ok(ArtifactOpened {
            handle: artifact.handle,
            display_name: artifact.display_name,
            media_type: artifact.media_type,
            size: artifact.size,
            revision_hash: artifact.revision_hash,
        })
    }

    pub fn read_range(
        &self,
        handle: &str,
        start: usize,
        length: usize,
    ) -> Result<Vec<u8>, StoreError> {
        if length > MAX_READ_RANGE {
            return Err(StoreError::RangeTooLarge);
        }
        let artifact = self.resolve(handle)?;
        let size = usize::try_from(artifact.size).map_err(|_| StoreError::InvalidRange)?;
        if start > size || (start == size && length != 0) {
            return Err(StoreError::InvalidRange);
        }
        let available = size - start;
        let read_length = length.min(available);
        Ok(artifact.bytes[start..start + read_length].to_vec())
    }

    pub fn validate_kind(&self, handle: &str, kind: ArtifactKind) -> Result<(), StoreError> {
        if self.resolve(handle)?.kind == kind {
            Ok(())
        } else {
            Err(StoreError::KindMismatch)
        }
    }

    pub fn open_controlled_copy_with<L: ControlledCopyLauncher + ?Sized>(
        &self,
        handle: &str,
        jobs_root: &Path,
        launcher: &L,
    ) -> Result<ControlledCopyReceipt, StoreError> {
        let artifact = self.resolve(handle)?;
        if artifact.kind != ArtifactKind::Artifact {
            return Err(StoreError::KindMismatch);
        }
        if !matches!(artifact.extension.as_str(), "docx" | "pptx") {
            return Err(StoreError::ControlledCopyUnsupported);
        }

        ensure_owned_directory(jobs_root)?;
        let receipt_id = Uuid::new_v4().simple().to_string();
        let job_dir = jobs_root.join(&receipt_id);
        fs::create_dir(&job_dir).map_err(map_io)?;
        restrict_owner_access(&job_dir, true)?;
        let copy_path = job_dir.join(format!("review-copy.{}", artifact.extension));
        let mut destination = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&copy_path)
            .map_err(map_io)?;
        restrict_owner_access(&copy_path, false)?;
        destination.write_all(&artifact.bytes).map_err(map_io)?;
        destination.flush().map_err(map_io)?;
        destination.sync_all().map_err(map_io)?;
        drop(destination);
        sync_directory(&job_dir)?;

        let mut copied_file = File::open(&copy_path).map_err(map_io)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = copied_file.read(&mut buffer).map_err(map_io)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let copied_hash = encode_hex(hasher.finalize().as_ref());
        if copied_hash != artifact.revision_hash {
            return Err(StoreError::CopyVerificationFailed);
        }
        launcher.launch(&copy_path)?;
        Ok(ControlledCopyReceipt { receipt_id })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlledCopyReceipt {
    pub receipt_id: String,
}

pub trait ControlledCopyLauncher: Send + Sync {
    fn launch(&self, path: &Path) -> Result<(), StoreError>;
}

pub struct PlatformLauncher;

impl ControlledCopyLauncher for PlatformLauncher {
    fn launch(&self, path: &Path) -> Result<(), StoreError> {
        #[cfg(target_os = "macos")]
        let status = Command::new("/usr/bin/open").arg(path).status();
        #[cfg(target_os = "windows")]
        let status = Command::new("explorer.exe").arg(path).status();
        #[cfg(all(unix, not(target_os = "macos")))]
        let status = Command::new("/usr/bin/xdg-open").arg(path).status();
        let status = status.map_err(|_| StoreError::LaunchFailed)?;
        if status.success() {
            Ok(())
        } else {
            Err(StoreError::LaunchFailed)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreError {
    NotFound,
    InvalidKind,
    KindMismatch,
    Symlink,
    NotRegularFile,
    TooLarge,
    UnsupportedExtension,
    InvalidFormat,
    FileChangedDuringAuthorization,
    InvalidRange,
    RangeTooLarge,
    ControlledCopyUnsupported,
    CopyVerificationFailed,
    LaunchFailed,
    Io,
    StorePoisoned,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for StoreError {}

impl StoreError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "SW_REVIEW_ARTIFACT_NOT_FOUND",
            Self::InvalidKind => "SW_REVIEW_ASSET_KIND_INVALID",
            Self::KindMismatch => "SW_REVIEW_ASSET_KIND_MISMATCH",
            Self::Symlink => "SW_REVIEW_ARTIFACT_SYMLINK_DENIED",
            Self::NotRegularFile => "SW_REVIEW_ARTIFACT_NOT_REGULAR",
            Self::TooLarge => "SW_REVIEW_ARTIFACT_TOO_LARGE",
            Self::UnsupportedExtension => "SW_REVIEW_ARTIFACT_EXTENSION_UNSUPPORTED",
            Self::InvalidFormat => "SW_REVIEW_ARTIFACT_FORMAT_INVALID",
            Self::FileChangedDuringAuthorization => "SW_REVIEW_ARTIFACT_CHANGED",
            Self::InvalidRange => "SW_REVIEW_RANGE_INVALID",
            Self::RangeTooLarge => "SW_REVIEW_RANGE_TOO_LARGE",
            Self::ControlledCopyUnsupported => "SW_REVIEW_CONTROLLED_COPY_UNSUPPORTED",
            Self::CopyVerificationFailed => "SW_REVIEW_CONTROLLED_COPY_HASH_MISMATCH",
            Self::LaunchFailed => "SW_REVIEW_CONTROLLED_COPY_LAUNCH_FAILED",
            Self::Io => "SW_REVIEW_HOST_IO_FAILED",
            Self::StorePoisoned => "SW_REVIEW_HOST_STATE_UNAVAILABLE",
        }
    }
}

fn map_io(_error: std::io::Error) -> StoreError {
    StoreError::Io
}

fn media_type_for(extension: &str) -> &'static str {
    match extension {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    encode_hex(Sha256::digest(bytes).as_ref())
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

fn validate_format(extension: &str, bytes: &[u8]) -> Result<(), StoreError> {
    match extension {
        "pdf" => validate_pdf(bytes),
        "docx" => validate_ooxml(bytes, OoxmlKind::Docx),
        "pptx" => validate_ooxml(bytes, OoxmlKind::Pptx),
        _ => Err(StoreError::UnsupportedExtension),
    }
}

fn validate_pdf(bytes: &[u8]) -> Result<(), StoreError> {
    if !bytes.starts_with(b"%PDF-") || !has_bounded_final_pdf_eof(bytes) {
        return Err(StoreError::InvalidFormat);
    }
    let document = lopdf::Document::load_mem(bytes).map_err(|_| StoreError::InvalidFormat)?;
    document
        .trailer
        .get(b"Root")
        .map_err(|_| StoreError::InvalidFormat)?;
    document.catalog().map_err(|_| StoreError::InvalidFormat)?;
    Ok(())
}

fn has_bounded_final_pdf_eof(bytes: &[u8]) -> bool {
    let mut cursor = bytes.len();
    let mut trailing_whitespace = 0_usize;
    while cursor > 0 && is_pdf_whitespace(bytes[cursor - 1]) {
        trailing_whitespace += 1;
        if trailing_whitespace + b"%%EOF".len() > PDF_EOF_SCAN_LIMIT {
            return false;
        }
        cursor -= 1;
    }
    cursor >= b"%%EOF".len() && bytes.get(cursor - b"%%EOF".len()..cursor) == Some(b"%%EOF")
}

fn is_pdf_whitespace(byte: u8) -> bool {
    matches!(byte, b'\0' | b'\t' | b'\n' | 0x0c | b'\r' | b' ')
}

#[derive(Clone, Copy)]
enum OoxmlKind {
    Docx,
    Pptx,
}

fn validate_ooxml(bytes: &[u8], expected: OoxmlKind) -> Result<(), StoreError> {
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err(StoreError::InvalidFormat);
    }
    let eocd = find_eocd(bytes).ok_or(StoreError::InvalidFormat)?;
    if read_u16(bytes, eocd + 4)? != 0 || read_u16(bytes, eocd + 6)? != 0 {
        return Err(StoreError::InvalidFormat);
    }
    let disk_entries = usize::from(read_u16(bytes, eocd + 8)?);
    let total_entries = usize::from(read_u16(bytes, eocd + 10)?);
    if disk_entries != total_entries || total_entries == usize::from(u16::MAX) {
        return Err(StoreError::InvalidFormat);
    }
    let central_size =
        usize::try_from(read_u32(bytes, eocd + 12)?).map_err(|_| StoreError::InvalidFormat)?;
    let central_offset =
        usize::try_from(read_u32(bytes, eocd + 16)?).map_err(|_| StoreError::InvalidFormat)?;
    let comment_length = usize::from(read_u16(bytes, eocd + 20)?);
    if eocd.checked_add(22 + comment_length) != Some(bytes.len())
        || central_offset.checked_add(central_size) != Some(eocd)
    {
        return Err(StoreError::InvalidFormat);
    }

    let mut cursor = central_offset;
    let mut names = HashSet::new();
    for _ in 0..total_entries {
        if read_u32(bytes, cursor)? != 0x0201_4b50 {
            return Err(StoreError::InvalidFormat);
        }
        let flags = read_u16(bytes, cursor + 8)?;
        let method = read_u16(bytes, cursor + 10)?;
        if flags & 1 != 0 || !matches!(method, 0 | 8) {
            return Err(StoreError::InvalidFormat);
        }
        let compressed_size = usize::try_from(read_u32(bytes, cursor + 20)?)
            .map_err(|_| StoreError::InvalidFormat)?;
        let name_length = usize::from(read_u16(bytes, cursor + 28)?);
        let extra_length = usize::from(read_u16(bytes, cursor + 30)?);
        let comment_length = usize::from(read_u16(bytes, cursor + 32)?);
        let local_offset = usize::try_from(read_u32(bytes, cursor + 42)?)
            .map_err(|_| StoreError::InvalidFormat)?;
        let name_start = cursor.checked_add(46).ok_or(StoreError::InvalidFormat)?;
        let name_end = name_start
            .checked_add(name_length)
            .ok_or(StoreError::InvalidFormat)?;
        let name = std::str::from_utf8(slice(bytes, name_start, name_end)?)
            .map_err(|_| StoreError::InvalidFormat)?;
        validate_zip_name(name)?;
        if !names.insert(name.to_owned()) {
            return Err(StoreError::InvalidFormat);
        }
        validate_local_entry(
            bytes,
            local_offset,
            name,
            method,
            compressed_size,
            central_offset,
        )?;
        cursor = name_end
            .checked_add(extra_length)
            .and_then(|value| value.checked_add(comment_length))
            .ok_or(StoreError::InvalidFormat)?;
        if cursor > eocd {
            return Err(StoreError::InvalidFormat);
        }
    }
    if cursor != eocd || !names.contains("[Content_Types].xml") {
        return Err(StoreError::InvalidFormat);
    }
    match expected {
        OoxmlKind::Docx
            if names.contains("word/document.xml") && !names.contains("ppt/presentation.xml") => {}
        OoxmlKind::Pptx
            if names.contains("ppt/presentation.xml") && !names.contains("word/document.xml") => {}
        _ => return Err(StoreError::InvalidFormat),
    }
    Ok(())
}

fn find_eocd(bytes: &[u8]) -> Option<usize> {
    let minimum = bytes.len().saturating_sub(65_557);
    (minimum..bytes.len().saturating_sub(3))
        .rev()
        .find(|offset| bytes.get(*offset..offset + 4) == Some(b"PK\x05\x06"))
}

fn validate_local_entry(
    bytes: &[u8],
    offset: usize,
    expected_name: &str,
    expected_method: u16,
    compressed_size: usize,
    central_offset: usize,
) -> Result<(), StoreError> {
    if read_u32(bytes, offset)? != 0x0403_4b50 || read_u16(bytes, offset + 8)? != expected_method {
        return Err(StoreError::InvalidFormat);
    }
    let name_length = usize::from(read_u16(bytes, offset + 26)?);
    let extra_length = usize::from(read_u16(bytes, offset + 28)?);
    let name_start = offset.checked_add(30).ok_or(StoreError::InvalidFormat)?;
    let name_end = name_start
        .checked_add(name_length)
        .ok_or(StoreError::InvalidFormat)?;
    if slice(bytes, name_start, name_end)? != expected_name.as_bytes() {
        return Err(StoreError::InvalidFormat);
    }
    let data_end = name_end
        .checked_add(extra_length)
        .and_then(|value| value.checked_add(compressed_size))
        .ok_or(StoreError::InvalidFormat)?;
    if data_end > central_offset {
        return Err(StoreError::InvalidFormat);
    }
    Ok(())
}

fn validate_zip_name(name: &str) -> Result<(), StoreError> {
    if name.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.split('/').any(|part| matches!(part, "." | ".."))
    {
        Err(StoreError::InvalidFormat)
    } else {
        Ok(())
    }
}

fn slice(bytes: &[u8], start: usize, end: usize) -> Result<&[u8], StoreError> {
    bytes.get(start..end).ok_or(StoreError::InvalidFormat)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, StoreError> {
    let value: [u8; 2] = slice(
        bytes,
        offset,
        offset.checked_add(2).ok_or(StoreError::InvalidFormat)?,
    )?
    .try_into()
    .map_err(|_| StoreError::InvalidFormat)?;
    Ok(u16::from_le_bytes(value))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, StoreError> {
    let value: [u8; 4] = slice(
        bytes,
        offset,
        offset.checked_add(4).ok_or(StoreError::InvalidFormat)?,
    )?
    .try_into()
    .map_err(|_| StoreError::InvalidFormat)?;
    Ok(u32::from_le_bytes(value))
}

fn ensure_owned_directory(path: &Path) -> Result<(), StoreError> {
    fs::create_dir_all(path).map_err(map_io)?;
    let metadata = fs::symlink_metadata(path).map_err(map_io)?;
    if metadata.file_type().is_symlink() {
        Err(StoreError::Symlink)
    } else if !metadata.is_dir() {
        Err(StoreError::NotRegularFile)
    } else {
        Ok(())
    }
}

fn sync_directory(path: &Path) -> Result<(), StoreError> {
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

fn restrict_owner_access(path: &Path, directory: bool) -> Result<(), StoreError> {
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

#[cfg(unix)]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.created().ok() == right.created().ok()
}
