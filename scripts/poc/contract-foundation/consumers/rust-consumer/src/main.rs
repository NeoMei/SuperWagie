use anyhow::{Context, Result, bail};
use jsonschema::{Registry, Validator};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn arg(name: &str) -> Option<String> {
    let values: Vec<String> = env::args().collect();
    values
        .iter()
        .position(|value| value == name)
        .and_then(|index| values.get(index + 1).cloned())
}

fn read_json(path: &Path) -> Result<Value> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("invalid JSON {}", path.display()))
}

fn compact_bytes(value: &Value) -> Result<usize> {
    Ok(serde_json::to_vec(value)?.len())
}

fn schema_id(schema: &Value) -> Result<&str> {
    schema
        .get("$id")
        .and_then(Value::as_str)
        .context("schema is missing $id")
}

fn build_validator(registry: &Registry, schema: &Value) -> Result<Validator> {
    jsonschema::draft202012::options()
        .with_registry(registry)
        .should_validate_formats(true)
        .build(schema)
        .map_err(Into::into)
}

fn parse_timestamp(value: &Value) -> Option<OffsetDateTime> {
    value
        .as_str()
        .and_then(|text| OffsetDateTime::parse(text, &Rfc3339).ok())
}

fn main() -> Result<()> {
    let repo = PathBuf::from(arg("--repo-root").context("missing --repo-root")?);
    let fixture = arg("--fixture").context("missing --fixture")?;
    if !repo.is_absolute()
        || fixture.len() != "CF-PROTOCOL-000".len()
        || !fixture.starts_with("CF-PROTOCOL-")
        || !fixture["CF-PROTOCOL-".len()..]
            .chars()
            .all(|value| value.is_ascii_digit())
    {
        bail!("invalid consumer arguments");
    }
    let contracts = repo.join("docs/contracts/v1");
    let fixtures = repo.join("fixtures/contract-foundation").join(&fixture);
    let schema_files = [
        "resource-handle.schema.json",
        "ui-query.schema.json",
        "human-gates.schema.json",
        "envelopes.schema.json",
    ];
    let mut schemas = BTreeMap::new();
    let mut registry_builder = Registry::new();
    for file in schema_files {
        let schema = read_json(&contracts.join(file))?;
        registry_builder = registry_builder.add(schema_id(&schema)?, schema.clone())?;
        schemas.insert(file.to_string(), schema);
    }
    let registry = registry_builder.prepare()?;

    let envelopes_id = schema_id(&schemas["envelopes.schema.json"])?;
    let resource_id = schema_id(&schemas["resource-handle.schema.json"])?;
    let query_id = schema_id(&schemas["ui-query.schema.json"])?;
    let gates_id = schema_id(&schemas["human-gates.schema.json"])?;
    let refs = BTreeMap::from([
        (
            "ClientIntent",
            format!("{envelopes_id}#/$defs/ClientIntent"),
        ),
        (
            "AuthorizedCommand",
            format!("{envelopes_id}#/$defs/AuthorizedCommand"),
        ),
        (
            "CommandResultEnvelope",
            format!("{envelopes_id}#/$defs/CommandResultEnvelope"),
        ),
        (
            "EventEnvelope",
            format!("{envelopes_id}#/$defs/EventEnvelope"),
        ),
        ("ArtifactRef", format!("{envelopes_id}#/$defs/ArtifactRef")),
        (
            "ErrorEnvelope",
            format!("{envelopes_id}#/$defs/ErrorEnvelope"),
        ),
        ("ResourceHandle", resource_id.to_string()),
        ("QueryRequest", format!("{query_id}#/$defs/QueryRequest")),
        ("QuerySnapshot", format!("{query_id}#/$defs/QuerySnapshot")),
        (
            "SubscriptionOpen",
            format!("{query_id}#/$defs/SubscriptionOpen"),
        ),
        (
            "SubscriptionAccepted",
            format!("{query_id}#/$defs/SubscriptionAccepted"),
        ),
        (
            "ProjectionEvent",
            format!("{query_id}#/$defs/ProjectionEvent"),
        ),
        (
            "ResyncRequired",
            format!("{query_id}#/$defs/ResyncRequired"),
        ),
        (
            "WorkflowGateDecision",
            format!("{gates_id}#/$defs/WorkflowGateDecision"),
        ),
        (
            "RiskGateDecision",
            format!("{gates_id}#/$defs/RiskGateDecision"),
        ),
        (
            "InstallGateDecision",
            format!("{gates_id}#/$defs/InstallGateDecision"),
        ),
        (
            "WorkflowGateReceipt",
            format!("{gates_id}#/$defs/WorkflowGateReceipt"),
        ),
        (
            "RiskGateReceipt",
            format!("{gates_id}#/$defs/RiskGateReceipt"),
        ),
        (
            "InstallGateReceipt",
            format!("{gates_id}#/$defs/InstallGateReceipt"),
        ),
    ]);
    let mut branches = BTreeMap::new();
    for (name, reference) in refs {
        branches.insert(
            name,
            build_validator(&registry, &json!({"$ref": reference}))?,
        );
    }
    let roots: Vec<Validator> = schemas
        .values()
        .map(|schema| build_validator(&registry, schema))
        .collect::<Result<Vec<_>>>()?;

    let mut files: Vec<PathBuf> = fs::read_dir(&fixtures)?
        .filter_map(|entry| entry.ok().map(|value| value.path()))
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect();
    files.sort();
    let mut cases = Vec::new();
    for file in files {
        let definition = read_json(&file)?;
        let case_id = definition
            .get("case_id")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                file.file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("unknown")
            });
        let kind = definition.get("kind").and_then(Value::as_str).unwrap_or("");
        let mut passed = false;
        let observed = match kind {
            "schema" => {
                let envelope = &definition["envelope"];
                let matched: Vec<&str> = branches
                    .iter()
                    .filter(|(_, validator)| validator.is_valid(envelope))
                    .map(|(name, _)| *name)
                    .collect();
                let root_valid = roots.iter().any(|validator| validator.is_valid(envelope));
                let valid = root_valid && matched.len() == 1;
                passed = if definition["expect"] == "valid" {
                    valid
                        && definition
                            .get("expect_type")
                            .and_then(Value::as_str)
                            .is_none_or(|expected| matched.first().copied() == Some(expected))
                } else {
                    !root_valid && matched.is_empty()
                };
                json!({"matched": matched, "root_valid": root_valid})
            }
            "size-limit" => {
                let mut envelope = definition["envelope"].clone();
                if let Some(padding) = definition.get("padding_bytes").and_then(Value::as_u64) {
                    envelope
                        .get_mut("payload")
                        .and_then(Value::as_object_mut)
                        .context("size fixture payload missing")?
                        .insert(
                            "blob".to_string(),
                            Value::String("x".repeat(padding as usize)),
                        );
                }
                let bytes = compact_bytes(&envelope)?;
                let max_bytes = definition["max_bytes"]
                    .as_u64()
                    .context("max_bytes missing")? as usize;
                let outcome = if bytes > max_bytes {
                    "over-limit"
                } else {
                    "within-limit"
                };
                passed = definition["expect"] == outcome;
                json!({"outcome": outcome, "bytes": bytes, "max_bytes": max_bytes})
            }
            "request-log" => {
                let envelopes = definition["envelopes"]
                    .as_array()
                    .context("envelopes missing")?;
                let schema_valid = envelopes
                    .iter()
                    .all(|value| branches["ClientIntent"].is_valid(value));
                let ids: Vec<&str> = envelopes
                    .iter()
                    .filter_map(|value| value.get("request_id").and_then(Value::as_str))
                    .collect();
                let unique: BTreeSet<&str> = ids.iter().copied().collect();
                let outcome = if unique.len() == ids.len() {
                    "unique"
                } else {
                    "duplicate"
                };
                passed = schema_valid && definition["expect"] == outcome;
                json!({"outcome": outcome, "schema_valid": schema_valid})
            }
            "event-sequence" => {
                let envelopes = definition["envelopes"]
                    .as_array()
                    .context("envelopes missing")?;
                let schema_valid = envelopes
                    .iter()
                    .all(|value| branches["EventEnvelope"].is_valid(value));
                let mut seen = BTreeSet::new();
                let mut previous = 0_u64;
                let mut outcome = "ok";
                for envelope in envelopes {
                    let revision = envelope["aggregate_revision"]
                        .as_u64()
                        .context("revision missing")?;
                    if seen.contains(&revision) {
                        outcome = "duplicate";
                        break;
                    }
                    if !seen.is_empty() && revision != previous + 1 {
                        outcome = "gap";
                        break;
                    }
                    seen.insert(revision);
                    previous = revision;
                }
                passed = schema_valid && definition["expect"] == outcome;
                json!({"outcome": outcome, "schema_valid": schema_valid})
            }
            "deadline" => {
                let issued = parse_timestamp(&definition["envelope"]["issued_at"]);
                let deadline = parse_timestamp(&definition["envelope"]["deadline_at"]);
                let outcome = if issued.is_some() && deadline.is_some() && deadline > issued {
                    "met"
                } else {
                    "violated"
                };
                passed = definition["expect"] == outcome;
                json!({"outcome": outcome})
            }
            "resource-policy" => {
                let handle = &definition["handle"];
                let request = &definition["request"];
                let schema_valid = branches["ResourceHandle"].is_valid(handle);
                let issued_at = parse_timestamp(&handle["issued_at"]);
                let requested_at = parse_timestamp(&request["at"]);
                let expires_at = parse_timestamp(&handle["expires_at"]);
                let operation_allowed =
                    handle["allowed_operations"]
                        .as_array()
                        .is_some_and(|operations| {
                            operations
                                .iter()
                                .any(|value| value == &request["operation"])
                        });
                let outcome = if !schema_valid {
                    "invalid-handle"
                } else if request["revoked"] == true {
                    "revoked"
                } else if handle["audience"] != request["audience"] {
                    "audience-mismatch"
                } else if handle["resource_revision"] != request["resource_revision"] {
                    "revision-mismatch"
                } else if !operation_allowed {
                    "operation-denied"
                } else if issued_at.is_none() || requested_at.is_none() || requested_at < issued_at
                {
                    "not-yet-valid"
                } else if expires_at.is_none() || requested_at >= expires_at {
                    "expired"
                } else if request["requested_bytes"].as_u64().unwrap_or(u64::MAX)
                    > handle["size_limit_bytes"].as_u64().unwrap_or(0)
                {
                    "size-exceeded"
                } else if request["requested_range_bytes"]
                    .as_u64()
                    .unwrap_or(u64::MAX)
                    > handle["range_limit_bytes"].as_u64().unwrap_or(0)
                {
                    "range-exceeded"
                } else if handle["one_shot"] == true && request["one_shot_consumed"] == true {
                    "consumed"
                } else {
                    "allowed"
                };
                passed = definition["expect"] == outcome
                    && if definition["expect"] == "invalid-handle" {
                        !schema_valid
                    } else {
                        schema_valid
                    };
                json!({"outcome": outcome, "schema_valid": schema_valid})
            }
            "projection-stream" => {
                let snapshot = &definition["snapshot"];
                let events = definition["events"].as_array().context("events missing")?;
                let schema_valid = branches["QuerySnapshot"].is_valid(snapshot)
                    && events
                        .iter()
                        .all(|event| branches["ProjectionEvent"].is_valid(event));
                let expected_revision = snapshot["snapshot_revision"].as_u64().unwrap_or(u64::MAX);
                let subscription_matches = events
                    .iter()
                    .all(|event| event["subscription_id"] == definition["subscription_id"]);
                let revisions_match = events.iter().enumerate().all(|(index, event)| {
                    expected_revision
                        .checked_add(index as u64 + 1)
                        .is_some_and(|expected| {
                            event["snapshot_revision"].as_u64() == Some(expected)
                        })
                });
                let versions_match = events
                    .iter()
                    .all(|event| event["projection_version"] == snapshot["projection_version"]);
                let cursors: Vec<&Value> =
                    events.iter().map(|event| &event["event_cursor"]).collect();
                let expected_cursors: Vec<&Value> = definition["expected_cursors"]
                    .as_array()
                    .context("expected_cursors missing")?
                    .iter()
                    .collect();
                let outcome = if !schema_valid {
                    "invalid-stream"
                } else if definition["core_restarted"] == true
                    || !subscription_matches
                    || !revisions_match
                    || !versions_match
                    || cursors != expected_cursors
                {
                    "resync_required"
                } else {
                    "continuous"
                };
                passed = definition["expect"] == outcome
                    && if definition["expect"] == "invalid-stream" {
                        !schema_valid
                    } else {
                        schema_valid
                    };
                json!({"outcome": outcome, "schema_valid": schema_valid})
            }
            "cancel-intent" => {
                let envelope = &definition["envelope"];
                let payload = envelope["payload"].as_object();
                let schema_valid = branches["ClientIntent"].is_valid(envelope);
                let target_request_id = payload
                    .and_then(|value| value.get("request_id"))
                    .and_then(Value::as_str);
                let accepted = schema_valid
                    && envelope["command_type"] == "system.request.cancel"
                    && payload
                        .is_some_and(|value| value.len() == 1 && value.contains_key("request_id"))
                    && target_request_id.is_some_and(|target| {
                        !target.is_empty() && Some(target) != envelope["request_id"].as_str()
                    });
                let outcome = if accepted { "accepted" } else { "rejected" };
                passed = schema_valid && definition["expect"] == outcome;
                json!({"outcome": outcome, "schema_valid": schema_valid})
            }
            _ => json!({"error": "unknown-kind"}),
        };
        cases.push(
            json!({"case_id": case_id, "kind": kind, "passed": passed, "observed": observed}),
        );
    }

    let report = json!({
        "schema_id": "superwagie.contract-consumer-result.v1",
        "schema_version": 1,
        "consumer": "rust",
        "fixture": fixture,
        "pass": cases.iter().all(|case| case["passed"] == true),
        "cases": cases,
    });
    println!("{}", serde_json::to_string(&report)?);
    if report["pass"] == true {
        Ok(())
    } else {
        bail!("fixture validation failed")
    }
}
