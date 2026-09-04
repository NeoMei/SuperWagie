use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::env;
#[cfg(unix)]
use std::ffi::CString;
#[cfg(windows)]
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt as WindowsMetadataExt, OpenOptionsExt};
#[cfg(unix)]
use std::path::Component;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;
const PROTOCOL: &str = "solution-b-v1";
const CORE_IDENTITY: &str = "solution-b-rust-core";
const MAIN_IDENTITY: &str = "electron-main@44.1.0";
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    #[serde(rename = "type")]
    kind: String,
    protocol: String,
    request_id: String,
    deadline_ms: u64,
    main_nonce: String,
    main_identity: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    protocol: String,
    request_id: String,
    deadline_ms: u64,
    main_nonce: String,
    core_nonce: String,
    sequence: u64,
    command: Value,
    mac: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Heartbeat,
    Query {
        query_id: String,
        after_cursor: Option<String>,
    },
    Resync,
    IssueHandle {
        resource_id: String,
        revision: u64,
        audience: String,
        operations: Vec<String>,
        ttl_ms: u64,
        size_limit: u64,
        range_limit: u64,
        one_shot: bool,
    },
    VerifyHandle {
        signed_handle: String,
        audience: String,
        operation: String,
        revision: u64,
        offset: u64,
        length: u64,
    },
    RevokeHandle {
        handle_id: String,
    },
    Checkpoint,
    Shutdown,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandleClaims {
    handle_id: String,
    resource_id: String,
    revision: u64,
    audience: String,
    operations: Vec<String>,
    issued_at_ms: u64,
    expires_at_ms: u64,
    size_limit: u64,
    range_limit: u64,
    one_shot: bool,
}

struct State {
    authenticated: bool,
    main_nonce: String,
    core_nonce: String,
    last_sequence: u64,
    request_ids: HashSet<String>,
    snapshot_revision: u64,
    event_cursor: String,
    next_handle: u64,
    consumed: HashSet<String>,
    revoked: HashSet<String>,
    range_bytes: HashMap<String, u64>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            authenticated: false,
            main_nonce: String::new(),
            core_nonce: String::new(),
            last_sequence: 0,
            request_ids: HashSet::new(),
            snapshot_revision: 1,
            event_cursor: "cursor-1".into(),
            next_handle: 0,
            consumed: HashSet::new(),
            revoked: HashSet::new(),
            range_bytes: HashMap::new(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn canonical(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap(),
        Value::Array(v) => format!(
            "[{}]",
            v.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(v) => {
            let mut keys = v.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical(&v[k])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn mac_hex(key: &[u8], v: &Value) -> String {
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(canonical(v).as_bytes());
    hex::encode(mac.finalize().into_bytes())
}
fn verify_mac(key: &[u8], v: &Value, supplied: &str) -> bool {
    let Ok(bytes) = hex::decode(supplied) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(canonical(v).as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

fn sign_handle(key: &[u8], claims: &HandleClaims) -> String {
    let bytes = serde_json::to_vec(claims).unwrap();
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(&bytes);
    format!(
        "{}.{}",
        hex::encode(&bytes),
        hex::encode(mac.finalize().into_bytes())
    )
}
fn decode_handle(key: &[u8], signed: &str) -> Result<HandleClaims, &'static str> {
    let (body, tag) = signed.split_once('.').ok_or("HANDLE_MALFORMED")?;
    let body = hex::decode(body).map_err(|_| "HANDLE_MALFORMED")?;
    let tag = hex::decode(tag).map_err(|_| "HANDLE_MALFORMED")?;
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(&body);
    mac.verify_slice(&tag).map_err(|_| "HANDLE_FORGED")?;
    serde_json::from_slice(&body).map_err(|_| "HANDLE_MALFORMED")
}

#[derive(Serialize)]
struct UnsignedCheckpoint<'a> {
    protocol: &'a str,
    core_identity: &'a str,
    revision: u64,
    event_cursor: &'a str,
    safe: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointEnvelope {
    protocol: String,
    core_identity: String,
    revision: u64,
    event_cursor: String,
    safe: bool,
    mac: String,
}

#[cfg(unix)]
struct CheckpointStore {
    directory: OwnedFd,
    leaf: CString,
    key: Vec<u8>,
}

#[cfg(windows)]
struct CheckpointStore {
    parent: PathBuf,
    leaf: OsString,
    parent_volume: u32,
    parent_file_index: u64,
    key: Vec<u8>,
}

#[cfg(unix)]
fn os_error() -> io::Error {
    io::Error::last_os_error()
}

#[cfg(unix)]
fn openat_owned(
    directory: i32,
    leaf: &CString,
    flags: i32,
    mode: libc::mode_t,
) -> io::Result<OwnedFd> {
    let fd = unsafe { libc::openat(directory, leaf.as_ptr(), flags, mode as libc::c_uint) };
    if fd < 0 {
        Err(os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

#[cfg(unix)]
fn open_checkpoint_parent(path: &Path) -> io::Result<(OwnedFd, CString)> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "checkpoint path must be absolute",
        ));
    }
    let leaf = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "checkpoint leaf required"))?;
    let leaf = CString::new(leaf.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "checkpoint NUL"))?;
    let root = CString::new("/").unwrap();
    let root_fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(os_error());
    }
    let mut current = unsafe { OwnedFd::from_raw_fd(root_fd) };
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "checkpoint parent required"))?;
    #[cfg(target_os = "macos")]
    let parent: PathBuf = if let Ok(tail) = parent.strip_prefix("/var") {
        Path::new("/private/var").join(tail)
    } else if let Ok(tail) = parent.strip_prefix("/tmp") {
        Path::new("/private/tmp").join(tail)
    } else {
        parent.to_path_buf()
    };
    #[cfg(not(target_os = "macos"))]
    let parent: PathBuf = parent.to_path_buf();
    for component in parent.components() {
        let Component::Normal(name) = component else {
            continue;
        };
        let name = CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "checkpoint component NUL"))?;
        current = openat_owned(
            current.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        )?;
    }
    Ok((current, leaf))
}

