#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source .env
set +a

docker compose --env-file .env -f compose.gateway.yml run --rm certbot renew --webroot -w /var/www/certbot
docker compose --env-file .env -f compose.gateway.yml up -d --force-recreate nginx
docker compose --env-file .env -f compose.mail.yml up -d --force-recreate mailserver
