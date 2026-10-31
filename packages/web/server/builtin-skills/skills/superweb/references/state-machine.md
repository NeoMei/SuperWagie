# State machine and revisions

`superweb.json` is the only source of truth. The CLI is the only writer.

## Stages

```
brief -> direction -> sample -> full -> acceptance -> delivered
```

| Stage | Meaning | Next |
| --- | --- | --- |
| `brief` | Task exists, brief may still be incomplete | `directions` |
| `direction` | Three directions and section structure are on disk | direction decision |
| `sample` | Only `预览/v0.html` exists | sample decision |
| `full` | Full page `预览/index.html` exists | `inspect` |
| `acceptance` | Report and screenshots exist | acceptance decision |
| `delivered` | User accepted | `deliver`, or rework |

`stageRevision` starts at 1. Every accepted transition increments it:
directions generation, each decision, every `inspect` run, and rework. A
decision must carry the current revision; anything else is rejected.

`direction` decisions use the offered direction IDs parsed from
`设计方向.md`. An ID that is not in the current three is rejected. Regenerating
directions clears `selectedDirectionId`, increments the revision, and makes
previous confirmations stale.

## Decisions

| Gate | Valid choice | Effect |
| --- | --- | --- |
| `direction` | one of the three offered IDs | `selectedDirectionId`, stage → `sample` |
| `sample` | `accept` | stage → `full`, records `预览/v0.html` |
| `acceptance` | `accept` | stage → `delivered` |
| `acceptance` | `rework` | stage → `target` (`full` by default, or `sample`) |

Accepted transitions append a decision:

```json
{
  "id": "direction-1",
  "gate": "direction",
  "revision": 2,
  "choice": "editorial-swiss",
  "at": "2026-10-22T08:00:00.000Z"
}
```

验收返工决定会额外记录 `target`（`full` 或 `sample`）；同一个
`decisionId` 重放时，`gate`、`choice`、`revision`、`target` 和
`acknowledgedIssues` 都必须一致，否则会被拒绝。

`--revision` defaults to the current `stageRevision`, and `--decision-id` is
generated when omitted, so the normal flow is just
`decide --gate … --choice …`. Explicit values are still validated. Keep them in
scripts that need idempotent retries: an auto-generated ID is new on every
call, so a retried command creates a second decision.

`acknowledgedIssues: true` is recorded when the user explicitly accepts a
failed or skipped browser acceptance.

Current inspection reports also carry a hash of `预览/index.html` and its local
assets. Acceptance refuses a report whose hash no longer matches the preview;
rerun `inspect` after changing the page.

Accepting the acceptance gate also runs `deliver`. If the self-contained check
fails, the decision is kept, the command exits `1`, and `交付/` is not written;
fix the files and run `superweb deliver` again.

## Idempotency and conflicts

- Replaying a decision with the same `decisionId`, gate, choice, and revision
  returns success with `idempotent: true` and does not change state.
- Reusing a `decisionId` with a different payload is rejected.
- A stale revision is rejected even if the payload is otherwise valid.
- Submitting a gate in the wrong stage is rejected. This cannot be used to skip
  a gate.

Decision IDs are chosen by the caller. Use a new readable ID per decision,
for example `direction-editorial-1`, `sample-ok-1`, `accept-1`, `rework-1`.

## Acceptance policy

Accepting when `acceptance.passed` is false requires
`--acknowledge-issues`. This includes a failed check and an unavailable
Chrome. The delivery readme must say so.

A failed `inspect` still advances to `acceptance`; it never auto-rejects or
auto-delivers. The user sees the report and chooses.

## Rework

Before delivery:

```bash
superweb decide --gate acceptance --choice rework --target full …
# or --target sample when the hero/shell itself is wrong
```

After delivery, the same command is allowed from `delivered`; it increments
the revision and returns to `full`. The existing `交付/` stays untouched until
the next successful `deliver`, which archives it as `交付-v1/` before writing a
new `交付/`.

Keep the confirmed direction and tokens. Rebuild only the sections with
problems. A direction change is a new direction-gate decision after rework,
not a silent edit.

## Artifacts

| Key | Path | Written by |
| --- | --- | --- |
| `brief` | `需求.md` | `start` |
| `directions` | `设计方向.md` | `directions` |
| `guide` | `设计引导.md` | `directions` and direction decision |
| `copy` | `文案.md` | agent, optional |
| `sample` | `预览/v0.html` | agent; recorded by sample decision |
| `preview` | `预览/index.html` | `inspect` |
| `delivery` | `交付/` | `deliver` |

Artifact paths in state are relative to the task directory, so a task folder
can be moved as a whole.

## Corrupt state

Invalid JSON, a missing field, an unknown stage, an unknown top-level key, or a
bad decision payload produces exit code `3` and an explanation. The file is
left intact. Never "fix" it by resetting to a blank state; that would discard
confirmed decisions.
