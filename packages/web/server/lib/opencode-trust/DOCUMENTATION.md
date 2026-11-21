# OpenCode folder trust

Opening a folder through managed OpenCode can load project configuration and start local plugins or tools. The trust gate checks project and inherited configuration before scoped OpenCode reads and writes, session location changes, and worktree prewarm. Global session discovery stays available so users can browse projects and switch folders while a review is pending.

The assessment reads project configuration, local plugin sources and static local imports, and agent permission definitions. It lists local execution settings, substitutions, and rules that relax user permissions. The review shows configuration names and source paths. Command arguments, substitution values, and contents of referenced files stay out of the response. Assessment reads source files without running them.

Trust is keyed by repository identity and a fingerprint of the reviewed settings. Linked worktrees can reuse a decision when they have the same effective configuration. A configuration change creates a fresh review. A save with an outdated fingerprint returns the newest assessment, which the user can review before confirming again. Approvals are stored in `opencode-trust.json` under the app's data directory. The file is updated atomically under the existing cross-process lock.

The proxy and app-owned OpenCode transport check the directory from the route, header, request body, or session owner before dispatch. The host leaves isolated space directories to their owning runtimes. The VS Code bridge uses the same assessment and keeps its checks with the connected OpenCode instance. An endpoint switch cancels a pending review. Paused projects can be reviewed from the session sidebar.

Assessment uses the filesystem visible to the app-owned runtime. Standalone OpenCode processes, engine requests outside the proxy or bridge, and external engine filesystems are outside this gate.
