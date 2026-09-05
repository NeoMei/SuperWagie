use super::GatewayError;
use crate::agent::ThreadRecord;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub(super) const PROJECTION: &str = "agent_state:v1";
type HmacSha256 = Hmac<Sha256>;

pub(super) struct AgentCursor {
    key: [u8; 32],
    pub boot: String,
    pub scope_generation: u64,
}

fn scope(record: &ThreadRecord) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(&(&record.project_id, &record.thread_id))
            .expect("identifier serialization"),
    ))
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

fn number(value: &str) -> Result<u64, GatewayError> {
    value
        .parse::<u64>()
        .ok()
        .filter(|n| n.to_string() == value)
        .ok_or(GatewayError::InvalidRequest)
}

impl AgentCursor {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            boot: hex::encode(&Sha256::digest(key)[..16]),
            key,
            scope_generation: 0,
        }
    }

    fn mac(&self, payload: &str) -> HmacSha256 {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC key length");
        mac.update(b"superwagie-agent-state-cursor:");
        mac.update(payload.as_bytes());
        mac
    }

    pub fn issue(&self, record: &ThreadRecord) -> String {
        let payload = format!(
            "{PROJECTION}.{}.{}.{}.{}",
            self.boot,
            self.scope_generation,
            scope(record),
            record.revision
        );
        format!(
            "{payload}.{}",
            hex::encode(self.mac(&payload).finalize().into_bytes())
        )
    }

    // Boot/version hints can only request resync. Current-instance cursors must
    // authenticate before being used; neither path authorizes reading a project.
    pub fn check(
        &self,
        cursor: &str,
        record: &ThreadRecord,
    ) -> Result<Option<&'static str>, GatewayError> {
        let parts: Vec<_> = cursor.split('.').collect();
        if cursor.len() > 512
            || parts.len() != 6
            || !parts[0].starts_with("agent_state:v")
            || parts[0][13..].is_empty()
            || !parts[0][13..].bytes().all(|v| v.is_ascii_digit())
            || !is_hex(parts[1], 32)
            || !is_hex(parts[3], 64)
            || !is_hex(parts[5], 64)
        {
            return Err(GatewayError::InvalidRequest);
        }
        let generation = number(parts[2])?;
        let revision = number(parts[4])?;
        if parts[0] != PROJECTION {
            return Ok(Some("projection_changed"));
        }
        if parts[1] != self.boot {
            return Ok(Some("core_restarted"));
        }
        self.mac(&parts[..5].join("."))
            .verify_slice(&hex::decode(parts[5]).map_err(|_| GatewayError::InvalidRequest)?)
            .map_err(|_| GatewayError::InvalidRequest)?;
        if generation != self.scope_generation || parts[3] != scope(record) {
            return Ok(Some("scope_changed"));
        }
        if revision != record.revision {
            return Ok(Some("cursor_gap"));
        }
        Ok(None)
    }

    pub fn subscription_id(&self, serial: u64) -> String {
        format!(
            "subscription:{}:{}:{serial}",
            self.boot, self.scope_generation
        )
    }

    pub fn subscription_scope(&self, id: &str) -> Result<Option<&'static str>, GatewayError> {
        let parts: Vec<_> = id.split(':').collect();
        if id.len() > 128 || parts.len() != 4 || parts[0] != "subscription" || !is_hex(parts[1], 32)
        {
            return Err(GatewayError::InvalidRequest);
        }
        let generation = number(parts[2])?;
        number(parts[3])?;
        if parts[1] != self.boot {
            return Ok(Some("core_restarted"));
        }
        if generation != self.scope_generation {
            return Ok(Some("scope_changed"));
        }
        Ok(None)
    }
}
