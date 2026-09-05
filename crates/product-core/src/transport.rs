use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::gateway::{Gateway, GatewayError};
use crate::protocol::{MAX_ENVELOPE_BYTES, ShellSelection};

type HmacSha256 = Hmac<Sha256>;
const TRANSPORT_PROTOCOL: &str = "superwagie-product-v1";
const CORE_IDENTITY: &str = "superwagie-rust-product-core";

#[derive(Debug)]
pub enum TransportError {
    Environment,
    InvalidMessage,
    Authentication,
    Replay,
    Expired,
    Io(io::Error),
    Json(serde_json::Error),
    Gateway(GatewayError),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Environment => "SW_TRANSPORT_ENVIRONMENT",
            Self::InvalidMessage => "SW_TRANSPORT_INVALID_MESSAGE",
            Self::Authentication => "SW_TRANSPORT_AUTHENTICATION",
            Self::Replay => "SW_TRANSPORT_REPLAY",
            Self::Expired => "SW_TRANSPORT_EXPIRED",
            Self::Io(_) => "SW_TRANSPORT_IO",
            Self::Json(_) => "SW_TRANSPORT_JSON",
            Self::Gateway(_) => "SW_TRANSPORT_GATEWAY",
        })
    }
}

impl std::error::Error for TransportError {}

