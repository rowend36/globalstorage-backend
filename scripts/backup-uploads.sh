#!/bin/sh
set -eu

compose_file=${COMPOSE_FILE:-compose.production.yml}
env_file=${ENV_FILE:-.env.production}
backup_dir=${BACKUP_DIR:-./backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$backup_dir"
docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
  --entrypoint sh production-api \
  -v "$backup_dir:/backup" \
  -c "tar -czf /backup/globalstorage-production-uploads-$timestamp.tar.gz -C /app/uploads ."

echo "Created $backup_dir/globalstorage-production-uploads-$timestamp.tar.gz"
