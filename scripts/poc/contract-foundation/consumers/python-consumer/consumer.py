#!/usr/bin/env python3

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
import re
import sys
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry
from referencing.jsonschema import DRAFT202012


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--fixture", required=True)
    return parser.parse_args()


def compact_bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def parse_timestamp(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def main() -> int:
    args = arguments()
    repo = args.repo_root.resolve()
    if not args.repo_root.is_absolute() or not re.fullmatch(r"CF-PROTOCOL-[0-9]{3}", args.fixture):
        raise ValueError("invalid consumer arguments")
    contracts = repo / "docs/contracts/v1"
    fixtures = repo / "fixtures/contract-foundation" / args.fixture
    schema_files = [
        "resource-handle.schema.json",
        "ui-query.schema.json",
        "human-gates.schema.json",
        "envelopes.schema.json",
    ]
    schemas = {name: json.loads((contracts / name).read_text()) for name in schema_files}
    registry = Registry()
    for schema in schemas.values():
        registry = registry.with_resource(schema["$id"], DRAFT202012.create_resource(schema))
    checker = FormatChecker()

    envelopes_id = schemas["envelopes.schema.json"]["$id"]
    resource_id = schemas["resource-handle.schema.json"]["$id"]
    query_id = schemas["ui-query.schema.json"]["$id"]
    gates_id = schemas["human-gates.schema.json"]["$id"]
    refs = {
        "ClientIntent": f"{envelopes_id}#/$defs/ClientIntent",
        "AuthorizedCommand": f"{envelopes_id}#/$defs/AuthorizedCommand",
        "CommandResultEnvelope": f"{envelopes_id}#/$defs/CommandResultEnvelope",
        "EventEnvelope": f"{envelopes_id}#/$defs/EventEnvelope",
        "ArtifactRef": f"{envelopes_id}#/$defs/ArtifactRef",
        "ErrorEnvelope": f"{envelopes_id}#/$defs/ErrorEnvelope",
        "ResourceHandle": resource_id,
        "QueryRequest": f"{query_id}#/$defs/QueryRequest",
        "QuerySnapshot": f"{query_id}#/$defs/QuerySnapshot",
        "SubscriptionOpen": f"{query_id}#/$defs/SubscriptionOpen",
        "SubscriptionAccepted": f"{query_id}#/$defs/SubscriptionAccepted",
        "ProjectionEvent": f"{query_id}#/$defs/ProjectionEvent",
        "ResyncRequired": f"{query_id}#/$defs/ResyncRequired",
        "WorkflowGateDecision": f"{gates_id}#/$defs/WorkflowGateDecision",
        "RiskGateDecision": f"{gates_id}#/$defs/RiskGateDecision",
        "InstallGateDecision": f"{gates_id}#/$defs/InstallGateDecision",
        "WorkflowGateReceipt": f"{gates_id}#/$defs/WorkflowGateReceipt",
        "RiskGateReceipt": f"{gates_id}#/$defs/RiskGateReceipt",
        "InstallGateReceipt": f"{gates_id}#/$defs/InstallGateReceipt",
    }
    branches = {
        name: Draft202012Validator({"$ref": ref}, registry=registry, format_checker=checker)
        for name, ref in refs.items()
    }
    roots = [
        Draft202012Validator(schema, registry=registry, format_checker=checker)
        for schema in schemas.values()
    ]

    def schema_observation(envelope: Any) -> dict[str, Any]:
        matched = [name for name, validator in branches.items() if validator.is_valid(envelope)]
        return {"matched": matched, "root_valid": any(validator.is_valid(envelope) for validator in roots)}

    def resource_policy_observation(definition: dict[str, Any]) -> dict[str, Any]:
        handle = definition["handle"]
        request = definition["request"]
        schema_valid = branches["ResourceHandle"].is_valid(handle)
        issued_at = parse_timestamp(handle.get("issued_at"))
        requested_at = parse_timestamp(request.get("at"))
        expires_at = parse_timestamp(handle.get("expires_at"))
        outcome = "allowed"
        if not schema_valid:
            outcome = "invalid-handle"
        elif request.get("revoked") is True:
            outcome = "revoked"
        elif handle.get("audience") != request.get("audience"):
            outcome = "audience-mismatch"
        elif handle.get("resource_revision") != request.get("resource_revision"):
            outcome = "revision-mismatch"
        elif request.get("operation") not in handle.get("allowed_operations", []):
            outcome = "operation-denied"
        elif issued_at is None or requested_at is None or requested_at < issued_at:
            outcome = "not-yet-valid"
        elif expires_at is None or requested_at >= expires_at:
            outcome = "expired"
        elif int(request.get("requested_bytes", 0)) > int(handle.get("size_limit_bytes", 0)):
            outcome = "size-exceeded"
        elif int(request.get("requested_range_bytes", 0)) > int(handle.get("range_limit_bytes", 0)):
            outcome = "range-exceeded"
        elif handle.get("one_shot") is True and request.get("one_shot_consumed") is True:
            outcome = "consumed"
        return {"outcome": outcome, "schema_valid": schema_valid}

    def projection_stream_observation(definition: dict[str, Any]) -> dict[str, Any]:
        snapshot = definition["snapshot"]
        events = definition["events"]
        schema_valid = branches["QuerySnapshot"].is_valid(snapshot) and all(
            branches["ProjectionEvent"].is_valid(event) for event in events
        )
        outcome = "continuous"
        if not schema_valid:
            outcome = "invalid-stream"
        elif definition.get("core_restarted") is True:
            outcome = "resync_required"
        elif any(event.get("subscription_id") != definition.get("subscription_id") for event in events):
            outcome = "resync_required"
        elif any(
            int(event.get("snapshot_revision", -1)) != int(snapshot["snapshot_revision"]) + index + 1
            for index, event in enumerate(events)
        ):
            outcome = "resync_required"
        elif any(event.get("projection_version") != snapshot.get("projection_version") for event in events):
            outcome = "resync_required"
        elif [event.get("event_cursor") for event in events] != definition.get("expected_cursors"):
            outcome = "resync_required"
        return {"outcome": outcome, "schema_valid": schema_valid}

    def cancel_intent_observation(definition: dict[str, Any]) -> dict[str, Any]:
        envelope = definition["envelope"]
        payload = envelope.get("payload")
        schema_valid = branches["ClientIntent"].is_valid(envelope)
        target_request_id = payload.get("request_id") if isinstance(payload, dict) else None
        accepted = (
            schema_valid
            and envelope.get("command_type") == "system.request.cancel"
            and isinstance(payload, dict)
            and set(payload) == {"request_id"}
            and isinstance(target_request_id, str)
            and bool(target_request_id)
            and target_request_id != envelope.get("request_id")
        )
        return {"outcome": "accepted" if accepted else "rejected", "schema_valid": schema_valid}

    results: list[dict[str, Any]] = []
    for file in sorted(fixtures.glob("*.json")):
        definition = json.loads(file.read_text())
        case_id = str(definition.get("case_id", file.name))
        kind = str(definition.get("kind", ""))
        observed: dict[str, Any]
        passed = False
        if kind == "schema":
            observed = schema_observation(definition["envelope"])
            matched = observed["matched"]
            valid = observed["root_valid"] and len(matched) == 1
            passed = (
                valid and (not definition.get("expect_type") or matched[0] == definition["expect_type"])
                if definition["expect"] == "valid"
                else not observed["root_valid"] and len(matched) == 0
            )
        elif kind == "size-limit":
            envelope = deepcopy(definition["envelope"])
            if definition.get("padding_bytes"):
                envelope["payload"]["blob"] = "x" * int(definition["padding_bytes"])
            byte_count = compact_bytes(envelope)
            max_bytes = int(definition["max_bytes"])
            outcome = "over-limit" if byte_count > max_bytes else "within-limit"
            observed = {"outcome": outcome, "bytes": byte_count, "max_bytes": max_bytes}
            passed = outcome == definition["expect"]
        elif kind == "request-log":
            schema_valid = all(branches["ClientIntent"].is_valid(value) for value in definition["envelopes"])
            request_ids = [value["request_id"] for value in definition["envelopes"]]
            outcome = "unique" if len(set(request_ids)) == len(request_ids) else "duplicate"
            observed = {"outcome": outcome, "schema_valid": schema_valid}
            passed = schema_valid and outcome == definition["expect"]
        elif kind == "event-sequence":
            schema_valid = all(branches["EventEnvelope"].is_valid(value) for value in definition["envelopes"])
            seen: set[int] = set()
            previous = 0
            outcome = "ok"
            for envelope in definition["envelopes"]:
                revision = int(envelope["aggregate_revision"])
                if revision in seen:
                    outcome = "duplicate"
                    break
                if seen and revision != previous + 1:
                    outcome = "gap"
                    break
                seen.add(revision)
                previous = revision
            observed = {"outcome": outcome, "schema_valid": schema_valid}
            passed = schema_valid and outcome == definition["expect"]
        elif kind == "deadline":
            issued = parse_timestamp(definition["envelope"].get("issued_at"))
            deadline = parse_timestamp(definition["envelope"].get("deadline_at"))
            outcome = "met" if issued is not None and deadline is not None and deadline > issued else "violated"
            observed = {"outcome": outcome}
            passed = outcome == definition["expect"]
        elif kind == "resource-policy":
            observed = resource_policy_observation(definition)
            passed = observed["outcome"] == definition["expect"] and (
                not observed["schema_valid"] if definition["expect"] == "invalid-handle" else observed["schema_valid"]
            )
        elif kind == "projection-stream":
            observed = projection_stream_observation(definition)
            passed = observed["outcome"] == definition["expect"] and (
                not observed["schema_valid"] if definition["expect"] == "invalid-stream" else observed["schema_valid"]
            )
        elif kind == "cancel-intent":
            observed = cancel_intent_observation(definition)
            passed = observed["schema_valid"] and observed["outcome"] == definition["expect"]
        else:
            observed = {"error": "unknown-kind"}
        results.append({"case_id": case_id, "kind": kind, "passed": passed, "observed": observed})

    report = {
        "schema_id": "superwagie.contract-consumer-result.v1",
        "schema_version": 1,
        "consumer": "python",
        "fixture": args.fixture,
        "pass": all(case["passed"] for case in results),
        "cases": results,
    }
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
