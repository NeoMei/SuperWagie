# Transcript error summaries

## Ownership

This module classifies errors recorded on assistant messages. Chat and session
notice components translate the resulting semantic keys in the current UI
language. OpenCode projection owns the incoming structured error contract;
diagnostics retain the original error and response body.

## Invariants

- Missing model credentials and rejected model authentication have distinct,
  actionable summaries. Neither implies that the SuperWagie account login failed.
- Authentication uses the structured error name or explicit authentication text.
  A rate limit, insufficient balance, service failure or dropped connection alone
  never becomes a request to configure the model.
- HTTP 429 and the explicit OpenCode free-usage refusal have localized summaries
  of their own. The notice never subscribes, retries or selects a paid model.
- Errors remain untranslated in stored history. Switching languages updates
  already rendered errors without changing the conversation or retrying a call.
- The user can expand the original error details. A provider response body takes
  precedence; errors without one retain their original message as details.
- A user stop remains a stop, and retry status remains distinct from a final
  failure. Shared web, Electron, VS Code and mobile renderers use the same rules.

## Decisions

### Why summaries use dictionary keys

Persisting or returning translated sentences fixes an old error to the language
active when it occurred. Semantic keys let the current renderer choose the
language while preserving the original diagnostic evidence.

## Review comment source anchors

`contextParts.ts` keeps the path, range, side and comparison origin across
draft, send, transcript and restore. Diff comments can also carry a staging
flag and a nested repository path relative to the owning chat directory.
Older OpenCode comment metadata still supplies the file and selection when
the OpenChamber payload is absent. A whole-file anchor has no line.

The source action uses structured paths. Table quote labels and unsaved plan
names stay as display text. An isolated-space source must resolve inside the
session directory and within the same space. Source navigation reads this
metadata locally. The model-facing comment format stays the same.
