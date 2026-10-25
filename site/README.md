# SuperWagie website

Static marketing site and documentation, in Chinese at `/` and English at `/en/`.
The current public origin is `https://superwagie.quukk.com`.

## Build

```bash
node site/build.mjs
```

Pages are hand-written fragments in `site/src/pages/<lang>/`; `site/build.mjs`
wraps them in the shared navigation, footer, meta tags, sitemap and 404 page and
writes `site/dist/`. No dependencies.

## Preview

```bash
cd site/dist && python3 -m http.server 8899
# http://127.0.0.1:8899/
```

## Search indexing

- Every page carries a unique title and description, canonical, `hreflang`
  (`zh-CN`, `en`, `x-default`), Open Graph and Twitter cards, and a JSON-LD
  graph: Organization everywhere, WebSite and SoftwareApplication on the home
  page, FAQPage on `/faq/`, TechArticle plus BreadcrumbList on docs pages.
- `sitemap.xml` lists all 32 canonical pages. It omits optional `lastmod`
  until actual content modification dates are available; a build date does
  not establish when a page changed. `robots.txt` disallows crawling
  `/downloads/`; it does not guarantee that linked installer URLs stay out
  of search results.
- The canonical origin is `https://superwagie.quukk.com`. Keep canonical,
  hreflang, sitemap, structured data and the GitHub homepage on this origin.
  The homepage uses both brand names, `犇马` and `SuperWagie`, in visible
  content and WebSite metadata. GitHub links back to the official pages.
- Before promoting a domain, check public DNS, HTTPS certificate validation,
  a 200 response and the absence of `noindex` in both response headers and
  HTML. Test the homepage, download page, docs and English pages. A reachable
  site with `X-Robots-Tag: noindex` cannot be indexed.
- Submit `https://superwagie.quukk.com/sitemap.xml` in Google Search Console
  after verifying site ownership. Use URL Inspection for indexing status;
  an empty `site:` search does not prove that Google has never crawled the site.
- The public front (47) terminates TLS and serves static pages directly.
  Its `/downloads/` route proxies to 113. Keep gzip enabled for text assets.

## Deploy

The site is plain files. `site/deploy/nginx-public.conf` records the current
public Nginx configuration for `superwagie.quukk.com`. Its deployed filename is
`/etc/nginx/conf.d/superwagie-preview.conf`; the legacy filename does not make
this host a preview. It is the indexable production site.

Back up the existing configuration before installing a change, then validate
and reload Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx

# deploy from this machine:
DEPLOY_HOST=<server> DEPLOY_USER=<user> DEPLOY_DIR=/var/www/superwagie \
  ./site/deploy/deploy.sh
```

The current public host uses the existing wildcard `*.quukk.com` certificate.
`site/deploy/nginx.conf` is a template for a future self-contained deployment
on `www.superwagie.com`; it is not the current public configuration.

## DNS

The current public name resolves to the public front:

| Name | Type | Value |
| --- | --- | --- |
| `superwagie.quukk.com` | A | `47.108.85.222` |

`www.superwagie.com` is awaiting ICP approval. Leave its existing DNS, server
routing and certificates unchanged until approval is confirmed and the new
public endpoint has passed DNS and HTTPS checks.

## Content

- `src/pages/zh|en/` contains one body-only HTML fragment per page.
- `src/site.css` owns shared styles; `src/site.js` owns the clock, task demo, FAQ and scroll stage.
- `src/assets/` contains the logo, two credited desk photos and Open Graph image.
- `build.mjs` owns the page list, navigation, language switch, canonical, hreflang and sitemap.

## Production layout (current)

- Main server: `113.249.120.24` (private `10.0.0.3`). Static files in
  `/var/www/superwagie`; Nginx site `sites-available/superwagie` listens on
  `8444` with the existing `*.quukk.com` certificate and
  `server_name www.superwagie.com superwagie.com`.
- Public front: `47.108.85.222`. `conf.d/superwagie-preview.conf` serves
  `superwagie.quukk.com` directly from `/var/www/superwagie` with the wildcard
  certificate. Production HTML has no `X-Robots-Tag: noindex` header.
- The public `/downloads/` route proxies to `https://113.249.120.24:8444`
  using the existing upstream host `www.superwagie.com`. Keep that internal
  host-routing contract unchanged when changing the public canonical origin.
- The separate `conf.d/superwagie.conf` configuration for `www.superwagie.com`
  remains unchanged while ICP approval is pending.
- The 113 server does not expose 80/443 publicly. Public TLS terminates on 47.

Deploy:

```bash
node site/build.mjs
# Installers are served from the same host under /downloads/. They are not part
# of site/dist: deploy.sh excludes the directory so --delete keeps them.
rsync -az --delete --exclude downloads/ --exclude 'google*.html' site/dist/ root@113.249.120.24:/var/www/superwagie/

# Upload a release's installers (names are referenced by the download page):
rsync -a SuperWagie-<version>-mac-arm64.dmg SuperWagie-<version>-mac-arm64.zip \
  root@113.249.120.24:/var/www/superwagie/downloads/

# The public site serves its own static files on 47. Sync those pages too.
# Its /downloads/ route proxies to 113, so keep installers on 113 only.
ssh root@113.249.120.24 'tar -C /var/www/superwagie --exclude=./downloads -czf - . | ssh root@47.108.85.222 "tar -xzf - -C /var/www/superwagie"'
```

Before copying files, back up the existing static site on both servers without
the downloads directory. Preserve any search ownership verification files
already deployed on either server; keep them outside deletion or explicitly
exclude their filenames. The example excludes Google HTML verification files
without assuming that one is present. After deployment, read back the Chinese and English
home and download pages from both the origin and public site. Verify the
release version, installer links and download sizes. An origin response does
not establish public-domain availability; check public HTTPS separately.

## Future migration to www.superwagie.com

Wait for actual ICP approval, then verify public DNS, a valid TLS certificate,
page responses and installer downloads on `www.superwagie.com`. An expected
approval date is not sufficient to switch domains.

Once the new host passes those checks, update the builder's canonical origin,
canonical links, sitemap, hreflang, JSON-LD, Open Graph URLs, README links and
the GitHub homepage together. Redirect every old page to the same path on the
new host with HTTP 301 or 308, preserving query strings. Retain those redirects
and submit the new sitemap in the verified Search Console property.

For a self-contained Nginx deployment using `site/deploy/nginx.conf`, issue the
certificate only after DNS and approval are ready:

```bash
sudo certbot --nginx -d www.superwagie.com -d superwagie.com
```
