#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

static ARMED: AtomicBool = AtomicBool::new(false);

fn now_millis() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}ms", d.as_millis())
}

// Data dir honors SUPERWAGIE_SHELL_DATA_DIR so automated runs never touch
// real user data (isolation-friendly, mirrors R-RI-01 spirit).
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("SUPERWAGIE_SHELL_DATA_DIR") {
        if !d.is_empty() {
            return Ok(PathBuf::from(d));
        }
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Clone)]
struct Health {
    ok: bool,
    webview_loaded_at: String,
}

#[tauri::command]
fn health_check(app: AppHandle) -> Result<Health, String> {
    let dir = data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let health = Health {
        ok: true,
        webview_loaded_at: now_millis(),
    };
    fs::write(
        dir.join("webview-health.json"),
        serde_json::to_string(&health).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(health)
}

#[tauri::command]
fn save_layout(app: AppHandle, layout: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("shell-layout.json"), layout).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_layout(app: AppHandle) -> Result<Option<String>, String> {
    match fs::read_to_string(data_dir(&app)?.join("shell-layout.json")) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn arm_recovery() {
    ARMED.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn simulate_render_crash(window: tauri::WebviewWindow) -> Result<(), String> {
    // Deterministic stand-in for a render-process death: WKWebView exposes no
    // public API to kill WebContent from outside, so the PoC simulates the
    // recovery path by destroying the window while ARMED is set.
    window.destroy().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod macos_drag {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use std::path::PathBuf;
    use std::ptr::NonNull;

    // Keep the legacy type alongside public.file-url because the current wry
    // bridge still advertises it. Scope the deprecation exception to this
    // compatibility shim so new deprecated AppKit usage remains visible.
    #[allow(deprecated)]
    pub fn register_drag_types_on_view(view: *mut AnyObject) -> bool {
        if view.is_null() {
            return false;
        }
        unsafe {
            let ptrs: [NonNull<NSString>; 2] = [
                NonNull::from(NSPasteboardTypeFileURL),
                NonNull::from(objc2_app_kit::NSFilenamesPboardType),
            ];
            let types = NSArray::<NSString>::arrayWithObjects_count(
                NonNull::new(ptrs.as_ptr() as *mut NonNull<NSString>).unwrap(),
                2,
            );
            let _: () = msg_send![view, registerForDraggedTypes: &*types];
        }
        true
    }

    pub fn register_webview(ns_view: *mut std::ffi::c_void) -> bool {
        if ns_view.is_null() {
            return false;
        }
        register_drag_types_on_view(ns_view as *mut AnyObject)
    }

    // Belt-and-braces: also register the window content view (an ancestor of
    // the webview) in case the WKWebView re-registers its own drag types
    // during page load and clobbers ours. AppKit walks up the superview
    // chain when matching dragged types.
    pub fn register_window_content(ns_window: *mut std::ffi::c_void) -> bool {
        if ns_window.is_null() {
            return false;
        }
        let cv: *mut AnyObject = unsafe { msg_send![ns_window as *mut AnyObject, contentView] };
        register_drag_types_on_view(cv)
    }

    // Ground truth for the drag-debug log: what the pasteboard actually
    // carries when a drop reaches us.
    pub fn pasteboard_types_summary() -> String {
        let pb = NSPasteboard::generalPasteboard();
        let mut parts: Vec<String> = vec![format!("changeCount={}", pb.changeCount())];
        if let Some(types) = pb.types() {
            let list: Vec<String> = types.iter().map(|t| t.to_string()).collect();
            parts.push(format!("types=[{}]", list.join(", ")));
        }
        if let Some(items) = pb.pasteboardItems() {
            parts.push(format!("items={}", items.len()));
        }
        parts.join(" ")
    }

    // wry collects drop paths via the legacy NSFilenamesPboardType, which
    // modern Finder drags no longer provide, so Drop arrives with empty
    // paths. Finder file drags put public.file-url entries on the general
    // pasteboard; read them back ourselves.
    pub fn read_file_urls_from_pasteboard() -> Vec<PathBuf> {
        let mut out = Vec::new();
        unsafe {
            let pb = NSPasteboard::generalPasteboard();
            if let Some(items) = pb.pasteboardItems() {
                for item in items.iter() {
                    if let Some(s) = item.stringForType(NSPasteboardTypeFileURL) {
                        if let Some(url) = NSURL::URLWithString(&s) {
                            if let Some(p) = url.path() {
                                out.push(PathBuf::from(p.to_string()));
                            }
                        }
                    }
                }
            }
            if out.is_empty() {
                if let Some(s) = pb.stringForType(NSPasteboardTypeFileURL) {
                    if let Some(url) = NSURL::URLWithString(&s) {
                        if let Some(p) = url.path() {
                            out.push(PathBuf::from(p.to_string()));
                        }
                    }
                }
            }
        }
        out
    }
}

fn drag_debug_log(handle: &AppHandle, msg: &str) {
    let dir = data_dir(handle).unwrap_or_else(|_| std::env::temp_dir());
    let _ = fs::create_dir_all(&dir);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("drag-debug.log"))
    {
        let _ = writeln!(f, "[{stamp}] {msg}");
    }
}

#[tauri::command]
fn debug_log(app: AppHandle, msg: String) {
    drag_debug_log(&app, &format!("ui: {msg}"));
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("不是文件: {path}"));
    }
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("文件超过 2MB，POC 阶段不支持预览".to_string());
    }
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("不是文件: {path}"));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("不支持的图片格式: {ext}"));
    }
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("文件超过 10MB，POC 阶段不支持预览".to_string());
    }
    use base64::Engine as _;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[derive(serde::Serialize)]
