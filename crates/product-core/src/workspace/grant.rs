use std::ffi::CString;
use std::fs;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use super::{WorkspaceError, identity, secure_fs};

pub(crate) struct WorkspaceGrant {
    root_path: PathBuf,
    root_fd: OwnedFd,
    root_identity: String,
}

impl WorkspaceGrant {
    pub(crate) fn open(root: &Path) -> Result<Self, WorkspaceError> {
        let metadata = fs::symlink_metadata(root).map_err(WorkspaceError::Io)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(WorkspaceError::RootIdentityChanged);
        }
        let c_path = CString::new(root.as_os_str().as_bytes())
            .map_err(|_| WorkspaceError::InvalidLogicalPath)?;
        let raw = unsafe {
            libc::open(
                c_path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if raw < 0 {
            return Err(WorkspaceError::Io(std::io::Error::last_os_error()));
        }
        let root_fd = unsafe { OwnedFd::from_raw_fd(raw) };
        Ok(Self {
            root_path: root.to_owned(),
            root_fd,
            root_identity: identity::root_identity(&metadata),
        })
    }

    pub(crate) fn root_identity(&self) -> &str {
        &self.root_identity
    }

    pub(crate) fn verify_root_identity(&self) -> Result<(), WorkspaceError> {
        let metadata = fs::symlink_metadata(&self.root_path)
            .map_err(|_| WorkspaceError::RootIdentityChanged)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || identity::root_identity(&metadata) != self.root_identity
        {
            return Err(WorkspaceError::RootIdentityChanged);
        }
        Ok(())
    }

    pub(crate) fn read_utf8(
        &self,
        logical_path: &str,
    ) -> Result<secure_fs::SecureRead, WorkspaceError> {
        secure_fs::read_utf8(&self.root_fd, logical_path)
    }

    pub(crate) fn identity_if_present(
        &self,
        logical_path: &str,
    ) -> Result<Option<String>, WorkspaceError> {
        secure_fs::identity_if_present(&self.root_fd, logical_path)
    }

    pub(crate) fn list_markdown_files(
        &self,
    ) -> Result<Vec<secure_fs::SecureEntry>, WorkspaceError> {
        secure_fs::list_markdown_files(&self.root_fd)
    }
}
