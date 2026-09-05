use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// Test-owned process only; never launches Electron, a model, or host agents.
pub struct CoreProcess {
    child: Child,
    input: ChildStdin,
    output: Receiver<String>,
    reader: Option<std::thread::JoinHandle<()>>,
    hello: Value,
    sequence: u64,
    key: [u8; 32],
}

fn deadline() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000
}

impl CoreProcess {
    pub fn start(state: &Path) -> Self {
        let key = [73; 32]; // Fixture secret; product response MACs are still verified.
        let mut child = Command::new(env!("CARGO_BIN_EXE_superwagie-product-core"))
            .env_clear()
            .env("SUPERWAGIE_CORE_KEY", hex::encode(key))
            .env("SUPERWAGIE_STATE_ROOT", state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut process = Self {
            child,
            input,
            output,
            reader: Some(reader),
            hello: Value::Null,
            sequence: 0,
            key,
        };
        process.write(&json!({"type":"hello","protocol":"superwagie-product-v1","request_id":"hello:test",
            "deadline_ms":deadline(),"main_nonce":"agent-test-fixture-nonce","main_identity":"electron-main@44.1.0"}));
        process.hello = process.read();
        assert_eq!(process.hello["identity"], "superwagie-rust-product-core");
        process
    }

    fn mac(&self, value: &Value) -> Hmac<Sha256> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).unwrap();
        // serde_json's pinned default Map is a BTreeMap; this fixture contains
        // integer-only numbers and follows the protocol's sorted-key JSON.
        mac.update(&serde_json::to_vec(value).unwrap());
        mac
    }

    fn write(&mut self, value: &Value) {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
    }

    fn read(&mut self) -> Value {
        let line = self
            .output
            .recv_timeout(Duration::from_secs(5))
            .expect("Core reply deadline");
        let mut value: Value = serde_json::from_str(&line).unwrap();
        let signature = value.as_object_mut().unwrap().remove("mac").unwrap();
        self.mac(&value)
            .verify_slice(&hex::decode(signature.as_str().unwrap()).unwrap())
            .unwrap();
        value
    }

    pub fn call(&mut self, command: Value) -> Value {
        self.sequence += 1;
        let mut envelope = json!({"type":"request","protocol":"superwagie-product-v1",
            "request_id":format!("transport:{}",self.sequence),"deadline_ms":deadline(),
            "main_nonce":self.hello["main_nonce"],"core_nonce":self.hello["core_nonce"],
            "sequence":self.sequence,"command":command});
        envelope["mac"] = json!(hex::encode(self.mac(&envelope).finalize().into_bytes()));
        self.write(&envelope);
        let reply = self.read();
        assert_eq!(reply["sequence"], self.sequence);
        assert_eq!(reply["request_id"], envelope["request_id"]);
        reply
    }

    pub fn ok(&mut self, command: Value) -> Value {
        let reply = self.call(command);
        assert_eq!(reply["ok"], true, "{reply}");
        reply["result"].clone()
    }
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
