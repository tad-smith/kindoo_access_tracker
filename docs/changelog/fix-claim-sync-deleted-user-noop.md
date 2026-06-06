# No-op claim sync when the auth user is gone

**Shipped:** 2026-06-05
**Commits:** PR #218 (`fix/claim-sync-deleted-user-noop`) — fix + test `0b1b4ce`, docs (this commit)

## What shipped

The three claim appliers in `functions/src/lib/applyClaims.ts` — `applyStakeClaims`, `applySuperadminClaim`, `applyFullClaims` — no longer throw when the auth user has been deleted out from under them. A missing user is now a benign, observable no-op: the applier logs a structured skip and returns without writing claims. Any other error still throws, so Eventarc still retries on genuine failures.

This is a production bugfix, not a behaviour change a manager would notice. It removes an infinite Eventarc retry storm and de-flakes `functions/tests/syncSuperadminClaims.e2e.test.ts`.

## The bug

Each applier began with `auth.getUser(uid)`, then computed and wrote the merged claim block. A role-doc write can outlive its auth user: the user is deleted between the role-doc write and the claim-sync trigger firing. This is a real race in prod and a constant in the integration suite, where sibling tests create-then-delete users under the same emulator. When the user is gone, `getUser` throws `auth/user-not-found`. The unhandled throw propagated out of the Firestore trigger; Eventarc treats a thrown trigger as a delivery failure and retries it — forever. CI observed roughly 82 re-throws over ~58 seconds before the run was killed.

That storm was also the root cause of a separate symptom: the flaky `syncSuperadminClaims.e2e.test.ts`. The retry storm saturated the emulator and starved that test's trigger delivery, so it intermittently timed out waiting for a claim that never landed in time. One missing-user race manifested as two unrelated-looking failures.

## The fix

`getUser` is now wrapped by `loadExistingClaims`, which catches `auth/user-not-found`, emits a `logger.info` skip (`{ uid }`), and returns a `USER_GONE` sentinel. Each applier returns cleanly on the sentinel — no throw means no Eventarc retry. The claim write itself is wrapped by `writeClaims`, which tolerates a *late* `auth/user-not-found` from `setCustomUserClaims` / `revokeRefreshTokens` (the user can vanish between the read and the write); that too becomes a logged no-op. Detection is by the Admin SDK error `code`, not a message-string match, so it survives SDK message changes. Every other error still rethrows exactly as before.

## Why a no-op rather than a guard at the trigger

The missing-user case has no meaningful work to do — there is no auth user to stamp claims onto. Swallowing it inside the appliers (rather than, say, pre-checking existence in each of the three sync triggers) keeps the "is the user still here?" logic in one place, next to the `getUser` call that can race, and keeps the three triggers thin. It also handles the narrow second window — user deleted *after* the read, *during* the write — which a trigger-level pre-check cannot. The skip is logged, not silenced: an operator can still see that a sync was dropped and why, satisfying the workspace's "don't silently swallow errors" rule.

This extends the existing no-op contract the sync triggers already carry. `syncSuperadminClaims` (and its siblings) already bail when `uidForCanonical` returns `null` — i.e. no auth user maps to the canonical email at trigger time. The new guard closes the narrower window where a user *does* map at `uidForCanonical` time but is deleted before or during the applier's own `getUser` / write. Same outcome (skip the sync), one layer deeper.

## What didn't change that you'd expect to

- **No spec change.** The new no-op is consistent with the documented `uidForCanonical → null` no-op already in `spec.md` §4 ("Claim staleness"). The PR reviewer judged no spec surface affected; the spec describes the happy-path mint/revoke and does not enumerate the missing-user case, so there is nothing to correct.
- **Retry semantics for real failures are untouched.** Only `auth/user-not-found` is treated as benign. A transient Firestore/Auth error, a permissions failure, or any other Admin SDK error still throws, and Eventarc still retries — which is the behaviour you want for a genuinely recoverable failure.
- **`revokeRefreshTokens` rate-limit discipline is unchanged.** The claims-equal short-circuit (`claimsEqual`) still gates the revoke, so a no-op sync still skips the revoke; the new code only adds the missing-user exit ahead of that check.
- **`KINDOO_SKIP_CLAIM_SYNC` test short-circuit is unchanged.** The E2E opt-out still fires first, before any `getUser`.

## Spec / doc edits

- `docs/BUGS.md` — added `[B-17]` (the `syncSuperadminClaims.e2e.test.ts` flake + its `auth/user-not-found` retry-storm root cause), status `closed (fixed in PR #218)`.

## Known issues / deferred

None. The fix ships with an emulator-driven test covering all three appliers (no throw, no claims written, skip logged) plus a present-user control, and de-flakes `syncSuperadminClaims.e2e.test.ts` in the same commit.
