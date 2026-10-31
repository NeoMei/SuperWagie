# SuperWagie website

Static marketing site and documentation, in Chinese at `/` and English at `/en/`.
The source and production canonical origin is `https://www.superwagie.com`.
The HTTPS site and GitHub homepage use this origin. The old host,
`https://superwagie.quukk.com`, remains available with HTTP 200 as a compatibility
entry point; its pages also identify the www origin as canonical.

The website's default release is 2.7.43 for macOS Apple silicon and Windows x64.
The download page also lists the explicitly requested 2.7.40-intel local Mac
compatibility build and the 2.7.34 Windows ARM64 compatibility build. Optional
architectures are built and published only on explicit request; a routine
release does not advance them. The Apple silicon build uses ad-hoc signing;
the Intel and Windows installers are unsigned. The macOS builds have no Apple
notarization. Installer sizes are updated from the verified final artifacts
before deployment.

Conversation learning is opt-in. Once enabled, completed OpenCode turns are
distilled in the background and indexed for project retrieval. Existing session
history requires explicit processing. Methodology candidates require confirmation.

Installer links point to their versioned GitHub Release assets. Each optional
build has its own version and validation limits, and requires manual updates.
The Intel local package targets macOS 12 Monterey with Electron 43.8.4. It runs
OpenCode, the knowledge library, memory, terminals and speech on this Mac, and
keeps project files locally. Model calls use the services configured by the user.
Its OpenCode service bundle uses the application's Node 24 runtime and provides the HTTP APIs
used by SuperWagie. The standalone terminal interface and service-management CLI
are outside this compatibility package. The previous 2.7.39-intel release is a
separate remote-client package; the download page now selects the local package.

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
   Keep installers and ownership verification files intact.
2. Build and validate the site, deploy its static files, and preserve
   `/downloads/` and all ownership verification files. Install
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
# Installers and Google verification files are managed separately.
rsync -az --delete --exclude downloads/ --exclude 'google*.html' site/dist/ root@113.249.120.24:/var/www/superwagie/

# Public pages live on 47; downloads remain on 113.
ssh root@113.249.120.24 'tar -C /var/www/superwagie --exclude=./downloads --exclude=./google\*.html -czf - . | ssh root@47.108.85.222 "tar -xzf - -C /var/www/superwagie"'
```

`site/deploy/deploy.sh` also excludes `downloads/` and `google*.html` from
rsync deletion. Preserve any other existing ownership verification files by
excluding their exact filenames. No verification token is stored in source.
