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

- **Write path** (hot, never waits): validate request → check auth/space/
  quota → commit key row in one operational transaction (version =
  `max(nowMs, currentVersion + 1)`, now dirty) → best-effort pre-lock →
  acknowledge. Lock state never blocks an acknowledged write. The
  pre-lock is best-effort correctness, not a gate: acquiring follows the
  configured strategy (§2.7) with dict-first ordering, and while the
  block stays held, later reads serve the local row directly (no newer
  medium state can exist); when acquisition fails, the write still
  commits and reads fall back to version-checked behavior.
- **Flush path** (debounced timer): fast path when every needed block is
  already held and nothing needs moving — update blocks only, no
  dictionary, no dict lock, both strategies identical. Otherwise the
  structural path (§2.7): reconcile, plan, acquire the full lock set,
  apply, publish under the held dict lock, mark persisted, purge
  confirmed tombstones. The handler reports backpressure (returns
  unflushed space ids) instead of blocking; the scheduler retries them
  on its cadence. The worker self-registers with the scheduler in
  `onModuleInit` — constructor-injecting the handler would close a
  Worker→Engine→Scheduler→Worker resolution cycle that hangs Nest
  silently.
- **Deletion**: deleting sets `deletedAt` (timestamp version), clears
  `value`/`contentType`, frees the quota immediately — the row becomes
  a pending-delete tombstone, so the flush knows the medium removal is
  still owed. Tombstoned keys return 404 without consulting the medium
  (read-your-deletes). The flush removes the entry from the
  block/dictionary and purges the row. A block is deleted the moment
  its last key is gone. That is the ONLY way blocks go stale — there is
  no retired-block set and no deferred GC in Stage 1. Crash-orphaned
  unreferenced files are a later-stage reconcile concern.
- **Reads**: operational row first. Tombstoned → 404 without medium
  contact. Live row in a continuously-held block → serve directly (no
  newer medium state can exist; hold-continuity tracked, lapse forces
  re-sync first). Otherwise consult the dictionary (cache, else load):
  entry absent → genuine 404; entry newer than the row → lock the block
  (bounded by `readTimeoutMs`), re-read, pull, serve; lock/read failure
  → serve the cached row if present, else 503, while the attempt
  continues in the background (singleflight per block, capped retries)
  to warm the cache for the next read. A newer local value is never
  replaced by an older external value; a read that cannot be served
  safely fails explicitly with the space marked `unhealthy`.

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

**Sync triggers and refresh** (bulk work is cooldown-gated —
`syncCooldownMs`, default 5000; targeted per-key checks always apply):

1. **Lock time** (flush start, under the held dict lock): compare every
   dictionary entry's `keyVersion` against local rows, then apply the
   ordering rules above, before planning. No block-level baseline is
   kept: the dictionary must be fully walked for planning anyway, and
   per-key versions already gate every expensive block read — a
   block-version skip would save only an in-memory compare loop at the
   cost of baseline bookkeeping and its false-baseline trap. This is
   what keeps instances sharing one medium coherent. Reconcile
   discoveries are returned as change events
   (`spaceId, key, oldVersion, newVersion, operation`) — currently
   logged, consumed by the watch stage later.
2. **Read miss or indicated staleness**: pull the single key as §2.5
   describes (lock-bounded, version-checked, fallback on timeout, never
   clobbering newer local state).
3. **Refresh (SWR semantics, watch foundation)**: re-reading held blocks
   needs no lock ops and no dictionary IO (mappings pinned by held
   locks), so currency checks are cheap: serve local immediately,
   revalidate in the background within the cooldown, pull on newer. The
   standalone interval/subscription-driven refresh trigger and fan-out
   are watch-stage work; the primitive, the event shape, and the cheap
   property are Stage 1.

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
  (live key count, live bytes) so a future merge pass can find
  fragmented non-active blocks without scanning block contents.
  Deliberately no block versions: per-key `keyVersion`s already gate
  every expensive read, and the dictionary walk is unavoidable for
  planning — a version skip would save only compares at the cost of
  baseline state. Stage 1 writes the stats and defers merge decisions.

### Dictionary size estimate

Measured against the actual serialized format (verified empirically):

```
dict_bytes ≈ 150 + N × (K_avg + 64) + B × 56
```

- `150`: fixed overhead (`format`, `dictionaryVersion`, 64-char
  `checksum`, braces).
