mod support;

use serde_json::{Value, json};
use superwagie_product_core::agent::{ThreadAction, ThreadCommand, ThreadStore};
use superwagie_product_core::gateway::Gateway;
use support::TestWorkspace;

fn request(message: &str) -> Value {
    json!({"protocol_version":1,"message_type":message,"request_id":"request:read",
        "query_id":"agent.thread_state","params":{"task_thread_id":"thread:one"}})
}

fn change(f: &TestWorkspace, store: &ThreadStore, revision: u64, action: ThreadAction) {
    store
        .apply(&ThreadCommand {
            project_id: f.core().project_id().into(),
            thread_id: "thread:one".into(),
            request_id: format!("request:write:{revision}"),
            expected_revision: revision,
            action,
        })
        .unwrap();
}

#[test]
fn snapshot_uses_durable_revision_and_does_not_expose_storage_or_authority() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    change(&f, &store, 0, ThreadAction::Create);
    let mut gateway = Gateway::open(f.state()).unwrap();
    let snapshot = gateway.query(&request("query.execute")).unwrap();
    assert_eq!(snapshot["snapshot_revision"], 1);
    assert_eq!(snapshot["projection_version"], "agent_state:v1");
    assert_eq!(
        snapshot["payload"],
        json!({"project_id":f.core().project_id(),"task_thread_id":"thread:one",
        "state":"ready","turn":0,"has_state_checkpoint":false,"updated_at":store.get(f.core().project_id(), "thread:one").unwrap().updated_at})
    );
    assert!(snapshot["event_cursor"].as_str().is_some());
    assert!(!snapshot.to_string().contains(f.state().to_str().unwrap()));
    assert_eq!(
        gateway.query(&request("query.execute")).unwrap()["snapshot_revision"],
        1
    );
}

fn setup() -> (TestWorkspace, ThreadStore, Gateway) {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    change(&f, &store, 0, ThreadAction::Create);
    let gateway = Gateway::open(f.state()).unwrap();
    (f, store, gateway)
}

#[test]
fn subscription_delivers_only_contiguous_changes_and_is_quiet_without_changes() {
    let (f, store, mut gateway) = setup();
    let opened = gateway.query(&request("subscription.open")).unwrap();
    assert_eq!(opened["message_type"], "subscription.accepted");
    assert_eq!(opened["snapshot"]["snapshot_revision"], 1);
    let id = opened["subscription_id"].as_str().unwrap();
    assert!(gateway.poll_agent_subscription(id).unwrap().is_none());
    change(&f, &store, 1, ThreadAction::Start);
    let event = gateway.poll_agent_subscription(id).unwrap().unwrap();
    assert_eq!(event["message_type"], "subscription.event");
    assert_eq!(event["snapshot_revision"], 2);
    assert_eq!(event["payload"]["state"], "running");
    assert!(gateway.poll_agent_subscription(id).unwrap().is_none());
    change(&f, &store, 2, ThreadAction::Complete);
    assert_eq!(
        gateway.poll_agent_subscription(id).unwrap().unwrap()["snapshot_revision"],
        3
    );
    assert_eq!(
        store
            .get(f.core().project_id(), "thread:one")
            .unwrap()
            .revision,
        3
    );
}

#[test]
fn missing_revisions_require_snapshot_instead_of_guessing_an_event() {
    let (f, store, mut gateway) = setup();
    let opened = gateway.query(&request("subscription.open")).unwrap();
    let id = opened["subscription_id"].as_str().unwrap();
    change(&f, &store, 1, ThreadAction::Start);
    change(&f, &store, 2, ThreadAction::Complete);
    let gap = gateway.poll_agent_subscription(id).unwrap().unwrap();
    assert_eq!(gap["reason"], "cursor_gap");
    assert_eq!(gap["next_action"], "query.execute");
    assert!(gap.get("payload").is_none());
    assert!(gateway.poll_agent_subscription(id).is_err());
    assert_eq!(
        gateway.query(&request("query.execute")).unwrap()["snapshot_revision"],
        3
    );
}

