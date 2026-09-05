use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::Read;
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
    let duplicate_fd = duplicate(directory_fd)?;
    let raw = std::os::fd::IntoRawFd::into_raw_fd(duplicate_fd);
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