- Per key: the UTF-8 key bytes plus a **constant 64 bytes** of envelope
  (`"blockId": "blk_<16 hex>"`, 13-digit `"keyVersion"`, braces,
  separators) — constant regardless of key length.
- Per block: ~56 bytes of stats (`keyCount`, `liveBytes`).
- `keyVersion` timestamps stay 13 digits until the year 2286, so the
  per-entry cost is stable; block ids are a fixed 20 chars.

Worked examples (K_avg = 20): 1K keys ≈ 85 KB; 100K keys ≈ 8.4 MB;
1M keys ≈ 84 MB in a single JSON file. That file size — not the compare
loop — is the scaling wall: sharding the dictionary (fetch only needed
entries) is the later-stage answer, and no version trick avoids reading
it while planning needs the full key→block map.

### 2.6 Conflict policy (handles non-conformant writers and crashes)

- Stored artifact **lower version or corrupt** → Global Storage
  overwrites it with its authoritative state.
- Stored artifact **higher version than this instance can interpret** →
  fail explicitly, mark the space `unhealthy`, never guess.
- Fencing tokens: every block write and dictionary update is tagged;
  a worker whose lease expired can never publish over a newer holder.
- Retried flushes are idempotent via version checks.

### 2.7 Locking protocol

Locks are medium resources (`locks/<resource>`), discoverable by every
conformant instance sharing the storage. Each carries owner (per-process
random — a restarted process is never the same holder, which is what
makes fencing sound), fencing token, and lease expiry. They coordinate
conformant instances only; non-conformant writers bypass them (handled
by §2.6).

**Families and lifetimes.** Dictionary locks are short and
transactional: acquired to stabilize a mapping operation, lapsed
shortly after — never explicitly released except via the purge prefix
wipe. Block locks are long and sticky: acquired (pre-lock at write, or
first flush), renewed while hot, lapsed when cold. The asymmetry is
principled: dict exclusion is space-global (prompt lapse matters),
block exclusion is selective (retention is reservation). No
steady-state explicit releases anywhere: expiry is the lifecycle, and
crash-safety falls out free — nothing depends on a release call a dead
process never makes. Explicit deletion happens only for proven-useless
locks (stale pre-locks at flush) and the purge wipe.

**Dict-first ordering, always.** Every block-lock acquisition sequence
begins holding the dict lock — otherwise you may lock the wrong block,
and on Drive/GitHub-class media each wasted acquisition costs hundreds
of milliseconds plus quota. The dict lock alone doesn't guarantee
correctness (only dict-lock + fresh mapping does); it guarantees you're
not acquiring blind. Resolution source is tiered for economy:
cache-first (staleness bounded by flush recency), fresh dict read on
cache miss; the flush always fresh-reads for planning. Pre-lock dict
acquisitions are singleflighted per space so bursts share one round.

**Acquisition strategies** (acquisition paths only — flush publishing
always happens under a held dict lock regardless). Configurable per
adapter capability with space override (`lockStrategy`; local default
pessimistic, quota-limited media default optimistic):
- *Pessimistic*: hold dict → resolve → acquire blocks (deterministic id
  order, all-or-nothing) → proceed. Pays dict ops on every attempt;
  never wastes a block acquisition; imposes a lease-long exclusion
  window on other planners per attempt.
- *Optimistic*: read dict → acquire block → re-read dict → validate
  (fast path: `dictionaryVersion` equal → stable; verdict: entry-level
  `blockId`+`keyVersion` compare for the key; timestamps make ABA
  impossible, so failures are always safe retries) → proceed, or release
  as useless + bounded retry (pre-lock: 1 retry then abandon to flush;
  reads: bounded by `readTimeoutMs`; refresh: paced by interval). Zero
  exclusion footprint when uncontended.
- *Escalation*: an optimistic path that discovers structural need
  (move/create) acquires the dict lock and proceeds pessimistically from
  there. High contention → pessimistic wins (retries dominate); low
  contention → optimistic wins (no footprint).
- The flush fast path (all needed blocks already held, no structural
  need) takes neither path: merely update blocks. The flush structural
  path follows the configured strategy for discovery, then holds the
  dict lock for publish in both cases.

**Renewal needs no dict lock.** Renewal extends an existing hold
(owner+fence match) without resolving anything — the fence check is the
entire safety argument. Margin is proportional with floor: renew when
remaining < `max(leaseMs × 0.25, 5000ms)` — longer leases imply costlier
media, so renew earlier. Local-validity fast path: while comfortably
within lease (local clock math, zero IO), skip all medium contact;
touch the medium only at acquisition, margin-renewal, and fresh reads.
(Cross-instance clock skew is a documented limitation.)

