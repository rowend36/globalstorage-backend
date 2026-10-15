#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TARGET=${1:-all}
source "$ROOT_DIR/.env"
: "${MAIL_HOST:?Missing MAIL_HOST in $ROOT_DIR/.env}"
: "${MAIL_DOMAIN:?Missing MAIL_DOMAIN in $ROOT_DIR/.env}"
: "${MAIL_ENABLED:-true}"
[[ "$TARGET" == preview || "$TARGET" == production || "$TARGET" == all ]] || {
  printf 'Usage: %s [preview|production|all]\n' "$0" >&2; exit 2;
}

add_unique() {
  local -n bucket=$1
  local value=$2
  for item in "${bucket[@]}"; do [[ "$item" == "$value" ]] && return 0; done
  bucket+=("$value")
}

domains=()
mail_domains=()
add_unique mail_domains "$MAIL_DOMAIN"
[[ "${MAIL_ENABLED:-true}" == "true" ]] && add_unique domains "$MAIL_HOST"
if [[ "$TARGET" == preview || "$TARGET" == all ]]; then
  [[ -f "$ROOT_DIR/.env.preview" ]] || { echo "Missing $ROOT_DIR/.env.preview" >&2; exit 1; }
  source "$ROOT_DIR/.env.preview"
  : "${PREVIEW_DOMAIN:?Missing PREVIEW_DOMAIN in $ROOT_DIR/.env.preview}"
  add_unique domains "$PREVIEW_DOMAIN"
  [[ -n "${PREVIEW_MAIL_DOMAIN:-}" ]] && add_unique mail_domains "$PREVIEW_MAIL_DOMAIN"
fi
if [[ "$TARGET" == production || "$TARGET" == all ]]; then
  [[ -f "$ROOT_DIR/.env.production" ]] || { echo "Missing $ROOT_DIR/.env.production" >&2; exit 1; }
  source "$ROOT_DIR/.env.production"
  : "${PRODUCTION_DOMAIN:?Missing PRODUCTION_DOMAIN in $ROOT_DIR/.env.production}"
  add_unique domains "$PRODUCTION_DOMAIN"
  [[ -n "${PRODUCTION_MAIL_DOMAIN:-}" ]] && add_unique mail_domains "$PRODUCTION_MAIL_DOMAIN"
fi

for domain in "${domains[@]}"; do
  ip=$(getent hosts "$domain" | awk 'NR == 1 { print $1 }' || true)
  [[ -n "$ip" ]] || { echo "ERROR: DNS does not resolve: $domain" >&2; exit 1; }
  echo "$domain -> $ip"
done

if [[ "${MAIL_ENABLED:-true}" == "true" ]]; then
  mail_ip=$(getent hosts "$MAIL_HOST" | awk 'NR == 1 { print $1 }' || true)
  ptr=$(dig +short -x "$mail_ip" 2>/dev/null | sed 's/\.$//' || true)
  if [[ "$ptr" == "$MAIL_HOST" ]]; then
    echo "PTR -> $ptr"
  else
    echo "WARNING: PTR mismatch: expected $MAIL_HOST, got ${ptr:-none}" >&2
  fi
fi

check_mail_domain() {
  local domain=$1
  local spf dmarc dkim selector=mail key_dir selector_file

  spf=$(dig +short TXT "$domain" 2>/dev/null | tr -d '"\n' | grep -o 'v=spf1' | head -n1 || true)
  if [[ -n "$spf" ]]; then
    echo "SPF   -> ok ($domain)"
  else
    echo "WARNING: No SPF TXT record for $domain" >&2
  fi

  dmarc=$(dig +short TXT "_dmarc.$domain" 2>/dev/null | tr -d '"\n' | grep -o 'v=DMARC1' | head -n1 || true)
  if [[ -n "$dmarc" ]]; then
    echo "DMARC -> ok (_dmarc.$domain)"
  else
    echo "WARNING: No DMARC record for _dmarc.$domain" >&2
  fi

  key_dir="$ROOT_DIR/data/mail-config/opendkim/keys/$domain"
  if [[ -d "$key_dir" ]]; then
    selector_file=$(compgen -G "$key_dir/*.txt" | head -n1 || true)
    [[ -n "$selector_file" ]] && selector=$(basename "$selector_file" .txt)
  fi
  dkim=$(dig +short TXT "$selector._domainkey.$domain" 2>/dev/null | tr -d '"\n ' | grep -o 'v=DKIM1' | head -n1 || true)
  if [[ -n "$dkim" ]]; then
    echo "DKIM  -> ok ($selector._domainkey.$domain)"
  else
    echo "WARNING: No DKIM TXT record for $selector._domainkey.$domain" >&2
    local key_txt="$key_dir/$selector.txt"
    if [[ -r "$key_txt" ]]; then
      echo "         Publish the DKIM value from $key_txt at $selector._domainkey.$domain" >&2
    fi
  fi
}

if [[ "${MAIL_ENABLED:-true}" == "true" ]]; then
  for domain in "${mail_domains[@]}"; do
    check_mail_domain "$domain"
  done
else
  echo "Mail disabled (MAIL_ENABLED=false); skipping SPF/DKIM/DMARC checks" >&2
fi