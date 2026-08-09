# Recover a bootstrap admin whose manager claim never mints

Operator playbook for the fail-closed gate `useCompleteSetupMutation` added in
PR #260 (`docs/architecture.md` D30). That gate refuses to flip a stake's
`setup_complete` to `true` unless the bootstrap admin's ID token already
carries the `manager` claim for that stake — flipping without it would strand
them permanently, because `isBootstrapAdmin(stakeId)` and
`isSetupInProgressReadable(stakeId)` (`firestore/firestore.rules`) are both
gated on `setup_complete == false`, so the instant the flip lands they can no
longer read the stake doc or write `kindooManagers` to fix it themselves.

Fail-closed is correct. But it means a persistent underlying fault — the
claim never minting no matter how many times the admin clicks Complete
Setup — has no in-app recovery. This is that recovery, run by the operator
from their own laptop against the Firestore + Authentication consoles and
the `firebase` CLI. Expected to come up rarely: at most once per stake
onboarded, and only when something is actually wrong.

## When this happens

Any time a stake is onboarded, between `createStake` and that stake's
bootstrap admin clicking Complete Setup. Not tied to a deploy — unlike the
B-19 backfill in `infra/runbooks/deploy.md`, there is no "run this once after
this specific deploy" window here. It can happen to the tenth stake as
easily as the second.

## Prereqs

- Firestore console + Authentication console access to the target project
  (`kindoo-staging` for rehearsal, `kindoo-prod` for live).
- `firebase` CLI, logged in and able to run `firebase auth:export --project
  <project>`.
- `jq`.
- Only for the blunter fallback (§3b below): `gcloud auth
  application-default login` run at least once, with a Google account that
  holds a role able to manage Firebase Auth users on the target project
  (e.g. Firebase Admin, or project Editor/Owner), and a local checkout of
  this repo so `functions/`'s `firebase-admin` dependency is resolvable.

## 1. Recognise it

- The admin is stuck on the bootstrap wizard. Clicking **Complete Setup**
  repeatedly shows `Completing…` then toasts:

  > Setup access is still syncing — wait a moment and try Complete Setup
  > again.

  That message is honest, not a lie the operator has to work around: each
  attempt really does re-issue the idempotent
  `stakes/{stakeId}/kindooManagers/{canonical}` write, giving
  `syncManagersClaims` another chance to fire. The message just can't
  distinguish "give it a few more seconds" from "this will never resolve on
  its own" — see the next bullet for the signal that does.
- The admin's own browser console (DevTools) carries, on each failed
  attempt:

  ```
  [complete-setup] manager claim did not land after re-issue { stakeId: "...", canonical: "..." }
  ```

  Ask the admin to open DevTools → Console and read off (or screenshot)
  `stakeId` and `canonical`. Both are needed for diagnosis below.

## 2. Diagnose the cause

The known cause: `syncManagersClaims`
(`functions/src/triggers/syncManagersClaims.ts`) resolves the canonical
email to a Firebase Auth uid via `userIndex/{canonical}`, and early-returns
if that lookup misses:

```ts
const uid = await uidForCanonical(memberCanonical);
if (!uid) return;
```

If `userIndex/{canonical}` doesn't exist, the claim can never mint — not on
the first attempt, not on the hundredth. `userIndex` is normally written by
`onAuthUserCreate` at the admin's first-ever sign-in
(`functions/src/triggers/onAuthUserCreate.ts`); this gap means that write
didn't happen or didn't land before `syncManagersClaims` needed it.

**Check both the doc and the current claim state in one step**, using the
`canonical` value from the console breadcrumb:

```bash
out=$(mktemp)
firebase auth:export "$out" --project staging   # or: --project prod
jq --arg canonical "<canonical from the breadcrumb>" \
  '.users[] | select((.customAttributes // "{}") | contains($canonical)) | {uid: .localId, email, customAttributes}' "$out"
rm -f "$out"
```

This returns the admin's uid, typed-form email, and current
`customAttributes` (their claims, as a JSON string) in one shot — useful
regardless of which fix path you end up on. Confirm the claim is actually
missing: `customAttributes` should have no `"stakes":{"<stakeId>":{"manager":true,...}}` entry for the affected `stakeId`. If it already shows
`manager:true`, the claim landed and the admin's stuck token is a stale-cache
problem, not a minting problem — skip straight to §4 (full sign-out/sign-in)
without touching `userIndex`.

Then check the doc itself in the Firestore console:

<https://console.firebase.google.com/project/kindoo-staging/firestore/data/~2FuserIndex>
(or `kindoo-prod`) → look for a doc at `userIndex/<canonical>`.

- **Missing** → known cause confirmed. Fix via §3a.
- **Present**, with a `uid` field matching the `localId` from the `jq`
  output above → not this cause. Fix via §3b (the blunter fallback), or dig
  further (e.g. confirm `stakes/{stakeId}/kindooManagers/{canonical}` really
  has `active: true` — `computeStakeClaims` reads it to decide `manager`).

## 3a. Fix: write the missing `userIndex/{canonical}`

Firestore console → `userIndex` collection → **Add document**:

- **Document ID:** the canonical email from the breadcrumb (e.g.
  `admin@csnorth.org`).
