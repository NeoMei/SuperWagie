use std::path::Path;
use std::process::Command;

#[test]
fn actual_core_enforces_authenticated_protocol_and_handle_constraints() {
    let core_dir = if Path::new("Cargo.toml").exists() {
        Path::new(".")
    } else {
        Path::new("core")
    };
    let status = Command::new("cargo")
        .args(["test", "--locked", "--test", "authenticated_protocol"])
        .current_dir(core_dir)
        .status()
        .expect("run the actual Rust authenticated-protocol integration suite");
    assert!(status.success());
}
