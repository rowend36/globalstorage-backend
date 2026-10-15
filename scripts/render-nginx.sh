#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TARGET=${1:-all}
MODE=${2:-tls}
source "$ROOT_DIR/.env"
if [[ "$TARGET" == production || "$TARGET" == all ]]; then source "$ROOT_DIR/.env.production"; fi
if [[ "$TARGET" == preview || "$TARGET" == all ]]; then source "$ROOT_DIR/.env.preview"; fi
mkdir -p "$ROOT_DIR/data/nginx"
output="$ROOT_DIR/data/nginx/default.conf"
{
  cat <<'EOF'
server {
    listen 80;
EOF
  names=()
  [[ "$TARGET" == production || "$TARGET" == all ]] && names+=("$PRODUCTION_DOMAIN")
  [[ "$TARGET" == preview || "$TARGET" == all ]] && names+=("$PREVIEW_DOMAIN")
  echo "    server_name ${names[*]};"
  cat <<'EOF'
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
EOF
  if [[ "$MODE" == bootstrap ]]; then
    cat <<'EOF'
    location / { return 503; }
EOF
  else
    cat <<'EOF'
    location / { return 301 https://$host$request_uri; }
EOF
  fi
  cat <<'EOF'
}
EOF
  [[ "$MODE" == bootstrap ]] && exit 0
  if [[ "$TARGET" == production || "$TARGET" == all ]]; then
    source "$ROOT_DIR/.env.production"
    cat <<EOF
server {
    listen 443 ssl;
    http2 on;
    server_name $PRODUCTION_DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$PRODUCTION_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PRODUCTION_DOMAIN/privkey.pem;
    location /uploads/ {
        alias /var/www/uploads/production/;
        try_files \$uri =404;
    }
    location / {
        proxy_pass http://production-api:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  fi
  if [[ "$TARGET" == preview || "$TARGET" == all ]]; then
    source "$ROOT_DIR/.env.preview"
    cat <<EOF
server {
    listen 443 ssl;
    http2 on;
    server_name $PREVIEW_DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$PREVIEW_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PREVIEW_DOMAIN/privkey.pem;
    location /uploads/ {
        alias /var/www/uploads/preview/;
        try_files \$uri =404;
    }
    location / {
        proxy_pass http://preview-api:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  fi
} > "$output"
echo "Rendered $output for $TARGET"