#[test]
fn old_cursor_requires_resync_but_current_cursor_can_subscribe() {
    let (f, store, mut gateway) = setup();
    let first = gateway.query(&request("query.execute")).unwrap();
    let mut resume = request("subscription.open");
    resume["after_cursor"] = first["event_cursor"].clone();
    assert_eq!(
        gateway.query(&resume).unwrap()["message_type"],
        "subscription.accepted"
    );
    change(&f, &store, 1, ThreadAction::Start);
    assert_eq!(gateway.query(&resume).unwrap()["reason"], "cursor_gap");
    resume["after_cursor"] =
        gateway.query(&request("query.execute")).unwrap()["event_cursor"].clone();
    assert_eq!(
        gateway.query(&resume).unwrap()["snapshot"]["snapshot_revision"],
        2
    );
}

#[test]
fn reopen_invalidates_old_cursor_and_subscription_without_changing_thread() {
    let (f, store, mut gateway) = setup();
    change(&f, &store, 1, ThreadAction::Start);
    let opened = gateway.query(&request("subscription.open")).unwrap();
    drop(gateway);
    let mut gateway = Gateway::open(f.state()).unwrap();
    let mut resume = request("subscription.open");
    resume["after_cursor"] = opened["snapshot"]["event_cursor"].clone();
    assert_eq!(gateway.query(&resume).unwrap()["reason"], "core_restarted");
    assert_eq!(
        gateway
            .poll_agent_subscription(opened["subscription_id"].as_str().unwrap())
            .unwrap()
            .unwrap()["reason"],
        "core_restarted"
    );
    assert_eq!(
        gateway.query(&request("query.execute")).unwrap()["payload"]["state"],
        "running"
    );
    assert_eq!(
        store
            .get(f.core().project_id(), "thread:one")
            .unwrap()
            .revision,
        2
    );
}

