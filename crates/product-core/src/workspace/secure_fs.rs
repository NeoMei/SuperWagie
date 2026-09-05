use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Component, Path};

use super::{WorkspaceError, identity};

const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) struct SecureRead {
    pub(crate) bytes: Vec<u8>,
    pub(crate) file_identity: String,
}

#[derive(Debug, Clone)]
pub(crate) struct SecureEntry {
    pub(crate) logical_path: String,
    pub(crate) file_identity: String,
}

pub(crate) struct PublishEvidence {
    pub(crate) previous_bytes: Vec<u8>,
    pub(crate) published_bytes: Vec<u8>,
    pub(crate) staging_path: String,
}

fn path_segments(logical_path: &str) -> Result<Vec<CString>, WorkspaceError> {
    if logical_path.is_empty() || logical_path.as_bytes().contains(&0) {
        return Err(WorkspaceError::InvalidLogicalPath);
    }
    let path = Path::new(logical_path);
    if path.is_absolute() {
        return Err(WorkspaceError::InvalidLogicalPath);
    }
    let mut output = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                use std::os::unix::ffi::OsStrExt;
                output.push(
                    CString::new(value.as_bytes())
                        .map_err(|_| WorkspaceError::InvalidLogicalPath)?,
                );
            }
            _ => return Err(WorkspaceError::InvalidLogicalPath),
        }
    }
    if output.is_empty() {
        Err(WorkspaceError::InvalidLogicalPath)
    } else {
        Ok(output)
    }
}

fn duplicate(fd: RawFd) -> Result<OwnedFd, WorkspaceError> {
    let raw = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if raw < 0 {
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn stat_at(fd: RawFd, name: &CStr) -> Result<libc::stat, WorkspaceError> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::fstatat(fd, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) };
    if result == 0 {
        return Ok(stat);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        Err(WorkspaceError::NotFound)
    } else {
        Err(WorkspaceError::Io(error))
    }
}

fn mode_type(stat: &libc::stat) -> libc::mode_t {
    stat.st_mode & libc::S_IFMT
}

fn open_child(fd: RawFd, name: &CStr, directory: bool) -> Result<OwnedFd, WorkspaceError> {
    let stat = stat_at(fd, name)?;
    if mode_type(&stat) == libc::S_IFLNK {
        return Err(WorkspaceError::SymlinkDenied);
    }
    if directory && mode_type(&stat) != libc::S_IFDIR {
        return Err(WorkspaceError::NotRegularFile);
    }
    let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
    if directory {
        flags |= libc::O_DIRECTORY;
    }
    let raw = unsafe { libc::openat(fd, name.as_ptr(), flags) };
    if raw < 0 {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ELOOP) => Err(WorkspaceError::SymlinkDenied),
            Some(libc::ENOENT) => Err(WorkspaceError::NotFound),
            _ => Err(WorkspaceError::Io(error)),
        };
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn open_logical(
    root_fd: &OwnedFd,
    logical_path: &str,
) -> Result<(OwnedFd, libc::stat), WorkspaceError> {
    let segments = path_segments(logical_path)?;
    let mut current = duplicate(root_fd.as_raw_fd())?;
    for (index, segment) in segments.iter().enumerate() {
        let last = index + 1 == segments.len();
        current = open_child(current.as_raw_fd(), segment, !last)?;
    }
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(current.as_raw_fd(), &mut stat) } != 0 {
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    Ok((current, stat))
}

fn parent_and_name(
    root_fd: &OwnedFd,
    logical_path: &str,
) -> Result<(OwnedFd, CString, String), WorkspaceError> {
    let mut segments = path_segments(logical_path)?;
    let name = segments.pop().ok_or(WorkspaceError::InvalidLogicalPath)?;
    let mut current = duplicate(root_fd.as_raw_fd())?;
    let mut prefix = Vec::new();
    for segment in segments {
        prefix.push(segment.to_string_lossy().into_owned());
        current = open_child(current.as_raw_fd(), &segment, true)?;
    }
    Ok((current, name, prefix.join("/")))
}