impl From<io::Error> for TransportError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for TransportError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<GatewayError> for TransportError {
    fn from(value: GatewayError) -> Self {
        Self::Gateway(value)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    r#type: String,
    protocol: String,
    request_id: String,
    deadline_ms: u64,
    main_nonce: String,
    main_identity: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthenticatedRequest {
    r#type: String,
    protocol: String,
    request_id: String,
    deadline_ms: u64,
    main_nonce: String,
    core_nonce: String,
    sequence: u64,
    command: Value,
    mac: String,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("string serialization"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("key serialization"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn sign(key: &[u8], value: &Value) -> Result<String, TransportError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| TransportError::Environment)?;
    mac.update(canonical_json(value).as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn verify(key: &[u8], value: &Value, supplied: &str) -> Result<(), TransportError> {
    let supplied = hex::decode(supplied).map_err(|_| TransportError::Authentication)?;
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| TransportError::Environment)?;
    mac.update(canonical_json(value).as_bytes());
    mac.verify_slice(&supplied)
        .map_err(|_| TransportError::Authentication)
}

fn exact_object_without_mac(value: &Value) -> Result<Value, TransportError> {
    let object = value.as_object().ok_or(TransportError::InvalidMessage)?;
    let mut unsigned = Map::new();
    for (key, value) in object {
        if key != "mac" {
            unsigned.insert(key.clone(), value.clone());
        }
    }
    Ok(Value::Object(unsigned))
}

fn write_signed(
    output: &mut impl Write,
    key: &[u8],
    mut value: Map<String, Value>,
) -> Result<(), TransportError> {
    let unsigned = Value::Object(value.clone());
    value.insert("mac".to_owned(), Value::String(sign(key, &unsigned)?));
    let encoded = serde_json::to_vec(&Value::Object(value))?;
    if encoded.len() > MAX_ENVELOPE_BYTES {
        return Err(TransportError::InvalidMessage);
    }
    output.write_all(&encoded)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn read_bounded_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, TransportError> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                Ok(Some(output))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content = newline.map_or(available, |index| &available[..index]);
        if output.len().saturating_add(content.len()) > MAX_ENVELOPE_BYTES {
            return Err(TransportError::InvalidMessage);
        }
        output.extend_from_slice(content);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(output));
        }
    }
}

fn command_result(gateway: &mut Gateway, command: &Value) -> Result<(Value, bool), GatewayError> {
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .ok_or(GatewayError::InvalidRequest)?;
    match command_type {
        "heartbeat" => Ok((json!({"status": "alive"}), false)),
        "shutdown" => Ok((json!({"status": "checkpointed"}), true)),
        "shell_select" => {
            let selected_root = command.get("selected_root").and_then(Value::as_str);
            let selection = selected_root
                .map(|root| ShellSelection::selected(PathBuf::from(root)))
                .unwrap_or_else(ShellSelection::cancelled);
            let selected = gateway.select(selection)?;
            Ok((
                selected
                    .map(|project| {
                        json!({
                            "status": "selected",
                            "project_id": project.project_id,
                            "workspace_id": project.workspace_id
                        })
                    })
                    .unwrap_or_else(|| json!({"status": "cancelled"})),
                false,
            ))
        }
        "query" => Ok((gateway.query(&command["request"])?, false)),
        "resource_read" => {
            let handle_id = command["handle_id"]
                .as_str()
                .ok_or(GatewayError::InvalidRequest)?;
            let audience = command["audience"]
                .as_str()
                .ok_or(GatewayError::InvalidRequest)?;
            let offset = command["offset"]
                .as_u64()
                .and_then(|value| value.try_into().ok())
                .ok_or(GatewayError::InvalidRequest)?;
            let length = command["length"]
                .as_u64()
                .and_then(|value| value.try_into().ok())
                .ok_or(GatewayError::InvalidRequest)?;
            let bytes = gateway.read_resource(handle_id, audience, offset, length)?;
            Ok((json!({"content_hex": hex::encode(bytes)}), false))
        }
        _ => Err(GatewayError::InvalidRequest),
    }
}

pub fn run_stdio() -> Result<(), TransportError> {
    let key = env::var("SUPERWAGIE_CORE_KEY")
        .ok()
        .and_then(|value| hex::decode(value).ok())
        .filter(|value| value.len() == 32)
        .ok_or(TransportError::Environment)?;
    let state_root = env::var_os("SUPERWAGIE_STATE_ROOT")
        .map(PathBuf::from)
        .ok_or(TransportError::Environment)?;
    let mut gateway = Gateway::open(&state_root)?;
    let input = io::stdin();
    let mut reader = input.lock();
    let output = io::stdout();
    let mut writer = output.lock();
    let line = read_bounded_line(&mut reader)?.ok_or(TransportError::InvalidMessage)?;
    let hello_value: Value = serde_json::from_slice(&line)?;
    let hello: Hello = serde_json::from_value(hello_value)?;
    if hello.r#type != "hello"
        || hello.protocol != TRANSPORT_PROTOCOL
        || hello.request_id.is_empty()
        || hello.deadline_ms < now_millis()
        || hello.main_nonce.len() < 16
        || hello.main_identity != "electron-main@44.1.0"
    {
        return Err(TransportError::InvalidMessage);
    }
    let core_nonce = hex::encode(
        &Sha256::digest(
            format!(
                "{}:{}:{}",
                hello.main_nonce,
                std::process::id(),
                now_millis()
            )
            .as_bytes(),
        )[..16],
    );
    let ack = json!({
        "type": "hello_ack",
        "protocol": TRANSPORT_PROTOCOL,
        "request_id": hello.request_id,
        "deadline_ms": hello.deadline_ms,
        "main_nonce": hello.main_nonce,
        "core_nonce": core_nonce,
        "identity": CORE_IDENTITY,
        "pid": std::process::id()
    });
    write_signed(
        &mut writer,
        &key,
        ack.as_object()
            .cloned()
            .ok_or(TransportError::InvalidMessage)?,
    )?;

    let mut expected_sequence = 1_u64;
    loop {
        let Some(line) = read_bounded_line(&mut reader)? else {
            return Ok(());
        };
        let value: Value = serde_json::from_slice(&line)?;
        let request: AuthenticatedRequest = serde_json::from_value(value.clone())?;
        if request.r#type != "request"
            || request.protocol != TRANSPORT_PROTOCOL
            || request.main_nonce != ack["main_nonce"]
            || request.core_nonce != ack["core_nonce"]
        {
            return Err(TransportError::Authentication);
        }
        if request.sequence != expected_sequence {
            return Err(TransportError::Replay);
        }
        if request.deadline_ms < now_millis() {
            return Err(TransportError::Expired);
        }
        let unsigned = exact_object_without_mac(&value)?;
        verify(&key, &unsigned, &request.mac)?;
        expected_sequence = expected_sequence.saturating_add(1);
        let (ok, result, code, shutdown) = match command_result(&mut gateway, &request.command) {
            Ok((result, shutdown)) => (true, Some(result), None, shutdown),
            Err(error) => (false, None, Some(error.to_string()), false),
        };
        let mut response = Map::from_iter([
            ("type".to_owned(), json!("response")),
            ("protocol".to_owned(), json!(TRANSPORT_PROTOCOL)),
            ("request_id".to_owned(), json!(request.request_id)),
            ("deadline_ms".to_owned(), json!(request.deadline_ms)),
            ("main_nonce".to_owned(), ack["main_nonce"].clone()),
            ("core_nonce".to_owned(), ack["core_nonce"].clone()),
            ("sequence".to_owned(), json!(request.sequence)),
            ("identity".to_owned(), json!(CORE_IDENTITY)),
            ("ok".to_owned(), json!(ok)),
        ]);
        if let Some(result) = result {
            response.insert("result".to_owned(), result);
        }
        if let Some(code) = code {
            response.insert("code".to_owned(), json!(code));
        }
        write_signed(&mut writer, &key, response)?;
        if shutdown {
            return Ok(());
        }
    }
}