#[test]
fn revocation_invalidates_live_subscription_and_denies_fresh_snapshot() {
    let (f, _, mut gateway) = setup();
    let opened = gateway.query(&request("subscription.open")).unwrap();
    f.core().revoke().unwrap();
    assert!(gateway.query(&request("query.execute")).is_err());
    let event = gateway
        .poll_agent_subscription(opened["subscription_id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(event["reason"], "scope_changed");
    assert!(event.get("payload").is_none());
}

#[test]
fn changing_projects_cannot_reuse_old_subscription_even_when_switching_back() {
    use superwagie_product_core::protocol::ShellSelection;
    let (f, _, mut gateway) = setup();
    let opened = gateway.query(&request("subscription.open")).unwrap();
    let other = f.root().join("other");
    std::fs::create_dir(&other).unwrap();
    gateway.select(ShellSelection::selected(other)).unwrap();
    assert!(gateway.query(&request("query.execute")).is_err());
    gateway
        .select(ShellSelection::selected(f.root().into()))
        .unwrap();
    assert_eq!(
        gateway
            .poll_agent_subscription(opened["subscription_id"].as_str().unwrap())
            .unwrap()
            .unwrap()["reason"],
        "scope_changed"
    );
    let mut resume = request("subscription.open");
    resume["after_cursor"] = opened["snapshot"]["event_cursor"].clone();
    assert_eq!(gateway.query(&resume).unwrap()["reason"], "scope_changed");
}

#[test]
fn replaced_root_identity_denies_snapshot_and_invalidates_subscription() {
    let (f, _, mut gateway) = setup();
    let opened = gateway.query(&request("subscription.open")).unwrap();
    let moved = f.root().with_file_name("moved-workspace");
    std::fs::rename(f.root(), moved).unwrap();
    std::fs::create_dir(f.root()).unwrap();
    assert!(gateway.query(&request("query.execute")).is_err());
    assert_eq!(
        gateway
            .poll_agent_subscription(opened["subscription_id"].as_str().unwrap())
            .unwrap()
            .unwrap()["reason"],
        "scope_changed"
    );
}

#[test]
fn closed_subscription_releases_capacity_and_old_id_is_not_live() {
    let (_fixture, _store, mut gateway) = setup();
    let mut ids = Vec::new();
    for _ in 0..64 {
        ids.push(
            gateway.query(&request("subscription.open")).unwrap()["subscription_id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    assert!(gateway.query(&request("subscription.open")).is_err());
    assert!(gateway.close_agent_subscription(&ids[0]).unwrap());
    assert!(!gateway.close_agent_subscription(&ids[0]).unwrap());
    assert!(gateway.poll_agent_subscription(&ids[0]).is_err());
    assert!(gateway.query(&request("subscription.open")).is_ok());
}

#[test]
fn spoofed_context_null_cursor_and_oversized_requests_are_rejected() {
    let (f, store, mut gateway) = setup();
    for field in [
        "project_id",
        "actor_context",
        "wallet_id",
        "permission_context",
        "state",
    ] {
        let mut query = request("query.execute");
        query["params"][field] = json!("forged");
        assert!(gateway.query(&query).is_err(), "{field}");
        let mut query = request("query.execute");
        query[field] = json!("forged");
        assert!(gateway.query(&query).is_err());
    }
    for value in [Value::Null, json!(""), json!("x".repeat(513))] {
        let mut query = request("subscription.open");
        query["after_cursor"] = value;
        assert!(gateway.query(&query).is_err());
    }
    let mut query = request("query.execute");
    query["params"]["task_thread_id"] = json!("x".repeat(1024 * 1024));
    assert!(gateway.query(&query).is_err());
    assert_eq!(
        store
            .get(f.core().project_id(), "thread:one")
            .unwrap()
            .revision,
        1
    );
}

#[test]
fn tampered_cursor_is_rejected_and_old_projection_requests_resync() {
    let (_fixture, _store, mut gateway) = setup();
    let snapshot = gateway.query(&request("query.execute")).unwrap();
    let cursor = snapshot["event_cursor"].as_str().unwrap();
    let mut tampered = cursor.to_owned();
    let last = tampered.pop().unwrap();
    tampered.push(if last == '0' { '1' } else { '0' });
    let mut resume = request("subscription.open");
    resume["after_cursor"] = json!(tampered);
    assert!(gateway.query(&resume).is_err());
    // A version mismatch is only a resync hint, never access authority.
    resume["after_cursor"] = json!(cursor.replacen("agent_state:v1", "agent_state:v0", 1));
    assert_eq!(
        gateway.query(&resume).unwrap()["reason"],
        "projection_changed"
    );
}

#[test]
fn revisions_outside_javascript_exact_integer_range_are_never_rounded_in_projection() {
    let (f, store, mut gateway) = setup();
    let mut record = store.get(f.core().project_id(), "thread:one").unwrap();
    record.revision = 9_007_199_254_740_992;
    let sql = rusqlite::Connection::open(f.state().join("operational.sqlite3")).unwrap();
    sql.execute(
        "UPDATE agent_threads SET revision=?1,record_json=?2",
        rusqlite::params![
            record.revision as i64,
            serde_json::to_string(&record).unwrap()
        ],
    )
    .unwrap();
    assert!(gateway.query(&request("query.execute")).is_err());
}

#[test]
fn cursor_for_another_thread_cannot_bind_to_current_thread_subscription() {
    let (f, store, mut gateway) = setup();
    let first = gateway.query(&request("query.execute")).unwrap();
    store
        .apply(&ThreadCommand {
            project_id: f.core().project_id().into(),
            thread_id: "thread:two".into(),
            request_id: "create:two".into(),
            expected_revision: 0,
            action: ThreadAction::Create,
        })
        .unwrap();
    let mut resume = request("subscription.open");
    resume["params"]["task_thread_id"] = json!("thread:two");
    resume["after_cursor"] = first["event_cursor"].clone();
    let result = gateway.query(&resume).unwrap();
    assert_eq!(result["reason"], "scope_changed");
    assert!(result.get("payload").is_none());
}

#[test]
fn malformed_queries_and_unknown_subscription_ids_do_not_panic_or_mutate() {
    let (f, store, mut gateway) = setup();
    for cursor in ["x", ".....", "agent_state:v1.💥.0.x.1.x", "agent_state:v1"] {
        let mut query = request("subscription.open");
        query["after_cursor"] = json!(cursor);
        assert!(gateway.query(&query).is_err());
    }
    for id in ["", "not:a:subscription", "💥", "subscription:x:0:1"] {
        assert!(gateway.poll_agent_subscription(id).is_err());
        assert!(gateway.close_agent_subscription(id).is_err());
    }
    let mut query = request("query.execute");
    query["protocol_version"] = json!(2);
    assert!(gateway.query(&query).is_err());
    assert_eq!(
        store
            .get(f.core().project_id(), "thread:one")
            .unwrap()
            .revision,
        1
    );
}
