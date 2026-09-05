mod support;

use rusqlite::Connection;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Barrier};
use superwagie_product_core::agent::state::ThreadState;
use superwagie_product_core::agent::{ThreadAction, ThreadCommand, ThreadError, ThreadStore};
use support::TestWorkspace;

fn command(
    fixture: &TestWorkspace,
    request: &str,
    revision: u64,
    action: ThreadAction,
) -> ThreadCommand {
    ThreadCommand {
        project_id: fixture.core().project_id().into(),
        thread_id: "thread:one".into(),
        request_id: request.into(),
        expected_revision: revision,
        action,
    }
}

fn connection(fixture: &TestWorkspace) -> Connection {
    Connection::open(fixture.state().join("operational.sqlite3")).unwrap()
}

#[test]
fn create_and_original_request_result_survive_reopen_and_later_changes() {
    let f = TestWorkspace::new();
    let create = command(&f, "request:create", 0, ThreadAction::Create);
    let store = ThreadStore::open(f.state()).unwrap();
    let created = store.apply(&create).unwrap();
    assert_eq!(
        (created.state, created.revision, created.turn),
        (ThreadState::Ready, 1, 0)
    );
    let started = store
        .apply(&command(&f, "request:start", 1, ThreadAction::Start))
        .unwrap();
    drop(store);
    let store = ThreadStore::open(f.state()).unwrap();
    assert_eq!(store.apply(&create).unwrap(), created);
    assert_eq!(
        store.get(&create.project_id, &create.thread_id).unwrap(),
        started
    );
    assert_eq!(
        store.recovery_candidates(&create.project_id).unwrap(),
        vec![started]
    );
}

#[test]
fn all_pause_states_checkpoint_and_resume_the_same_turn() {
    for state in [
        ThreadState::AwaitingUser,
        ThreadState::UserStopped,
        ThreadState::CreditsBlocked,
        ThreadState::Disconnected,
        ThreadState::RecoverableFailed,
    ] {
        let f = TestWorkspace::new();
        let store = ThreadStore::open(f.state()).unwrap();
        store
            .apply(&command(&f, "r:create", 0, ThreadAction::Create))
            .unwrap();
        store
            .apply(&command(&f, "r:start", 1, ThreadAction::Start))
            .unwrap();
        let pause = command(&f, "r:pause", 2, ThreadAction::Pause(state));
        let paused = store.apply(&pause).unwrap();
        let checkpoint = paused.checkpoint.as_ref().unwrap();
        assert_eq!((checkpoint.turn, checkpoint.revision), (1, 3));
        assert!(!checkpoint.checkpoint_id.is_empty());
        drop(store);
        let store = ThreadStore::open(f.state()).unwrap();
        assert_eq!(store.apply(&pause).unwrap(), paused);
        let resumed = store
            .apply(&command(&f, "r:resume", 3, ThreadAction::Start))
            .unwrap();
        assert_eq!(
            (resumed.state, resumed.turn, resumed.revision),
            (ThreadState::Running, 1, 4)
        );
    }
}

#[test]
fn completed_thread_starts_a_new_turn_without_new_identity() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    store
        .apply(&command(&f, "r:create", 0, ThreadAction::Create))
        .unwrap();
    store
        .apply(&command(&f, "r:start", 1, ThreadAction::Start))
        .unwrap();
    store
        .apply(&command(&f, "r:complete", 2, ThreadAction::Complete))
        .unwrap();
    let next = store
        .apply(&command(&f, "r:next", 3, ThreadAction::Start))
        .unwrap();
    assert_eq!((next.thread_id.as_str(), next.turn), ("thread:one", 2));
    assert!(next.checkpoint.is_none());
    let count: i64 = connection(&f)
        .query_row("SELECT count(*) FROM agent_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 4);
}

#[test]
fn archive_restore_retains_pause_and_never_implicitly_runs() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    store
        .apply(&command(&f, "r:create", 0, ThreadAction::Create))
        .unwrap();
    store
        .apply(&command(&f, "r:start", 1, ThreadAction::Start))
        .unwrap();
    let paused = store
        .apply(&command(
            &f,
            "r:stop",
            2,
            ThreadAction::Pause(ThreadState::UserStopped),
        ))
        .unwrap();
    store
        .apply(&command(&f, "r:archive", 3, ThreadAction::Archive))
        .unwrap();
    assert!(matches!(
        store.apply(&command(&f, "r:bad", 4, ThreadAction::Start)),
        Err(ThreadError::InvalidTransition)
    ));
    drop(store);
    let store = ThreadStore::open(f.state()).unwrap();
    let restored = store
        .apply(&command(&f, "r:restore", 4, ThreadAction::RestoreArchive))
        .unwrap();
    assert_eq!(restored.state, ThreadState::UserStopped);
    assert_eq!(restored.checkpoint, paused.checkpoint);
    let resumed = store
        .apply(&command(&f, "r:resume", 5, ThreadAction::Start))
        .unwrap();
    assert_eq!(resumed.turn, 1);
}

