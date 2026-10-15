#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TARGET=${1:-}
[[ "$TARGET" == preview || "$TARGET" == production || "$TARGET" == all ]] || {
  printf 'Usage: %s preview|production|all\n' "$0" >&2; exit 2;
}
cd "$ROOT_DIR"
trap 'echo "Deployment failed near line $LINENO. Correct the reported problem and rerun the same command." >&2' ERR
[[ -f .env && -f .env.$TARGET || "$TARGET" == all ]] || { echo "Missing environment file for $TARGET" >&2; exit 1; }
set -a
source .env
if [[ "$TARGET" == all ]]; then
  source .env.preview
  source .env.production
else
  source ".env.$TARGET"
fi
set +a

phase() { local name=$1; shift; echo "== $name =="; "$@"; }
compose_target() {
  local env_file=$1
  shift
  env -u DB_NAME -u DB_USER -u DB_PASSWORD -u SMTP_USER -u SMTP_PASSWORD \
    docker compose --env-file .env --env-file "$env_file" "$@"
}
refresh_preview_dependencies() {
  local image=$1 current_digest='' image_digest
  image_digest=$(docker image inspect "$image" --format '{{.Id}}')
  [[ -f data/.preview-dependencies-image ]] && current_digest=$(<data/.preview-dependencies-image)
  if [[ "$current_digest" != "$image_digest" ]]; then
    compose_target .env.preview stop preview-api >/dev/null 2>&1 || true
    compose_target .env.preview rm -f preview-api >/dev/null 2>&1 || true
    docker volume rm globalstorage-backend_preview_node_modules >/dev/null 2>&1 || true
    printf '%s\n' "$image_digest" > data/.preview-dependencies-image
  fi
}
mkdir -p data
phase dns scripts/verify-dns.sh "$TARGET"
phase render-bootstrap scripts/render-nginx.sh "$TARGET" bootstrap
phase gateway-bootstrap docker compose --env-file .env -f compose.gateway.yml up -d nginx
if [[ "$TARGET" == preview || "$TARGET" == all ]]; then
  : "${PREVIEW_DEPENDENCIES_IMAGE:?PREVIEW_DEPENDENCIES_IMAGE is required in .env.preview}"
fi
if [[ "$TARGET" == production || "$TARGET" == all ]]; then
  : "${PRODUCTION_IMAGE:?PRODUCTION_IMAGE is required in .env.production}"
fi
phase mail-certificate docker compose --env-file .env -f compose.gateway.yml run --rm certbot certonly --webroot -w /var/www/certbot -d "$MAIL_HOST" --cert-name "$MAIL_HOST" --non-interactive --agree-tos --no-eff-email --email "${ACME_EMAIL:?ACME_EMAIL is required}"
if [[ "$TARGET" == production || "$TARGET" == all ]]; then
  phase production-certificate docker compose --env-file .env -f compose.gateway.yml run --rm certbot certonly --webroot -w /var/www/certbot -d "$PRODUCTION_DOMAIN" --cert-name "$PRODUCTION_DOMAIN" --non-interactive --agree-tos --no-eff-email --email "${ACME_EMAIL:?ACME_EMAIL is required}"
fi
if [[ "$TARGET" == preview || "$TARGET" == all ]]; then
  phase preview-certificate docker compose --env-file .env -f compose.gateway.yml run --rm certbot certonly --webroot -w /var/www/certbot -d "$PREVIEW_DOMAIN" --cert-name "$PREVIEW_DOMAIN" --non-interactive --agree-tos --no-eff-email --email "${ACME_EMAIL:?ACME_EMAIL is required}"
fi
phase mail docker compose --env-file .env -f compose.mail.yml up -d
phase mail-config scripts/configure-mail.sh "$TARGET"
if [[ "$TARGET" == preview ]]; then
  phase preview-pull compose_target .env.preview -f compose.preview.yml pull preview-api
  refresh_preview_dependencies "$PREVIEW_DEPENDENCIES_IMAGE"
  phase preview compose_target .env.preview -f compose.preview.yml up -d
fi
if [[ "$TARGET" == production ]]; then
  phase production-pull compose_target .env.production -f compose.production.yml pull production-api
  phase production compose_target .env.production -f compose.production.yml up -d
fi
if [[ "$TARGET" == all ]]; then
  phase preview-pull compose_target .env.preview -f compose.preview.yml pull preview-api
  refresh_preview_dependencies "$PREVIEW_DEPENDENCIES_IMAGE"
  phase preview compose_target .env.preview -f compose.preview.yml up -d
  phase production-pull compose_target .env.production -f compose.production.yml pull production-api
  phase production compose_target .env.production -f compose.production.yml up -d
fi
phase render-tls scripts/render-nginx.sh "$TARGET"
phase gateway docker compose --env-file .env -f compose.gateway.yml up -d --force-recreate nginx
echo "Deployment phases complete for $TARGET"
