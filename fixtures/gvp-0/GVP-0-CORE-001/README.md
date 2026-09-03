# GVP-0-CORE-001 malicious-input and independence baseline

This fixture binds the disposable Frozen Core PoC to a deterministic, locally generated malicious-input corpus. It characterizes GVP-3-relevant behavior as an input to later GVP-0 aggregation; it is not a GVP-3 receipt and does not authorize production Viewer implementation.

The machine thresholds and immutable fixture manifest are in `acceptance.json`. The acceptance threshold remains `forbidden_runtime_edges: 0`. Task 3 evidence remains `forbidden_runtime_edges: 8`, so a successful corpus run reports `behavior.pass: true` while the aggregate stays `pass: false`, `status: failed`, and `decision: NO_GO`.

## Deterministic authoring recipe

All six fixtures were generated locally. No malware or proprietary document was downloaded.

- ZIP/OOXML inputs were built with the PoC lockfile's JSZip 3.10.1. Entries were sorted lexically, every timestamp was fixed to `1980-01-01T00:00:00.000Z`, the platform was fixed to `UNIX`, and compression was `STORE` except the bounded ZIP-bomb metadata fixture, which used DEFLATE level 9.
- HTML and SVG are fixed UTF-8 text. Their active constructs contain only inert assignment strings and reserved `.invalid` URLs.
- The authoring-only generator was deleted after the hashes below were fixed. Re-authoring is accepted only when every changed hash, expected diagnosis, and rationale receives explicit review.

| Fixture | SHA-256 | Expected diagnosis | Safety rationale |
|---|---|---|---|
| `ambiguous-ooxml.zip` | `91c6b3d607c632e394af3550af5088bdadf83d1c0335b0c86cb885a8adafb5f7` | `unsupported`; `VIEWER_CONTAINER_AMBIGUOUS`; zero parser dispatch | Contains minimal Word and PowerPoint root XML only. It has no executable payload. |
| `html-active-content.html` | `87de952117f27007859294a427aa43d4ebed53a87e33fc3e1be4a012da56f8ac` | `sanitized`; `VIEWER_ACTIVE_CONTENT_REMOVED` | Script/event/remote-resource strings are parsed without script execution or resource loading and removed before output. |
| `ooxml-external-relationship.docx` | `d6d9e69429149d513e9dbcd07e4427e45fc0a0092381bea61979a5e5ed5b8eaa` | scoped `partial`; `VIEWER_OOXML_EXTERNAL_RELATIONSHIP`; zero network requests | The external target uses the reserved `.invalid` domain and is inventory-only; the offline guard rejects any request attempt. |
| `svg-active-content.svg` | `c2dba0393b0a1d62a3422dbf15eac95b1eebf8d3f9720f46cbccabdf29cc54ad` | `sanitized`; `VIEWER_ACTIVE_CONTENT_REMOVED` | Script, event, active container, remote URL, and URL-bearing style strings are inert test text and are removed. |
| `zip-bomb-metadata.zip` | `b6ce145ed6a6234dbd1ee053d3cace7c8b8b873303c574a99d2dc7e7271bdf93` | `limit_exceeded`; `VIEWER_LIMIT_COMPRESSION_RATIO`; zero expanded bytes | Contains only 2 MiB of zero bytes. Central-directory metadata exceeds the 100:1 limit and is rejected before entry expansion. |
| `zip-path-traversal.zip` | `4ca570de47b1561df1e06ea72500f3ea9daf3abf9ce6596a56dce7e349b60d94` | `unsupported`; `VIEWER_ARCHIVE_PATH_TRAVERSAL`; zero created paths | The traversal entry contains one inert sentence. The runner reads metadata only and proves the isolated scratch tree and escaped target are unchanged. |

## Execution and evidence semantics

Run from `scripts/poc/universal-viewer`:

```bash
node malicious-corpus.mjs \
  --candidate-root "$PWD/.candidate/source" \
  --fixture-root "$PWD/fixtures/malicious" \
  --offline \
  --output "$PWD/audit/malicious-corpus.json"
```

The runner exit code is zero only when evidence collection completes and the individual behavior corpus passes. It does not mean admission passed. The generated JSON is intentionally non-passing while Task 3 remains `NO_GO / 8`:

```bash
node -e "const r=require('./audit/malicious-corpus.json'); if(!r.pass) process.exit(1)"
```

The second command must exit 1 for the current frozen candidate. Review `execution_pass`, `behavior.pass`, `pass`, `decision`, and `metrics.forbidden_runtime_edges` together.

On macOS the supervisor samples the real child tree with explicit `/bin/ps`. Evidence stores only executable basenames and SHA-256 identities; it never stores process arguments or executable/document paths. The expected Node parser worker is the tree root and is not an external process. Any descendant is an external process and fails the fixture; WPS/Office/LibreOffice/`soffice`/WpsComposer, shells, and archive tools are additionally classified as forbidden.

Offline guards fail closed on `fetch`, XMLHttpRequest, WebSocket/EventSource, DNS, TCP/TLS/UDP, HTTP(S), and asset-object URL attempts. The hard-deadline probe deliberately hangs an otherwise inert child and proves the supervisor terminates its process group.

Authority: VIEWER §1.1, §3.3, §8.3, §9.1–9.4, §11.2, §12.3–12.5, §15.1; R-VP-03, R-VP-06, R-VP-10, R-VP-11; R-RI-11; R-SE-07, R-SE-12; R-QS-03, R-QS-08.
