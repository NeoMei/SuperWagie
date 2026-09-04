use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
#[cfg(unix)]
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;
const KEY: &str = "authenticated-core-test-key";
const MAIN_NONCE: &str = "main-nonce-strict";

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap(),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).unwrap(),
                            canonical(&values[key])
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn mac(value: &Value) -> String {
    let mut mac = HmacSha256::new_from_slice(KEY.as_bytes()).unwrap();
    mac.update(canonical(value).as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

struct Client {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    core_nonce: String,
    sequence: u64,
}

impl Client {
    fn spawn() -> Self {
        Self::spawn_with_checkpoint(None)
    }

    fn spawn_with_checkpoint(checkpoint: Option<&Path>) -> Self {
        let mut command = core_command(checkpoint);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            _child: child,
            stdin,
            stdout,
            core_nonce: String::new(),
            sequence: 0,
        }
    }

    #[cfg(unix)]
    fn shutdown(mut self) {
        let response = self.request("shutdown", json!({"type":"shutdown"}));
        assert_eq!(response["ok"], true);
        drop(self.stdin);
        assert!(self._child.wait().unwrap().success());
    }

    fn raw(&mut self, value: &Value) -> Value {
        writeln!(self.stdin, "{}", serde_json::to_string(value).unwrap()).unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "core response required");
        serde_json::from_str(&line).unwrap()
    }

    fn hello(&mut self) -> Value {
        let hello = json!({
            "type":"hello", "protocol":"solution-b-v1", "request_id":"hello-1",
            "deadline_ms":now_ms() + 5_000, "main_nonce":MAIN_NONCE,
            "main_identity":"electron-main@44.1.0"
        });
        let ack = self.raw(&hello);
        assert_eq!(ack["type"], "hello_ack");
        assert_eq!(ack["protocol"], "solution-b-v1");
        assert_eq!(ack["identity"], "solution-b-rust-core");
        assert_eq!(ack["main_nonce"], MAIN_NONCE);
        self.core_nonce = ack["core_nonce"].as_str().unwrap().to_owned();
        let supplied = ack["mac"].as_str().unwrap();
        let mut unsigned = ack.clone();
        unsigned.as_object_mut().unwrap().remove("mac");
        assert_eq!(supplied, mac(&unsigned));
        ack
    }

    fn envelope(&self, sequence: u64, request_id: &str, command: Value) -> Value {
        let unsigned = json!({
            "type":"request", "protocol":"solution-b-v1", "request_id":request_id,
            "deadline_ms":now_ms() + 5_000, "main_nonce":MAIN_NONCE,
            "core_nonce":self.core_nonce, "sequence":sequence, "command":command
        });
        let mut signed = unsigned;
        let request_mac = mac(&signed);
        signed
            .as_object_mut()
            .unwrap()
            .insert("mac".into(), Value::String(request_mac));
        signed
    }

    fn request(&mut self, request_id: &str, command: Value) -> Value {
        self.sequence += 1;
        let sequence = self.sequence;
        let response = self.raw(&self.envelope(sequence, request_id, command));
        assert_eq!(response["type"], "response");
        assert_eq!(response["request_id"], request_id);
        assert_eq!(response["sequence"], sequence);
        assert_eq!(response["main_nonce"], MAIN_NONCE);
        assert_eq!(response["core_nonce"], self.core_nonce);
        let supplied = response["mac"].as_str().unwrap();
        let mut unsigned = response.clone();
        unsigned.as_object_mut().unwrap().remove("mac");
        assert_eq!(supplied, mac(&unsigned));
        response
    }
}

#[cfg(unix)]
fn custody_file() -> &'static File {
    use std::sync::OnceLock;
    static CUSTODY: OnceLock<File> = OnceLock::new();
    CUSTODY.get_or_init(|| {
        let path = std::env::temp_dir().join(format!(
            "solution-b-checkpoint-custody-{}",
            std::process::id()
        ));
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(&[0x5au8; 32]).unwrap();
        file.sync_all().unwrap();
        fs::remove_file(path).unwrap();
        let duplicated = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        assert!(duplicated >= 64);
        unsafe { File::from_raw_fd(duplicated) }
    })
}

