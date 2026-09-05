#[path = "support/agent_transport.rs"]
mod agent_transport;
mod support;

use agent_transport::CoreProcess;
use serde_json::{Value, json};
use superwagie_product_core::agent::{ThreadAction, ThreadCommand, ThreadStore};
use support::TestWorkspace;

fn query(message: &str) -> Value {
    json!({"protocol_version":1,"message_type":message,"request_id":"query:test",
        "query_id":"agent.thread_state","params":{"task_thread_id":"thread:one"}})
}

fn mutate(f: &TestWorkspace, store: &ThreadStore, revision: u64, action: ThreadAction) {
    store
        .apply(&ThreadCommand {
            project_id: f.core().project_id().into(),
            thread_id: "thread:one".into(),
            request_id: format!("mutation:{revision}"),
            expected_revision: revision,
            action,
        })
        .unwrap();
}

#[test]
fn signed_real_core_subscription_survives_only_through_fresh_snapshot_after_restart() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    mutate(&f, &store, 0, ThreadAction::Create);
    let mut core = CoreProcess::start(f.state());
    let request = query("query.execute");
    let snapshot = core.ok(json!({"type":"query","request":request}));
    assert_eq!(snapshot["payload"]["state"], "ready");
    assert_eq!(
        core.call(json!({"type":"query","request":request,"actor_context":"forged"}))["ok"],
        false
    );
    let subscribe = query("subscription.open");
    let opened = core.ok(json!({"type":"query","request":subscribe}));
    let id = opened["subscription_id"].clone();
    mutate(&f, &store, 1, ThreadAction::Start);
    let event = core.ok(json!({"type":"subscription_poll","subscription_id":id}));
    assert_eq!(event["snapshot_revision"], 2);
    assert_eq!(event["payload"]["state"], "running");
    assert_eq!(
        core.ok(json!({"type":"subscription_poll","subscription_id":id})),
        Value::Null
    );
    // Scope-only APIs must never become a mutation or authority-injection route.
    assert_eq!(
        core.call(
            json!({"type":"subscription_poll","subscription_id":id,"actor_context":"forged"})
        )["ok"],
        false
    );
    assert_eq!(
        core.ok(json!({"type":"subscription_close","subscription_id":id})),
        json!({"closed":true})
    );
    assert_eq!(
        core.call(json!({"type":"subscription_poll","subscription_id":id}))["ok"],
        false
    );
    drop(core); // Abrupt termination of this fixture's actual product Core.
    let mut restarted = CoreProcess::start(f.state());
    let mut resume = query("subscription.open");
    resume["after_cursor"] = event["event_cursor"].clone();
    let resync = restarted.ok(json!({"type":"query","request":resume}));
    assert_eq!(resync["reason"], "core_restarted");
    let refreshed = restarted.ok(json!({"type":"query","request":query("query.execute")}));
    assert_eq!(refreshed["snapshot_revision"], 2);
    assert_eq!(refreshed["payload"]["state"], "running");
    assert_eq!(
        store
            .get(f.core().project_id(), "thread:one")
            .unwrap()
            .revision,
        2
    );
    // Consumed by the desktop contract test; these are real Core outputs, not mocks.
    println!(
        "AGENT_QUERY_CONTRACT:{}",
        json!([
            request, subscribe, snapshot, opened, event, resume, resync, refreshed
        ])
    );
}
