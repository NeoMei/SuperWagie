# Directory reachability

The server checks whether a project path answers before opening it on Windows. A missing project on a reachable drive can be removed. A missing drive letter or UNC share is unreachable and the saved project stays available for a later retry.

## Probe lifetime

A probe opens the directory, reads one entry and closes the handle. At most two probes run in the server, including while a helper is unavailable. When a probe takes over 250 ms, a hidden helper with its own filesystem thread pool takes the pending work. If the helper exits unexpectedly, probes already running in the server keep their slots. Other requests queue until a slot opens or the helper returns. Callers share a probe for the same path and wait up to three seconds for a first answer. Known unreachable paths and their descendants have a shorter retry wait. A stuck helper is replaced so a remounted path can recover. Idle helpers exit.

A helper reply completes a pending probe only when its request ID matches and it contains either an explicit `null` for success or a string error code. Malformed JSON and incomplete replies leave the probe pending under its existing deadline.

A reachability result describes the disk at the time of the probe. The subsequent stat, access or realpath in `readProjectPath` has its own two-second deadline because a drive can disconnect in between.
