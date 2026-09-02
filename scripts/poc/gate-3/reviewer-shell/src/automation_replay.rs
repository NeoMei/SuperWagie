use std::sync::Mutex;
use std::time::Duration;
use tauri::{webview::PageLoadEvent, Url};

pub const AUTOMATION_REPLAY_DELAYS: [Duration; 5] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_millis(1_000),
    Duration::from_millis(2_000),
    Duration::from_millis(4_000),
];

pub struct AutomationReplayGate<T> {
    state: Mutex<AutomationReplayState<T>>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct AutomationHandshakeSnapshot {
    pub setup_armed: bool,
    pub trusted_main_finished: bool,
    pub rejected_lifecycle: bool,
    pub rejected_label: bool,
    pub rejected_page: bool,
    pub client_ready_received: bool,
    pub client_ready_accepted: bool,
    pub client_ready_rejected: bool,
    pub released: bool,
    pub first_artifact_emitted: bool,
}

impl AutomationHandshakeSnapshot {
    pub fn merge(&mut self, other: Self) {
        self.setup_armed |= other.setup_armed;
        self.trusted_main_finished |= other.trusted_main_finished;
        self.rejected_lifecycle |= other.rejected_lifecycle;
        self.rejected_label |= other.rejected_label;
        self.rejected_page |= other.rejected_page;
        self.client_ready_received |= other.client_ready_received;
        self.client_ready_accepted |= other.client_ready_accepted;
        self.client_ready_rejected |= other.client_ready_rejected;
        self.released |= other.released;
        self.first_artifact_emitted |= other.first_artifact_emitted;
    }
}

struct AutomationReplayState<T> {
    pending: Option<Vec<T>>,
    main_page_finished: bool,
    client_ready: bool,
    consumed: bool,
    diagnostics: AutomationHandshakeSnapshot,
}

impl<T> AutomationReplayGate<T> {
    pub fn new(events: Vec<T>) -> Self {
        let setup_armed = !events.is_empty();
        Self {
            state: Mutex::new(AutomationReplayState {
                pending: setup_armed.then_some(events),
                main_page_finished: false,
                client_ready: false,
                consumed: false,
                diagnostics: AutomationHandshakeSnapshot {
                    setup_armed,
                    ..AutomationHandshakeSnapshot::default()
                },
            }),
        }
    }

    pub fn arm(&self, events: Vec<T>) -> Result<Option<Vec<T>>, ()> {
        if events.is_empty() {
            return Ok(None);
        }
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.consumed || state.pending.is_some() {
            return Err(());
        }
        state.diagnostics.setup_armed = true;
        state.pending = Some(events);
        Ok(Self::take_if_ready(&mut state))
    }

    pub fn take_for_page_load(
        &self,
        webview_label: &str,
        url: &Url,
        event: PageLoadEvent,
    ) -> Option<Vec<T>> {
        let mut state = self.state.lock().ok()?;
        if state.consumed {
            return None;
        }
        if event != PageLoadEvent::Finished {
            state.diagnostics.rejected_lifecycle = true;
            return None;
        }
        if webview_label != "main" {
            state.diagnostics.rejected_label = true;
            return None;
        }
        if !is_trusted_app_page(url) {
            state.diagnostics.rejected_page = true;
            return None;
        }
        state.main_page_finished = true;
        state.diagnostics.trusted_main_finished = true;
        Self::take_if_ready(&mut state)
    }

    pub fn take_for_client_ready(&self) -> Option<Vec<T>> {
        let mut state = self.state.lock().ok()?;
        if state.consumed {
            return None;
        }
        state.client_ready = true;
        state.diagnostics.client_ready_received = true;
        state.diagnostics.client_ready_accepted = true;
        Self::take_if_ready(&mut state)
    }

    pub fn record_rejected_client_ready(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.diagnostics.client_ready_received = true;
            state.diagnostics.client_ready_rejected = true;
        }
    }

    pub fn mark_first_artifact_emitted(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.diagnostics.first_artifact_emitted = true;
        }
    }

    pub fn diagnostics(&self) -> AutomationHandshakeSnapshot {
        self.state
            .lock()
            .map(|state| state.diagnostics)
            .unwrap_or_default()
    }

    fn take_if_ready(state: &mut AutomationReplayState<T>) -> Option<Vec<T>> {
        if state.consumed || !state.main_page_finished || !state.client_ready {
            return None;
        }
        let events = state.pending.take()?;
        state.consumed = true;
        state.diagnostics.released = true;
        Some(events)
    }
}

