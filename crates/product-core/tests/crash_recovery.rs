mod support;

use std::fs;
use superwagie_product_core::workspace::{
    ConflictResolution, RecoveryOutcome, SaveFault, SaveOutcome, WorkspaceError,
};
use support::TestWorkspace;

#[test]
fn external_edit_survives_stale_save() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    fixture.write("正文.md", b"external");
    let outcome = fixture
        .core()
        .save(&base.document_id, &base.revision, b"local", 1)
        .unwrap();
    let SaveOutcome::Conflict { conflict_id } = outcome else {
        panic!("expected conflict");
    };
    let conflict = fixture.core().conflict_snapshot(&conflict_id).unwrap();
    assert_eq!(conflict.base, b"base");
    assert_eq!(conflict.current, b"external");
    assert_eq!(conflict.proposed, b"local");
    assert_eq!(fixture.read("正文.md"), b"external");
}

#[test]
fn committed_save_reports_the_generation_and_real_revision() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    let outcome = fixture
        .core()
        .save(&base.document_id, &base.revision, "本地🙂".as_bytes(), 7)
        .unwrap();
    let SaveOutcome::Committed {
        revision,
        change_generation,
    } = outcome
    else {
        panic!("expected committed save");
    };
    assert_eq!(change_generation, 7);
    assert_eq!(fixture.read("正文.md"), "本地🙂".as_bytes());
    assert_eq!(fixture.read_document("正文.md").revision, revision);
}

#[test]
fn staged_draft_is_durable_across_core_restart() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    let handle = fixture
        .core()
        .stage_draft(&base.document_id, &base.revision, b"durable", 2)
        .unwrap();
    let restarted = fixture.restart();
    let outcome = restarted.save_staged(&handle.handle_id).unwrap();
    assert!(matches!(
        outcome,
        SaveOutcome::Committed {
            change_generation: 2,
            ..
        }
    ));
    assert_eq!(fixture.read("正文.md"), b"durable");
}

#[test]
fn crash_after_prepared_recovers_without_losing_the_draft() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    let result = fixture.core().save_with_fault(
        &base.document_id,
        &base.revision,
        b"recovered",
        3,
        SaveFault::CrashAfterPrepared,
    );
    assert!(matches!(result, Err(WorkspaceError::InjectedCrash)));
    assert_eq!(fixture.read("正文.md"), b"base");

    let restarted = fixture.restart();
    let recovered = restarted.recover().unwrap();
    assert!(matches!(
        recovered.as_slice(),
        [RecoveryOutcome::Committed { .. }]
    ));
    assert_eq!(fixture.read("正文.md"), b"recovered");
}

#[test]
fn recovery_never_overwrites_an_external_revision() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    fixture
        .core()
        .save_with_fault(
            &base.document_id,
            &base.revision,
            b"local",
            4,
            SaveFault::CrashAfterPrepared,
        )
        .unwrap_err();
    fixture.write("正文.md", b"external-after-crash");

    let restarted = fixture.restart();
    let recovered = restarted.recover().unwrap();
    assert!(matches!(
        recovered.as_slice(),
        [RecoveryOutcome::Conflicted { .. }]
    ));
    assert_eq!(fixture.read("正文.md"), b"external-after-crash");
}

#[test]
fn crash_after_atomic_swap_is_recognized_as_committed() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    fixture
        .core()
        .save_with_fault(
            &base.document_id,
            &base.revision,
            b"published",
            5,
            SaveFault::CrashAfterPublish,
        )
        .unwrap_err();
    assert_eq!(fixture.read("正文.md"), b"published");

    let restarted = fixture.restart();
    let recovered = restarted.recover().unwrap();
    assert!(matches!(
        recovered.as_slice(),
        [RecoveryOutcome::Committed { .. }]
    ));
    assert_eq!(fixture.read("正文.md"), b"published");
}