#[test]
fn request_identity_reuse_and_stale_revisions_cannot_mutate_state() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    let created = store
        .apply(&command(&f, "r:create", 0, ThreadAction::Create))
        .unwrap();
    assert!(matches!(
        store.apply(&command(&f, "r:create", 1, ThreadAction::Start)),
        Err(ThreadError::RequestIdReused)
    ));
    assert!(matches!(
        store.apply(&command(&f, "r:stale", 0, ThreadAction::Start)),
        Err(ThreadError::RevisionConflict)
    ));
    assert!(matches!(
        store.apply(&command(&f, "r:bad", 1, ThreadAction::Complete)),
        Err(ThreadError::InvalidTransition)
    ));
    assert_eq!(
        store.get(&created.project_id, &created.thread_id).unwrap(),
        created
    );
}

#[test]
fn revoked_project_cannot_read_or_replay_previously_accepted_request() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    let create = command(&f, "r:create", 0, ThreadAction::Create);
    store.apply(&create).unwrap();
    f.core().revoke().unwrap();
    assert!(matches!(
        store.apply(&create),
        Err(ThreadError::ScopeDenied)
    ));
    assert!(matches!(
        store.get(&create.project_id, &create.thread_id),
        Err(ThreadError::ScopeDenied)
    ));
    assert!(matches!(
        store.recovery_candidates(&create.project_id),
        Err(ThreadError::ScopeDenied)
    ));
}

#[test]
fn another_active_project_cannot_read_or_claim_the_same_thread() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    let create = command(&f, "r:create", 0, ThreadAction::Create);
    store.apply(&create).unwrap();
    let other_root = f.root().join("another-project");
    fs::create_dir(&other_root).unwrap();
    let other =
        superwagie_product_core::workspace::Workspace::open_for_test(&other_root, f.state())
            .unwrap();
    assert!(matches!(
        store.get(other.project_id(), &create.thread_id),
        Err(ThreadError::NotFound)
    ));
    let mut conflicting = create;
    conflicting.project_id = other.project_id().into();
    assert!(store.apply(&conflicting).is_err());
}

#[test]
fn failed_receipt_insert_rolls_back_snapshot_checkpoint_and_event() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    store
        .apply(&command(&f, "r:create", 0, ThreadAction::Create))
        .unwrap();
    let running = store
        .apply(&command(&f, "r:start", 1, ThreadAction::Start))
        .unwrap();
    let sql = connection(&f);
    sql.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_requests BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;").unwrap();
    let pause = command(
        &f,
        "r:pause",
        2,
        ThreadAction::Pause(ThreadState::UserStopped),
    );
    assert!(store.apply(&pause).is_err());
    drop(store);
    let store = ThreadStore::open(f.state()).unwrap();
    assert_eq!(
        store.get(&running.project_id, &running.thread_id).unwrap(),
        running
    );
    let count: i64 = sql
        .query_row("SELECT count(*) FROM agent_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2);
    sql.execute_batch("DROP TRIGGER fail_receipt").unwrap();
    assert_eq!(store.apply(&pause).unwrap().revision, 3);
}

#[test]
fn concurrent_connections_cannot_both_advance_the_same_revision() {
    let f = TestWorkspace::new();
    let a = ThreadStore::open(f.state()).unwrap();
    let b = ThreadStore::open(f.state()).unwrap();
    a.apply(&command(&f, "r:create", 0, ThreadAction::Create))
        .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let commands = [
        command(&f, "r:a", 1, ThreadAction::Start),
        command(&f, "r:b", 1, ThreadAction::Start),
    ];
    let handles: Vec<_> = [a, b]
        .into_iter()
        .zip(commands)
        .map(|(store, cmd)| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.apply(&cmd)
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(ThreadError::RevisionConflict)))
            .count(),
        1
    );
}

#[test]
fn missing_checkpoint_is_not_silently_recreated_on_resume() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    store
        .apply(&command(&f, "r:create", 0, ThreadAction::Create))
        .unwrap();
    store
        .apply(&command(&f, "r:start", 1, ThreadAction::Start))
        .unwrap();
    let mut record = store
        .apply(&command(
            &f,
            "r:stop",
            2,
            ThreadAction::Pause(ThreadState::Disconnected),
        ))
        .unwrap();
    record.checkpoint = None;
    connection(&f)
        .execute(
            "UPDATE agent_threads SET record_json = ?1",
            [serde_json::to_string(&record).unwrap()],
        )
        .unwrap();
    assert!(matches!(
        store.apply(&command(&f, "r:resume", 3, ThreadAction::Start)),
        Err(ThreadError::CheckpointRequired)
    ));
}

