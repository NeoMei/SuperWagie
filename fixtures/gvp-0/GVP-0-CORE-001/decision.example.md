# GVP-0-CORE-001 decision example

## Behavior result

- Corpus behavior: `PASS`
- Six immutable fixtures: expected outcomes observed
- Observed external Viewer-group/descendant processes: `0`
- Network attempts: `0`
- Exposed filesystem paths: `0`
- Source mutations: `0`
- Hung parser worker group: hard-killed, direct worker reaped, no original-group or known-descendant survivor

## Admission result

- Aggregate `pass`: `false`
- Aggregate `status`: `failed`
- Decision: `NO_GO`
- Required `forbidden_runtime_edges`: `0`
- Observed Task 3 `forbidden_runtime_edges`: `8`

The behavior result does not override the stronger static reachability evidence. Candidate remediation and a new frozen-source admission attempt are required before any aggregate `GO` is possible. This document is an example interpretation, not a signed Gate receipt.
