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

ssh root@113.249.120.24 'cd /var/www && tar czf - superwagie | ssh root@47.108.85.222 "tar xzf - -C /var/www"'
```

After `superwagie.com` points at 47:

```bash
ssh root@113.249.120.24 'ssh root@47.108.85.222 "certbot --nginx -d www.superwagie.com -d superwagie.com"'
```
