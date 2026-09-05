use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use superwagie_product_core::workspace::Workspace;

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

pub struct TestWorkspace {
    base: PathBuf,
    root: PathBuf,
    state: PathBuf,
    core: Workspace,
}

impl TestWorkspace {
    pub fn new() -> Self {
        let nonce = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "superwagie-product-core-test-{}-{now}-{nonce}",
            std::process::id()
        ));
        let root = base.join("workspace");
        let state = base.join("state");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&state).unwrap();
        fs::write(base.join(".owned-by-superwagie-test"), b"test fixture").unwrap();
        let core = Workspace::open_for_test(&root, &state).unwrap();
        Self {
            base,
            root,
            state,
            core,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn state(&self) -> &Path {
        &self.state
    }
    pub fn core(&self) -> &Workspace {
        &self.core
    }

    pub fn write(&self, relative: &str, bytes: &[u8]) {
        let target = self.root.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(target, bytes).unwrap();
    }

    pub fn read(&self, relative: &str) -> Vec<u8> {
        fs::read(self.root.join(relative)).unwrap()
    }

    #[cfg(unix)]
    pub fn symlink_outside(&self, relative: &str, bytes: &[u8]) {
        use std::os::unix::fs::symlink;
        let outside = self.base.join("outside-secret");
        fs::write(&outside, bytes).unwrap();
        symlink(outside, self.root.join(relative)).unwrap();
    }

    pub fn restart(&self) -> Workspace {
        Workspace::open_for_test(&self.root, &self.state).unwrap()
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let owned = self
            .base
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("superwagie-product-core-test-"))
            && self.base.join(".owned-by-superwagie-test").is_file();
        if owned {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
}
