# SuperWagie website

Static marketing site and documentation, in Chinese at `/` and English at `/en/`.
The source and production canonical origin is `https://www.superwagie.com`.
The HTTPS site and GitHub homepage use this origin. The old host,
`https://superwagie.quukk.com`, remains available with HTTP 200 as a compatibility
entry point; its pages also identify the www origin as canonical.

The website's only published release is 2.7.72 for macOS Apple silicon and
Windows x64. Optional architectures are not part of the unified release. The
Apple silicon build requires macOS 13 or later. Its complete app bundle uses
ad-hoc signing and has no Apple notarization; the
Windows installer is unsigned. Installer sizes are updated from the verified
final artifacts before deployment.

The bundled OpenCode runs in SuperWagie's private application space. Its model
settings, credentials and runtime data are separate from a system OpenCode
installation. When no model is configured, the app selects an available free
OpenCode model. Explicit model choices are preserved. Free models remain subject
to provider limits and availability.

After a SuperWagie Key subscription, setup selects compatible models from the
key's available catalog. It retains an existing model when that model is still
available and supports the required purpose. Each supported function is tested
with the same key before its connection is applied. Tests appear as they start,
with up to three running together. A missing compatible model has an explicit
unavailable result. Models without native prices remain unavailable.

Version 2.7.72 corrects automatic model selection for unconfigured profiles and
shows readable model setup, connection and free-usage-limit messages in the
current UI language. The avatar opens the vertical account panel for wallet,
subscription, API keys and profile. Settings no longer has a duplicate account
entry. Low-balance notices still open the account panel's funding form.

Existing account keys can finish configuration when the private engine has the
intended model list but lacks its credential. Historical sessions in the system
OpenCode database are not imported.

Account Key setup also supports Qwen speech synthesis through the catalog.
Speech playback and video narration reuse the saved encrypted credential.
Model connectivity and configuration application have separate results. If all
model calls pass but an existing index prevents an embedding change, setup stays
pending and the original connection and index remain. Migration completion is
not implied, and no automatic index rebuild is performed.

Conversation learning is opt-in. Once enabled, completed OpenCode turns are
distilled in the background and indexed for project retrieval. Existing session
history requires explicit processing. Methodology candidates require confirmation.

Installer links point to the v2.7.72 GitHub Release assets. The unified release
ships Apple silicon Mac and Windows x64 only; other architectures stay out of the
public download page until a separately validated release is requested.

The Intel validation workflow runs on a native Intel host with a newer macOS.
A successful run establishes behavior on that host only. macOS 12 hardware
acceptance remains pending. Installer publication requires validation of the
frozen build and the extracted DMG and ZIP payloads.

The Windows ARM64 app uses a separate x64 knowledge process and the standard
x86 installer helper. Native Windows ARM installation and runtime acceptance
remain pending. Existing files on the official download host are retained.

Public HTTPS works with TLS 1.3. Earlier checks found HTTP 403 from Beaver and
a disconnected TLS 1.2 handshake on the new domain. Alibaba Cloud is processing
removal of that block. Retain the old host until public HTTP and TLS 1.2 checks
pass; the HTTPS migration does not establish that every transport works.

## Build and preview

```bash
node site/build.mjs
cd site/dist && python3 -m http.server 8899
# http://127.0.0.1:8899/
```

Pages are hand-written body fragments in `site/src/pages/<lang>/`.
`site/build.mjs` adds navigation, metadata, the sitemap and a 404 page, then
writes `site/dist/`. It has no dependencies. `site/src/site.css` and
`site/src/site.js` own shared styling and interactions; `site/src/assets/`
contains the logo, credited photos and Open Graph image.

