use super::{MAX_ENVELOPE_BYTES, PROTOCOL_VERSION, ProtocolError, is_identifier};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AgentQuery {
    protocol_version: u64,
    pub message_type: String,
    pub request_id: String,
    query_id: String,
    pub params: Params,
    pub after_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Params {
    pub task_thread_id: String,
}

pub(crate) fn parse(value: &Value) -> Result<AgentQuery, ProtocolError> {
    if serde_json::to_vec(value)
        .map_err(|_| ProtocolError::InvalidJson)?
        .len()
        > MAX_ENVELOPE_BYTES
    {
        return Err(ProtocolError::EnvelopeTooLarge);
    }
    let request: AgentQuery =
        serde_json::from_value(value.clone()).map_err(|_| ProtocolError::InvalidEnvelope)?;
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }
    if request.query_id != "agent.thread_state"
        || !matches!(
            request.message_type.as_str(),
            "query.execute" | "subscription.open"
        )
        || !is_identifier(&request.request_id)
        || !is_identifier(&request.params.task_thread_id)
        || (value.get("after_cursor").is_some()
            && (request.message_type != "subscription.open"
                || request
                    .after_cursor
                    .as_ref()
                    .is_none_or(|v| v.is_empty() || v.len() > 512)))
    {
        return Err(ProtocolError::InvalidEnvelope);
    }
    Ok(request)
}