#[test]
fn external_write_in_the_compare_swap_window_is_preserved_and_conflicted() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    let outcome = fixture
        .core()
        .save_with_fault(
            &base.document_id,
            &base.revision,
            b"local",
            6,
            SaveFault::ExternalWriteAfterCompare(b"racing-external".to_vec()),
        )
        .unwrap();
    assert!(matches!(outcome, SaveOutcome::Conflict { .. }));
    assert_eq!(fixture.read("正文.md"), b"racing-external");
    assert!(fixture.core().pending_draft_count().unwrap() >= 1);
}

#[test]
fn failed_publish_keeps_a_durable_recovery_record() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    let result = fixture.core().save_with_fault(
        &base.document_id,
        &base.revision,
        b"local",
        7,
        SaveFault::FailBeforePublish,
    );
    assert!(matches!(result, Err(WorkspaceError::InjectedIoFailure)));
    assert_eq!(fixture.read("正文.md"), b"base");
    assert!(fixture.core().pending_draft_count().unwrap() >= 1);
}

#[test]
fn conflict_actions_are_revision_bound() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    fixture.write("正文.md", b"disk");
    let SaveOutcome::Conflict { conflict_id } = fixture
        .core()
        .save(&base.document_id, &base.revision, b"local", 8)
        .unwrap()
    else {
        panic!("expected conflict");
    };
    let disk = fixture.read_document("正文.md");
    let outcome = fixture
        .core()
        .resolve_conflict(
            &conflict_id,
            &disk.revision,
            ConflictResolution::Merge(b"disk\nlocal".to_vec()),
            9,
        )
        .unwrap();
    assert!(matches!(outcome, SaveOutcome::Committed { .. }));
    assert_eq!(fixture.read("正文.md"), b"disk\nlocal");
}

#[test]
fn use_disk_discards_no_audit_record_and_does_not_write() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    fixture.write("正文.md", b"disk");
    let SaveOutcome::Conflict { conflict_id } = fixture
        .core()
        .save(&base.document_id, &base.revision, b"local", 10)
        .unwrap()
    else {
        panic!("expected conflict");
    };
    let disk = fixture.read_document("正文.md");
    let outcome = fixture
        .core()
        .resolve_conflict(
            &conflict_id,
            &disk.revision,
            ConflictResolution::UseDisk,
            11,
        )
        .unwrap();
    assert!(matches!(outcome, SaveOutcome::DiskKept { .. }));
    assert_eq!(fixture.read("正文.md"), b"disk");
}

#[test]
fn stale_conflict_confirmation_creates_a_new_conflict() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    fixture.write("正文.md", b"disk-one");
    let SaveOutcome::Conflict { conflict_id } = fixture
        .core()
        .save(&base.document_id, &base.revision, b"local", 12)
        .unwrap()
    else {
        panic!("expected conflict");
    };
    let disk_one = fixture.read_document("正文.md");
    fixture.write("正文.md", b"disk-two");
    let outcome = fixture
        .core()
        .resolve_conflict(
            &conflict_id,
            &disk_one.revision,
            ConflictResolution::KeepCurrent,
            13,
        )
        .unwrap();
    assert!(matches!(outcome, SaveOutcome::Conflict { .. }));
    assert_eq!(fixture.read("正文.md"), b"disk-two");
}

#[test]
fn external_rename_before_compare_never_recreates_the_old_path() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.read_document("正文.md");
    let outcome = fixture
        .core()
        .save_with_fault(
            &base.document_id,
            &base.revision,
            b"local",
            14,
            SaveFault::ExternalRenameBeforeCompare("外部改名.md".into()),
        )
        .unwrap();
    assert!(matches!(outcome, SaveOutcome::Conflict { .. }));
    assert!(!fixture.root().join("正文.md").exists());
    assert_eq!(
        fs::read(fixture.root().join("外部改名.md")).unwrap(),
        b"base"
    );
}