fn read_fd(mut file: File, max_bytes: u64) -> io::Result<Vec<u8>> {
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bounded regular file required",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)?;
    if bytes.len() as u64 != metadata.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "checkpoint changed during read",
        ));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn random_secret() -> io::Result<Vec<u8>> {
    let mut bytes = vec![0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

#[cfg(unix)]
fn read_checkpoint_key_from_custody_fd() -> io::Result<Vec<u8>> {
    let fd: i32 = env::var("SUPERWAGIE_CHECKPOINT_KEY_FD")
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "checkpoint key custody FD required",
            )
        })?
        .parse()
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "checkpoint key custody FD invalid",
            )
        })?;
    if fd < 3 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "checkpoint key custody FD invalid",
        ));
    }
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate < 0 {
        return Err(os_error());
    }
    let file = unsafe { File::from_raw_fd(duplicate) };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.nlink() != 0 || metadata.len() != 32 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "checkpoint key custody must be an unlinked 32-byte regular file",
        ));
    }
    let mut key = vec![0u8; 32];
    let read = unsafe { libc::pread(file.as_raw_fd(), key.as_mut_ptr().cast(), key.len(), 0) };
    if read != key.len() as isize {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "checkpoint key custody read failed",
        ));
    }
    Ok(key)
}

#[cfg(windows)]
fn random_secret() -> io::Result<Vec<u8>> {
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            size: u32,
            flags: u32,
        ) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
    let mut bytes = vec![0u8; 32];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        Err(io::Error::other(format!(
            "BCryptGenRandom failed: {status:#x}"
        )))
    } else {
        Ok(bytes)
    }
}

#[cfg(windows)]
fn read_checkpoint_key_from_custody_fd() -> io::Result<Vec<u8>> {
    let fd: i32 = env::var("SUPERWAGIE_CHECKPOINT_KEY_FD")
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "checkpoint key custody FD required",
            )
        })?
        .parse()
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "checkpoint key custody FD invalid",
            )
        })?;
    if fd < 3 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "checkpoint key custody FD invalid",
        ));
    }
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(duplicate, metadata.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let metadata = unsafe { metadata.assume_init() };
        if metadata.st_size != 32 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "checkpoint key custody must be a 32-byte inherited file",
            ));
        }
        if unsafe { libc::lseek(duplicate, 0, libc::SEEK_SET) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut key = vec![0u8; 32];
        let read = unsafe { libc::read(duplicate, key.as_mut_ptr().cast(), key.len() as u32) };
        if read != key.len() as i32 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "checkpoint key custody read failed",
            ));
        }
        Ok(key)
    })();
    unsafe { libc::close(duplicate) };
    result
}