struct PathInfo {
    name: String,
    ext: String,
    size: u64,
    is_dir: bool,
}

#[tauri::command]
fn path_info(paths: Vec<String>) -> Vec<PathInfo> {
    paths
        .iter()
        .map(|p| {
            let pb = PathBuf::from(p);
            let meta = fs::metadata(&pb).ok();
            PathInfo {
                name: pb
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone()),
                ext: pb
                    .extension()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            }
        })
        .collect()
}

// Native drag-drop support: register the webview for file drags and, on
// drop, forward authoritative paths to the frontend. On macOS 26 wry's
// Drop carries empty paths (legacy pasteboard type), so fall back to
// reading file URLs from the general pasteboard.
fn attach_drag_drop(app: &AppHandle, label: &str) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let handle = app.clone();
    #[cfg(target_os = "macos")]
    {
        let win_label = label.to_string();
        let view_ok = win
            .ns_view()
            .map(macos_drag::register_webview)
            .unwrap_or(false);
        let content_ok = win
            .ns_window()
            .map(macos_drag::register_window_content)
            .unwrap_or(false);
        drag_debug_log(
            app,
            &format!("attach: registered view={view_ok} contentView={content_ok}"),
        );
        // Page loads can reset the dragging destination; re-register after
        // the webview settles so native registration survives navigation.
        let h = handle.clone();
        let l = win_label.clone();
        std::thread::spawn(move || {
            let reregister = |hh: &AppHandle, ll: &str, tag: &'static str| {
                let _ = hh.run_on_main_thread({
                    let hh = hh.clone();
                    let ll = ll.to_string();
                    move || {
                        if let Some(w) = hh.get_webview_window(&ll) {
                            let v = w
                                .ns_view()
                                .map(macos_drag::register_webview)
                                .unwrap_or(false);
                            let c = w
                                .ns_window()
                                .map(macos_drag::register_window_content)
                                .unwrap_or(false);
                            drag_debug_log(
                                &hh,
                                &format!("re-register({tag}): view={v} contentView={c}"),
                            );
                        }
                    }
                });
            };
            std::thread::sleep(Duration::from_millis(1500));
            reregister(&h, &l, "+1500ms");
            std::thread::sleep(Duration::from_millis(3500));
            reregister(&h, &l, "+5000ms");
        });
    }
    win.on_window_event(move |event| match event {
        WindowEvent::DragDrop(tauri::DragDropEvent::Enter { .. }) => {
            drag_debug_log(&handle, "event: Enter");
        }
        WindowEvent::DragDrop(tauri::DragDropEvent::Leave) => {
            drag_debug_log(&handle, "event: Leave");
        }
        WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
            drag_debug_log(&handle, "event: Drop");
            let resolved: Vec<String> = paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            #[cfg(target_os = "macos")]
            let mut resolved = resolved;
            #[cfg(target_os = "macos")]
            {
                let pb = macos_drag::pasteboard_types_summary();
                drag_debug_log(&handle, &format!("pasteboard: {pb}"));
                if resolved.is_empty() {
                    resolved = macos_drag::read_file_urls_from_pasteboard()
                        .iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect();
                }
            }
            drag_debug_log(&handle, &format!("resolved={resolved:?}"));
            let emit_res = handle.emit("drag-drop-paths", serde_json::json!({ "paths": resolved }));
            drag_debug_log(&handle, &format!("emit ok={}", emit_res.is_ok()));
        }
        _ => {}
    });
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Native-side boot marker: proves the process and webview host came
            // up even when frontend injection fails, and records launch context
            // (argv0/cwd) so a failing manual launch can be diagnosed later.
            let dir = data_dir(app.handle()).unwrap_or_else(|_| std::env::temp_dir());
            let _ = fs::create_dir_all(&dir);
            let boot = serde_json::json!({
                "pid": std::process::id(),
                "argv0": std::env::args().next().unwrap_or_default(),
                "cwd": std::env::current_dir()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                "booted_at": now_millis()
            });
            let _ = fs::write(
                dir.join("shell-boot.json"),
                serde_json::to_string(&boot).unwrap_or_default(),
            );
            attach_drag_drop(app.handle(), "main");
            // Synthetic channel test (debug only): fires a fake drag-drop
            // event 10s after boot so the Rust→JS event pipeline can be
            // verified end-to-end without a real drag session. The frontend
            // listener logs receipt into drag-debug.log.
            #[cfg(debug_assertions)]
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(10));
                    // Prefer a real text file so the frontend preview path is
                    // exercised too; fall back to the synthetic placeholder.
                    let real = concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md");
                    let payload_path = if std::path::Path::new(real).is_file() {
                        real.to_string()
                    } else {
                        "/synthetic/test-event.md".to_string()
                    };
                    let ok = h
                        .emit(
                            "drag-drop-paths",
                            serde_json::json!({ "paths": [payload_path] }),
                        )
                        .is_ok();
                    drag_debug_log(&h, &format!("synthetic-emit sent ok={ok}"));
                    // Exercise the image preview pipeline too.
                    std::thread::sleep(Duration::from_secs(2));
                    let img = concat!(env!("CARGO_MANIFEST_DIR"), "/icons/icon.png");
                    if std::path::Path::new(img).is_file() {
                        let ok2 = h
                            .emit("drag-drop-paths", serde_json::json!({ "paths": [img] }))
                            .is_ok();
                        drag_debug_log(&h, &format!("synthetic-emit(img) sent ok={ok2}"));
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            save_layout,
            load_layout,
            arm_recovery,
            simulate_render_crash,
            path_info,
            debug_log,
            read_text_file,
            read_file_base64
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = event
            {
                // Recovery entry: when the webview render process was killed on
                // purpose (crash test), rebuild the window; layout restore is
                // performed by the frontend from shell-layout.json.
                if ARMED.swap(false, Ordering::SeqCst) {
                    let app = app.clone();
                    let rebuilt_label = label.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(300));
                        let _ = WebviewWindowBuilder::new(
                            &app,
                            &rebuilt_label,
                            WebviewUrl::App("index.html".into()),
                        )
                        .title("SuperWagie Shell")
                        .inner_size(1280.0, 800.0)
                        .build();
                        attach_drag_drop(&app, &rebuilt_label);
                    });
                }
            }
        });
}
