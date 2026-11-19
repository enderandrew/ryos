#!/usr/bin/env bash
#
# build-apache.sh — build ryOS as a static site for an Apache web server.
#
# No Docker needed. Requires Bun (https://bun.sh) on the machine that builds;
# the web server itself only needs Apache with mod_rewrite (+ mod_headers
# recommended). Put this file in the repo's scripts/ directory.
#
#   scripts/build-apache.sh                       # build into ./dist
#   scripts/build-apache.sh --deploy /var/www/mac # build, then sync to docroot
#   scripts/build-apache.sh --api-proxy http://127.0.0.1:3000
#                                                 # also proxy /api to the Bun
#                                                 # backend (see notes below)
#
# IMPORTANT: ryOS must live at the ROOT of a hostname (e.g. a subdomain such as
# https://mac.example.com/). It cannot be served from a sub-folder such as
# https://example.com/mac/ — the app hardcodes root-absolute URLs (/icons/...,
# /assets/..., /api/...) in several hundred places.
#
# Modes
#   static (default)  Everything that runs in the browser works: desktop, Finder,
#                     TextEdit, MacPaint, Minesweeper, Synth, Soundboard, Photo
#                     Booth, Terminal, Virtual PC, Infinite Mac, themes, etc.
#                     Features that call the server (/api/*) fail gracefully:
#                     AI chat, accounts/sync, chat rooms, Internet Explorer,
#                     iPod/Karaoke/Videos metadata, lyrics, etc.
#   --api-proxy URL   Apache serves the static files and reverse-proxies /api,
#                     /ws and /app-config.js to the ryOS Bun server, which you
#                     run yourself (`bun run start`, plus Redis and API keys —
#                     see the repo README, "VPS / self-hosting path").
#                     Needs mod_proxy + mod_proxy_http (+ mod_proxy_wstunnel).
#
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  cat <<'EOF'
Options
  --repo DIR          ryOS checkout to build (default: parent of this script,
                      or the current directory)
  --deploy DIR        after building, rsync the result into DIR (the vhost's
                      DocumentRoot). Refuses to touch a non-empty DIR that was
                      not created by this script.
  --api-proxy URL     reverse-proxy /api, /ws, /app-config.js to URL
  --frame-ancestors "ORIGINS"
                      space-separated origins allowed to <iframe> the site, in
                      addition to itself (e.g. "https://example.com")
  --print-vhost HOST [DOCROOT]
                      print an example Apache VirtualHost for HOST and exit
  --print-ieproxy-vhost HOST [BACKEND]
                      print an Apache VirtualHost for the isolated Internet
                      Explorer proxy host (IE_PROXY_ORIGIN) and exit;
                      BACKEND defaults to http://127.0.0.1:3000
  --typecheck         also run the TypeScript typecheck (slower)
  --skip-install      do not run `bun install`
  --no-htaccess       do not write dist/.htaccess
  -h, --help          show this help
EOF
}

