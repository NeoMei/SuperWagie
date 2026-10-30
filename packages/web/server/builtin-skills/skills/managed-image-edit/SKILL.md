---
name: managed-image-edit
description: Edit a local image using a local mask and the SuperWagie managed image model, preserving the paid task for recovery.
---

# Managed image edit

For an explicitly requested masked image edit, provide a PNG mask with an alpha channel and the same dimensions as the source image. Fully transparent pixels (alpha 0) mark the area to edit; fully opaque pixels (alpha 255) mark the area to preserve. Semi-transparent pixels are not supported. The mask must be 512–4096 pixels on each side and no larger than 4 MiB. The gateway performs the final validation before dispatch. If the supplied mask does not meet this contract, explain what is needed and do not submit it.

Invoke `node <skill-directory>/scripts/edit.mjs submit <private-record-directory>` with a JSON request on stdin containing `imagePath`, `maskPath`, `prompt`, `model`, and optional `sessionID`. The helper returns a callID; preserve it even when submission is uncertain. Poll or recover using `node <skill-directory>/scripts/edit.mjs status <private-record-directory>` with `{callID, sessionID?}`. On success, the helper writes the validated result into the same directory without replacing an existing file and returns its absolute path. Pending or uncertain calls must only be polled using the original ID; never resubmit them. Submit a new call only for a separately authorized edit. Run from SuperWagie with the configured managed model; do not read or request provider credentials.