The homepage and primary download action use `site/src/download-platform.mjs`.
Mac browsers go to the Mac architecture choices on the download page because
the platform name does not identify Apple silicon or Intel. On Windows it requests
`architecture` and `bitness` through User-Agent Client Hints. Only a 64-bit `x86`
result selects the Windows x64 installer. A 64-bit ARM result selects the
Windows ARM64 compatibility section, where the separate version and validation
limits are visible. Missing, rejected, unknown or 32-bit hints keep the general
Windows download-page anchor. User-agent strings cannot choose
a Windows architecture. Mobile and unrecognized platforms keep the
download-page fallback. The explicit Windows x64 link is never rewritten.
Detection runs locally without storing or sending the hints.

The architecture mapping follows [Microsoft's documentation](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/how-to-detect-win11).
[MDN documents unavailable or withheld high-entropy values](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues). Run the focused regression test with
`node --test site/test/download-platform.test.mjs`.

## Product help content

Help content has its own publication, separate from installers. The author
source is `packages/web/server/lib/product-help/content.json` and must use schema 2. Edit articles by
their stable `id`, keeping both `en` and `zh-CN` titles and text. Each release
contains the cumulative edits and additions. Increment `revision` and change
`catalogVersion` for every content release. Keep `minAppVersion` at `2.7.59`
while instructions remain compatible with that backend. Optional `maxAppVersion`
includes its endpoint. Backends outside the declared range keep their valid help.
A remote connection uses its server's version and content source.

The publisher produces two public channels from the same author snapshot:

| Public path | Readers and content |
| --- | --- |
| `https://www.superwagie.com/product-help/v1/catalog.json` | Existing schema 1 backends, including previously shipped 2.7.59. Contains text and keywords with every `target` removed. |
| `https://www.superwagie.com/product-help/v2/catalog.json` | Backends with schema 2 support. Contains the same text plus each optional registered navigation `target`. |

Schema 2 can assign an installed target to a new help article without an app
update. Omitting `target` from a schema 2 article leaves it without location or
guide buttons. The registered identifiers live in
`packages/web/server/lib/product-help/navigation-targets.js`; runtime code owns
their destinations and availability. Content cannot provide scripts, selectors,
URLs or execute actions. A new target identifier, navigation behavior or
executable operation still requires an application update. Schema 1 readers
retain their shipped article-to-target mappings; new articles remain readable
as text. Both channels keep the same content revision and compatibility range.

Clients need an application/backend that already supports the content feed.
Compatible text changes then require no app version change, app build or new
installer. Version 2.7.59 alone does not indicate schema 2 support; older
installations keep their schema 1 source until their backend is upgraded.

The visible, focused assistant checks on open, return to the foreground and
every five minutes. Its successful article snapshot is also cached for five
minutes. The active backend checks its public source at most once every five
minutes; ordinary answers use the current snapshot without starting a download.
These are check intervals, so publication does not guarantee every client
receives it within five minutes. Hidden/background panels stop their timers.
Failed or incompatible downloads keep valid cached help or the bundled baseline.
`OPENCHAMBER_PRODUCT_HELP_UPDATES=0` disables public checks. Runtime source
overrides remain HTTPS-only through `OPENCHAMBER_PRODUCT_HELP_URL`.

The UI has no normal-state force-refresh control. Retry appears on article-load
failure. Closing and reopening within the cache period can reuse its snapshot;
an application reload resets the UI cache but does not bypass the backend's
source/cache policy. Existing answers and a guide already in progress retain
their clicked text. A newer catalogue is used for subsequent article browsing
and answers. Content version and last-success time are internal state, not a
visible confirmation that the official source was refreshed.

Validate and prepare the file from the repository root:

```bash
node scripts/product-help-content.mjs --check
node scripts/product-help-content.mjs --output tmp/product-help-content
# Equivalent package scripts: bun run help:check; bun run help:build
```

The full validator checks the schema, duplicate IDs, text and byte limits, and
compatibility with the current application version before writing either
`tmp/product-help-content/v1/catalog.json` or
`tmp/product-help-content/v2/catalog.json`. Author inputs using schema 1 or an
unknown schema are rejected before either output changes. Schema 1 is an output
compatibility format; runtime acceptance of older feeds is a separate contract.
Review both projections before publishing. The website
builder previews the same formats under `site/dist/product-help/v1/` and
`site/dist/product-help/v2/`. Its shared projection helper checks the basic
article-list shape, supported schema and registered targets without dependencies,
and copies only public fields into each format. It does not replace full author
validation; the dedicated generator and publisher run the strict runtime parser
before any output write or transfer, rejecting unknown fields and invalid data.
Full website deployment preserves the independently published `product-help/`
directory and recovery files. Use the dedicated publisher for content releases.

Publish only the help file with the existing website deployment variables:

```bash
DEPLOY_HOST=your-server DEPLOY_USER=your-user DEPLOY_DIR=/var/www/superwagie \
  bash site/deploy/product-help.sh
```

`DEPLOY_PORT` defaults to `22`. `DEPLOY_DIR` is the website root. The script
validates the current author source again, prepares a temporary local copy,
and sends a tar containing only `v1/catalog.json` and `v2/catalog.json` over one
SSH connection. Both hosts need `tar`; the remote host also needs a POSIX shell
and `sha256sum`. A shared `product-help/.publish-lock` covers both channels.
Both uploaded SHA-256 values must match before either public file changes.
Each channel then atomically replaces its own `catalog.json`, retaining the
previous distinct version as `catalog.previous.json` in that channel. Repeating
the same publication leaves its backup unchanged. The script neither rebuilds
the website nor reloads Nginx.

The two replacements are independent. A second-channel filesystem failure can
leave v1 published while v2 retains its last valid file. The error lists the
completed channels; retry both from the same author snapshot. V1's repeated
publication is harmless and preserves its previous distinct version. If saving
a previous file fails after a successful replacement, or the process receives
a termination signal between those renames, cleanup retains the staged backup
and prints its recovery path. An uncatchable kill can also leave the shared lock
and staging directory; inspect them before clearing the lock.

Run it once for each static website server when keeping the public front and
origin synchronized. A failed second upload leaves the first server updated;
retry the failed host with the same source. Read back both official HTTPS URLs
and compare each with its matching prepared artifact before reporting
publication as verified. Successful SSH output verifies only that host's file
replacements. For example:

```bash
curl -fsS https://www.superwagie.com/product-help/v1/catalog.json -o tmp/product-help-content/v1.published.json
curl -fsS https://www.superwagie.com/product-help/v2/catalog.json -o tmp/product-help-content/v2.published.json
cmp tmp/product-help-content/v1/catalog.json tmp/product-help-content/v1.published.json
cmp tmp/product-help-content/v2/catalog.json tmp/product-help-content/v2.published.json
```

For a content correction or rollback, restore the desired article text in the
author source and publish with a new, higher revision. Clients that cached a
newer revision do not accept an older one. The server backup remains available
for immediate file recovery. Concurrent publication is refused by a
`product-help/.publish-lock` directory. If a killed remote process leaves
that directory behind, confirm no publication is running before removing it
and retrying.

## Search indexing

- The builder targets `https://www.superwagie.com` for canonical links,
  hreflang, sitemap, Open Graph URLs and JSON-LD. The homepage identifies
  both `犇马` and `SuperWagie` in visible content and WebSite metadata.
- Every page has a title, description, canonical, hreflang for `zh-CN`,
  `en` and `x-default`, Open Graph metadata and a Twitter card. JSON-LD
  describes the organization, website, application, FAQs and documentation.
- `sitemap.xml` lists 32 canonical pages. Optional `lastmod` is omitted until
  actual content modification dates are available. `robots.txt` disallows
  crawling `/downloads/`; this does not guarantee that linked installers
  stay out of search results.
- The GitHub homepage points to the www origin. Submit
  `https://www.superwagie.com/sitemap.xml` in the verified Search Console
  property and use URL Inspection to check indexing status. An empty `site:`
  search does not prove that Google has never crawled the site.

## Servers and routing

The public front is `47.108.85.222`. The origin is `113.249.120.24`, with
private address `10.0.0.3`. Both hold static files in `/var/www/superwagie`.
The origin listens on HTTPS port `8444` with the existing `*.quukk.com`
certificate and host routing for `www.superwagie.com` and `superwagie.com`.

`site/deploy/nginx-public.conf` is the production configuration for 47:

- Serve `www.superwagie.com` directly from `/var/www/superwagie` with its valid
  public certificate. Keep gzip enabled for text assets.
- Proxy `/downloads/` to `https://113.249.120.24:8444/downloads/`, preserving
  the upstream Host and SNI name `www.superwagie.com`. The macOS and Windows
  2.7.10 installers already exist on 113. Do not copy them to 47.
- Redirect `superwagie.com` to the same path on `https://www.superwagie.com`
  with HTTP 301, preserving query strings.
- Serve `superwagie.quukk.com` with HTTP 200 and its existing wildcard
  certificate while the new domain's HTTP and TLS 1.2 restrictions remain.
  Both hosts use the same static files and download proxy.
- Keep existing Google HTML ownership verification files reachable with
  HTTP 200 on the old host so its Search Console ownership remains valid.

Install this configuration as `/etc/nginx/conf.d/superwagie.conf` and move the
old `/etc/nginx/conf.d/superwagie-preview.conf` outside the loaded configuration
directory. The new file contains both hosts; loading the old preview file too
would duplicate host blocks. The route does not use the existing cross-site
proxy on port `8484`. `site/deploy/nginx.conf` is a separate self-contained
deployment template, not the configuration for this two-server deployment.

## Deployment and compatibility checks

1. Back up existing vhost configurations and static directories on both servers.
   Keep installers, independently published `product-help/` content and ownership verification files intact.
2. Build and validate the site, deploy its static files, and preserve
   `/downloads/`, `/product-help/` and all ownership verification files. Install
   `nginx-public.conf` as described above, run `nginx -t`, and reload only after
   configuration validation succeeds.
3. Read back the new HTTPS site's Chinese and English homepages, docs, download
   pages, robots and sitemap. Verify its certificate, canonical metadata and
   absence of `noindex`. Check installer responses and sizes. Recheck the old
   HTTPS host's HTTP 200 pages and Google verification files, plus the apex
   redirect's paths and query strings. If activation fails, restore the saved
   files and configuration and reload the validated previous configuration.
4. Keep GitHub and the submitted sitemap on the www HTTPS origin. Record public
   HTTP and TLS 1.2 results separately from successful TLS 1.3 checks.

After Alibaba Cloud removes the public restrictions, verify HTTP and both TLS
1.2 and TLS 1.3 on the new domain, including installer downloads. Only then
replace the old host's compatibility pages with same-path HTTP 301 redirects to
www, preserving query strings. Keep `google*.html` as HTTP 200 exceptions so
old-property ownership verification survives the redirect.

Static file transfer:

```bash
node site/build.mjs
# Installers, product-help content and Google verification files are managed separately.
rsync -az --delete --exclude downloads/ --exclude product-help/ --exclude 'google*.html' site/dist/ root@113.249.120.24:/var/www/superwagie/

# Public pages live on 47; downloads remain on 113.
ssh root@113.249.120.24 'tar -C /var/www/superwagie --exclude=./downloads --exclude=./product-help --exclude=./google\*.html -czf - . | ssh root@47.108.85.222 "tar -xzf - -C /var/www/superwagie"'
```

`site/deploy/deploy.sh` also excludes `downloads/`, `product-help/` and `google*.html` from
rsync deletion. Preserve these paths in site-only backups and rollbacks as well.
Preserve any other existing ownership verification files by
excluding their exact filenames. No verification token is stored in source.
