# firestore — Claude Code guidance

Firestore Security Rules + composite-index declarations + their tests. Defense-in-depth for every read and write.

**Owner agent:** `backend-engineer` (same agent owns `functions/`).

## Stack

- `firestore.rules` (rules_version = '2')
- `firestore.indexes.json`
- `@firebase/rules-unit-testing` for tests
- Vitest test runner
- Auth emulator + Firestore emulator for local rule evaluation

## File layout

```
firestore.rules                    # the rules
firestore.indexes.json             # composite indexes (single-field auto-create)
tests/                             # one test file per match block
└── lib/
    └── rules.ts                   # helpers for mounting rules in tests
```

## Conventions

- **Helper functions at top.** `isAuthed`, `authedCanonical`, `isManager`, `isStakeMember`, `bishopricWardOf`, `isAnyMember`, `isPlatformSuperadmin`, `lastActorMatchesAuth`. Defined once; reused.
- **Match blocks in canonical order** matching `docs/firebase-schema.md` §§3–4. (userIndex → platformSuperadmins → platformAuditLog → stakes → wards → buildings → kindooManagers → access → seats → requests → templates → auditLog.)
- **Inline comments explain non-obvious rules** — `getAfter()` use, split-ownership on access, the `lastActor` integrity check.
- **Composite indexes carry comments** about which query (in `apps/web/` or `functions/`) requires them. When the query is removed, the index can be too.
- **Tests in `tests/` mirror the rules structure.** One test file per match block. Synthetic auth tokens via the Auth emulator helper.
- **Rules check `request.auth.token` for role claims.** Custom claims are the fast path; only `getAfter()` cross-doc invariants reach into other documents.

## Don't

- **Don't add a rule without a passing test.** Rules tests are non-negotiable per the migration plan F13.
- **Don't loosen rules without an inline comment** explaining why.
- **Don't allow client writes to system collections** (auditLog, userIndex, platformAuditLog). Those are server-only via Admin SDK.
- **Don't use `get()` in rules where `exists()` works.** `get()` reads + parses the doc; `exists()` is a cheap presence check. Latency matters in rules.
- **Don't add composite indexes "just in case."** Add them when a query demands one. Stale indexes are silent storage cost.

## Boundaries

- **Web-engineer added a new query that needs an index** → they PR the index alongside the query and tag you for review.
- **Web-engineer requests a new rule** → `TASKS.md` entry from them; you write rule + passing test.
- **Schema change** in `packages/shared/` → coordinate via `TASKS.md`; rules may need updating.
- **Phase B (multi-stake) collection-group rules** → significant rewrite; coordinate with web-engineer's principal-shape change.

## Tests

- **Every collection has rules tests** covering: anonymous read denied, authed non-member read denied, authed member read allowed, cross-stake read denied, all client write paths (allowed + denied).
- **Use synthetic auth tokens** with custom claims via the Auth emulator's `signInWithCustomToken`.
- **`getAfter()` paths get a dedicated test** that proves the cross-doc invariant works in both emulator and (via staging deploy) production.
