mod support;

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use superwagie_product_core::workspace::WorkspaceError;
use support::TestWorkspace;

#[test]
fn symlink_outside_grant_is_never_read() {
    let fixture = TestWorkspace::new();
    fixture.symlink_outside("逃逸.md", b"private");
    assert!(matches!(
        fixture.core().read("逃逸.md"),
        Err(WorkspaceError::SymlinkDenied)
    ));
}

#[test]
fn absolute_parent_and_nul_paths_are_rejected() {
    let fixture = TestWorkspace::new();
    for path in [
        "/etc/passwd",
        "../secret.md",
        "dir/../../secret.md",
        "bad\0name.md",
    ] {
        assert!(matches!(
            fixture.core().read(path),
            Err(WorkspaceError::InvalidLogicalPath)
        ));
    }
}

#[test]
fn parent_directory_symlink_is_rejected() {
    let fixture = TestWorkspace::new();
    let outside = fixture.root().parent().unwrap().join("outside-dir");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.md"), b"private").unwrap();
    symlink(&outside, fixture.root().join("linked")).unwrap();
    assert!(matches!(
        fixture.core().read("linked/secret.md"),
        Err(WorkspaceError::SymlinkDenied)
    ));
}

#[test]
fn non_regular_files_are_rejected() {
    let fixture = TestWorkspace::new();
    fs::create_dir(fixture.root().join("folder.md")).unwrap();
    assert!(matches!(
        fixture.core().read("folder.md"),
        Err(WorkspaceError::NotRegularFile)
    ));
}

#[test]
fn invalid_utf8_is_rejected_without_lossy_conversion() {
    let fixture = TestWorkspace::new();
    fixture.write("bytes.md", &[0xff, 0xfe]);
    assert!(matches!(
        fixture.core().read("bytes.md"),
        Err(WorkspaceError::InvalidUtf8)
    ));
}

#[test]
fn hardlink_aliases_are_rejected_as_ambiguous() {
    let fixture = TestWorkspace::new();
    fixture.write("one.md", b"same inode");
    fs::hard_link(fixture.root().join("one.md"), fixture.root().join("two.md")).unwrap();
    fixture.core().read("one.md").unwrap();
    assert!(matches!(
        fixture.core().read("two.md"),
        Err(WorkspaceError::HardlinkAlias)
    ));
}

#[test]
fn unicode_names_are_read_as_distinct_logical_paths() {
    let fixture = TestWorkspace::new();
    fixture.write("中文.md", "你好🙂".as_bytes());
    fixture.write("Café.md", b"nfd");
    assert_eq!(fixture.core().read("中文.md").unwrap().content, "你好🙂");
    assert_eq!(fixture.core().read("Café.md").unwrap().content, "nfd");
}

#[test]
fn revoke_immediately_closes_the_grant() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"content");
    fixture.core().read("正文.md").unwrap();
    fixture.core().revoke().unwrap();
    assert!(matches!(
        fixture.core().read("正文.md"),
        Err(WorkspaceError::GrantRevoked)
    ));
}

#[test]
fn repeated_mount_uses_stable_project_workspace_and_document_ids() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"content");
    let first = fixture.core().read("正文.md").unwrap();
    let restarted = fixture.restart();
    let second = restarted.read("正文.md").unwrap();
    assert_eq!(fixture.core().project_id(), restarted.project_id());
    assert_eq!(fixture.core().workspace_id(), restarted.workspace_id());
    assert_eq!(first.document_id, second.document_id);
}

#[test]
fn operational_store_is_private_and_outside_the_workspace() {
    let fixture = TestWorkspace::new();
    let db = fixture.state().join("operational.sqlite3");
    assert!(db.is_file());
    assert_eq!(
        fs::metadata(&db).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        !fixture
            .root()
            .join(".superwagie/operational.sqlite3")
            .exists()
    );
}

#[test]
fn replacing_the_authorized_root_fails_closed() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"trusted");
    let moved = fixture.root().with_extension("moved");
    fs::rename(fixture.root(), &moved).unwrap();
    fs::create_dir(fixture.root()).unwrap();
    fs::write(fixture.root().join("正文.md"), b"replacement").unwrap();
    assert!(matches!(
        fixture.core().read("正文.md"),
        Err(WorkspaceError::RootIdentityChanged)
    ));
    fs::remove_dir_all(fixture.root()).unwrap();
    fs::rename(moved, fixture.root()).unwrap();
}

#[test]
fn atomic_replace_keeps_document_id_but_updates_file_identity() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"one");
    let first = fixture.core().read("正文.md").unwrap();
    let replacement = fixture.root().join(".replacement");
    fs::write(&replacement, b"two").unwrap();
    fs::rename(replacement, fixture.root().join("正文.md")).unwrap();
    let second = fixture.core().read("正文.md").unwrap();
    assert_eq!(fixture.read("正文.md"), b"two");
    assert_eq!(first.document_id, second.document_id);
    assert_ne!(first.file_identity, second.file_identity);
}

#[test]
fn reconciliation_tracks_an_external_rename_by_inode() {
    let fixture = TestWorkspace::new();
    fixture.write("旧名.md", b"content");
    let first = fixture.core().read("旧名.md").unwrap();
    fs::rename(
        fixture.root().join("旧名.md"),
        fixture.root().join("新名.md"),
    )
    .unwrap();
    let updates = fixture.core().reconcile().unwrap();
    assert_eq!(updates.len(), 1);
    let second = fixture.core().read("新名.md").unwrap();
    assert_eq!(first.document_id, second.document_id);
}

#[test]
fn root_identity_uses_device_and_inode_not_path_text() {
    let fixture = TestWorkspace::new();
    let metadata = fs::metadata(fixture.root()).unwrap();
    assert_eq!(
        fixture.core().root_identity(),
        format!("{}:{}", metadata.dev(), metadata.ino())
    );
}

#[test]
fn repeated_tree_scans_observe_external_renames() {
    let fixture = TestWorkspace::new();
    fixture.write("正文.md", b"content");
    let first = fixture.core().tree().unwrap();
    assert_eq!(first[0].logical_path, "正文.md");
    fs::rename(
        fixture.root().join("正文.md"),
        fixture.root().join("外部改名.md"),
    )
    .unwrap();
    let second = fixture.core().tree().unwrap();
    assert_eq!(second[0].logical_path, "外部改名.md");
    assert_eq!(first[0].document_id, second[0].document_id);
}