fn core_command(checkpoint: Option<&Path>) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_solution-b-core"));
    command.env_clear().env("SUPERWAGIE_CORE_KEY", KEY);
    #[cfg(unix)]
    {
        let custody_fd = custody_file().as_raw_fd();
        command
            .env("SUPERWAGIE_CHECKPOINT_KEY_FD", "3")
            .envs(checkpoint.map(|path| ("SUPERWAGIE_CHECKPOINT_PATH", path)));
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(custody_fd, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    assert!(
        checkpoint.is_none(),
        "Windows checkpoint custody is exercised through the Node/Electron parent that can inherit fd 3"
    );
    command
}

#[test]
fn rejects_legacy_unknown_replayed_expired_and_oversized_messages() {
    let mut client = Client::spawn();
    client.hello();

    let second_hello = client.raw(&json!({
        "type":"hello", "protocol":"solution-b-v1", "request_id":"hello-2",
        "deadline_ms":now_ms()+5000, "main_nonce":"replacement",
        "main_identity":"electron-main@44.1.0"
    }));
    assert_eq!(second_hello["code"], "HANDSHAKE_ALREADY_COMPLETE");

    let legacy = client.raw(&json!({"type":"query","query_id":"shell.snapshot"}));
    assert_eq!(legacy["code"], "INVALID_ENVELOPE");

    let mut unknown = client.envelope(1, "unknown-field", json!({"type":"heartbeat"}));
    unknown
        .as_object_mut()
        .unwrap()
        .insert("extra".into(), json!(true));
    let unknown_response = client.raw(&unknown);
    assert_eq!(unknown_response["code"], "INVALID_ENVELOPE");

    let valid = client.envelope(1, "first", json!({"type":"heartbeat"}));
    assert_eq!(client.raw(&valid)["ok"], true);
    let replay = client.raw(&valid);
    assert_eq!(replay["code"], "REPLAY_REJECTED");

    let mut expired = client.envelope(2, "expired", json!({"type":"heartbeat"}));
    expired["deadline_ms"] = json!(now_ms() - 1);
    let unsigned_mac = {
        let mut unsigned = expired.clone();
        unsigned.as_object_mut().unwrap().remove("mac");
        mac(&unsigned)
    };
    expired["mac"] = json!(unsigned_mac);
    assert_eq!(client.raw(&expired)["code"], "DEADLINE_EXCEEDED");

    let oversized = format!("{{\"padding\":\"{}\"}}\n", "x".repeat(70_000));
    client.stdin.write_all(oversized.as_bytes()).unwrap();
    client.stdin.flush().unwrap();
    let mut line = String::new();
    client.stdout.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["code"], "MESSAGE_TOO_LARGE");
}

