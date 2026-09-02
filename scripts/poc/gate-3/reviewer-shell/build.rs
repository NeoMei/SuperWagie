const COMMANDS: &[&str] = &[
    "asset_url",
    "start_truth_render",
    "preview_status",
    "save_annotation",
    "accept_preview",
    "open_controlled_copy",
    "record_metrics",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build the restricted Tauri application manifest");
}
