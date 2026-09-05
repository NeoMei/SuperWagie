mod support;

use serde_json::json;
use sha2::Digest;
use superwagie_product_core::gateway::Gateway;
use superwagie_product_core::protocol::ShellSelection;
use support::TestWorkspace;

#[test]
fn a_cancelled_shell_selection_creates_no_mount() {
    let fixture = TestWorkspace::new();
    fixture.core().revoke().unwrap();
    let mut gateway = Gateway::open_for_test(fixture.state()).unwrap();
    assert!(
        gateway
            .select(ShellSelection::cancelled())
            .unwrap()
            .is_none()
    );
    let projects = gateway
        .query(&json!({
            "protocol_version": 1,
            "message_type": "query.execute",
            "request_id": "request:one",
            "query_id": "project.list",
            "params": {}
        }))
        .unwrap();
    assert_eq!(projects["payload"]["items"], json!([]));
}

#[test]
fn selected_root_stays_out_of_project_and_tree_snapshots() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"body");
    let mut gateway = Gateway::open_for_test(fixture.state()).unwrap();
    let selected = gateway
        .select(ShellSelection::selected(fixture.root().to_owned()))
        .unwrap()
        .unwrap();
    let tree = gateway
        .query(&json!({
            "protocol_version": 1,
            "message_type": "query.execute",
            "request_id": "request:tree",
            "query_id": "workspace.tree",
            "params": {"project_id": selected.project_id}
        }))
        .unwrap();
    assert_eq!(tree["payload"]["items"][0]["logical_path"], "正文.md");
    let serialized = serde_json::to_string(&tree).unwrap();
    assert!(!serialized.contains(fixture.root().to_str().unwrap()));
}

#[test]
fn document_snapshot_returns_a_scoped_handle_not_inline_content() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"secret body");
    let mut gateway = Gateway::open_for_test(fixture.state()).unwrap();
    let selected = gateway
        .select(ShellSelection::selected(fixture.root().to_owned()))
        .unwrap()
        .unwrap();
    let tree = gateway
        .query(&json!({
            "protocol_version": 1,
            "message_type": "query.execute",
            "request_id": "request:tree",
            "query_id": "workspace.tree",
            "params": {"project_id": selected.project_id}
        }))
        .unwrap();
    let document_id = tree["payload"]["items"][0]["document_id"].as_str().unwrap();
    let snapshot = gateway
        .query(&json!({
            "protocol_version": 1,
            "message_type": "query.execute",
            "request_id": "request:document",
            "query_id": "document.snapshot",
            "params": {"document_id": document_id}
        }))
        .unwrap();
    assert!(
        snapshot["payload"]["content_handle"]["handle_id"]
            .as_str()
            .is_some()
    );
    assert!(snapshot["payload"].get("content").is_none());
    assert!(
        !serde_json::to_string(&snapshot)
            .unwrap()
            .contains("secret body")
    );
}

#[test]
fn core_restart_reopens_only_the_persisted_active_grant() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"body");
    let project_id = {
        let mut gateway = Gateway::open_for_test(fixture.state()).unwrap();
        gateway
            .select(ShellSelection::selected(fixture.root().to_owned()))
            .unwrap()
            .unwrap()
            .project_id
    };
    let mut restarted = Gateway::open_for_test(fixture.state()).unwrap();
    let projects = restarted
        .query(&json!({
            "protocol_version": 1,
            "message_type": "query.execute",
            "request_id": "request:restart",
            "query_id": "project.list",
            "params": {}
        }))
        .unwrap();
    assert_eq!(projects["payload"]["items"][0]["project_id"], project_id);
}

#[test]
fn renderer_save_uses_a_staged_draft_handle_not_inline_content() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let mut gateway = Gateway::open_for_test(fixture.state()).unwrap();
    let selected = gateway
        .select(ShellSelection::selected(fixture.root().to_owned()))
        .unwrap()
        .unwrap();
    let tree = gateway
        .query(&json!({
            "protocol_version": 1,
            "message_type": "query.execute",
            "request_id": "request:tree-save",
            "query_id": "workspace.tree",
            "params": {"project_id": selected.project_id}
        }))
        .unwrap();
    let document_id = tree["payload"]["items"][0]["document_id"].as_str().unwrap();
    let base = fixture.core().read("正文.md").unwrap();
    let proposed = "中文🙂".as_bytes();
    let upload_id = gateway
        .begin_draft_upload(
            document_id,
            &base.revision,
            proposed.len(),
            &format!("sha256:{}", hex::encode(sha2::Sha256::digest(proposed))),
            17,
        )
        .unwrap();
    gateway
        .append_draft_upload(&upload_id, 0, proposed)
        .unwrap();
    let draft = gateway.finish_draft_upload(&upload_id).unwrap();
    let result = gateway
        .command(&json!({
            "protocol_version": 1,
            "request_id": "request:save",
            "command_type": "document.save",
            "resource_refs": [],
            "requested_permissions": ["workspace.write"],
            "expected_revision": null,
            "payload": {
                "document_id": document_id,
                "base_revision": base.revision,
                "draft_handle_id": draft.handle_id,
                "change_generation": 17
            },
            "issued_at": "2026-09-05T00:00:00Z",
            "deadline_at": null
        }))
        .unwrap();
    assert_eq!(result["status"], "committed");
    assert_eq!(fixture.read("正文.md"), proposed);
}

#[test]
fn resource_handle_rejects_wrong_audience_range_and_stale_revision() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"resource body");
    let mut gateway = Gateway::open_for_test(fixture.state()).unwrap();
    let selected = gateway
        .select(ShellSelection::selected(fixture.root().to_owned()))
        .unwrap()
        .unwrap();
    let tree = gateway
        .query(&json!({
            "protocol_version": 1,
            "message_type": "query.execute",
            "request_id": "request:resource-tree",
            "query_id": "workspace.tree",
            "params": {"project_id": selected.project_id}
        }))
        .unwrap();
    let document_id = tree["payload"]["items"][0]["document_id"]
        .as_str()
        .unwrap();
    let snapshot = gateway
        .query(&json!({
            "protocol_version": 1,
            "message_type": "query.execute",
            "request_id": "request:resource-document",
            "query_id": "document.snapshot",
            "params": {"document_id": document_id}
        }))
        .unwrap();
    let handle_id = snapshot["payload"]["content_handle"]["handle_id"]
        .as_str()
        .unwrap();
    assert!(gateway.read_resource(handle_id, "other_surface", 0, 1).is_err());
    assert!(gateway.read_resource(handle_id, "app_ui", 0, 256 * 1024 + 1).is_err());
    fixture.write("正文.md", b"external revision");
    assert!(gateway.read_resource(handle_id, "app_ui", 0, 1).is_err());
}
