# Backend architecture

All provider selection is data configuration (`DATABASE_DRIVER`, `STORAGE_PROVIDER`, etc.); no business module tests `NODE_ENV`. Preview mounts source using `compose.preview.yml`; production runs only the compiled image (`node dist/main`). Nest uses the SWC builder for fast compilation, with `tsc --noEmit` retained as the explicit type-check gate.

## Authorization and tenancy

Users hold tenant memberships. Memberships hold roles; roles hold claims. `includeDescendants` grants a membership into the materialized-path subtree. Access JWTs carry the role/claim snapshot plus user and role versions. Every request validates those versions from cache; membership changes bump the user version and claim changes bump the role version, immediately invalidating stale access tokens.

Authentication has two modes. `cookies=true` returns only secure, HttpOnly access/refresh cookies with a readable CSRF cookie; otherwise login and refresh return both tokens in JSON. Refresh credentials are opaque random values stored only as keyed hashes, rotated on every use, and a replay revokes the session family. Refresh reconstructs the current authorization snapshot, while logout/password/auth-method events revoke sessions.

## Compliance controls

Audit events are append-only records, independent of application logs. Enforce immutability at the DB role/trigger layer, export to immutable object storage, and retain on the statutory schedule. PII fields use AES-256-GCM envelope encryption with KMS-managed data keys; keys must be rotated and never logged.

Money is integer minor units/decimal database columns—never JS floats. Every payment command requires `Idempotency-Key`, uses a unique database constraint, and updates balances in a single transaction using row locks (`SELECT ... FOR UPDATE` in PostgreSQL).

## Operations checklist

- Redis-backed throttling, cache, BullMQ, JWT revocation, and idempotency state are required for multi-instance production. Memory implementations are development-only provider choices.
- Add CSRF double-submit/token middleware before enabling cookie auth on state-changing routes; retain bearer-token support for non-browser clients.
- Configure OIDC discovery/client settings and pre-provision `external_identities` (`issuer`, `subject`, user) for agency SSO or social providers. `GET /v1/auth/oidc/login` uses discovery, state validation, and PKCE; its callback issues the normal cookie session only for a provisioned identity.
- Generate notices using a queue worker and store generated PDFs through the configured storage provider.
- Enable OpenTelemetry traces with correlation IDs and export to the selected collector; send errors separately to the monitoring provider.
- RDS: automated PITR backups, cross-region copy, quarterly restore drills, encrypted snapshots, and documented RTO/RPO.

## Migrations

Migration generation is explicitly driver-scoped. Use `npm run migration:create:sqlite` or `npm run migration:create:pg`; initial baselines are available as `migration:create:sqlite:initial` and `migration:create:pg:initial`. Generated files and snapshots are written under the matching `src/database/migrations/{sqlite,postgresql}` directory. Use the matching `migration:up:*`, `migration:down:*`, or `migration:fresh:*` script for execution.
