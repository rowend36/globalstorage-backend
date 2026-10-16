# Global Storage — Implementation Plan (Stage 1)

Source of truth for the Stage 1 design. Agreed after correcting the v0.1
protocol spec in review. Last updated: 2026-10-15.

Product: **Global Storage** — a user-owned, versioned key-value storage
service with pluggable user-controlled persistence.

> Applications interact with Global Storage. Global Storage manages the
> data. Users control the underlying storage.

Repos: `~/Work/globalstorage-backend` (NestJS) and
`~/Work/globalstorage-frontend` (not yet created).

## 1. What Stage 1 delivers

- User accounts: register, login, refresh, `GET /v1/auth/me`. Personal
  tenants auto-created with MFA policy `'none'`; tenancy otherwise dormant.
- Spaces: create / list / get / update / delete. 50 MB default quota per
  space, 1 GB aggregate per user. Unlimited space count.
- Key-value API: wildcard key route CRUD, `If-Match`/expected-version
  conditional writes (412 on conflict), prefix + cursor pagination,
  `/status` (persistence + health).
- Opaque byte values with optional content-type metadata. Key encoding:
  NFC-normalized, no control characters, length-limited.
- Persistence: debounced in-process flush to a local filesystem adapter
  (`data/provider/<spaceId>/`). Read-your-writes always served from the
  operational DB, never the provider.
- Sync: timestamp versions with recency ordering; reconcile at lock
  time (cooldown-gated), hydrate on read miss; only persisted rows are
  ever evictable.
- Frontend: landing page + dashboard (auth, spaces list + usage, full
  key browse/read/write). React Router v7 SPA, TanStack Query, port 5180.
  Backend port 3000, Bearer tokens for the SPA.

## 2. Architecture (final — supersedes spec §6.3 and related text)

### 2.1 Layers

```
Applications (frontend dashboard, later third-party apps)
        │  Global Storage API (REST, §5.1 endpoints)
        ▼
Global Storage Engine — operational SQLite DB + flush scheduler
        │  StorageAdapter port (resource + lock operations)
        ▼
User-controlled storage (Stage 1: local filesystem adapter)
```

### 2.2 Operational database — a robust KV store, nothing else

Per Global Storage instance. Tables for storage: **`spaces`** and
**`space_keys`** only.

- `spaces`: owner, name, `quotaBytes` (default 50 MB), `usedBytes`,
  `providerType` (default `'local'`), `providerConfig` (nullable, e.g.
  per-type target block size), `state` (`active`/`unhealthy`), timestamps.
- `space_keys`: `space, key, version, value, lastPersistedVersion`
  (+ `contentType`, `deletedAt`, timestamps), unique on (`space`, `key`).
  - `version` and `lastPersistedVersion` are **timestamps** (ms since
    epoch), strictly increasing per key:
    `newVersion = max(nowMs, currentVersion + 1)`. Ordering = recency;
    same-key timestamp collisions are impossible by construction.
    `If-Match` carries the timestamp the client read. Stage 1 assumes
    one writer per space, so timestamps are exact; multi-instance clock
    skew is a documented limitation (hybrid logical clocks if it bites).
  - `lastPersistedVersion` = timestamp of the last version confirmed on
    the storage engine.
  - Dirty = `version > lastPersistedVersion`. API `status` is derived:
    `persisted` when equal, `pending` otherwise.
  - `deletedAt` (nullable) marks a **pending-delete tombstone**: delete
    sets it (with `version` = deletion timestamp, hence dirty) and
    clears `value`/`contentType`. The row is purged after the flush
    confirms its removal from the medium (idempotent: medium already
    lacking the entry → purge directly). Reads, lists, and status
    counts exclude tombstoned rows; the flush includes them.
  - Reads/writes touch ONLY this table. Quota accounting = logical
    value bytes; a delete frees its bytes immediately (tombstone rows
    are metadata overhead, tracked separately). `usedBytes` is
    instance-local and eventually consistent across instances after
    pulls — exact for Stage 1's single writer.

There are NO block, dictionary, or lock tables. Reads and writes never
touch blocks, dictionaries, or the provider.

### 2.3 Adapter-side artifacts — blocks, dictionary, locks

Blocks, the dictionary, and locks live **on the storage medium**,
written through the adapter. They are what other Global Storage
instances see, so locks are discoverable cross-instance. Locks coordinate
*conformant* instances only; non-conformant writers can bypass them
(see §2.6 conflict policy).

- **Blocks**: packed key-value payloads for media where one-key-per-file
  would be expensive. Target size ~100 KB default, from adapter
  capabilities, configurable per storage type (`providerConfig`).
  Blocks are identified by stable IDs and mutated in place; the
  dictionary tracks per-block stats (see §2.5). Each block entry is an
  envelope carrying the value plus per-key metadata —
  `{value, keyVersion, contentType, updatedAt}` — so pulls and
  hydrate-on-read restore rows losslessly.