#[test]
fn invalid_identifiers_and_revision_overflow_are_rejected() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    for invalid in ["", "bad\0id", "../escape"] {
        let mut cmd = command(&f, "r:create", 0, ThreadAction::Create);
        cmd.thread_id = invalid.into();
        assert!(matches!(store.apply(&cmd), Err(ThreadError::InvalidInput)));
    }
    assert!(matches!(
        store.apply(&command(&f, "r:huge", u64::MAX, ThreadAction::Start)),
        Err(ThreadError::InvalidInput)
    ));
}

#[test]
fn migration_keeps_workspace_data_and_a_readable_private_backup() {
    let f = TestWorkspace::new();
    f.write("旧文档.md", b"preserve me");
    let original = f.core().read("旧文档.md").unwrap();
    let draft = f
        .core()
        .stage_draft(
            &original.document_id,
            &original.revision,
            b"draft survives",
            7,
        )
        .unwrap();
    let store = ThreadStore::open(f.state()).unwrap();
    let sql = connection(&f);
    let backup: String = sql
        .query_row("SELECT backup_path FROM agent_schema", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let copy = Connection::open(&backup).unwrap();
    assert_eq!(
        copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    let count: i64 = copy
        .query_row("SELECT count(*) FROM document_bases", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let drafts: i64 = copy
        .query_row("SELECT count(*) FROM drafts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(drafts, 1);
    assert_eq!(f.core().read("旧文档.md").unwrap(), original);
    drop(store);
    ThreadStore::open(f.state()).unwrap();
    let same: String = sql
        .query_row("SELECT backup_path FROM agent_schema", [], |r| r.get(0))
        .unwrap();
    assert_eq!(same, backup);
    let outcome = f.restart().save_staged(&draft.handle_id).unwrap();
    assert!(matches!(
        outcome,
        superwagie_product_core::workspace::SaveOutcome::Committed {
            change_generation: 7,
            ..
        }
    ));
    assert_eq!(f.read("旧文档.md"), b"draft survives");
}

#[test]
fn wrong_turn_or_changed_checkpoint_identity_cannot_resume() {
    for wrong_turn in [true, false] {
        let f = TestWorkspace::new();
        let store = ThreadStore::open(f.state()).unwrap();
        store
            .apply(&command(&f, "r:create", 0, ThreadAction::Create))
            .unwrap();
        store
            .apply(&command(&f, "r:start", 1, ThreadAction::Start))
            .unwrap();
        let mut record = store
            .apply(&command(
                &f,
                "r:pause",
                2,
                ThreadAction::Pause(ThreadState::Disconnected),
            ))
            .unwrap();
        let cp = record.checkpoint.as_mut().unwrap();
        if wrong_turn {
            cp.turn += 1;
        } else {
            cp.checkpoint_id.push('x');
        }
        connection(&f)
            .execute(
                "UPDATE agent_threads SET record_json=?1",
                [serde_json::to_string(&record).unwrap()],
            )
            .unwrap();
        assert!(matches!(
            store.apply(&command(&f, "r:resume", 3, ThreadAction::Start)),
            Err(ThreadError::CheckpointRequired)
        ));
        assert_eq!(
            store.get(&record.project_id, &record.thread_id).unwrap(),
            record
        );
    }
}

#[test]
fn inconsistent_snapshot_revision_is_rejected_without_repair() {
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    let created = store
        .apply(&command(&f, "r:create", 0, ThreadAction::Create))
        .unwrap();
    connection(&f)
        .execute("UPDATE agent_threads SET revision=2", [])
        .unwrap();
    assert!(matches!(
        store.get(&created.project_id, &created.thread_id),
        Err(ThreadError::CorruptState)
    ));
    assert!(matches!(
        store.apply(&command(&f, "r:start", 1, ThreadAction::Start)),
        Err(ThreadError::CorruptState)
    ));
}

#[test]
fn ready_and_completed_archives_restore_without_running_or_losing_history() {
    for completed in [false, true] {
        let f = TestWorkspace::new();
        let store = ThreadStore::open(f.state()).unwrap();
        store
            .apply(&command(&f, "r:create", 0, ThreadAction::Create))
            .unwrap();
        let revision = if completed {
            store
                .apply(&command(&f, "r:start", 1, ThreadAction::Start))
                .unwrap();
            store
                .apply(&command(&f, "r:complete", 2, ThreadAction::Complete))
                .unwrap()
                .revision
        } else {
            1
        };
        let archived = store
            .apply(&command(&f, "r:archive", revision, ThreadAction::Archive))
            .unwrap();
        let restored = store
            .apply(&command(
                &f,
                "r:restore",
                archived.revision,
                ThreadAction::RestoreArchive,
            ))
            .unwrap();
        assert_eq!(restored.state, ThreadState::Completed);
        assert_eq!(restored.turn, u64::from(completed));
        assert!(
            store
                .recovery_candidates(&restored.project_id)
                .unwrap()
                .is_empty()
        );
        let history: i64 = connection(&f)
            .query_row("SELECT count(*) FROM agent_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(history as u64, restored.revision);
    }
}

#[test]
fn concurrent_duplicate_request_commits_only_one_event_and_returns_same_result() {
    let f = TestWorkspace::new();
    let stores = [
        ThreadStore::open(f.state()).unwrap(),
        ThreadStore::open(f.state()).unwrap(),
    ];
    let cmd = command(&f, "r:create", 0, ThreadAction::Create);
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = stores
        .into_iter()
        .map(|store| {
            let cmd = cmd.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.apply(&cmd).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results[0], results[1]);
    let events: i64 = connection(&f)
        .query_row("SELECT count(*) FROM agent_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(events, 1);
}

#[test]
fn migration_ddl_failure_rolls_back_version_and_preserves_old_rows() {
    let f = TestWorkspace::new();
    f.write("原文.md", b"before migration");
    let original = f.core().read("原文.md").unwrap();
    let sql = connection(&f);
    // Collision occurs after earlier Agent CREATE statements, testing DDL rollback.
    sql.execute_batch(
        "CREATE TABLE agent_events(sentinel TEXT); INSERT INTO agent_events VALUES('unchanged');",
    )
    .unwrap();
    assert!(matches!(
        ThreadStore::open(f.state()),
        Err(ThreadError::Sql(_))
    ));
    let count: i64 = sql.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('agent_schema','agent_threads','agent_requests')", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        sql.query_row("SELECT sentinel FROM agent_events", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "unchanged"
    );
    assert_eq!(f.core().read("原文.md").unwrap(), original);
    sql.execute_batch("DROP TABLE agent_events").unwrap();
    let store = ThreadStore::open(f.state()).unwrap();
    store
        .apply(&command(&f, "r:create", 0, ThreadAction::Create))
        .unwrap();
}

#[test]
fn abrupt_process_exit_does_not_publish_uncommitted_agent_state() {
    if let Some(state) = std::env::var_os("SUPERWAGIE_AGENT_EXIT_TEST_STATE") {
        storage_exit_child(std::path::PathBuf::from(state));
    }
    let f = TestWorkspace::new();
    let store = ThreadStore::open(f.state()).unwrap();
    let create = command(&f, "r:create", 0, ThreadAction::Create);
    let created = store.apply(&create).unwrap();
    let running = store
        .apply(&command(&f, "r:start", 1, ThreadAction::Start))
        .unwrap();
    drop(store);
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "abrupt_process_exit_does_not_publish_uncommitted_agent_state",
            "--nocapture",
        ])
        .env("SUPERWAGIE_AGENT_EXIT_TEST_STATE", f.state())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(91),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reopened = ThreadStore::open(f.state()).unwrap();
    assert_eq!(
        reopened
            .get(&running.project_id, &running.thread_id)
            .unwrap(),
        running
    );
    assert_eq!(reopened.apply(&create).unwrap(), created);
    let events: i64 = connection(&f)
        .query_row("SELECT count(*) FROM agent_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(events, 2);
    assert_eq!(
        reopened.recovery_candidates(&running.project_id).unwrap(),
        vec![running]
    );
}

// Subprocess entry: exit bypasses Rust/SQLite destructors without opening crash UI.
// This is an SQLite uncommitted-transaction test, not an App Server crash test.
fn storage_exit_child(state: std::path::PathBuf) -> ! {
    let base = state.parent().unwrap();
    assert!(
        base.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("superwagie-product-core-test-")
    );
    assert!(base.join(".owned-by-superwagie-test").is_file());
    let sql = Connection::open(state.join("operational.sqlite3")).unwrap();
    sql.execute_batch(
        "BEGIN IMMEDIATE;
        UPDATE agent_threads SET revision=3,record_json='uncommitted';
        INSERT INTO agent_events VALUES('thread:one',3,'r:uncommitted','uncommitted');",
    )
    .unwrap();
    std::process::exit(91);
}

#[test]
fn future_schema_is_rejected_without_downgrading_it() {
    let f = TestWorkspace::new();
    ThreadStore::open(f.state()).unwrap();
    let sql = connection(&f);
    sql.execute("UPDATE agent_schema SET version=99", [])
        .unwrap();
    assert!(matches!(
        ThreadStore::open(f.state()),
        Err(ThreadError::UnsupportedSchema(99))
    ));
    assert_eq!(
        sql.query_row("SELECT version FROM agent_schema", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        99
    );
}
