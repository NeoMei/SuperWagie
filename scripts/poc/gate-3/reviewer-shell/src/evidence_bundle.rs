#[cfg(test)]
use rustix::fs::renameat;
use rustix::fs::{
    fstat, fsync, mkdirat, open, openat, renameat_with, statat, unlinkat, AtFlags, Dir, FileType,
    Mode, OFlags, RenameFlags, Stat,
};
use rustix::io::Errno;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::os::fd::OwnedFd;
#[cfg(unix)]
use std::os::unix::fs::FileExt;
use std::path::Path;
use uuid::Uuid;

const PAGE_DIFF_FILES: [&str; 3] = ["diff.png", "diff-stats.json", "comparison-manifest.json"];
const AGENT_REQUEST_FILE: &str = "agent-change-request.json";

#[derive(Debug)]
pub struct EvidenceBundle {
    directory_name: String,
    files: BTreeMap<String, Vec<u8>>,
}

impl EvidenceBundle {
    pub fn page_diff(
        key: &str,
        png: Vec<u8>,
        statistics: Vec<u8>,
        manifest: Vec<u8>,
    ) -> Result<Self, PublishError> {
        validate_key(key)?;
        let manifest_value: Value =
            serde_json::from_slice(&manifest).map_err(|_| PublishError::InvalidBundle)?;
        if manifest_value.get("comparisonKey").and_then(Value::as_str) != Some(key) {
            return Err(PublishError::InvalidBundle);
        }
        let statistics_value: Value =
            serde_json::from_slice(&statistics).map_err(|_| PublishError::InvalidBundle)?;
        if !statistics_value.is_object() || png.is_empty() {
            return Err(PublishError::InvalidBundle);
        }
        Ok(Self {
            directory_name: format!("comparison-{key}"),
            files: BTreeMap::from([
                (PAGE_DIFF_FILES[0].to_string(), png),
                (PAGE_DIFF_FILES[1].to_string(), statistics),
                (PAGE_DIFF_FILES[2].to_string(), manifest),
            ]),
        })
    }

    pub fn agent_request(key: &str, request: Vec<u8>) -> Result<Self, PublishError> {
        validate_key(key)?;
        if sha256_hex(&request) != key || serde_json::from_slice::<Value>(&request).is_err() {
            return Err(PublishError::InvalidBundle);
        }
        Ok(Self {
            directory_name: format!("request-{key}"),
            files: BTreeMap::from([(AGENT_REQUEST_FILE.to_string(), request)]),
        })
    }