- **Dictionary**: key→block mapping (+ dictionary version, integrity
  info) stored on the medium. Never cached as authoritative state in the
  operational DB.
- **Locks**: lock resources for blocks and the dictionary, with owner,
  lease expiry, fencing token. Acquired via conditional create
  (filesystem `O_EXCL`/mkdir; S3 `IfNoneMatch`; …); capabilities
  advertised by the adapter. A lock that never expires can wedge a
  space permanently, so leases are mandatory.

### 2.4 Data formats are versioned

The **data format, the lock format, and the dictionary format each carry
a format-version header**. Format versions are unrelated to block
"generation" bookkeeping — blocks have no generations.

### 2.5 Mutation model

Blocks are **mutable and updated in place** under lock. No immutable
block versions, no copy-on-write publish, no retiring.

- **Write path** (hot, cheap): validate request → check auth/space/
  quota → commit key row in one operational transaction (version =
  `max(nowMs, currentVersion + 1)`, now dirty) → best-effort pre-lock
  (see §2.7) → acknowledge. Lock state never blocks an acknowledged
  write.
- **Flush path** (debounced timer): acquire the dictionary lock and
  **hold it for the whole cycle** → read the dictionary once
  (authoritative; absent → requeue all local rows first, voiding every
  persisted claim, then push everything) → **reconcile** (§2.8:
  cooldown-gated bulk refresh via `blockVersion`, then version-ordering
  rules incl. the deletion rule) → plan the complete target layout
  (allocate, rearrange/restructure — all before any medium write) →
  acquire every block lock in the plan (deterministic order) and hold
  them too → apply blocks + dictionary inside the same locked critical
  section → mark keys persisted (conditional on version: an old flush
  must never flip a newer write), purge confirmed tombstones → release
  ALL locks (blocks, dict last). Busy blocks/arrangements are skipped
  and stay dirty for the next flush. The handler reports backpressure
  (returns unflushed space ids) instead of blocking; the scheduler
  retries them on its cadence. The worker self-registers with the
  scheduler in `onModuleInit` — constructor-injecting the handler would
  close a Worker→Engine→Scheduler→Worker resolution cycle that hangs
  Nest silently.
- **Deletion**: deleting sets `deletedAt` (timestamp version), clears
  `value`/`contentType`, frees the quota immediately — the row becomes
  a pending-delete tombstone, so the flush knows the medium removal is
  still owed. Tombstoned keys return 404 without consulting the medium
  (read-your-deletes). The flush removes the entry from the
  block/dictionary and purges the row. A block is deleted the moment
  its last key is gone. That is the ONLY way blocks go stale — there is
  no retired-block set and no deferred GC in Stage 1. Crash-orphaned
  unreferenced files are a later-stage reconcile concern.
- **Reads**: always the operational row first (tombstoned → 404, no
  medium consult). On a miss, consult the dictionary (cache or medium):
  key present → fetch the envelope from its block, create/update the DB
  row, return it (hydrate-on-read); key absent → genuine 404. A newer
  local value is never replaced by an older external value; a read that
  cannot be served safely fails explicitly with the space marked
  `unhealthy`.

### 2.8 Sync from the medium (medium → DB direction)

Push (DB → medium) is only half the protocol. The medium also feeds
back into the DB — how one instance learns about another instance's
writes, and how a wiped DB rebuilds itself. No extra columns are needed:
local rows store timestamp `version` + `lastPersistedVersion`, and every
medium dictionary entry carries its `keyVersion`.

**Versions are timestamps** (`max(nowMs, currentVersion + 1)` per key),
so ordering = recency and same-key timestamp collisions are impossible
by construction. Stage 1 assumes one writer per space, so timestamps
are exact (this also fixes delete→recreate ordering: the recreated key
always carries a later timestamp than anything deleted before it).
Multi-instance clock skew is a documented limitation (hybrid logical
clocks if it ever bites).

**Version-ordering rules** (applied wherever the two sides meet):

- Medium `keyVersion` **newer** than local `version`, or key present in
  the dictionary but absent locally → **pull**: create/update the DB row
  from the block envelope (value, `version`, `contentType`;
  `lastPersistedVersion` = `version` since it is persisted by definition).
- Medium `keyVersion` **older or equal** → local state is authoritative;
  the flush pushes it (overwrite).
