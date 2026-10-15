#!/usr/bin/env bash
set -Eeuo pipefail

target=${1:-production}
[[ "$target" == production ]] || { echo 'Usage: backup.sh production' >&2; exit 2; }
"$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/backup-postgres.sh"
"$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/backup-uploads.sh"