#[cfg(unix)]
impl CheckpointStore {
    fn open(path: &Path) -> io::Result<Self> {
        let (directory, leaf) = open_checkpoint_parent(path)?;
        let key = read_checkpoint_key_from_custody_fd()?;
        Ok(Self {
            directory,
            leaf,
            key,
        })
    }

    fn restore(&self, state: &mut State) -> io::Result<()> {
        let fd = match openat_owned(
            self.directory.as_raw_fd(),
            &self.leaf,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        ) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let bytes = read_fd(File::from(fd), 64 * 1024)?;
        let checkpoint: CheckpointEnvelope = serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "checkpoint schema invalid"))?;
        if checkpoint.protocol != PROTOCOL
            || checkpoint.core_identity != CORE_IDENTITY
            || !checkpoint.safe
            || checkpoint.revision == 0
            || checkpoint.event_cursor != format!("cursor-{}", checkpoint.revision)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "checkpoint domain invalid",
            ));
        }
        let unsigned = serde_json::to_value(UnsignedCheckpoint {
            protocol: PROTOCOL,
            core_identity: CORE_IDENTITY,
            revision: checkpoint.revision,
            event_cursor: &checkpoint.event_cursor,
            safe: true,
        })?;
        if !verify_mac(&self.key, &unsigned, &checkpoint.mac) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "checkpoint MAC invalid",
            ));
        }
        state.snapshot_revision = checkpoint.revision;
        state.event_cursor = checkpoint.event_cursor;
        Ok(())
    }

    fn persist(&self, state: &State) -> io::Result<()> {
        let unsigned = serde_json::to_value(UnsignedCheckpoint {
            protocol: PROTOCOL,
            core_identity: CORE_IDENTITY,
            revision: state.snapshot_revision,
            event_cursor: &state.event_cursor,
            safe: true,
        })?;
        let mut envelope = unsigned.as_object().unwrap().clone();
        envelope.insert("mac".into(), json!(mac_hex(&self.key, &unsigned)));
        let bytes = serde_json::to_vec(&Value::Object(envelope))?;
        let random = hex::encode(random_secret()?);
        let temporary =
            CString::new(format!(".{}.stage-{}", self.leaf.to_string_lossy(), random)).unwrap();
        let mut file = File::from(openat_owned(
            self.directory.as_raw_fd(),
            &temporary,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )?);
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        let renamed = unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                temporary.as_ptr(),
                self.directory.as_raw_fd(),
                self.leaf.as_ptr(),
            )
        };
        if renamed != 0 {
            return Err(os_error());
        }
        if unsafe { libc::fsync(self.directory.as_raw_fd()) } != 0 {
            return Err(os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl CheckpointStore {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x00000400;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;

    fn parent_identity(path: &Path) -> io::Result<(u32, u64)> {
        #[repr(C)]
        struct ByHandleFileInformation {
            file_attributes: u32,
            creation_time: [u32; 2],
            last_access_time: [u32; 2],
            last_write_time: [u32; 2],
            volume_serial_number: u32,
            file_size_high: u32,
            file_size_low: u32,
            number_of_links: u32,
            file_index_high: u32,
            file_index_low: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateFileW(
                name: *const u16,
                access: u32,
                share: u32,
                security: *mut std::ffi::c_void,
                disposition: u32,
                flags: u32,
                template: *mut std::ffi::c_void,
            ) -> *mut std::ffi::c_void;
            fn GetFileInformationByHandle(
                handle: *mut std::ffi::c_void,
                information: *mut ByHandleFileInformation,
            ) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        const FILE_READ_ATTRIBUTES: u32 = 0x80;
        const FILE_SHARE_ALL: u32 = 0x7;
        const OPEN_EXISTING: u32 = 3;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
        let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
        encoded.push(0);
        let handle = unsafe {
            CreateFileW(
                encoded.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_ALL,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | Self::FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle as isize == -1 {
            return Err(io::Error::last_os_error());
        }
        let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::uninit();
        let success = unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) };
        let error = if success == 0 {
            Some(io::Error::last_os_error())
        } else {
            None
        };
        unsafe { CloseHandle(handle) };
        if let Some(error) = error {
            return Err(error);
        }
        let information = unsafe { information.assume_init() };
        if information.file_attributes & Self::FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "checkpoint parent reparse point forbidden",
            ));
        }
        Ok((
            information.volume_serial_number,
            ((information.file_index_high as u64) << 32) | information.file_index_low as u64,
        ))
    }

    fn verify_parent(&self) -> io::Result<()> {
        if Self::parent_identity(&self.parent)? != (self.parent_volume, self.parent_file_index) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "checkpoint parent identity changed",
            ));
        }
        Ok(())
    }

    fn path(&self) -> PathBuf {
        self.parent.join(&self.leaf)
    }

    fn open_regular_no_reparse(path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(Self::FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.file_attributes() & Self::FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "checkpoint reparse point forbidden",
            ));
        }
        Ok(file)
    }

    fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "checkpoint path must be absolute",
            ));
        }
        let parent = path
            .parent()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "checkpoint parent required")
            })?
            .canonicalize()?;
        let leaf = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "checkpoint leaf required"))?
            .to_os_string();
        let (parent_volume, parent_file_index) = Self::parent_identity(&parent)?;
        Ok(Self {
            parent,
            leaf,
            parent_volume,
            parent_file_index,
            key: read_checkpoint_key_from_custody_fd()?,
        })
    }

    fn restore(&self, state: &mut State) -> io::Result<()> {
        self.verify_parent()?;
        let file = match Self::open_regular_no_reparse(&self.path()) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let bytes = read_fd(file, 64 * 1024)?;
        self.verify_parent()?;
        let checkpoint: CheckpointEnvelope = serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "checkpoint schema invalid"))?;
        if checkpoint.protocol != PROTOCOL
            || checkpoint.core_identity != CORE_IDENTITY
            || !checkpoint.safe
            || checkpoint.revision == 0
            || checkpoint.event_cursor != format!("cursor-{}", checkpoint.revision)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "checkpoint domain invalid",
            ));
        }
        let unsigned = serde_json::to_value(UnsignedCheckpoint {
            protocol: PROTOCOL,
            core_identity: CORE_IDENTITY,
            revision: checkpoint.revision,
            event_cursor: &checkpoint.event_cursor,
            safe: true,
        })?;
        if !verify_mac(&self.key, &unsigned, &checkpoint.mac) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "checkpoint MAC invalid",
            ));
        }
        state.snapshot_revision = checkpoint.revision;
        state.event_cursor = checkpoint.event_cursor;
        Ok(())
    }

    fn persist(&self, state: &State) -> io::Result<()> {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
        }
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

        self.verify_parent()?;
        if let Ok(existing) = std::fs::symlink_metadata(self.path())
            && (!existing.is_file()
                || existing.file_attributes() & Self::FILE_ATTRIBUTE_REPARSE_POINT != 0)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unsafe checkpoint destination",
            ));
        }
        let unsigned = serde_json::to_value(UnsignedCheckpoint {
            protocol: PROTOCOL,
            core_identity: CORE_IDENTITY,
            revision: state.snapshot_revision,
            event_cursor: &state.event_cursor,
            safe: true,
        })?;
        let mut envelope = unsigned.as_object().unwrap().clone();
        envelope.insert("mac".into(), json!(mac_hex(&self.key, &unsigned)));
        let bytes = serde_json::to_vec(&Value::Object(envelope))?;
        let temporary = self.parent.join(format!(
            ".{}.stage-{}",
            self.leaf.to_string_lossy(),
            hex::encode(random_secret()?)
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(Self::FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        self.verify_parent()?;
        let mut source: Vec<u16> = temporary.as_os_str().encode_wide().collect();
        source.push(0);
        let mut destination: Vec<u16> = self.path().as_os_str().encode_wide().collect();
        destination.push(0);
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            let error = io::Error::last_os_error();
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        self.verify_parent()
    }
}

fn write_value(out: &mut impl Write, v: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *out, v)?;
    out.write_all(b"\n")?;
    out.flush()
}
fn reject(out: &mut impl Write, code: &str) -> io::Result<()> {
    write_value(out, &json!({"type":"rejected","valid":false,"code":code}))
}
fn sign_object(key: &[u8], mut obj: Map<String, Value>) -> Value {
    let unsigned = Value::Object(obj.clone());
    obj.insert("mac".into(), json!(mac_hex(key, &unsigned)));
    Value::Object(obj)
}
fn hello_ack(out: &mut impl Write, key: &[u8], h: &Hello, nonce: &str) -> io::Result<()> {
    let v = json!({"type":"hello_ack","protocol":PROTOCOL,"request_id":h.request_id,"deadline_ms":h.deadline_ms,"main_nonce":h.main_nonce,"core_nonce":nonce,"identity":CORE_IDENTITY,"pid":std::process::id()});
    write_value(out, &sign_object(key, v.as_object().unwrap().clone()))
}
fn response(key: &[u8], r: &Request, ok: bool, payload: Value) -> Value {
    let mut o=json!({"type":"response","protocol":PROTOCOL,"request_id":r.request_id,"deadline_ms":r.deadline_ms,"main_nonce":r.main_nonce,"core_nonce":r.core_nonce,"sequence":r.sequence,"identity":CORE_IDENTITY,"ok":ok}).as_object().unwrap().clone();
    if ok {
        o.insert("result".into(), payload);
    } else {
        o.insert(
            "code".into(),
            json!(payload.as_str().unwrap_or("CORE_ERROR")),
        );
    }
    sign_object(key, o)
}

fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-' | b'.'))
}
fn resource_bytes(id: &str, rev: u64) -> Option<Vec<u8>> {
    match (id, rev) {
        ("fixture:alpha", 1) => Some((0u8..64).collect()),
        _ if id.starts_with("artifact:") && rev > 0 => {
            Some((0u8..=255).cycle().take(4096).collect())
        }
        _ => None,
    }
}

fn command_has_exact_schema(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return false;
    };
    let expected: &[&str] = match kind {
        "heartbeat" | "resync" | "checkpoint" | "shutdown" => &["type"],
        "query" => &["type", "query_id", "after_cursor"],
        "issue_handle" => &[
            "type",
            "resource_id",
            "revision",
            "audience",
            "operations",
            "ttl_ms",
            "size_limit",
            "range_limit",
            "one_shot",
        ],
        "verify_handle" => &[
            "type",
            "signed_handle",
            "audience",
            "operation",
            "revision",
            "offset",
            "length",
        ],
        "revoke_handle" => &["type", "handle_id"],
        _ => return false,
    };
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn execute(
    c: Command,
    s: &mut State,
    key: &[u8],
    checkpoint: Option<&CheckpointStore>,
) -> (bool, Value, bool) {
    match c {
        Command::Heartbeat => (true, json!({"type":"heartbeat_ack"}), true),
        Command::Query {
            query_id,
            after_cursor,
        } => {
            if query_id.is_empty() || query_id.len() > 128 {
                (false, json!("INVALID_QUERY"), true)
            } else {
                (
                    true,
                    json!({"type":"query_snapshot","query_id":query_id,"snapshot_revision":s.snapshot_revision,"projection_version":PROTOCOL,"event_cursor":s.event_cursor,"after_cursor":after_cursor,"payload":{"status":"connected","authority":"rust-core"}}),
                    true,
                )
            }
        }
        Command::Resync => (
            true,
            json!({"type":"resync_required","snapshot_revision":s.snapshot_revision,"event_cursor":s.event_cursor}),
            true,
        ),
        Command::IssueHandle {
            resource_id,
            revision,
            audience,
            operations,
            ttl_ms,
            size_limit,
            range_limit,
            one_shot,
        } => {
            let error = if !valid_id(&resource_id) {
                Some("INVALID_RESOURCE")
            } else if !valid_id(&audience) || !audience.contains(':') {
                Some("INVALID_AUDIENCE")
            } else if operations.is_empty()
                || operations.len() > 4
                || operations
                    .iter()
                    .any(|op| !matches!(op.as_str(), "read" | "range_read" | "render"))
            {
                Some("INVALID_OPERATION")
            } else if revision == 0 {
                Some("INVALID_REVISION")
            } else if resource_bytes(&resource_id, revision).is_none() {
                Some("INVALID_RESOURCE")
            } else if ttl_ms == 0 || ttl_ms > 300_000 {
                Some("INVALID_TTL")
            } else if size_limit == 0 || range_limit > size_limit {
                Some("INVALID_LIMIT")
            } else {
                None
            };
            if let Some(code) = error {
                return (false, json!(code), true);
            };
            s.next_handle += 1;
            let issued = now_ms();
            let claims = HandleClaims {
                handle_id: format!("handle-{}-{}", std::process::id(), s.next_handle),
                resource_id,
                revision,
                audience,
                operations,
                issued_at_ms: issued,
                expires_at_ms: issued.saturating_add(ttl_ms),
                size_limit,
                range_limit,
                one_shot,
            };
            let signed = sign_handle(key, &claims);
            (
                true,
                json!({"type":"handle_issued","handle_id":claims.handle_id,"signed_handle":signed,"expires_at_ms":claims.expires_at_ms}),
                true,
            )
        }
        Command::VerifyHandle {
            signed_handle,
            audience,
            operation,
            revision,
            offset,
            length,
        } => {
            let claims = match decode_handle(key, &signed_handle) {
                Ok(v) => v,
                Err(e) => return (false, json!(e), true),
            };
            let error = if claims.audience != audience {
                Some("AUDIENCE_MISMATCH")
            } else if !claims.operations.iter().any(|v| v == &operation) {
                Some("OPERATION_DENIED")
            } else if claims.revision != revision {
                Some("REVISION_MISMATCH")
            } else if now_ms() >= claims.expires_at_ms {
                Some("HANDLE_EXPIRED")
            } else if s.revoked.contains(&claims.handle_id) {
                Some("HANDLE_REVOKED")
            } else if claims.one_shot && s.consumed.contains(&claims.handle_id) {
                Some("ONE_SHOT_CONSUMED")
            } else if length == 0 || length > claims.size_limit {
                Some("SIZE_LIMIT_EXCEEDED")
            } else if operation == "range_read" && length > claims.range_limit {
                Some("RANGE_LIMIT_EXCEEDED")
            } else {
                None
            };
            if let Some(code) = error {
                return (false, json!(code), true);
            };
            let Some(bytes) = resource_bytes(&claims.resource_id, claims.revision) else {
                return (false, json!("RESOURCE_REVISION_UNAVAILABLE"), true);
            };
            let Some(end) = offset.checked_add(length) else {
                return (false, json!("RESOURCE_RANGE_INVALID"), true);
            };
            if end > bytes.len() as u64 {
                return (false, json!("RESOURCE_RANGE_INVALID"), true);
            };
            let used = s.range_bytes.get(&claims.handle_id).copied().unwrap_or(0);
            let Some(total) = used.checked_add(length) else {
                return (false, json!("CUMULATIVE_LIMIT_EXCEEDED"), true);
            };
            if total > claims.size_limit
                || (operation == "range_read" && total > claims.range_limit)
            {
                return (false, json!("CUMULATIVE_LIMIT_EXCEEDED"), true);
            };
            s.range_bytes.insert(claims.handle_id.clone(), total);
            if claims.one_shot {
                s.consumed.insert(claims.handle_id.clone());
            }
            let bytes = &bytes[offset as usize..end as usize];
            (
                true,
                json!({"type":"handle_verified","valid":true,"handle_id":claims.handle_id,"resource_id":claims.resource_id,"revision":claims.revision,"offset":offset,"bytes_count":bytes.len(),"bytes_hex":hex::encode(bytes),"cumulative_bytes":total}),
                true,
            )
        }
        Command::RevokeHandle { handle_id } => {
            if !valid_id(&handle_id) {
                (false, json!("INVALID_HANDLE_ID"), true)
            } else {
                s.revoked.insert(handle_id.clone());
                (
                    true,
                    json!({"type":"handle_revoked","handle_id":handle_id}),
                    true,
                )
            }
        }
        Command::Checkpoint => match checkpoint.map_or(Ok(()), |store| store.persist(s)) {
            Ok(()) => (
                true,
                json!({"type":"checkpoint_ack","safe":true,"revision":s.snapshot_revision,"event_cursor":s.event_cursor}),
                true,
            ),
            Err(_) => (false, json!("CHECKPOINT_FAILED"), true),
        },
        Command::Shutdown => (true, json!({"type":"shutdown_ack"}), false),
    }
}

