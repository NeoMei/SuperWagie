# Native Hy memory smoke fixture

Run from the repository root with the rebuilt private backend and a Python
environment with the dependencies from
`packages/web/server/lib/hy-memory/requirements-lock.txt` installed:

```sh
node packages/web/scripts/hy-memory-smoke.mjs \
  --backend=/absolute/path/to/backend \
  --backend-root=/absolute/path/to/staged/backend \
  --python=/absolute/path/to/python
```

The staged backend path supplies `config/`, `migrations/sqlite/` and the
verified `jieba-dict/` resources. The fixture requires all 5 dictionaries and
sets `JIEBA_DICT_DIR` explicitly, so a build-machine Go cache cannot satisfy
a missing package resource. The fixture copies them into a temporary working directory and
starts the supplied binary there with a fresh SQLite database, generated
fixture credentials and an isolated child
environment. It reads no repository `.env` file. All temporary data and owned
processes are removed after the run. It writes 1 JSON summary to stdout and
exits with a nonzero status on failure. Paths, credentials, source prose and
backend logs are omitted from the summary.

Both fixtures share `hy-memory-smoke-support.mjs`, which owns temporary backend
provisioning, loopback embedding responses, process cleanup and JSON output.
The real Node runtime, Python Hy engine, backend HTTP client, SQLite index and
agent library action adapter run together. The fixtures supply synthetic
conversation messages, extraction results and embedding vectors. It checks
candidate inspection, confirmation, search, read, recall, raw core/key deletion,
sibling preservation, code history and full source erasure. Confirmation and
cleanup must leave the generation count at 2. An embedding model configuration
change re-embeds the same core/card identities into a new space, removes the old
vectors and preserves recall without another extraction. Both the organizer
and card projection use the production `createHySpaceMaintenance` callback.
Wiki derivation remains enabled
on the fixture knowledge base to verify that typed memory nodes bypass document
derivation. The fixture reads the knowledge base back to verify that setting.

The separate System2 fixture uses the same arguments:

```sh
node packages/web/scripts/hy-memory-s2-smoke.mjs \
  --backend=/absolute/path/to/backend \
  --backend-root=/absolute/path/to/staged/backend \
  --python=/absolute/path/to/python
```

It captures 2 synthetic source sessions through the actual Hy writer. The
automatic scheduler invokes the actual System2 clustering, schema tool and
cross-domain behavior representation code. Source experiences and the resulting
method remain unverified candidates. A deliberate first projection failure
leaves the result receipt durable. Restart recovery commits that receipt
without repeating generation, and the next real System2 batch reviews the
remaining cluster and exhausts its continuation. The original method becomes
eligible only after separate confirmation. Agent read and recall verify its
stored body. The expected generation counts are 4 capture calls, 2 System2
calls and 1 behavior abstraction call. The synthetic operation controller never
replaces `organizer.consolidate`.

Agent actions run through `createLibraryActions().execute()`. The OpenChamber
HTTP routes, official OpenCode source reads, provider model quality, packaged
installation and platform GUI behavior are outside these fixtures. The
single-session fixture does not exercise automatic S2; the second fixture
provides that evidence through the real worker and backend.

Argument and failure-output checks run without a backend:

```sh
node --test scripts/hy-memory-smoke.test.mjs
```
