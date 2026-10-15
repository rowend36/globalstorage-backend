#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $EUID -eq 0 ]]; then SUDO=(); else SUDO=(sudo); fi
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
  DOCKER_USER=$SUDO_USER
elif [[ $EUID -ne 0 ]]; then
  DOCKER_USER=${USER:?Unable to determine the current user}
else
  DOCKER_USER=$(logname 2>/dev/null || true)
  [[ "$DOCKER_USER" == root ]] && DOCKER_USER=
fi
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"
source /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) echo "Unsupported OS: ${ID:-unknown}; use Ubuntu or Debian." >&2; exit 1;; esac

"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y ca-certificates curl gnupg dnsutils
"${SUDO[@]}" install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/$ID/gpg | "${SUDO[@]}" tee /etc/apt/keyrings/docker.asc >/dev/null
  "${SUDO[@]}" chmod a+r /etc/apt/keyrings/docker.asc
fi
arch=$(dpkg --print-architecture)
codename=${VERSION_CODENAME:-$(. /etc/os-release && echo "$VERSION_CODENAME")}
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$arch" "$ID" "$codename" | "${SUDO[@]}" tee /etc/apt/sources.list.d/docker.list >/dev/null
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
"${SUDO[@]}" systemctl enable --now docker
if [[ -n "$DOCKER_USER" ]]; then
  "${SUDO[@]}" usermod -aG docker "$DOCKER_USER"
fi
mkdir -p data/nginx data/certbot-webroot data/mail-config backups
if [[ -n "$DOCKER_USER" ]]; then
  "${SUDO[@]}" chown -R "$DOCKER_USER":"$DOCKER_USER" data backups
fi
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=("${SUDO[@]}" docker); fi
"${DOCKER[@]}" network inspect globalstorage-gateway >/dev/null 2>&1 || "${DOCKER[@]}" network create globalstorage-gateway
"${DOCKER[@]}" network inspect globalstorage-mail >/dev/null 2>&1 || "${DOCKER[@]}" network create globalstorage-mail
if [[ -n "$DOCKER_USER" ]]; then
  echo "Docker VM setup complete. User $DOCKER_USER was added to the docker group; reconnect before running deployment."
else
  echo 'Docker VM setup complete, but no non-root login user was detected. Add your SSH user to the docker group before deployment.' >&2
fi
