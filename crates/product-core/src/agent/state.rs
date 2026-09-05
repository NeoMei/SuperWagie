use serde::{Deserialize, Serialize};

/// Durable Thread vocabulary (CAC §6.1), separate from Task Item and UI projections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadState {
    Ready,
    Running,
    AwaitingUser,
    UserStopped,
    CreditsBlocked,
    Disconnected,
    RecoverableFailed,
    Completed,
    Archived,
}

/// State topology only; not permission to execute or proof of a durable checkpoint.
pub fn can_transition(from: ThreadState, to: ThreadState) -> bool {
    use ThreadState::*;
    match from {
        Ready | UserStopped | Completed => matches!(to, Running | Archived),
        Running => matches!(
            to,
            AwaitingUser
                | UserStopped
                | CreditsBlocked
                | Disconnected
                | RecoverableFailed
                | Completed
        ),
        AwaitingUser | CreditsBlocked | Disconnected | RecoverableFailed => to == Running,
        Archived => false,
    }
}

/// The caller must load the archive source from trusted storage, never client input.
/// Restoring navigation must not automatically restart execution.
pub fn archive_restore_target(archived_from: ThreadState) -> Option<ThreadState> {
    use ThreadState::*;
    match archived_from {
        Ready | Completed => Some(Completed),
        UserStopped => Some(UserStopped),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{ThreadState, archive_restore_target, can_transition};
    use ThreadState::*;

    const STATES: [ThreadState; 9] = [
        Ready,
        Running,
        AwaitingUser,
        UserStopped,
        CreditsBlocked,
        Disconnected,
        RecoverableFailed,
        Completed,
        Archived,
    ];

    #[test]
    fn all_eighty_one_transition_pairs_match_cac() {
        let allowed: [&[ThreadState]; 9] = [
            &[Running, Archived],
            &[
                AwaitingUser,
                UserStopped,
                CreditsBlocked,
                Disconnected,
                RecoverableFailed,
                Completed,
            ],
            &[Running],
            &[Running, Archived],
            &[Running],
            &[Running],
            &[Running],
            &[Running, Archived],
            &[],
        ];
        for (index, from) in STATES.into_iter().enumerate() {
            for to in STATES {
                assert_eq!(
                    can_transition(from, to),
                    allowed[index].contains(&to),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn wire_states_match_authoritative_schema_and_round_trip() {
        let schema: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/contracts/v1/states.schema.json"
        )))
        .unwrap();
        let expected = schema["$defs"]["AgentTaskThread"]["properties"]["state"]["enum"]
            .as_array()
            .unwrap();
        let actual: Vec<serde_json::Value> = STATES
            .into_iter()
            .map(|state| serde_json::to_value(state).unwrap())
            .collect();
        assert_eq!(&actual, expected);
        for state in STATES {
            let value = serde_json::to_value(state).unwrap();
            assert_eq!(serde_json::from_value::<ThreadState>(value).unwrap(), state);
        }
        for invalid in ["paused", "cancelled", "blocked", "in_progress", "unknown"] {
            assert!(serde_json::from_value::<ThreadState>(invalid.into()).is_err());
        }
    }

    #[test]
    fn restoring_an_archive_never_starts_execution() {
        let expected = [
            Some(Completed),
            None,
            None,
            Some(UserStopped),
            None,
            None,
            None,
            Some(Completed),
            None,
        ];
        for (state, target) in STATES.into_iter().zip(expected) {
            assert_eq!(archive_restore_target(state), target);
            assert_ne!(archive_restore_target(state), Some(Running));
        }
    }
}
