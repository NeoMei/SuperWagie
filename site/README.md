# superwagie.com

Static marketing site and documentation, in Chinese at `/` and English at `/en/`.

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
  graph: Organization and WebSite everywhere, SoftwareApplication on the home
  page, FAQPage on `/faq/`, TechArticle plus BreadcrumbList on docs pages.
- `sitemap.xml` lists all 32 pages with `lastmod`; `robots.txt` keeps
  `/downloads/` out of the index.
- `nginx` must send gzip for text assets. The public front (47) terminates TLS
  and proxies to 113, so it compresses: `gzip on` with `gzip_types`, and
  `proxy_set_header Accept-Encoding ""` on the proxy location so the response
  is compressed once rather than twice.

## Deploy

The site is plain files; any static server works. For Nginx:

```bash
# first time: copy site/deploy/nginx.conf into /etc/nginx/sites-available/superwagie
# and link it into sites-enabled, then:
sudo nginx -t && sudo systemctl reload nginx

# deploy from this machine:
DEPLOY_HOST=<server> DEPLOY_USER=<user> DEPLOY_DIR=/var/www/superwagie \
  ./site/deploy/deploy.sh
```

TLS:

```bash
sudo certbot --nginx -d www.superwagie.com -d superwagie.com
```

## DNS

Point both names at the server:

| Name | Type | Value |
| --- | --- | --- |
| `www.superwagie.com` | A | server IPv4 |
| `superwagie.com` | A | server IPv4 |

If the DNS provider supports CNAME at the apex, `superwagie.com` may be a CNAME
to `www.superwagie.com` instead. With Cloudflare, keep the proxy off until
certbot has issued the certificate, then enable it with Full (strict).

## Content

- `src/pages/zh|en/` — one HTML fragment per page, the body only.
- `src/site.css` — shared design system; `src/site.js` — clock, task demo, FAQ, scroll stage.
- `src/assets/` — logo, two credited desk photos, Open Graph image.
- `build.mjs` — page list, navigation, language switch, canonical/hreflang, sitemap.

## Production layout (current)

- Main server: `113.249.120.24` (private `10.0.0.3`). Static files in
  `/var/www/superwagie`; Nginx site `sites-available/superwagie` listens on
  `8444` with the existing `*.quukk.com` certificate and
  `server_name www.superwagie.com superwagie.com`.
- Public front: `47.108.85.222`. `conf.d/superwagie.conf` proxies
  `www.superwagie.com` to `https://113.249.120.24:8444`.
- Temporary preview: `conf.d/superwagie-preview.conf` serves
  `superwagie.quukk.com` directly from `/var/www/superwagie` on 47 (wildcard
  certificate, `X-Robots-Tag: noindex`).
- The 113 server does not expose 80/443 publicly; the 47 front terminates
  public TLS for `superwagie.com` and reuses the forwarded `8444` port.

Deploy:

```bash
node site/build.mjs
# Installers are served from the same host under /downloads/. They are not part
# of site/dist: deploy.sh excludes the directory so --delete keeps them.
rsync -az --delete --exclude downloads/ site/dist/ root@113.249.120.24:/var/www/superwagie/

# Upload a release's installers (names are referenced by the download page):
rsync -a SuperWagie-<version>-mac-arm64.dmg SuperWagie-<version>-mac-arm64.zip \
  root@113.249.120.24:/var/www/superwagie/downloads/

# The public preview serves its own static files on 47. Sync those pages too.
# Its /downloads/ route proxies to 113, so keep installers on 113 only.
ssh root@113.249.120.24 'tar -C /var/www/superwagie --exclude=./downloads -czf - . | ssh root@47.108.85.222 "tar -xzf - -C /var/www/superwagie"'
```

Before copying files, back up the existing static site on both servers without
the downloads directory. After deployment, read back the Chinese and English
home and download pages from both the origin and public preview. Verify the
release version, installer links and download sizes. An origin response does
not establish public-domain availability; check public HTTPS separately.

After `superwagie.com` points at 47:

```bash
ssh root@113.249.120.24 'ssh root@47.108.85.222 "certbot --nginx -d www.superwagie.com -d superwagie.com"'
```