pub fn replay_bounded<T, Sleep, Emit>(events: &[T], mut sleep: Sleep, mut emit: Emit)
where
    T: Clone,
    Sleep: FnMut(Duration),
    Emit: FnMut(T),
{
    for delay in AUTOMATION_REPLAY_DELAYS {
        sleep(delay);
        for event in events.iter().cloned() {
            emit(event);
        }
    }
}

fn is_trusted_app_page(url: &Url) -> bool {
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => matches!(url.path(), "" | "/" | "/index.html"),
        ("http" | "https", Some("tauri.localhost")) => {
            matches!(url.path(), "/" | "/index.html")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{replay_bounded, AutomationReplayGate, AUTOMATION_REPLAY_DELAYS};
    use std::time::Duration;
    use tauri::webview::PageLoadEvent;

    #[test]
    fn cold_start_keeps_artifacts_pending_until_page_and_client_ready() {
        let gate = AutomationReplayGate::new(vec!["pdf", "docx", "pptx"]);
        let url = "tauri://localhost/".parse().unwrap();

        assert!(gate.diagnostics().setup_armed);
        assert!(!gate.diagnostics().trusted_main_finished);

        assert_eq!(
            gate.take_for_page_load("main", &url, PageLoadEvent::Finished),
            None
        );
        assert!(gate.diagnostics().trusted_main_finished);
        assert!(!gate.diagnostics().released);
        assert_eq!(
            gate.take_for_client_ready(),
            Some(vec!["pdf", "docx", "pptx"])
        );
        assert!(gate.diagnostics().client_ready_accepted);
        assert!(gate.diagnostics().released);
        assert!(!gate.diagnostics().first_artifact_emitted);
        gate.mark_first_artifact_emitted();
        assert!(gate.diagnostics().first_artifact_emitted);
    }

    #[test]
    fn setup_page_and_ready_release_once_in_every_ordering() {
        let app = "tauri://localhost/".parse().unwrap();
        for ordering in [
            ["setup", "page", "ready"],
            ["setup", "ready", "page"],
            ["page", "setup", "ready"],
            ["page", "ready", "setup"],
            ["ready", "setup", "page"],
            ["ready", "page", "setup"],
        ] {
            let gate = AutomationReplayGate::new(Vec::new());
            let mut releases = Vec::new();
            for operation in ordering {
                let released = match operation {
                    "setup" => gate.arm(vec![1, 2, 3]).unwrap(),
                    "page" => gate.take_for_page_load("main", &app, PageLoadEvent::Finished),
                    "ready" => gate.take_for_client_ready(),
                    _ => unreachable!(),
                };
                if let Some(events) = released {
                    releases.push(events);
                }
            }
            assert_eq!(releases, vec![vec![1, 2, 3]], "ordering {ordering:?}");
            assert_eq!(gate.take_for_client_ready(), None);
            assert_eq!(
                gate.take_for_page_load("main", &app, PageLoadEvent::Finished),
                None
            );
        }
    }

    #[test]
    fn only_finished_main_local_page_consumes_the_pending_batch() {
        let gate = AutomationReplayGate::new(vec![1, 2, 3]);
        let app = "tauri://localhost/".parse().unwrap();
        let foreign = "https://example.com/".parse().unwrap();
        let asset = "reviewasset://localhost/artifact/0123456789abcdef0123456789abcdef"
            .parse()
            .unwrap();
        let unexpected_path = "tauri://localhost/other.html".parse().unwrap();
        let query = "tauri://localhost/index.html?reload=1".parse().unwrap();
        let fragment = "tauri://localhost/#reload".parse().unwrap();
        let port = "tauri://localhost:4444/".parse().unwrap();
        let credentials = "tauri://reviewer@localhost/".parse().unwrap();
        let pathless = "tauri://localhost".parse().unwrap();

        assert_eq!(
            gate.take_for_page_load("main", &app, PageLoadEvent::Started),
            None
        );
        assert_eq!(
            gate.take_for_page_load("secondary", &app, PageLoadEvent::Finished),
            None
        );
        assert_eq!(
            gate.take_for_page_load("main", &foreign, PageLoadEvent::Finished),
            None
        );
        assert_eq!(
            gate.take_for_page_load("main", &asset, PageLoadEvent::Finished),
            None
        );
        assert_eq!(
            gate.take_for_page_load("main", &unexpected_path, PageLoadEvent::Finished),
            None
        );
        assert_eq!(
            gate.take_for_page_load("main", &query, PageLoadEvent::Finished),
            None
        );
        assert_eq!(
            gate.take_for_page_load("main", &fragment, PageLoadEvent::Finished),
            None
        );
        assert_eq!(
            gate.take_for_page_load("main", &port, PageLoadEvent::Finished),
            None
        );
        assert_eq!(
            gate.take_for_page_load("main", &credentials, PageLoadEvent::Finished),
            None
        );
        let rejected = gate.diagnostics();
        assert!(rejected.rejected_lifecycle);
        assert!(rejected.rejected_label);
        assert!(rejected.rejected_page);
        gate.record_rejected_client_ready();
        assert!(gate.diagnostics().client_ready_received);
        assert!(gate.diagnostics().client_ready_rejected);
        assert_eq!(
            gate.take_for_page_load("main", &app, PageLoadEvent::Finished),
            None
        );
        assert_eq!(gate.take_for_client_ready(), Some(vec![1, 2, 3]));
        assert_eq!(
            gate.take_for_page_load("main", &app, PageLoadEvent::Finished),
            None,
            "a reload must not consume or replay the same automation batch twice"
        );

        let pathless_gate = AutomationReplayGate::new(vec![4, 5, 6]);
        assert_eq!(pathless_gate.take_for_client_ready(), None);
        assert_eq!(
            pathless_gate.take_for_page_load("main", &pathless, PageLoadEvent::Finished),
            Some(vec![4, 5, 6]),
            "the Tauri runtime may report its main document URL without a slash path"
        );
    }

    #[test]
    fn empty_gate_never_starts_a_replay() {
        let gate = AutomationReplayGate::<u8>::new(Vec::new());
        let app = "http://tauri.localhost/index.html".parse().unwrap();

        assert_eq!(
            gate.take_for_page_load("main", &app, PageLoadEvent::Finished),
            None
        );
    }

    #[test]
    fn setup_can_arm_an_initially_empty_gate_once() {
        let gate = AutomationReplayGate::new(Vec::new());
        let app = "https://tauri.localhost/".parse().unwrap();

        assert_eq!(gate.arm(vec![1, 2, 3]), Ok(None));
        assert_eq!(
            gate.arm(vec![4, 5, 6]),
            Err(()),
            "setup must not replace a pending batch"
        );
        assert_eq!(
            gate.take_for_page_load("main", &app, PageLoadEvent::Finished),
            None
        );
        assert_eq!(gate.take_for_client_ready(), Some(vec![1, 2, 3]));
    }

    #[test]
    fn a_finished_page_before_setup_is_remembered_and_armed_once() {
        let gate = AutomationReplayGate::new(Vec::new());
        let app = "tauri://localhost/".parse().unwrap();

        assert_eq!(
            gate.take_for_page_load("main", &app, PageLoadEvent::Finished),
            None
        );
        assert_eq!(gate.take_for_client_ready(), None);
        assert_eq!(gate.arm(vec![1, 2, 3]), Ok(Some(vec![1, 2, 3])));
        assert_eq!(
            gate.take_for_page_load("main", &app, PageLoadEvent::Finished),
            None
        );
        assert_eq!(gate.arm(vec![4, 5, 6]), Err(()));
    }

    #[test]
    fn replay_window_is_fixed_bounded_and_preserves_batch_order() {
        assert_eq!(
            AUTOMATION_REPLAY_DELAYS,
            [
                Duration::from_millis(250),
                Duration::from_millis(500),
                Duration::from_millis(1_000),
                Duration::from_millis(2_000),
                Duration::from_millis(4_000),
            ]
        );
        let mut sleeps = Vec::new();
        let mut emitted = Vec::new();

        replay_bounded(
            &["pdf", "docx", "pptx"],
            |delay| sleeps.push(delay),
            |event| emitted.push(event),
        );

        assert_eq!(sleeps, AUTOMATION_REPLAY_DELAYS);
        assert_eq!(emitted.len(), 15);
        for replay in emitted.chunks_exact(3) {
            assert_eq!(replay, ["pdf", "docx", "pptx"]);
        }
    }
}