- Clean local row **absent from the dictionary** → another instance
  deleted it: delete the local row. (Dirty local row absent → push as
  new: the medium simply hasn't seen it yet.)
- Equal version but **different content** → fail explicitly, mark the
  space `unhealthy`. Near-impossible with timestamp versions; kept as
  the backstop. Never guess.

**The two sync triggers** (bulk refresh is cooldown-gated on both —
targeted per-key checks always apply):

1. **Lock time** (flush start, under the held dict lock): if the
   per-space cooldown (`syncCooldownMs`, default 5000) has elapsed
   since the last sync, refresh stale rows — only blocks whose
   `blockVersion` changed are descended into — then apply the ordering
   rules above, before planning. This is what keeps instances sharing
   one medium coherent.
2. **Read miss** (`404` in DB, key present in dictionary): hydrate the
   row from the block envelope and serve it, always (single key, cheap).
   Genuine 404 only when the key is in neither.

**Delete races across instances** (future): a delete flushed as a bare
entry-removal can be undone by a concurrent unflushed write with an
older timestamp resurrecting the key. The full answer is tombstone
entries in the medium dictionary (deleted-at timestamp; recreates
continue the sequence); deferred with merge/GC, which ages tombstones
out. Stage 1's local tombstone rows + timestamp ordering are exact for
a single writer.

**Eviction invariant (enables the adapter as absolute truth):** because
any persisted state can be pulled back by version, the local DB may
later be periodically flushed and rehydrated on demand — **but only rows
with `version == lastPersistedVersion` may ever be evicted**. Dirty
rows are pinned until persisted; evicting them would destroy the only
recoverable copy of an acknowledged write. The periodic eviction
sweeper itself is a later stage (spec Stage 4); Stage 1 implements the
sync triggers and the invariant.

### 2.5a Layout operations and block stats

Layout changes are computed up front and applied as one committed
change; in-place block mutation never happens without the plan and
its lock set:

- **Allocate**: create new blocks for keys with no home block (new keys,
  or values too large for existing blocks).
- **Rearrange / restructure**: move entries between blocks when a key
  outgrows its block or a restructure requires it (e.g. a block that
  became empty of live keys is deleted at the same flush).
- **Merge (future optimization, NOT Stage 1)**: compact old
  *fragmented* blocks — blocks that are no longer actively written but
  hold few live entries — into fewer blocks. Active (hot) blocks are
  never merge targets.
- The dictionary stores **per-block stats** alongside the key mapping
  (`blockVersion` bumped on every block write, live key count, live
  bytes, target size). `blockVersion` drives the reconcile fast path
  (only changed blocks are descended into); the rest lets a future
  merge pass find fragmented non-active blocks without scanning block
  contents. Stage 1 writes all stats, uses `blockVersion`, and defers
  merge decisions.

### 2.6 Conflict policy (handles non-conformant writers and crashes)

- Stored artifact **lower version or corrupt** → Global Storage
  overwrites it with its authoritative state.
- Stored artifact **higher version than this instance can interpret** →
  fail explicitly, mark the space `unhealthy`, never guess.
- Fencing tokens: every block write and dictionary update is tagged;
  a worker whose lease expired can never publish over a newer holder.
- Retried flushes are idempotent via version checks.

### 2.7 Locking protocol

- **Hold everything till flush**: the flush acquires the dictionary
  lock first, reads the dictionary once, plans against it, acquires
  every block lock in the plan in deterministic block-id order, and
  holds ALL of them — dict included — until the flush completes.
  One authoritative dictionary read, no re-reads, no mapping drift.
  (Releasing the dict early would force a fresh dictionary read before
  every subsequent block access, for the same stability reasons the
  dict lock exists at all.)
- **Rearrangements lock everything they touch**: any operation that
  moves entries between blocks (source AND destination blocks, splits,
  merges) must first hold locks on **all** participating blocks —
  acquired in deterministic block-id order while holding the dict lock,
  all-or-nothing. Overstored flushes serialize instead of deadlocking.
- **Contention**: a busy block/arrangement is skipped; keys stay dirty
  and retry on the next write or flush (bounded backoff in later stages).
- **Future merges** follow the same rule: a merge plan locks every
  source and destination block (deterministic order) before moving a
  single entry; only non-active fragmented blocks are merge candidates.
- On first write to a key, use the in-memory **dictionary cache**
  (loaded from the medium on miss, best-effort) for the best-effort
  pre-lock — there is no separate advisory map: dict lock → resolve →
  block lock → release dict, block held till flush. At flush start,
  under the held dict lock, re-verify each pre-locked key's mapping
  once: changed → release the stale pre-lock and resolve fresh;
  unchanged → fold it into the plan's lock set. The flush never depends
  on whether the pre-lock succeeded.
- **Leases cover the whole hold window**: debounce + flush apply. The
  flush renews leases mid-apply for large batches; every write and the
  dictionary update are fenced, so an expired worker can never publish.
- Stage 1 keeps rearrangements minimal: a key moves only when its block
  would exceed the target (or an oversized value needs its own block).
  No gratuitous compaction.
- **Space deletion** acquires the space's dict lock (busy → 409/retry);
  the prefix wipe happens under it, so it can never race a flush.
- **One space at a time**: a flush processes spaces sequentially, never
  holding two dict locks at once.

## 3. Phases

### Phase 0 — Scaffold/rebrand/auth base (DONE, committed)
Commits: `d634629` scaffold+rebrand, `6bbe192` register/me/`'none'`
policy/CORS :5180, `1302290` space entities + sqlite/pg migrations.
Gates green. Dev server runs on :3000.

### Phase 1 — Fix the committed-schema drift + pre-existing e2e (approved)
- Generated migration: drop `space_blocks` and `space_dictionaries`
  (wrong model — logical block storage is expensive; superseded by §2).
- Fix `test/app.e2e-spec.ts` 4/5 red (MFA `'any'` forces email challenge
  for the memberless seeded user): seed a membership on a `'none'`
  tenant. Approved by user.
- pg migration live validation outstanding (colima down; needs user OK
  to start the VM).

### Phase 2 — Robust KV engine (operational SQLite)
- `EngineService`: `createSpace` (record + provider association +
  50 MB quota), `updateSpace`, `deleteSpace`, `writeKey`
  (validate → quota → commit with timestamp version → best-effort
  pre-lock → schedule flush), `readKey` (row lookup → miss: dictionary
  check → hydrate from the block envelope or genuine 404; tombstoned →
  404), `deleteKey` (tombstone row; purge after flush confirms),
  `listKeys` (prefix + keyset cursor, excluding tombstones), `getStatus`
  (versions, pending counts, provider health).
- `FlushScheduler`: debounced timer → batch dirty keys per space
  (`syncCooldownMs` gates bulk refresh).
- Errors: quota 403, version conflict 412, not-found 404.
- Version-conditional updates everywhere an old operation could
  overwrite a newer value.
- Unit + integration tests (KV semantics, quotas, conditional writes,
  read-your-writes; assert the read/write path never touches blocks).

### Phase 3 — Storage engine layer
- `StorageAdapter` port: resource read/write/delete + lock ops
  (`tryAcquire`/`release`, lease + fencing) + `getCapabilities`
  (`targetBlockBytes`, conditional-write support).
- `LocalFilesystemAdapter`: `data/provider/<spaceId>/blocks/*`,
  `dictionary`, `locks/*`; atomic tmp+rename; exclusive-create locks;
  checksums.
- Versioned format headers for data, lock, dictionary payloads.
- `BlockManager`: versioned envelope entries
  (`{value, keyVersion, contentType, updatedAt}`), packing at the
  adapter's target size, in-place read-modify-write, move handling,
  delete-block-when-empty, `blockVersion` bump on every block write.
- `FlushWorker`: §2.5/§2.6/§2.7 end-to-end (lock → cooldown-gated
  reconcile per §2.8 → pack → write → verify → publish dictionary →
  conditional persist-mark → purge confirmed tombstones → release;
  unhealthy on higher-version or conflicting data).

### Phase 4 — API (spec §5.1 exactly)
`GET/POST /v1/spaces`, `GET/PATCH/DELETE /v1/spaces/{id}`,
`GET/PUT/DELETE /v1/spaces/{id}/keys/{key}` (wildcard),
`GET /v1/spaces/{id}/keys`, `GET /v1/spaces/{id}/status`.
Precise key encoding, pagination, request size limits
(10 MB max value), error format.

### Phase 5 — Frontend
Scaffold (RRv7 + Vite + Tailwind v4 + shadcn, TanStack Query,
`VITE_PUBLIC_API_URL`): landing page; dashboard with auth, spaces
list + usage, full key browse/read/write.

### Phase 6 — Verification
All gates, end-to-end register→space→write→read→status flow against
the running server, READMEs.

## 4. Explicitly out of scope (later stages per the spec roadmap)

Durable mutation outbox, background worker processes, locking beyond
Stage 1 needs, Solid/S3/Drive adapters, eviction sweeper, crash-recovery
reconcile, merge/GC (incl. tombstone aging), medium dictionary
tombstones for multi-instance delete races, hybrid logical clocks,
OAuth applications, change notifications, real multi-user tenancy,
paid plans.

## 5. Standing rules (from this project's AGENTS.md)

- Migrations only via `npm run migration:create:sqlite` / `:pg`
  (never hand-written, never plain `mikro-orm migration:create`).
- Never remove code you did not write; fix only your own code on
  failure, otherwise stop and show the failure + proposed fix.
- No push to remote without explicit approval. No extra `.md` files
  (this file is explicitly requested).