fn read_child(parent_fd: RawFd, name: &CStr) -> Result<Vec<u8>, WorkspaceError> {
    let fd = open_child(parent_fd, name, false)?;
    let mut file = File::from(fd);
    let metadata = file.metadata().map_err(WorkspaceError::Io)?;
    if !metadata.is_file() {
        return Err(WorkspaceError::NotRegularFile);
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(WorkspaceError::FileTooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).map_err(WorkspaceError::Io)?;
    Ok(bytes)
}

pub(crate) fn atomic_publish(
    root_fd: &OwnedFd,
    logical_path: &str,
    proposed: &[u8],
    token: &str,
) -> Result<PublishEvidence, WorkspaceError> {
    if proposed.len() as u64 > MAX_DOCUMENT_BYTES || std::str::from_utf8(proposed).is_err() {
        return Err(if proposed.len() as u64 > MAX_DOCUMENT_BYTES {
            WorkspaceError::FileTooLarge
        } else {
            WorkspaceError::InvalidUtf8
        });
    }
    let (parent, target_name, parent_prefix) = parent_and_name(root_fd, logical_path)?;
    let target_stat = stat_at(parent.as_raw_fd(), &target_name)?;
    if mode_type(&target_stat) != libc::S_IFREG {
        return Err(WorkspaceError::NotRegularFile);
    }
    let sanitized = token
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric())
        .take(48)
        .collect::<Vec<_>>();
    let stage_name = CString::new(format!(
        ".superwagie-save-{}",
        String::from_utf8_lossy(&sanitized)
    ))
    .map_err(|_| WorkspaceError::InvalidLogicalPath)?;
    let raw = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            stage_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if raw < 0 {
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    let stage_fd = unsafe { OwnedFd::from_raw_fd(raw) };
    if unsafe { libc::fchmod(stage_fd.as_raw_fd(), target_stat.st_mode & 0o777) } != 0 {
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    let mut stage_file = File::from(stage_fd);
    stage_file.write_all(proposed).map_err(WorkspaceError::Io)?;
    stage_file.sync_all().map_err(WorkspaceError::Io)?;
    drop(stage_file);

    let swapped = unsafe {
        libc::renameatx_np(
            parent.as_raw_fd(),
            stage_name.as_ptr(),
            parent.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if swapped != 0 {
        let error = std::io::Error::last_os_error();
        unsafe { libc::unlinkat(parent.as_raw_fd(), stage_name.as_ptr(), 0) };
        return Err(WorkspaceError::Io(error));
    }
    if unsafe { libc::fsync(parent.as_raw_fd()) } != 0 {
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    let previous_bytes = read_child(parent.as_raw_fd(), &stage_name)?;
    let published_bytes = read_child(parent.as_raw_fd(), &target_name)?;
    let staging_path = if parent_prefix.is_empty() {
        stage_name.to_string_lossy().into_owned()
    } else {
        format!("{parent_prefix}/{}", stage_name.to_string_lossy())
    };
    Ok(PublishEvidence {
        previous_bytes,
        published_bytes,
        staging_path,
    })
}

pub(crate) fn restore_previous_if_target_matches(
    root_fd: &OwnedFd,
    logical_path: &str,
    staging_path: &str,
    expected_target: &[u8],
) -> Result<bool, WorkspaceError> {
    let (target_parent, target_name, _) = parent_and_name(root_fd, logical_path)?;
    let (stage_parent, stage_name, _) = parent_and_name(root_fd, staging_path)?;
    if read_child(target_parent.as_raw_fd(), &target_name)? != expected_target {
        return Ok(false);
    }
    let swapped = unsafe {
        libc::renameatx_np(
            stage_parent.as_raw_fd(),
            stage_name.as_ptr(),
            target_parent.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if swapped != 0 {
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    unsafe { libc::fsync(target_parent.as_raw_fd()) };
    Ok(true)
}

pub(crate) fn remove_staging(root_fd: &OwnedFd, staging_path: &str) -> Result<(), WorkspaceError> {
    let (parent, name, _) = parent_and_name(root_fd, staging_path)?;
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        unsafe { libc::fsync(parent.as_raw_fd()) };
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        Ok(())
    } else {
        Err(WorkspaceError::Io(error))
    }
}

pub(crate) fn overwrite_for_fault(
    root_fd: &OwnedFd,
    logical_path: &str,
    bytes: &[u8],
) -> Result<(), WorkspaceError> {
    let (parent, name, _) = parent_and_name(root_fd, logical_path)?;
    let raw = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_TRUNC | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if raw < 0 {
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    let mut file = File::from(unsafe { OwnedFd::from_raw_fd(raw) });
    file.write_all(bytes).map_err(WorkspaceError::Io)?;
    file.sync_all().map_err(WorkspaceError::Io)
}

pub(crate) fn rename_for_fault(
    root_fd: &OwnedFd,
    from: &str,
    to: &str,
) -> Result<(), WorkspaceError> {
    let (from_parent, from_name, _) = parent_and_name(root_fd, from)?;
    let (to_parent, to_name, _) = parent_and_name(root_fd, to)?;
    let result = unsafe {
        libc::renameat(
            from_parent.as_raw_fd(),
            from_name.as_ptr(),
            to_parent.as_raw_fd(),
            to_name.as_ptr(),
        )
    };
    if result != 0 {
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    unsafe { libc::fsync(from_parent.as_raw_fd()) };
    Ok(())
}

pub(crate) fn read_utf8(
    root_fd: &OwnedFd,
    logical_path: &str,
) -> Result<SecureRead, WorkspaceError> {
    let (fd, stat) = open_logical(root_fd, logical_path)?;
    if mode_type(&stat) != libc::S_IFREG {
        return Err(WorkspaceError::NotRegularFile);
    }
    if stat.st_size < 0 || stat.st_size as u64 > MAX_DOCUMENT_BYTES {
        return Err(WorkspaceError::FileTooLarge);
    }
    let mut file = File::from(fd);
    let mut bytes = Vec::with_capacity(stat.st_size as usize);
    file.read_to_end(&mut bytes).map_err(WorkspaceError::Io)?;
    std::str::from_utf8(&bytes).map_err(|_| WorkspaceError::InvalidUtf8)?;
    Ok(SecureRead {
        bytes,
        file_identity: identity::file_identity(stat.st_dev as u64, stat.st_ino),
    })
}

pub(crate) fn identity_if_present(
    root_fd: &OwnedFd,
    logical_path: &str,
) -> Result<Option<String>, WorkspaceError> {
    match open_logical(root_fd, logical_path) {
        Ok((_fd, stat)) if mode_type(&stat) == libc::S_IFREG => Ok(Some(identity::file_identity(
            stat.st_dev as u64,
            stat.st_ino,
        ))),
        Ok(_) => Ok(None),
        Err(WorkspaceError::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn list_markdown_files(root_fd: &OwnedFd) -> Result<Vec<SecureEntry>, WorkspaceError> {
    let mut entries = Vec::new();
    walk_directory(root_fd.as_raw_fd(), "", &mut entries)?;
    entries.sort_by(|left, right| left.logical_path.cmp(&right.logical_path));
    Ok(entries)
}

fn walk_directory(
    directory_fd: RawFd,
    prefix: &str,
    output: &mut Vec<SecureEntry>,
) -> Result<(), WorkspaceError> {
    // fcntl(F_DUPFD_CLOEXEC) shares the directory cursor with its source open
    // file description. Open "." relative to the authorized descriptor so
    // every reconciliation scan gets an independent cursor.
    let directory_view = open_child(directory_fd, c".", true)?;
    let raw = std::os::fd::IntoRawFd::into_raw_fd(directory_view);
    let directory = unsafe { libc::fdopendir(raw) };
    if directory.is_null() {
        unsafe { libc::close(raw) };
        return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
    }
    loop {
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(directory) };
        if entry.is_null() {
            let errno = unsafe { *libc::__error() };
            unsafe { libc::closedir(directory) };
            return if errno == 0 {
                Ok(())
            } else {
                Err(WorkspaceError::Io(std::io::Error::from_raw_os_error(errno)))
            };
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        let Ok(name_text) = std::str::from_utf8(name.to_bytes()) else {
            continue;
        };
        let stat = stat_at(directory_fd, name)?;
        let logical_path = if prefix.is_empty() {
            name_text.to_owned()
        } else {
            format!("{prefix}/{name_text}")
        };
        match mode_type(&stat) {
            libc::S_IFDIR => {
                let child = open_child(directory_fd, name, true)?;
                walk_directory(child.as_raw_fd(), &logical_path, output)?;
            }
            libc::S_IFREG if logical_path.to_lowercase().ends_with(".md") => {
                output.push(SecureEntry {
                    logical_path,
                    file_identity: identity::file_identity(stat.st_dev as u64, stat.st_ino),
                })
            }
            _ => {}
        }
    }
}
