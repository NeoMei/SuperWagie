use std::os::unix::fs::MetadataExt;

pub(crate) fn root_identity(metadata: &std::fs::Metadata) -> String {
    format!("{}:{}", metadata.dev(), metadata.ino())
}

pub(crate) fn file_identity(device: u64, inode: u64) -> String {
    format!("unix:{device}:{inode}")
}