REPO=""
DEPLOY=""
API_PROXY=""
FRAME_ANCESTORS=""
TYPECHECK=0
SKIP_INSTALL=0
WRITE_HTACCESS=1
VHOST_HOST=""
VHOST_DOCROOT=""
IEPROXY_HOST=""
IEPROXY_BACKEND="http://127.0.0.1:3000"
MARKER=".ryos-apache-deploy"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a directory}"; shift 2 ;;
    --deploy) DEPLOY="${2:?--deploy needs a directory}"; shift 2 ;;
    --api-proxy) API_PROXY="${2:?--api-proxy needs a URL}"; shift 2 ;;
    --frame-ancestors) FRAME_ANCESTORS="${2:?--frame-ancestors needs a value}"; shift 2 ;;
    --print-vhost)
      VHOST_HOST="${2:?--print-vhost needs a hostname}"; shift 2
      if [[ $# -gt 0 && "$1" != -* ]]; then VHOST_DOCROOT="$1"; shift; fi ;;
    --print-ieproxy-vhost)
      IEPROXY_HOST="${2:?--print-ieproxy-vhost needs a hostname}"; shift 2
      if [[ $# -gt 0 && "$1" != -* ]]; then IEPROXY_BACKEND="${1%/}"; shift; fi ;;
    --typecheck) TYPECHECK=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --no-htaccess) WRITE_HTACCESS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------ example vhost
if [[ -n "$VHOST_HOST" ]]; then
  docroot="${VHOST_DOCROOT:-${DEPLOY:-/var/www/$VHOST_HOST}}"
  cat <<EOF
# Example Apache 2.4 virtual host for ryOS. Save as e.g.
# /etc/apache2/sites-available/$VHOST_HOST.conf, then:
#   a2enmod rewrite headers deflate && a2ensite $VHOST_HOST && systemctl reload apache2
# (add "proxy proxy_http proxy_wstunnel" to a2enmod if you build with --api-proxy)
# For HTTPS, run certbot afterwards or copy this into a :443 block with your
# SSLCertificate* lines. HTTPS is required for the offline service worker,
# Photo Booth (camera) and the emulators.
<VirtualHost *:80>
  ServerName $VHOST_HOST
  DocumentRoot $docroot

  # Most Apache installs globally alias /icons/ to Apache's own directory-
  # listing icons, which hides ryOS's /icons/ folder (every desktop icon 404s).
  # This cannot be fixed from .htaccess; this line takes the path back.
  Alias /icons/ $docroot/icons/

  # Pass the real Host to the Bun backend for the proxied /api, /ws and
  # /app-config.js requests (only matters with --api-proxy).
  ProxyPreserveHost On

  <Directory $docroot>
    AllowOverride All
    Require all granted
  </Directory>
</VirtualHost>
EOF
  exit 0
fi

# ------------------------------------------------- example IE proxy vhost
if [[ -n "$IEPROXY_HOST" ]]; then
  cat <<EOF
# Isolated host for Internet Explorer proxied pages. With it, IE keeps the
# scripts of the sites it shows; without it they are stripped for safety.
#
# 1. DNS: point $IEPROXY_HOST at this server (same A/AAAA or a CNAME).
# 2. Save this as /etc/apache2/sites-available/$IEPROXY_HOST.conf, then:
#      a2enmod proxy proxy_http headers && a2ensite $IEPROXY_HOST
#      systemctl reload apache2 && certbot --apache -d $IEPROXY_HOST
# 3. Add to /etc/ryos/ryos.env and restart:
#      IE_PROXY_ORIGIN=https://$IEPROXY_HOST
#      systemctl restart ryos-api
#
# The Bun server itself limits this host to /api/iframe-check, /health and
# /fonts/, and the ryOS login cookie is never sent here (it is host-only).
<VirtualHost *:80>
  ServerName $IEPROXY_HOST

  # REQUIRED: the server recognizes the proxy host by its Host header.
  # Without this it sees 127.0.0.1, treats the request as the main site,
  # and redirects back to $IEPROXY_HOST forever.
  ProxyPreserveHost On
  RequestHeader set X-Forwarded-Proto "https" env=HTTPS

  ProxyPass        / $IEPROXY_BACKEND/
  ProxyPassReverse / $IEPROXY_BACKEND/
</VirtualHost>
EOF
  exit 0
fi

check_deploy_target() {
  if [[ -d "$DEPLOY" && -n "$(ls -A "$DEPLOY" 2>/dev/null)" && ! -f "$DEPLOY/$MARKER" ]]; then
    die "$DEPLOY is not empty and was not created by this script; refusing to
       overwrite it. Point --deploy at an empty directory used only for ryOS."
  fi
}
[[ -z "$DEPLOY" ]] || check_deploy_target

# ---------------------------------------------------------------- locate repo
if [[ -z "$REPO" ]]; then
  script_parent="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ -f "$script_parent/vite.config.ts" ]]; then
    REPO="$script_parent"
  else
    REPO="$PWD"
  fi
fi
REPO="$(cd "$REPO" && pwd)"
[[ -f "$REPO/vite.config.ts" && -f "$REPO/package.json" ]] \
  || die "$REPO does not look like a ryOS checkout (use --repo DIR)"

if [[ -n "$API_PROXY" ]]; then
  API_PROXY="${API_PROXY%/}"
  [[ "$API_PROXY" =~ ^https?://[A-Za-z0-9._:-]+$ ]] \
    || die "--api-proxy must look like http://127.0.0.1:3000 (no path)"
fi
if [[ -n "$FRAME_ANCESTORS" && ! "$FRAME_ANCESTORS" =~ ^[A-Za-z0-9\ ./:*-]+$ ]]; then
  die "--frame-ancestors may only contain origins separated by spaces"
fi

command -v bun >/dev/null 2>&1 \
  || die "Bun is not installed. Install it with:  curl -fsSL https://bun.sh/install | bash"

cd "$REPO"
wanted_bun="$(sed -n 's/^bun *= *"\(.*\)"/\1/p' .mise.toml 2>/dev/null || true)"
have_bun="$(bun --version)"
if [[ -n "$wanted_bun" && "$wanted_bun" != "$have_bun" ]]; then
  echo "note: repo pins Bun $wanted_bun, you have $have_bun (usually fine; \`bun upgrade\` if the build misbehaves)"
fi

# -------------------------------------------------------------------- install
if [[ $SKIP_INSTALL -eq 0 ]]; then
  say "Installing dependencies"
  if ! bun install --frozen-lockfile; then
    cat >&2 <<'EOF'

`bun install` failed. If the error mentions castlabs/electron-releases, that is
the Electron desktop-app dependency being fetched from the GitHub API (it is not
needed for the web build). It usually means GitHub rate-limited you: wait a bit,
or export GITHUB_TOKEN=<a personal access token> and re-run.
EOF
    exit 1
  fi
fi

# ---------------------------------------------------------------------- build
say "Generating version + i18n shell"
bun run prebuild

if [[ $TYPECHECK -eq 1 ]]; then
  say "Typechecking"
  bun run typecheck
fi

say "Bundling with Vite"
NODE_ENV=production NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" \
  bun run build:vite

DIST="$REPO/dist"
[[ -f "$DIST/index.html" ]] || die "build finished but $DIST/index.html is missing"

# ------------------------------------------------------------------ .htaccess
if [[ $WRITE_HTACCESS -eq 1 ]]; then
  say "Writing $DIST/.htaccess"

  if [[ -n "$API_PROXY" ]]; then
    ws_target="${API_PROXY/#http/ws}"
    api_rules="$(cat <<EOF
  # --- Backend: reverse-proxy to the ryOS Bun server ($API_PROXY)
  RewriteCond %{HTTP:Upgrade} =websocket [NC]
  RewriteRule ^ws(/.*)?\$ ${ws_target}/ws\$1 [P,L]
  RewriteRule ^(api(/.*)?|app-config\\.js)\$ ${API_PROXY}/\$1 [P,L]
EOF
)"
  else
    api_rules="$(cat <<'EOF'
  # --- No backend in this build: answer API calls with a plain 404 instead
  #     of handing them the HTML app shell.
  RewriteRule ^(api|ws)(/|$) - [R=404,L]
EOF
)"
  fi

  cat > "$DIST/.htaccess" <<EOF
# Generated by scripts/build-apache.sh — edits here are overwritten on rebuild.
# Requires: AllowOverride All (or at least FileInfo Indexes Options) for this
# directory, and mod_rewrite. mod_headers / mod_deflate / mod_mime are used
# when present.

Options -Indexes -MultiViews
DirectoryIndex index.html
ErrorDocument 404 /404.html

<Files "${MARKER}">
  Require all denied
</Files>

<IfModule mod_mime.c>
  AddType application/wasm .wasm
  AddType application/epub+zip .epub
  AddType text/markdown .md
  AddType font/woff2 .woff2
  AddType font/otf .otf
  AddType audio/mp4 .m4a
  AddType image/webp .webp
  AddDefaultCharset utf-8
</IfModule>

<IfModule mod_rewrite.c>
  RewriteEngine On

  # --- Routes the upstream server deliberately removes
  RewriteRule ^(embed/)?infinite-pc/?\$ - [R=404,L]

  # --- Short links
  RewriteRule ^docs/?\$ /docs/overview [R=302,L]
  RewriteRule ^privacy/?\$ /docs/privacy [R=302,L]
  RewriteRule ^terms/?\$ /docs/terms [R=302,L]

${api_rules}

  # --- Emulator wrappers: /embed/pc -> embed/pc.html (headers added below)
  RewriteRule ^embed/(infinite-mac|pc)\$ embed/\$1.html [L]

  # --- Docs clean URLs: /docs/finder -> docs/finder.html
  RewriteCond %{DOCUMENT_ROOT}/docs/\$1.html -f
  RewriteRule ^docs/([^.]+)\$ docs/\$1.html [L]

  # --- Real files are served as-is
  RewriteCond %{REQUEST_FILENAME} -f
  RewriteRule ^ - [L]

  # --- A real sub-folder with its own index.html (a separate game or site you
  #     dropped into the docroot) is served by DirectoryIndex, not swallowed
  #     by the SPA fallback below.
  RewriteCond %{REQUEST_FILENAME} -d
  RewriteCond %{REQUEST_FILENAME}/index.html -f
  RewriteRule ^ - [L]

  # --- Single-page-app fallback: any URL whose last segment has no dot
  #     (/finder, /ipod/abc, /terminal ...) boots the desktop.
  RewriteRule (^|/)[^./]*\$ index.html [L]
</IfModule>

<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Content-Security-Policy "frame-ancestors 'self'${FRAME_ANCESTORS:+ $FRAME_ANCESTORS}"

  # Default: cache, but revalidate every time.
  Header set Cache-Control "public, max-age=0, must-revalidate"

  # Content-hashed bundles and assets that never change in place.
  <If "%{REQUEST_URI} =~ m#^/(assets/[^/]+-[A-Za-z0-9_-]{8}\\.[a-z0-9]+|workbox-[a-f0-9]{8}\\.js|apple-touch-icon\\.png|favicon\\.ico)\$#">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </If>
  <If "%{REQUEST_URI} =~ m#^/(wallpapers/(tiles|photos|thumbs|videos)|icons/(default|macosx|system7|win98|xp)|sounds|patterns|assets/games/jsdos)/#">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </If>
  <If "%{REQUEST_URI} =~ m#^/fonts/#">
    Header set Cache-Control "public, max-age=31536000, immutable"
    Header set Access-Control-Allow-Origin "*"
  </If>
  <If "%{REQUEST_URI} == '/wallpapers/placeholders.json'">
    Header set Cache-Control "public, max-age=86400, stale-while-revalidate=604800"
  </If>

  # The app shell, service worker and manifests must never be served stale,
  # or a new deploy keeps pointing browsers at bundles that no longer exist.
  <If "%{REQUEST_URI} =~ m#^/(index\\.html|404\\.html|sw\\.js|registerSW\\.js|manifest\\.json|version\\.json|theme-bootstrap-config\\.js|app-config\\.js|(icons|wallpapers)/manifest\\.json|data/.*)\$#">
    Header set Cache-Control "no-cache, no-store, must-revalidate"
  </If>

  # Virtual PC / Infinite Mac need cross-origin isolation (SharedArrayBuffer).
  <If "%{REQUEST_URI} =~ m#^/embed/(infinite-mac|pc)(\\.html)?\$#">
    Header set Cross-Origin-Embedder-Policy "credentialless"
    Header set Cross-Origin-Opener-Policy "same-origin"
  </If>
</IfModule>

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/plain text/markdown
  AddOutputFilterByType DEFLATE application/javascript text/javascript application/json
  AddOutputFilterByType DEFLATE image/svg+xml application/wasm application/manifest+json
</IfModule>
EOF
fi

# --------------------------------------------------------------------- deploy
if [[ -n "$DEPLOY" ]]; then
  check_deploy_target
  say "Deploying to $DEPLOY"
  mkdir -p "$DEPLOY"
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$DIST/$MARKER"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$DIST"/ "$DEPLOY"/
  else
    find "$DEPLOY" -mindepth 1 -delete
    cp -a "$DIST"/. "$DEPLOY"/
  fi
  rm -f "$DIST/$MARKER"
fi

say "Done"
echo "Static site:  $DIST  ($(du -sh "$DIST" | cut -f1))"
if [[ -n "$DEPLOY" ]]; then
  echo "Deployed to:  $DEPLOY"
else
  echo "Upload the CONTENTS of that folder (including .htaccess) to the"
  echo "DocumentRoot of the hostname that will serve ryOS."
fi
echo "Apache setup: $0 --print-vhost your.host.name   (note the /icons/ Alias)"
if [[ -n "$API_PROXY" ]]; then
  echo "Backend:      /api, /ws and /app-config.js proxy to $API_PROXY"
  echo "              (start it in the repo with: APP_PUBLIC_ORIGIN=https://your-host bun run start)"
else
  echo "Backend:      none (static-only). Server-backed features will be unavailable."
fi