**Single lock outside a flush.** Outside the flush critical section,
never hold more than one block lock (release-then-acquire when
switching; single-lock holders cannot deadlock). The flush is the only
place holding lock sets, acquired deterministically. Same-process
held locks stay compatible via adoption (same owner → renew-verify,
not abandon). Reader pre-locks that prove stale are released as
known-useless.

**Contention and backpressure.** Busy locks are never waited on
indefinitely: pre-lock failure changes nothing (write already
committed); read waits are bounded by `readTimeoutMs` with background
continuation (singleflight per block, capped retries); flush abandons
the plan and reports the space back (unflushed ids) for scheduler retry.
Retries use bounded backoff with jitter in later stages; Stage 1
retries on the debounce cadence.
- Stage 1 keeps rearrangements minimal: a key moves only when its block
  would exceed the target (or an oversized value needs its own block).
  No gratuitous compaction.
- **Space deletion** acquires the space's dict lock (busy → 409/retry);
  the prefix wipe happens under it, so it can never race a flush.
- **One space at a time**: a flush processes spaces sequentially, never
  holding two dict locks at once.

### 2.9 Configuration reference

Timing policy lives in global config (`persistence.*`); lease durations
are per-medium (adapter capability defaults, space `providerConfig`
override); packing/quotas as before. Fixed-in-code policy (not knobs):
renewal margin `max(lease × 0.25, 5s)`, single-lock-outside-flush,
fence/owner semantics, deterministic acquisition order, retry bounds
(pre-lock 1 retry then abandon; reads bounded by timeout; refresh
paced by interval).

| Knob | Default | Level | Bounds |
|---|---|---|---|
| `flushDebounceMs` | 1000 | global | write→flush delay |
| `syncCooldownMs` | 5000 | global | min interval between bulk reconciles |
| `readTimeoutMs` | 1000 | global | read-path medium budget → fallback + background |
| `readRetrySpacingMs` | 100 | global | lock-attempt spacing while attached |
| `backgroundMaxAttempts` / `backgroundMaxElapsedMs` | 10 / 30s | global | detached continuation caps |
| `dictLockLeaseMs` | 30s | capability → space override | one plan+publish window |
| `blockLockLeaseMs` | 120s | capability → space override | debounce+flush+refresh retention |
| `preLockLeaseMs` | 60s | fixed (covers write→adoption; adoption converts) | reservation window |
| `lockStrategy` | pessimistic (local), optimistic (remote) | capability → space override | acquisition discipline |
| `targetBlockBytes` | 100KB | capability → space override | packing |
| `maxKeyBytes`, quotas | 10MB / 50MB / 1GB | `spaces.*` | admission |

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
  delete-block-when-empty.
- `FlushWorker`: §2.5/§2.6/§2.7 end-to-end (fast path when all blocks
  held, else lock → cooldown-gated reconcile per §2.8 → plan → write →
  verify → publish dictionary under held dict lock → conditional
  persist-mark → purge confirmed tombstones; backpressure via unflushed
  ids; unhealthy on higher-version or conflicting data).

### Phase 3c — Doctrine reconciliation (next)
Bring the implementation to §2.7: `lockStrategy` capability + space
override with optimistic validate paths and pessimistic escalation;
pre-lock dict-first + singleflight + local short-circuit; lapse-based
release (drop worker finally-release-all; purge wipe stays); renewal
margin formula + local-validity fast paths; read path
(staleness-indicated lock+read, timeout, fallback, background
continuation, singleflight); serve-direct on held-continuous;
flush fast path (skip dict when all held + no structural need);
reconcile ChangeEvents. Done already: `getKeyEntries`, requeue,
per-process owner ids, dict-free renewal.

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

Durable mutation outbox, background worker processes, Solid/S3/Drive
adapters, eviction sweeper, orphan-block GC, medium dictionary
tombstones for multi-instance delete races, hybrid logical clocks,
standalone refresh loop + watch fan-out, OAuth applications, change
notifications, real multi-user tenancy, paid plans.

## 5. Standing rules (from this project's AGENTS.md)

- Migrations only via `npm run migration:create:sqlite` / `:pg`
  (never hand-written, never plain `mikro-orm migration:create`).
- Never remove code you did not write; fix only your own code on
  failure, otherwise stop and show the failure + proposed fix.
- No push to remote without explicit approval. No extra `.md` files
  (this file is explicitly requested).
