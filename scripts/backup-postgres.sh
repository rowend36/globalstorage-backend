#!/bin/sh
set -eu

compose_file=${COMPOSE_FILE:-compose.production.yml}
env_file=${ENV_FILE:-.env.production}
backup_dir=${BACKUP_DIR:-./backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$backup_dir"
docker compose --env-file "$env_file" -f "$compose_file" exec -T production-postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip > "$backup_dir/globalstorage-production-$timestamp.sql.gz"

echo "Created $backup_dir/globalstorage-production-$timestamp.sql.gz"
