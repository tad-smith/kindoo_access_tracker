# firestore/

Firestore Security Rules and composite-index declarations.

**Owner agent:** `backend-engineer`. See `firestore/CLAUDE.md` for conventions.

## Files

| File                     | Status (Phase 3) |
|---|---|
| `firestore.rules`        | Full per-collection rules per `docs/firebase-schema.md` §6. Helpers, the `tiedToRequestCompletion` cross-doc invariant, and split-ownership on `access` are all in place. |
| `firestore.indexes.json` | Composite indexes per `docs/firebase-schema.md` §5.1 (five on `auditLog`, four on `requests`). See "Index justifications" below for which query each one supports. |
| `tests/`                 | One rules-unit-testing suite per match block. Every collection has anon-deny / non-member-deny / member-allow / cross-stake-deny / write-path coverage. The Phase 1 `setup.test.ts` smoke and the Phase 2 `userIndex.test.ts` survive into Phase 3. |

## Index justifications

JSON doesn't admit comments, so the per-index rationale lives here. If a query is removed, the matching index can be too.

`auditLog` — per-stake `COLLECTION`-scope indexes (queried as `stakes/{stakeId}/auditLog`, not collection-group):

- `(action ASC, timestamp DESC)` — filter by action.
- `(entity_type ASC, timestamp DESC)` — filter by entity type.
- `(entity_id ASC, timestamp DESC)` — per-entity history view (one seat or one request's lifecycle).
- `(actor_canonical ASC, timestamp DESC)` — filter by actor (Importer activity, manager activity).
- `(member_canonical ASC, timestamp DESC)` — cross-collection per-user view (every audit row about one member).

The default Audit Log page view (`.orderBy('timestamp', 'desc')` with no `where`) does not need a declared index: Firestore auto-creates ASC + DESC single-field indexes at `COLLECTION` scope by default. Declaring it as a composite was rejected by the deploy with `this index is not necessary, configure using single field index controls` — the entry was removed in `fix/firestore-unnecessary-index`.

`requests` — collection-group indexes:

- `(status ASC, requested_at ASC)` — manager queue, pending FIFO (oldest pending first).
- `(status ASC, completed_at DESC)` — manager queue, resolved (newest-resolved first).
- `(requester_canonical ASC, requested_at DESC)` — MyRequests (one user's requests, newest first).
- `(scope ASC, status ASC, requested_at ASC)` — manager queue scoped by ward (filter by scope + status, ordered).

`access`, `kindooManagers`, `wards`, `buildings`, `*CallingTemplates`: no composite indexes. These collections are small enough at v1 scale (~12 wards, ~250 seats) to load fully and filter client-side; per `firestore/CLAUDE.md`, indexes are added only when a real query needs one.

`seats`: single-field on `scope` (auto-created on first query) covers most reads. Bishopric / stake-roster pages filter by scope; managers load all and filter client-side.

## TTL configuration (operator action)

Firestore TTL on `auditLog.ttl` is configured once via `gcloud`, not declared in source:

```bash
gcloud firestore fields ttls update ttl \
  --collection-group=auditLog \
  --enable-ttl \
  --project=<staging-project>
```

Repeat for the production project. Optionally also for `platformAuditLog` if retention there matters. See `docs/TASKS.md` entry T-15 for the operator follow-up.

## Why locked-down rules in earlier phases

Phase 1 shipped a lock-everything stub; Phase 2 added a single allow-list for `userIndex/{canonical}` self-reads. Phase 3 (this commit) replaces the stub with the full rule matrix; the Phase 2 `userIndex` block is preserved verbatim.