#[test]
fn validates_handle_domains_and_streams_actual_revision_bound_bytes() {
    let mut client = Client::spawn();
    client.hello();

    for (id, command, code) in [
        (
            "empty-resource",
            json!({"type":"issue_handle","resource_id":"","revision":1,"audience":"artifact_preview:surface-3","operations":["range_read"],"ttl_ms":1000,"size_limit":64,"range_limit":32,"one_shot":false}),
            "INVALID_RESOURCE",
        ),
        (
            "empty-audience",
            json!({"type":"issue_handle","resource_id":"fixture:alpha","revision":1,"audience":"","operations":["range_read"],"ttl_ms":1000,"size_limit":64,"range_limit":32,"one_shot":false}),
            "INVALID_AUDIENCE",
        ),
        (
            "bad-op",
            json!({"type":"issue_handle","resource_id":"fixture:alpha","revision":1,"audience":"artifact_preview:surface-3","operations":["shell"],"ttl_ms":1000,"size_limit":64,"range_limit":32,"one_shot":false}),
            "INVALID_OPERATION",
        ),
        (
            "zero-revision",
            json!({"type":"issue_handle","resource_id":"fixture:alpha","revision":0,"audience":"artifact_preview:surface-3","operations":["range_read"],"ttl_ms":1000,"size_limit":64,"range_limit":32,"one_shot":false}),
            "INVALID_REVISION",
        ),
        (
            "zero-ttl",
            json!({"type":"issue_handle","resource_id":"fixture:alpha","revision":1,"audience":"artifact_preview:surface-3","operations":["range_read"],"ttl_ms":0,"size_limit":64,"range_limit":32,"one_shot":false}),
            "INVALID_TTL",
        ),
    ] {
        let response = client.request(id, command);
        assert_eq!(response["code"], code);
    }

    let issued = client.request(
        "issue",
        json!({
            "type":"issue_handle","resource_id":"fixture:alpha","revision":1,
            "audience":"artifact_preview:surface-3","operations":["range_read"],
            "ttl_ms":5000,"size_limit":64,"range_limit":32,"one_shot":false
        }),
    );
    assert_eq!(issued["ok"], true);
    let signed = issued["result"]["signed_handle"].as_str().unwrap();
    let bytes = client.request(
        "range-1",
        json!({
            "type":"verify_handle","signed_handle":signed,"audience":"artifact_preview:surface-3",
            "operation":"range_read","revision":1,"offset":4,"length":8
        }),
    );
    assert_eq!(bytes["result"]["offset"], 4);
    assert_eq!(bytes["result"]["bytes_count"], 8);
    assert_eq!(bytes["result"]["bytes_hex"], "0405060708090a0b");
    let cumulative = client.request(
        "range-cumulative",
        json!({
            "type":"verify_handle","signed_handle":signed,"audience":"artifact_preview:surface-3",
            "operation":"range_read","revision":1,"offset":8,"length":30
        }),
    );
    assert_eq!(cumulative["code"], "CUMULATIVE_LIMIT_EXCEEDED");
    let actual_end = client.request(
        "range-end",
        json!({
            "type":"verify_handle","signed_handle":signed,"audience":"artifact_preview:surface-3",
            "operation":"range_read","revision":1,"offset":60,"length":8
        }),
    );
    assert_eq!(actual_end["code"], "RESOURCE_RANGE_INVALID");

    let expiring = client.request(
        "issue-expiring",
        json!({
            "type":"issue_handle","resource_id":"fixture:alpha","revision":1,
            "audience":"artifact_preview:surface-3","operations":["range_read"],
            "ttl_ms":1,"size_limit":64,"range_limit":32,"one_shot":false
        }),
    );
    thread::sleep(Duration::from_millis(2));
    let expired = client.request(
        "expired-handle",
        json!({
            "type":"verify_handle","signed_handle":expiring["result"]["signed_handle"],
            "audience":"artifact_preview:surface-3","operation":"range_read","revision":1,
            "offset":0,"length":1
        }),
    );
    assert_eq!(expired["code"], "HANDLE_EXPIRED");

    let read_handle = client.request(
        "issue-bounded-read",
        json!({
            "type":"issue_handle","resource_id":"fixture:alpha","revision":1,
            "audience":"artifact_preview:surface-3","operations":["read"],
            "ttl_ms":5000,"size_limit":16,"range_limit":16,"one_shot":false
        }),
    );
    let signed_read = read_handle["result"]["signed_handle"].as_str().unwrap();
    let first_read = client.request(
        "bounded-read-first",
        json!({
            "type":"verify_handle","signed_handle":signed_read,
            "audience":"artifact_preview:surface-3","operation":"read","revision":1,
            "offset":0,"length":8
        }),
    );
    assert_eq!(first_read["result"]["cumulative_bytes"], 8);
    let cumulative_read = client.request(
        "bounded-read-over-limit",
        json!({
            "type":"verify_handle","signed_handle":signed_read,
            "audience":"artifact_preview:surface-3","operation":"read","revision":1,
            "offset":8,"length":9
        }),
    );
    assert_eq!(cumulative_read["code"], "CUMULATIVE_LIMIT_EXCEEDED");
}