fn handle_line(
    line: &[u8],
    s: &mut State,
    key: &[u8],
    checkpoint: Option<&CheckpointStore>,
    out: &mut impl Write,
) -> io::Result<bool> {
    if line.len() > MAX_MESSAGE_BYTES {
        reject(out, "MESSAGE_TOO_LARGE")?;
        return Ok(true);
    }
    let value: Value = match serde_json::from_slice(line) {
        Ok(v) => v,
        Err(_) => {
            reject(out, "INVALID_JSON")?;
            return Ok(true);
        }
    };
    if value.get("type").and_then(Value::as_str) == Some("hello") {
        if s.authenticated {
            reject(out, "HANDSHAKE_ALREADY_COMPLETE")?;
            return Ok(true);
        }
        let h: Hello = match serde_json::from_value(value) {
            Ok(v) => v,
            Err(_) => {
                reject(out, "INVALID_ENVELOPE")?;
                return Ok(true);
            }
        };
        if h.kind != "hello"
            || h.protocol != PROTOCOL
            || h.request_id.is_empty()
            || h.deadline_ms <= now_ms()
            || h.main_nonce.len() < 8
            || h.main_identity != MAIN_IDENTITY
        {
            reject(out, "HANDSHAKE_REJECTED")?;
            return Ok(true);
        }
        s.authenticated = true;
        s.main_nonce = h.main_nonce.clone();
        s.core_nonce = format!("core-{}-{}", std::process::id(), now_ms());
        hello_ack(out, key, &h, &s.core_nonce)?;
        return Ok(true);
    }
    if !s.authenticated {
        reject(out, "HANDSHAKE_REQUIRED")?;
        return Ok(true);
    }
    let r: Request = match serde_json::from_value(value.clone()) {
        Ok(v) => v,
        Err(_) => {
            reject(out, "INVALID_ENVELOPE")?;
            return Ok(true);
        }
    };
    if r.kind != "request"
        || r.protocol != PROTOCOL
        || r.request_id.is_empty()
        || r.request_id.len() > 128
        || r.main_nonce != s.main_nonce
        || r.core_nonce != s.core_nonce
    {
        reject(out, "SESSION_MISMATCH")?;
        return Ok(true);
    }
    let mut unsigned = value;
    unsigned.as_object_mut().unwrap().remove("mac");
    if !verify_mac(key, &unsigned, &r.mac) {
        reject(out, "MAC_INVALID")?;
        return Ok(true);
    }
    if r.deadline_ms <= now_ms() {
        write_value(out, &response(key, &r, false, json!("DEADLINE_EXCEEDED")))?;
        return Ok(true);
    }
    if r.sequence != s.last_sequence + 1 || s.request_ids.contains(&r.request_id) {
        write_value(out, &response(key, &r, false, json!("REPLAY_REJECTED")))?;
        return Ok(true);
    }
    s.last_sequence = r.sequence;
    s.request_ids.insert(r.request_id.clone());
    if !command_has_exact_schema(&r.command) {
        write_value(out, &response(key, &r, false, json!("INVALID_COMMAND")))?;
        return Ok(true);
    }
    let command: Command = match serde_json::from_value(r.command.clone()) {
        Ok(v) => v,
        Err(_) => {
            write_value(out, &response(key, &r, false, json!("INVALID_COMMAND")))?;
            return Ok(true);
        }
    };
    let (ok, payload, keep) = execute(command, s, key, checkpoint);
    write_value(out, &response(key, &r, ok, payload))?;
    Ok(keep)
}

fn main() -> io::Result<()> {
    let key = env::var("SUPERWAGIE_CORE_KEY").map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "SUPERWAGIE_CORE_KEY is required",
        )
    })?;
    let mut s = State::default();
    let checkpoint = env::var("SUPERWAGIE_CHECKPOINT_PATH")
        .ok()
        .map(|path| CheckpointStore::open(Path::new(&path)))
        .transpose()?;
    if let Some(store) = &checkpoint {
        store.restore(&mut s)?;
    }
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut out = io::stdout().lock();
    loop {
        let mut line = Vec::new();
        let n = input.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if !handle_line(&line, &mut s, key.as_bytes(), checkpoint.as_ref(), &mut out)? {
            break;
        }
    }
    if let Some(store) = &checkpoint {
        store.persist(&s)?;
    }
    Ok(())
}