- **Fields**, matching exactly what `onAuthUserCreate` writes
  (`functions/src/triggers/onAuthUserCreate.ts`, and the type at
  `packages/shared/src/types/userIndex.ts`):

  | Field | Type | Value |
  | --- | --- | --- |
  | `uid` | string | the `localId` from the `jq` output in §2 |
  | `typedEmail` | string | the `email` field from the same `jq` output |
  | `lastSignIn` | timestamp | now |

Save. Nothing else to do here — have the admin click **Complete Setup**
again. That retry re-issues the `kindooManagers` write, `syncManagersClaims`
fires, `uidForCanonical` now resolves, and the claim mints. **But see §4
before telling them to retry** — minting the claim revokes their refresh
token, so a bare retry click can fail with an unrelated auth error unless
they've signed out and back in first.

## 3b. Fallback: stamp the claim directly

Use this when §2 didn't find a missing `userIndex` doc (some other cause is
blocking the trigger), or when the admin needs to be unblocked immediately
rather than wait on the retry round-trip. This bypasses `syncManagersClaims`
entirely and writes the claim with the Admin SDK.

1. From the `jq` output in §2, take the existing `customAttributes` JSON
   string and parse it. Build the merged claims object: keep every existing
   field (in particular `canonical`, and any other stake's entry under
   `stakes`) and set the affected stake's entry to
   `{ "manager": true, "stake": false, "wards": [] }`. Example, starting
   from `{"canonical":"admin@csnorth.org"}`:

   ```json
   {
     "canonical": "admin@csnorth.org",
     "stakes": {
       "<stakeId>": { "manager": true, "stake": false, "wards": [] }
     }
   }
   ```

   `setCustomUserClaims` replaces the whole claims object — don't skip
   merging in fields the admin already had (e.g. `manager`/`wards` claims on
   a different stake they administer).

2. Run, from a checkout of this repo:

   ```bash
   cd functions
   node --input-type=module -e "
   import { initializeApp, applicationDefault } from 'firebase-admin/app';
   import { getAuth } from 'firebase-admin/auth';

   initializeApp({ credential: applicationDefault(), projectId: 'kindoo-staging' }); // or kindoo-prod

   const uid = '<localId from the jq output in step 2>';
   const claims = <the merged claims object from step 1, as JSON>;

   const auth = getAuth();
   await auth.setCustomUserClaims(uid, claims);
   await auth.revokeRefreshTokens(uid);
   console.log('stamped', uid);
   "
   ```

This is the blunt path — it skips the trigger and the doc it reads, so it
doesn't fix whatever actually broke `syncManagersClaims` for this admin (if
it wasn't the missing `userIndex` doc). Prefer §3a when it applies.

## 4. After either fix: the admin needs a full sign-out/sign-in, not a reload

Both paths above end in a `revokeRefreshTokens` call — §3a's indirectly via
`syncManagersClaims` → `applyStakeClaims`, §3b's explicitly in the one-liner.
Same caveat as the B-19 backfill in `infra/runbooks/deploy.md`: a revoked
refresh token makes the SPA's own silent token refresh fail outright, so the
admin's current session cannot pick up the new claim on its own, and a bare
retry of Complete Setup can throw an unrelated auth-refresh error instead of
succeeding (`waitForPostFlipAdminAccess` forces a token refresh before
checking claims, and a forced refresh against a revoked refresh token
fails).

Have them sign out completely — close every tab open on the origin, not
just click sign-out and stay on the page — then sign back in. That mints a
new ID token and a new refresh token together. They should land back on the
bootstrap wizard with Complete Setup now able to succeed.

## Manual verification

After either fix, before telling the admin to retry:

```bash
out=$(mktemp)
firebase auth:export "$out" --project staging   # or: --project prod
jq --arg canonical "<canonical from the breadcrumb>" \
  '.users[] | select((.customAttributes // "{}") | contains($canonical)) | .customAttributes' "$out"
rm -f "$out"
```

Expected: a JSON string containing `"stakes":{"<stakeId>":{"manager":true,...}}` for the affected stake. If it still doesn't show `manager:true`,
the fix didn't land — re-check §2's diagnosis before retrying either path.

Then confirm end-to-end: admin signs out/in per §4, opens the wizard,
clicks **Complete Setup**. Expected: no toast error, redirect off the
wizard, and `stakes/{stakeId}.setup_complete == true` in the Firestore
console.

## See also

- `docs/architecture.md` D30 — the fail-closed gate this runbook recovers
  from, and why it's deliberately narrower than the post-flip stake-doc read
  rule.
- `docs/architecture.md` D28 / `docs/BUGS.md` B-19 — the related (but
  distinct) stake-discovery gap and its deploy-triggered backfill, at
  `infra/runbooks/deploy.md` § "One-time fixup: backfill the `bootstrap`
  claim after PR #258". That fixup is a one-time, post-deploy step for
  stakes that predate PR #258; this runbook is a standing, any-time
  procedure with no deploy trigger — hence living on its own rather than as
  another `deploy.md` subsection.
- `infra/runbooks/seed-platform-superadmin.md` — same
  canonical-email/`userIndex`/claim-sync mechanics, for a different
  collection (`platformSuperadmins`).
- `functions/src/triggers/syncManagersClaims.ts`,
  `functions/src/triggers/onAuthUserCreate.ts`,
  `functions/src/lib/uidLookup.ts` — the trigger code this runbook works
  around.
- `apps/web/src/features/bootstrap/hooks.ts` — `useCompleteSetupMutation`,
  `waitForPostFlipAdminAccess`, `canAdministerStakePostFlip`.