    pub fn files(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.files
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishDisposition {
    Published,
    Reused,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishError {
    UnsafeRoot,
    InvalidBundle,
    Conflict,
    IdentityMismatch,
    ContentChanged,
    Injected,
    Io,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FaultPoint {
    AfterStageDirectoryCreated,
    BeforeFileWrite(usize),
    BeforeFileSync(usize),
    BeforeStageDirectorySync,
    BeforePublishRename,
    AfterPublishRename,
    BeforeRootSync,
    SwapStageEntryBeforeCommit,
    SwapFinalEntryDuringReuse,
    SwapFinalEntryAfterCommitCheck,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ObjectIdentity {
    device: u64,
    inode: u64,
}

impl ObjectIdentity {
    fn from_stat(stat: &Stat) -> Self {
        Self {
            device: stat.st_dev as u64,
            inode: stat.st_ino,
        }
    }
}

#[derive(Debug)]
struct AcceptedFile {
    file: File,
    identity: ObjectIdentity,
    owner: u32,
    length: usize,
    digest: String,
}

#[derive(Debug)]
pub struct AcceptedBundle {
    disposition: PublishDisposition,
    directory: OwnedFd,
    directory_identity: ObjectIdentity,
    owner: u32,
    files: BTreeMap<String, AcceptedFile>,
    content_digest: String,
}

impl AcceptedBundle {
    pub fn disposition(&self) -> PublishDisposition {
        self.disposition
    }

    pub fn content_digest(&self) -> &str {
        &self.content_digest
    }

    #[cfg(unix)]
    pub fn read_verified(&self, name: &str) -> Result<Vec<u8>, PublishError> {
        let entry = self.files.get(name).ok_or(PublishError::InvalidBundle)?;
        let directory_stat = fstat(&self.directory).map_err(|_| PublishError::Io)?;
        validate_directory(&directory_stat, self.owner)?;
        if ObjectIdentity::from_stat(&directory_stat) != self.directory_identity {
            return Err(PublishError::IdentityMismatch);
        }
        let before = fstat(&entry.file).map_err(|_| PublishError::Io)?;
        validate_regular_file(&before, entry.owner)?;
        if ObjectIdentity::from_stat(&before) != entry.identity
            || usize::try_from(before.st_size).ok() != Some(entry.length)
        {
            return Err(PublishError::ContentChanged);
        }
        let visible = statat(&self.directory, name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|_| PublishError::IdentityMismatch)?;
        if ObjectIdentity::from_stat(&visible) != entry.identity {
            return Err(PublishError::IdentityMismatch);
        }
        let bytes = read_exact_at(&entry.file, entry.length)?;
        let after = fstat(&entry.file).map_err(|_| PublishError::Io)?;
        validate_regular_file(&after, entry.owner)?;
        if ObjectIdentity::from_stat(&after) != entry.identity
            || usize::try_from(after.st_size).ok() != Some(entry.length)
            || sha256_hex(&bytes) != entry.digest
        {
            return Err(PublishError::ContentChanged);
        }
        Ok(bytes)
    }
}

#[derive(Debug)]
pub struct EvidencePublisher {
    root: OwnedFd,
    #[cfg(test)]
    fault: Option<FaultPoint>,
}

impl EvidencePublisher {
    pub fn open(root: &Path) -> Result<Self, PublishError> {
        let root = open(
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| PublishError::UnsafeRoot)?;
        Ok(Self {
            root,
            #[cfg(test)]
            fault: None,
        })
    }

    #[cfg(test)]
    pub fn open_with_fault(root: &Path, fault: FaultPoint) -> Result<Self, PublishError> {
        let mut publisher = Self::open(root)?;
        publisher.fault = Some(fault);
        Ok(publisher)
    }

    pub fn publish(&self, bundle: &EvidenceBundle) -> Result<AcceptedBundle, PublishError> {
        let stage_name = format!(".evidence-stage-{}", Uuid::new_v4());
        mkdirat(&self.root, &stage_name, Mode::from_bits_truncate(0o700))
            .map_err(|_| PublishError::Io)?;

        let staged_result = self.stage_and_commit(&stage_name, bundle);
        match staged_result {
            Ok(accepted) if accepted.disposition == PublishDisposition::Published => {
                self.inject_after_commit(FaultPointName::AfterPublishRename)?;
                self.inject_after_commit(FaultPointName::BeforeRootSync)?;
                fsync(&self.root).map_err(|_| PublishError::Io)?;
                self.test_swap_visible(
                    FaultPointName::SwapFinalEntryAfterCommitCheck,
                    &bundle.directory_name,
                )?;
                Ok(accepted)
            }
            Ok(accepted) => {
                self.remove_stage(&stage_name, bundle);
                Ok(accepted)
            }
            Err(error) => {
                self.remove_stage(&stage_name, bundle);
                Err(error)
            }
        }
    }

    fn stage_and_commit(
        &self,
        stage_name: &str,
        bundle: &EvidenceBundle,
    ) -> Result<AcceptedBundle, PublishError> {
        self.inject(FaultPointName::AfterStageDirectoryCreated, 0)?;
        let stage = openat(
            &self.root,
            stage_name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| PublishError::Io)?;
        let root_stat = fstat(&self.root).map_err(|_| PublishError::Io)?;
        let owner = root_stat.st_uid;
        let stage_stat = fstat(&stage).map_err(|_| PublishError::Io)?;
        validate_directory(&stage_stat, owner)?;
        let stage_identity = ObjectIdentity::from_stat(&stage_stat);
        let mut accepted_files = BTreeMap::new();

        for (index, (name, bytes)) in bundle.files.iter().enumerate() {
            self.inject(FaultPointName::BeforeFileWrite, index)?;
            let file = openat(
                &stage,
                name,
                OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| PublishError::Io)?;
            let mut file = File::from(file);
            file.write_all(bytes).map_err(|_| PublishError::Io)?;
            self.inject(FaultPointName::BeforeFileSync, index)?;
            file.sync_all().map_err(|_| PublishError::Io)?;
            let stat = fstat(&file).map_err(|_| PublishError::Io)?;
            validate_regular_file(&stat, owner)?;
            accepted_files.insert(
                name.clone(),
                AcceptedFile {
                    file,
                    identity: ObjectIdentity::from_stat(&stat),
                    owner,
                    length: bytes.len(),
                    digest: sha256_hex(bytes),
                },
            );
        }
        self.inject(FaultPointName::BeforeStageDirectorySync, 0)?;
        fsync(&stage).map_err(|_| PublishError::Io)?;
        self.inject(FaultPointName::BeforePublishRename, 0)?;
        self.test_swap_visible(FaultPointName::SwapStageEntryBeforeCommit, stage_name)?;
        revalidate_accepted_files(&stage, &accepted_files)?;
        require_held_visible_identity(
            &stage,
            &self.root,
            stage_name,
            stage_identity,
            FileType::Directory,
        )?;

        match renameat_with(
            &self.root,
            stage_name,
            &self.root,
            &bundle.directory_name,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {
                require_held_visible_identity(
                    &stage,
                    &self.root,
                    &bundle.directory_name,
                    stage_identity,
                    FileType::Directory,
                )?;
                revalidate_accepted_files(&stage, &accepted_files)?;
                Ok(build_accepted_bundle(
                    PublishDisposition::Published,
                    stage,
                    stage_identity,
                    owner,
                    accepted_files,
                ))
            }
            Err(Errno::EXIST) => self.open_identical_existing(bundle, owner),
            Err(_) => Err(PublishError::Io),
        }
    }

    fn open_identical_existing(
        &self,
        bundle: &EvidenceBundle,
        owner: u32,
    ) -> Result<AcceptedBundle, PublishError> {
        let pre_open = statat(
            &self.root,
            &bundle.directory_name,
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|_| PublishError::Conflict)?;
        validate_directory(&pre_open, owner)?;
        let existing = openat(
            &self.root,
            &bundle.directory_name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| PublishError::Conflict)?;
        let existing_stat = fstat(&existing).map_err(|_| PublishError::Io)?;
        validate_directory(&existing_stat, owner)?;
        let existing_identity = ObjectIdentity::from_stat(&existing_stat);
        if ObjectIdentity::from_stat(&pre_open) != existing_identity {
            return Err(PublishError::IdentityMismatch);
        }
        let mut actual_names = Vec::new();
        let mut directory = Dir::read_from(&existing).map_err(|_| PublishError::Io)?;
        while let Some(entry) = directory.read() {
            let entry = entry.map_err(|_| PublishError::Io)?;
            let name = entry.file_name().to_string_lossy();
            if name != "." && name != ".." {
                actual_names.push(name.into_owned());
            }
        }
        actual_names.sort();
        if actual_names != bundle.files.keys().cloned().collect::<Vec<_>>() {
            return Err(PublishError::Conflict);
        }
        let mut accepted_files = BTreeMap::new();
        for (name, expected) in &bundle.files {
            let before_open = statat(&existing, name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|_| PublishError::Conflict)?;
            validate_regular_file(&before_open, owner)?;
            let file = openat(
                &existing,
                name,
                OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| PublishError::Conflict)?;
            let file = File::from(file);
            let held_stat = fstat(&file).map_err(|_| PublishError::Io)?;
            validate_regular_file(&held_stat, owner)?;
            let identity = ObjectIdentity::from_stat(&held_stat);
            if ObjectIdentity::from_stat(&before_open) != identity
                || usize::try_from(held_stat.st_size).ok() != Some(expected.len())
            {
                return Err(PublishError::Conflict);
            }
            let actual = read_exact_at(&file, expected.len())?;
            let after_read = fstat(&file).map_err(|_| PublishError::Io)?;
            validate_regular_file(&after_read, owner)?;
            if ObjectIdentity::from_stat(&after_read) != identity
                || actual != *expected
                || sha256_hex(&actual) != sha256_hex(expected)
            {
                return Err(PublishError::Conflict);
            }
            accepted_files.insert(
                name.clone(),
                AcceptedFile {
                    file,
                    identity,
                    owner,
                    length: expected.len(),
                    digest: sha256_hex(expected),
                },
            );
        }
        self.test_swap_visible(
            FaultPointName::SwapFinalEntryDuringReuse,
            &bundle.directory_name,
        )?;
        require_held_visible_identity(
            &existing,
            &self.root,
            &bundle.directory_name,
            existing_identity,
            FileType::Directory,
        )?;
        revalidate_accepted_files(&existing, &accepted_files)?;
        Ok(build_accepted_bundle(
            PublishDisposition::Reused,
            existing,
            existing_identity,
            owner,
            accepted_files,
        ))
    }

    fn remove_stage(&self, stage_name: &str, bundle: &EvidenceBundle) {
        if let Ok(stage) = openat(
            &self.root,
            stage_name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            for name in bundle.files.keys() {
                let _ = unlinkat(&stage, name, AtFlags::empty());
            }
        }
        let _ = unlinkat(&self.root, stage_name, AtFlags::REMOVEDIR);
    }

    fn test_swap_visible(
        &self,
        point: FaultPointName,
        visible_name: &str,
    ) -> Result<(), PublishError> {
        #[cfg(test)]
        {
            let matches = matches!(
                (self.fault, point),
                (
                    Some(FaultPoint::SwapStageEntryBeforeCommit),
                    FaultPointName::SwapStageEntryBeforeCommit
                ) | (
                    Some(FaultPoint::SwapFinalEntryDuringReuse),
                    FaultPointName::SwapFinalEntryDuringReuse
                ) | (
                    Some(FaultPoint::SwapFinalEntryAfterCommitCheck),
                    FaultPointName::SwapFinalEntryAfterCommitCheck
                )
            );
            if matches {
                let displaced = format!(".displaced-{}", Uuid::new_v4());
                renameat(&self.root, visible_name, &self.root, &displaced)
                    .map_err(|_| PublishError::Io)?;
                mkdirat(&self.root, visible_name, Mode::from_bits_truncate(0o700))
                    .map_err(|_| PublishError::Io)?;
                let replacement = openat(
                    &self.root,
                    visible_name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| PublishError::Io)?;
                let attacker = openat(
                    &replacement,
                    "attacker",
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(|_| PublishError::Io)?;
                let mut attacker = File::from(attacker);
                attacker
                    .write_all(b"replacement")
                    .map_err(|_| PublishError::Io)?;
                attacker.sync_all().map_err(|_| PublishError::Io)?;
                fsync(&replacement).map_err(|_| PublishError::Io)?;
            }
        }
        let _ = (point, visible_name);
        Ok(())
    }

    fn inject(&self, name: FaultPointName, file_index: usize) -> Result<(), PublishError> {
        #[cfg(test)]
        {
            let matches = match (self.fault, name) {
                (
                    Some(FaultPoint::AfterStageDirectoryCreated),
                    FaultPointName::AfterStageDirectoryCreated,
                )
                | (
                    Some(FaultPoint::BeforeStageDirectorySync),
                    FaultPointName::BeforeStageDirectorySync,
                )
                | (Some(FaultPoint::BeforePublishRename), FaultPointName::BeforePublishRename) => {
                    true
                }
                (Some(FaultPoint::BeforeFileWrite(index)), FaultPointName::BeforeFileWrite)
                | (Some(FaultPoint::BeforeFileSync(index)), FaultPointName::BeforeFileSync) => {
                    index == file_index
                }
                _ => false,
            };
            if matches {
                return Err(PublishError::Injected);
            }
        }
        let _ = (name, file_index);
        Ok(())
    }

    fn inject_after_commit(&self, name: FaultPointName) -> Result<(), PublishError> {
        #[cfg(test)]
        {
            let matches = matches!(
                (self.fault, name),
                (
                    Some(FaultPoint::AfterPublishRename),
                    FaultPointName::AfterPublishRename
                ) | (
                    Some(FaultPoint::BeforeRootSync),
                    FaultPointName::BeforeRootSync
                )
            );
            if matches {
                return Err(PublishError::Injected);
            }
        }
        let _ = name;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum FaultPointName {
    AfterStageDirectoryCreated,
    BeforeFileWrite,
    BeforeFileSync,
    BeforeStageDirectorySync,
    BeforePublishRename,
    AfterPublishRename,
    BeforeRootSync,
    SwapStageEntryBeforeCommit,
    SwapFinalEntryDuringReuse,
    SwapFinalEntryAfterCommitCheck,
}

fn validate_directory(stat: &Stat, owner: u32) -> Result<(), PublishError> {
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory
        || stat.st_uid != owner
        || Mode::from_raw_mode(stat.st_mode) != Mode::from_bits_truncate(0o700)
    {
        return Err(PublishError::Conflict);
    }
    Ok(())
}

fn validate_regular_file(stat: &Stat, owner: u32) -> Result<(), PublishError> {
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
        || stat.st_nlink != 1
        || stat.st_uid != owner
        || Mode::from_raw_mode(stat.st_mode) != Mode::from_bits_truncate(0o600)
    {
        return Err(PublishError::Conflict);
    }
    Ok(())
}

fn require_held_visible_identity(
    held: &OwnedFd,
    parent: &OwnedFd,
    name: &str,
    expected: ObjectIdentity,
    expected_type: FileType,
) -> Result<(), PublishError> {
    let held_stat = fstat(held).map_err(|_| PublishError::Io)?;
    let visible = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|_| PublishError::IdentityMismatch)?;
    if FileType::from_raw_mode(held_stat.st_mode) != expected_type
        || FileType::from_raw_mode(visible.st_mode) != expected_type
        || ObjectIdentity::from_stat(&held_stat) != expected
        || ObjectIdentity::from_stat(&visible) != expected
    {
        return Err(PublishError::IdentityMismatch);
    }
    Ok(())
}

fn revalidate_accepted_files(
    directory: &OwnedFd,
    files: &BTreeMap<String, AcceptedFile>,
) -> Result<(), PublishError> {
    for (name, entry) in files {
        let held = fstat(&entry.file).map_err(|_| PublishError::Io)?;
        validate_regular_file(&held, entry.owner)?;
        let visible = statat(directory, name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|_| PublishError::IdentityMismatch)?;
        if ObjectIdentity::from_stat(&held) != entry.identity
            || ObjectIdentity::from_stat(&visible) != entry.identity
            || usize::try_from(held.st_size).ok() != Some(entry.length)
        {
            return Err(PublishError::IdentityMismatch);
        }
    }
    Ok(())
}

fn build_accepted_bundle(
    disposition: PublishDisposition,
    directory: OwnedFd,
    directory_identity: ObjectIdentity,
    owner: u32,
    files: BTreeMap<String, AcceptedFile>,
) -> AcceptedBundle {
    let mut digest = Sha256::new();
    digest.update(b"superwagie.review.evidence-bundle.v1\0");
    for (name, entry) in &files {
        digest.update((name.len() as u64).to_be_bytes());
        digest.update(name.as_bytes());
        digest.update((entry.length as u64).to_be_bytes());
        digest.update(entry.digest.as_bytes());
    }
    AcceptedBundle {
        disposition,
        directory,
        directory_identity,
        owner,
        files,
        content_digest: digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    }
}

#[cfg(unix)]
fn read_exact_at(file: &File, length: usize) -> Result<Vec<u8>, PublishError> {
    let mut output = vec![0_u8; length];
    let mut offset = 0;
    while offset < length {
        let read = file
            .read_at(&mut output[offset..], offset as u64)
            .map_err(|_| PublishError::Io)?;
        if read == 0 {
            return Err(PublishError::ContentChanged);
        }
        offset += read;
    }
    Ok(output)
}

fn validate_key(key: &str) -> Result<(), PublishError> {
    if key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(PublishError::InvalidBundle)
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        validate_regular_file, EvidenceBundle, EvidencePublisher, FaultPoint, PublishDisposition,
        PublishError,
    };
    use rustix::fs::{fstat, open, Mode, OFlags};
    use sha2::{Digest, Sha256};
    use std::fs;

    #[cfg(unix)]
    fn make_fifo(path: &std::path::Path) {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let path = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: the C string is NUL-terminated, names the test tempdir child,
        // and remains alive for the duration of this single syscall.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn page_diff(key: &str) -> EvidenceBundle {
        EvidenceBundle::page_diff(
            key,
            b"png-bytes".to_vec(),
            br#"{"changed_pixels":1,"total_pixels":2,"ratio":0.5}"#.to_vec(),
            format!(r#"{{"comparisonKey":"{key}","pageId":"page-1"}}"#).into_bytes(),
        )
        .expect("valid page diff")
    }

    fn assert_complete_page_diff(directory: &std::path::Path) {
        assert_eq!(fs::read(directory.join("diff.png")).unwrap(), b"png-bytes");
        assert!(fs::read(directory.join("diff-stats.json")).is_ok());
        assert!(fs::read(directory.join("comparison-manifest.json")).is_ok());
        assert_eq!(fs::read_dir(directory).unwrap().count(), 3);
    }

    #[test]
    fn publishes_and_reuses_only_identical_immutable_bundles() {
        let root = tempfile::tempdir().unwrap();
        let publisher = EvidencePublisher::open(root.path()).unwrap();
        let key = "a".repeat(64);
        let bundle = page_diff(&key);

        let published = publisher.publish(&bundle).unwrap();
        assert_eq!(published.disposition(), PublishDisposition::Published);
        assert_eq!(published.read_verified("diff.png").unwrap(), b"png-bytes");
        let reused = publisher.publish(&bundle).unwrap();
        assert_eq!(reused.disposition(), PublishDisposition::Reused);
        assert_eq!(reused.read_verified("diff.png").unwrap(), b"png-bytes");
        assert_eq!(published.content_digest(), reused.content_digest());
        assert_complete_page_diff(&root.path().join(format!("comparison-{key}")));

        let conflicting = EvidenceBundle::page_diff(
            &key,
            b"different-png".to_vec(),
            bundle.files()["diff-stats.json"].clone(),
            bundle.files()["comparison-manifest.json"].clone(),
        )
        .unwrap();
        assert_eq!(
            publisher.publish(&conflicting).unwrap_err(),
            PublishError::Conflict
        );
        assert_complete_page_diff(&root.path().join(format!("comparison-{key}")));
    }

    #[test]
    fn publishes_agent_request_as_one_narrow_single_file_bundle() {
        let root = tempfile::tempdir().unwrap();
        let publisher = EvidencePublisher::open(root.path()).unwrap();
        let json = br#"{"requestId":"request-1","instruction":"fixed"}"#.to_vec();
        let key = sha256_hex(&json);
        let bundle = EvidenceBundle::agent_request(&key, json.clone()).unwrap();

        let accepted = publisher.publish(&bundle).unwrap();
        assert_eq!(accepted.disposition(), PublishDisposition::Published);
        assert_eq!(
            accepted.read_verified("agent-change-request.json").unwrap(),
            json
        );
        let directory = root.path().join(format!("request-{key}"));
        assert_eq!(
            fs::read(directory.join("agent-change-request.json")).unwrap(),
            json
        );
        assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
    }

    #[test]
    fn every_precommit_fault_leaves_no_visible_final_bundle() {
        let points = [
            FaultPoint::AfterStageDirectoryCreated,
            FaultPoint::BeforeFileWrite(0),
            FaultPoint::BeforeFileSync(0),
            FaultPoint::BeforeFileWrite(1),
            FaultPoint::BeforeFileSync(1),
            FaultPoint::BeforeFileWrite(2),
            FaultPoint::BeforeFileSync(2),
            FaultPoint::BeforeStageDirectorySync,
            FaultPoint::BeforePublishRename,
        ];
        for point in points {
            let root = tempfile::tempdir().unwrap();
            let publisher = EvidencePublisher::open_with_fault(root.path(), point).unwrap();
            let key = "b".repeat(64);
            assert_eq!(
                publisher.publish(&page_diff(&key)).unwrap_err(),
                PublishError::Injected
            );
            assert!(
                !root.path().join(format!("comparison-{key}")).exists(),
                "{point:?}"
            );
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0, "{point:?}");
        }
    }

    #[test]
    fn postcommit_sync_fault_exposes_only_the_complete_bundle() {
        for point in [FaultPoint::AfterPublishRename, FaultPoint::BeforeRootSync] {
            let root = tempfile::tempdir().unwrap();
            let publisher = EvidencePublisher::open_with_fault(root.path(), point).unwrap();
            let key = "c".repeat(64);
            assert_eq!(
                publisher.publish(&page_diff(&key)).unwrap_err(),
                PublishError::Injected
            );
            assert_complete_page_diff(&root.path().join(format!("comparison-{key}")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn held_directory_identity_defeats_deterministic_path_swap_escape() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let selected = parent.path().join("selected");
        let moved = parent.path().join("selected-moved");
        let outside = parent.path().join("outside");
        fs::create_dir(&selected).unwrap();
        fs::create_dir(&outside).unwrap();
        let publisher = EvidencePublisher::open(&selected).unwrap();

        fs::rename(&selected, &moved).unwrap();
        symlink(&outside, &selected).unwrap();
        let key = "d".repeat(64);
        let accepted = publisher.publish(&page_diff(&key)).unwrap();
        assert_eq!(accepted.disposition(), PublishDisposition::Published);

        assert_complete_page_diff(&moved.join(format!("comparison-{key}")));
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_evidence_root_without_following_it() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let outside = parent.path().join("outside");
        let selected = parent.path().join("selected");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, &selected).unwrap();
        assert_eq!(
            EvidencePublisher::open(&selected).unwrap_err(),
            PublishError::UnsafeRoot
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn stage_entry_swap_fails_before_attacker_directory_can_be_committed() {
        let root = tempfile::tempdir().unwrap();
        let publisher =
            EvidencePublisher::open_with_fault(root.path(), FaultPoint::SwapStageEntryBeforeCommit)
                .unwrap();
        let key = "e".repeat(64);

        assert_eq!(
            publisher.publish(&page_diff(&key)).unwrap_err(),
            PublishError::IdentityMismatch
        );
        assert!(!root.path().join(format!("comparison-{key}")).exists());
    }

    #[test]
    fn reuse_entry_swap_never_returns_an_accepted_handle() {
        let root = tempfile::tempdir().unwrap();
        let key = "f".repeat(64);
        let bundle = page_diff(&key);
        EvidencePublisher::open(root.path())
            .unwrap()
            .publish(&bundle)
            .unwrap();
        let publisher =
            EvidencePublisher::open_with_fault(root.path(), FaultPoint::SwapFinalEntryDuringReuse)
                .unwrap();

        assert_eq!(
            publisher.publish(&bundle).unwrap_err(),
            PublishError::IdentityMismatch
        );
    }

    #[test]
    fn post_check_name_swap_cannot_redirect_the_held_accepted_handle() {
        let root = tempfile::tempdir().unwrap();
        let publisher = EvidencePublisher::open_with_fault(
            root.path(),
            FaultPoint::SwapFinalEntryAfterCommitCheck,
        )
        .unwrap();
        let key = "1".repeat(64);
        let accepted = publisher.publish(&page_diff(&key)).unwrap();

        assert_eq!(accepted.disposition(), PublishDisposition::Published);
        assert_eq!(accepted.read_verified("diff.png").unwrap(), b"png-bytes");
        assert_eq!(
            fs::read(root.path().join(format!("comparison-{key}/attacker"))).unwrap(),
            b"replacement"
        );
    }

    #[test]
    fn held_consumer_rehashes_content_and_fails_closed_after_same_uid_mutation() {
        let root = tempfile::tempdir().unwrap();
        let key = "2".repeat(64);
        let accepted = EvidencePublisher::open(root.path())
            .unwrap()
            .publish(&page_diff(&key))
            .unwrap();
        fs::write(
            root.path().join(format!("comparison-{key}/diff.png")),
            b"mutated",
        )
        .unwrap();

        assert_eq!(
            accepted.read_verified("diff.png").unwrap_err(),
            PublishError::ContentChanged
        );
    }

    #[cfg(unix)]
    #[test]
    fn reuse_rejects_symlink_fifo_hardlink_and_wrong_mode_without_reading_them() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        for kind in ["symlink", "fifo", "hardlink", "mode"] {
            let root = tempfile::tempdir().unwrap();
            let key = match kind {
                "symlink" => "3".repeat(64),
                "fifo" => "4".repeat(64),
                "hardlink" => "5".repeat(64),
                _ => "6".repeat(64),
            };
            let bundle = page_diff(&key);
            EvidencePublisher::open(root.path())
                .unwrap()
                .publish(&bundle)
                .unwrap();
            let directory = root.path().join(format!("comparison-{key}"));
            let target = directory.join("diff.png");
            match kind {
                "symlink" => {
                    fs::remove_file(&target).unwrap();
                    let outside = root.path().join("outside-secret");
                    fs::write(&outside, b"outside").unwrap();
                    symlink(&outside, &target).unwrap();
                }
                "fifo" => {
                    fs::remove_file(&target).unwrap();
                    make_fifo(&target);
                }
                "hardlink" => {
                    fs::remove_file(&target).unwrap();
                    let outside = root.path().join("outside-hardlink");
                    fs::write(&outside, b"png-bytes").unwrap();
                    fs::hard_link(&outside, &target).unwrap();
                }
                _ => {
                    fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
                }
            }

            assert_eq!(
                EvidencePublisher::open(root.path())
                    .unwrap()
                    .publish(&bundle)
                    .unwrap_err(),
                PublishError::Conflict,
                "{kind}"
            );
        }
    }

    #[test]
    fn device_metadata_is_rejected_as_non_regular_before_any_read() {
        let device = open(
            "/dev/null",
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .unwrap();
        let stat = fstat(&device).unwrap();
        assert_eq!(
            validate_regular_file(&stat, stat.st_uid).unwrap_err(),
            PublishError::Conflict
        );
    }
}
