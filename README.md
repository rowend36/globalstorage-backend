# Global Storage Backend

A user-owned key-value storage service. Applications authenticate with
Global Storage, get scoped access to user-owned spaces, and store logical
keys; Global Storage manages the block-level layout, quotas, and persistence
to user-controlled storage providers.

## Development

```bash
npm ci
npm run start:dev
```

The app boots on SQLite with in-memory queue/cache and console mail — no
external dependencies are required for local development.

Run checks with `npm run type-check` and `npm test -- --runInBand`.

Create the initial platform tenant and super-admin account with the management
command. It prompts for the password without placing it in shell history:

```bash
npm run command -- create-super-admin --email admin@example.com --name "Platform Admin"
```

Use `npm run command:prod -- create-super-admin ...` inside the compiled
production image.

The command is idempotent. It creates the reserved `platform` tenant, the
`platform.super_admin` role, and their membership assignment. Existing users
are not given a new password on rerun.

End users self-register through the API (`POST /v1/auth/register`); each
registration provisions a personal workspace that stays invisible to the
product surface.

Useful endpoints (all under `/v1`):

- `POST /v1/auth/register` — create an account
- `POST /v1/auth/login` — returns access + refresh tokens in the response body
- `GET /v1/auth/me` — current user (Bearer token)
- `GET /v1/spaces`, `POST /v1/spaces` — list/create spaces (50 MB default quota)
- `GET /v1/spaces/{id}/keys` — list keys
- `GET/PUT/DELETE /v1/spaces/{id}/keys/{key}` — read/replace/delete a value
- `GET /v1/spaces/{id}/status` — persistence and quota status

## VPS Deployment

The deployment is designed for a fresh Ubuntu or Debian VPS. The scripts are
idempotent and resume from completed phases. They do not delete Docker volumes,
databases, uploads, or mail data.

### 1. Prepare DNS

Create only subdomain records. Existing website and root mail records are not
changed:

```text
preview.example.com       A  VPS_PUBLIC_IP
globalstorage-prod.example.com      A  VPS_PUBLIC_IP
mail.globalstorage-prod.example.com A  VPS_PUBLIC_IP
```

Set the VPS provider reverse DNS/PTR for `VPS_PUBLIC_IP` to
`mail.globalstorage-prod.example.com` when available. A PTR mismatch is reported as a
warning and does not block deployment. Confirm outbound SMTP port `25` is allowed by the
VPS provider. The application uses authenticated SMTP submission on port `587`.

### 2. Prepare the VPS

Copy the repository to the VPS, enter its directory, and run:

```bash
./scripts/setup-vm.sh
```

This installs Docker Engine and Compose, enables Docker, creates the required
directories and networks, and checks the supported operating system. Log out
and back in if it reports a Docker group change.

### 3. Configure three environment files

```bash
cp .env.example .env
cp .env.preview.example .env.preview
cp .env.production.example .env.production
chmod 600 .env .env.preview .env.production
```

Replace every placeholder. `.env` contains shared mail settings. The other two
files contain environment-specific domains, database credentials, application
secrets, and SMTP credentials. Do not commit these files.

Set `SMTP_USER` and `SMTP_PASSWORD` in each environment file. The Compose files
derive that environment's `SMTP_URL` as
`smtp://SMTP_USER:SMTP_PASSWORD@MAIL_HOST:587`; do not maintain a separate
`SMTP_URL` value. Use URL-safe SMTP passwords or URL-encode reserved characters.

### 4. Deploy one environment

```bash
./scripts/deploy.sh preview
```

or:

```bash
./scripts/deploy.sh production
```

To deploy both:

```bash
./scripts/deploy.sh all
```

The script validates DNS, renders only the selected Nginx upstream, starts the
HTTP ACME endpoint, obtains certificates for the selected web domain and mail
host, starts the mail server, starts PostgreSQL and Redis, runs migrations, and
checks service health. Preview mounts the checked-out source and uses
prebuilt dependencies from GHCR. Production pulls and runs the immutable image
published by CI; the VPS does not build application images.

If DNS or an external VPS setting is incomplete, the script stops with the
failed phase and corrective action. Fix the external setting and rerun the same
command. Every step is idempotent, so existing containers, certificates,
accounts, and data are retained. Changing a domain in its environment file and
rerunning the command regenerates the gateway configuration and certificate
request for that environment.

### 5. Mail DNS and accounts

The mail server is outbound-only: IMAP and POP3 are disabled. `deploy.sh`
creates the configured SMTP accounts and DKIM configuration. Add the generated
SPF, DKIM, and DMARC records for each sender domain before sending real mail.
Use separate SMTP credentials for preview and production. Do not add or change
the apex domain's MX record.

The application images are published to GHCR by CI. Authenticate the VPS once
if the repository package is private:

```bash
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u GITHUB_USERNAME --password-stdin
```

Keep `PRODUCTION_IMAGE` in `.env.production` and
`PREVIEW_DEPENDENCIES_IMAGE` in `.env.preview` pointed at the desired GHCR
tags. Preview source remains the VPS checkout, while its `node_modules` volume
is refreshed automatically when the CI-published dependency image changes.

### 6. Verify deployment

```bash
./scripts/verify-dns.sh preview
curl -fsS https://preview.example.com/v1/health
```

Use `production` instead of `preview` for the production environment, or
`all` to verify both. The gateway exposes only ports `80` and `443`; database,
Redis, and API ports remain private.

### 7. Renew certificates

Certificate renewal is idempotent and reloads the gateway and mail services:

```bash
./scripts/renew-certificates.sh
```

Schedule that command with a root cron or systemd timer.

Mail, preview, and production use separate Let's Encrypt certificate lineages.
Deploying or renewing one environment does not change the certificate used by
the others. The Nginx configuration remains target-specific: deploying
`preview` intentionally removes the production route, and deploying
`production` intentionally removes the preview route. Use `all` when both
routes should be active.

### 8. Backups

Run the backup script regularly and copy the resulting files off the VPS:

```bash
./scripts/backup.sh production
```

Backups include PostgreSQL and uploads. Test restoration periodically.
