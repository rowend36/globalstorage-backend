#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TARGET=${1:-all}
cd "$ROOT_DIR"
[[ "$TARGET" == preview || "$TARGET" == production || "$TARGET" == all ]] || {
  printf 'Usage: %s preview|production|all\n' "$0" >&2; exit 2;
}
set -a
source .env
set +a

add_account() {
  local address=$1 password=$2
  [[ -n "$address" && -n "$password" ]] || { echo "Missing SMTP account configuration" >&2; exit 1; }
  docker compose --env-file .env -f compose.mail.yml exec -T mailserver setup email add "$address" "$password" || \
    docker compose --env-file .env -f compose.mail.yml exec -T mailserver setup email update "$address" "$password"
}

if [[ "$TARGET" == preview || "$TARGET" == all ]]; then
  source .env.preview
  add_account "$SMTP_USER" "$SMTP_PASSWORD"
fi
if [[ "$TARGET" == production || "$TARGET" == all ]]; then
  source .env.production
  add_account "$SMTP_USER" "$SMTP_PASSWORD"
fi

docker compose --env-file .env -f compose.mail.yml exec -T mailserver setup config dkim domain "$MAIL_DOMAIN"
if [[ "$TARGET" == preview || "$TARGET" == all ]]; then
  docker compose --env-file .env -f compose.mail.yml exec -T mailserver setup config dkim domain "$PREVIEW_MAIL_DOMAIN"
fi
echo "Mail accounts and DKIM configuration are ready. Publish the generated DKIM TXT value before sending mail."
