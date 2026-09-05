use serde_json::json;
use superwagie_product_core::protocol::{
    MAX_ENVELOPE_BYTES, ShellSelection, validate_query_payload, validate_renderer_bytes,
    validate_renderer_payload,
};

fn intent(command_type: &str, payload: serde_json::Value) -> serde_json::Value {
    json!({
        "protocol_version": 1,
        "request_id": "request:protocol-1",
        "command_type": command_type,
        "resource_refs": [],
        "requested_permissions": [],
        "payload": payload,
        "issued_at": "2026-09-05T00:00:00Z"
    })
}

#[test]
fn renderer_cannot_supply_selected_root() {
    let value = intent(
        "project.open_selected",
        json!({"selected_root":"/tmp/not-authorized"}),
    );
    assert!(validate_renderer_payload(&value).is_err());
}

#[test]
fn renderer_cannot_forge_trusted_context() {
    let mut value = intent("project.activate", json!({"project_id":"project:one"}));
    value
        .as_object_mut()
        .unwrap()
        .insert("actor_context".into(), json!({"user_id":"forged"}));
    assert!(validate_renderer_payload(&value).is_err());
}

#[test]
fn renderer_payloads_are_closed_and_versioned() {
    let unknown = intent(
        "document.open",
        json!({"document_id":"document:one", "selected_root":"/tmp/escape"}),
    );
    assert!(validate_renderer_payload(&unknown).is_err());

    let mut wrong_version = intent("project.activate", json!({"project_id":"project:one"}));
    wrong_version["protocol_version"] = json!(2);
    assert!(validate_renderer_payload(&wrong_version).is_err());
}

#[test]
fn save_references_a_durable_staged_draft_instead_of_inline_bytes() {
    let valid = intent(
        "document.save",
        json!({
            "document_id":"document:one",
            "base_revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "draft_handle_id":"handle:draft-one",
            "change_generation":7
        }),
    );
    assert!(validate_renderer_payload(&valid).is_ok());

    let inline = intent(
        "document.save",
        json!({
            "document_id":"document:one",
            "base_revision":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "draft_handle_id":"handle:draft-one",
            "change_generation":7,
            "content":"must not cross the command envelope"
        }),
    );
    assert!(validate_renderer_payload(&inline).is_err());
}

#[test]
fn renderer_envelope_limit_is_measured_in_utf8_bytes() {
    let oversized = vec![b'x'; MAX_ENVELOPE_BYTES + 1];
    assert!(validate_renderer_bytes(&oversized).is_err());
}

#[test]
fn only_registered_product_queries_are_accepted() {
    let valid = json!({
        "protocol_version":1,
        "message_type":"query.execute",
        "request_id":"request:query-1",
        "query_id":"project.list",
        "params":{}
    });
    assert!(validate_query_payload(&valid).is_ok());

    let unknown = json!({
        "protocol_version":1,
        "message_type":"query.execute",
        "request_id":"request:query-2",
        "query_id":"poc.query_snapshot",
        "params":{}
    });
    assert!(validate_query_payload(&unknown).is_err());
}

#[test]
fn shell_selection_is_a_separate_trusted_type() {
    let selected = ShellSelection::selected("/tmp/测试项目".into());
    assert_eq!(
        selected.selected_root().unwrap().to_string_lossy(),
        "/tmp/测试项目"
    );
    assert!(ShellSelection::cancelled().selected_root().is_none());
}
