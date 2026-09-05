use super::agent_cursor::{AgentCursor, PROJECTION};
use super::{Gateway, GatewayError};
use crate::agent::{ThreadError, ThreadRecord, ThreadStore};
use crate::protocol::agent_query;
use crate::workspace::WorkspaceError;
use serde_json::{Value, json};
use std::collections::HashMap;

const MAX_SUBSCRIPTIONS: usize = 64;

#[derive(Clone)]
struct Subscription {
    project_id: String,
    thread_id: String,
    revision: u64,
}

pub(super) struct AgentQueries {
    store: Option<ThreadStore>,
    cursor: AgentCursor,
    subscriptions: HashMap<String, Subscription>,
    next_id: u64,
}

impl AgentQueries {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            store: None,
            cursor: AgentCursor::new(key),
            subscriptions: HashMap::new(),
            next_id: 0,
        }
    }
    pub fn invalidate_scope(&mut self) {
        self.subscriptions.clear();
        self.cursor.scope_generation = self
            .cursor
            .scope_generation
            .checked_add(1)
            .expect("scope generation exhausted");
    }
    fn next_id(&mut self) -> Result<String, GatewayError> {
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(GatewayError::InvalidRequest)?;
        Ok(self.cursor.subscription_id(self.next_id))
    }
}

fn payload(record: &ThreadRecord) -> Value {
    json!({"project_id":record.project_id,"task_thread_id":record.thread_id,"state":record.state,
        "turn":record.turn,"has_state_checkpoint":record.checkpoint.is_some(),"updated_at":record.updated_at})
}

fn resync(id: &str, reason: &str) -> Value {
    json!({"protocol_version":1,"message_type":"subscription.resync_required",
        "subscription_id":id,"reason":reason,"next_action":"query.execute"})
}

impl Gateway {
    fn read_agent_state(&mut self, thread_id: &str) -> Result<ThreadRecord, GatewayError> {
        let workspace = self.workspace.as_ref().ok_or(GatewayError::ScopeMismatch)?;
        workspace.ensure_active()?;
        if self.agent_queries.store.is_none() {
            self.agent_queries.store = Some(ThreadStore::open(&self.state_root)?);
        }
        let record = self
            .agent_queries
            .store
            .as_ref()
            .ok_or(GatewayError::InvalidRequest)?
            .get(workspace.project_id(), thread_id)?;
        // UI consumers use JavaScript Numbers; never silently round a revision.
        if record.revision > 9_007_199_254_740_991 || record.turn > 9_007_199_254_740_991 {
            return Err(GatewayError::InvalidRequest);
        }
        Ok(record)
    }

    pub(super) fn agent_query(&mut self, request: &Value) -> Result<Value, GatewayError> {
        let request = agent_query::parse(request)?;
        // Always revalidate grant and scope before interpreting any cursor.
        let record = self.read_agent_state(&request.params.task_thread_id)?;
        let subscription = request.message_type == "subscription.open";
        let id = if subscription {
            Some(self.agent_queries.next_id()?)
        } else {
            None
        };
        if let Some(cursor) = &request.after_cursor
            && let Some(reason) = self.agent_queries.cursor.check(cursor, &record)?
        {
            return Ok(resync(
                id.as_deref().ok_or(GatewayError::InvalidRequest)?,
                reason,
            ));
        }
        let snapshot = json!({"protocol_version":1,"message_type":"query.snapshot",
            "request_id":request.request_id,"query_id":"agent.thread_state",
            "snapshot_revision":record.revision,"projection_version":PROJECTION,
            "event_cursor":self.agent_queries.cursor.issue(&record),"payload":payload(&record)});
        if let Some(id) = id {
            if self.agent_queries.subscriptions.len() >= MAX_SUBSCRIPTIONS {
                return Err(GatewayError::InvalidRequest);
            }
            self.agent_queries.subscriptions.insert(
                id.clone(),
                Subscription {
                    project_id: record.project_id,
                    thread_id: record.thread_id,
                    revision: record.revision,
                },
            );
            return Ok(
                json!({"protocol_version":1,"message_type":"subscription.accepted",
                "request_id":request.request_id,"subscription_id":id,"snapshot":snapshot}),
            );
        }
        Ok(snapshot)
    }

    /// Read-only, pull-based event delivery for the authenticated Shell transport.
    /// A gap discards the subscription; callers must query before subscribing again.
    pub fn poll_agent_subscription(&mut self, id: &str) -> Result<Option<Value>, GatewayError> {
        if let Some(reason) = self.agent_queries.cursor.subscription_scope(id)? {
            return Ok(Some(resync(id, reason)));
        }
        let subscription = self
            .agent_queries
            .subscriptions
            .get(id)
            .cloned()
            .ok_or(GatewayError::InvalidRequest)?;
        let record = match self.read_agent_state(&subscription.thread_id) {
            Ok(record) if record.project_id == subscription.project_id => record,
            Ok(_)
            | Err(GatewayError::ScopeMismatch)
            | Err(GatewayError::Workspace(
                WorkspaceError::GrantRevoked | WorkspaceError::RootIdentityChanged,
            ))
            | Err(GatewayError::Agent(ThreadError::ScopeDenied | ThreadError::NotFound)) => {
                self.agent_queries.subscriptions.remove(id);
                return Ok(Some(resync(id, "scope_changed")));
            }
            Err(error) => return Err(error),
        };
        if record.revision == subscription.revision {
            return Ok(None);
        }
        if subscription.revision.checked_add(1) != Some(record.revision) {
            self.agent_queries.subscriptions.remove(id);
            return Ok(Some(resync(id, "cursor_gap")));
        }
        self.agent_queries
            .subscriptions
            .get_mut(id)
            .ok_or(GatewayError::InvalidRequest)?
            .revision = record.revision;
        Ok(Some(
            json!({"protocol_version":1,"message_type":"subscription.event","subscription_id":id,
            "snapshot_revision":record.revision,"projection_version":PROJECTION,"event_cursor":self.agent_queries.cursor.issue(&record),
            "event_type":"agent.thread_state.changed","payload":payload(&record)}),
        ))
    }

    pub fn close_agent_subscription(&mut self, id: &str) -> Result<bool, GatewayError> {
        if self.agent_queries.cursor.subscription_scope(id)?.is_some() {
            return Ok(false);
        }
        Ok(self.agent_queries.subscriptions.remove(id).is_some())
    }
}