#[test]
fn checkpoint_persists_only_core_owned_revision_and_cursor() {
    let mut client = Client::spawn();
    client.hello();
    let snapshot = client.request(
        "query",
        json!({"type":"query","query_id":"shell.snapshot","after_cursor":null}),
    );
    let checkpoint = client.request("checkpoint", json!({"type":"checkpoint"}));
    assert_eq!(
        checkpoint["result"]["revision"],
        snapshot["result"]["snapshot_revision"]
    );
    assert_eq!(
        checkpoint["result"]["event_cursor"],
        snapshot["result"]["event_cursor"]
    );

    let legacy = client.request(
        "legacy-checkpoint",
        json!({
            "type":"checkpoint","revision":999,"event_cursor":"attacker","safe":false
        }),
    );
    assert_eq!(legacy["code"], "INVALID_COMMAND");
}

#[cfg(unix)]
fn checkpoint_fixture(name: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "solution-b-core-checkpoint-{}-{}-{}",
        name,
        std::process::id(),
        now_ms()
    ));
    fs::create_dir(&root).unwrap();
    let checkpoint = root.join("state").join("checkpoint.json");
    fs::create_dir(root.join("state")).unwrap();
    (root, checkpoint)
}

#[test]
#[cfg(unix)]
fn checkpoint_restore_requires_authenticated_strict_domain_validated_regular_file() {
    let (root, checkpoint_path) = checkpoint_fixture("authenticated");
    let mut first = Client::spawn_with_checkpoint(Some(&checkpoint_path));
    first.hello();
    assert_eq!(
        first.request("persist", json!({"type":"checkpoint"}))["ok"],
        true
    );
    first.shutdown();

    let checkpoint: Value = serde_json::from_slice(&fs::read(&checkpoint_path).unwrap()).unwrap();
    assert_eq!(checkpoint["protocol"], "solution-b-v1");
    assert_eq!(checkpoint["core_identity"], "solution-b-rust-core");
    assert_eq!(checkpoint["safe"], true);
    assert!(checkpoint["mac"].as_str().unwrap().len() == 64);
    assert!(
        !checkpoint_path
            .with_file_name("checkpoint.json.auth-key")
            .exists(),
        "checkpoint authentication secret must never be persisted beside evidence"
    );

    let mut restored = Client::spawn_with_checkpoint(Some(&checkpoint_path));
    restored.hello();
    let snapshot = restored.request(
        "restored-query",
        json!({"type":"query","query_id":"shell.snapshot","after_cursor":null}),
    );
    assert_eq!(snapshot["result"]["snapshot_revision"], 1);
    assert_eq!(snapshot["result"]["event_cursor"], "cursor-1");
    restored.shutdown();

    let mut forged = checkpoint.clone();
    forged["revision"] = json!(999);
    forged["event_cursor"] = json!("attacker-cursor");
    fs::write(&checkpoint_path, serde_json::to_vec(&forged).unwrap()).unwrap();
    let forged_start = core_command(Some(&checkpoint_path)).output().unwrap();
    assert!(
        !forged_start.status.success(),
        "forged checkpoint must fail closed"
    );

    fs::remove_file(&checkpoint_path).unwrap();
    let outside = root.join("outside-checkpoint.json");
    fs::write(&outside, serde_json::to_vec(&checkpoint).unwrap()).unwrap();
    std::os::unix::fs::symlink(&outside, &checkpoint_path).unwrap();
    let symlink_start = core_command(Some(&checkpoint_path)).output().unwrap();
    assert!(
        !symlink_start.status.success(),
        "checkpoint symlink must fail closed"
    );
    fs::remove_dir_all(root).unwrap();
}
