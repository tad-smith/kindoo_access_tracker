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

**Check both the Auth record and the current claim state in one step**,
using the `canonical` value from the console breadcrumb. `--format` isn't
needed if the target file ends in `.json` — `firebase auth:export` infers
format from the extension and errors out before doing anything else if it
can't (`firebase-tools/lib/accountExporter.js`'s `validateOptions`), so a
bare `$(mktemp)` (no extension) fails immediately:

```bash
out=$(mktemp).json
firebase auth:export "$out" --project staging   # or: --project prod
jq --arg email "<canonical from the breadcrumb>" \
  '.users[] | select(.email == $email) | {uid: .localId, email, customAttributes}' "$out"
rm -f "$out"
```

Match on `.email`, exactly, not a substring test — `contains` on
`customAttributes` matches any user whose claims JSON happens to *contain*
the canonical string anywhere, which includes an unrelated account whose own
canonical is a superstring of this one (`admin@csnorth.org` is a substring
of `superadmin@csnorth.org`); a privileged write keyed off that match would
land on the wrong account. Exact-match on `.email` is also more reliable
when the claim never minted at all (this runbook's main scenario): `.email`
comes from the Auth record itself, set at account creation, independent of
whatever `customAttributes` may or may not hold.

This assumes the stored (typed) email is byte-identical to the canonical
one — true for this app's non-Gmail stake domains, since `canonicalize()`
only lowercases those and Firebase Auth already stores email lowercased.
For a Gmail-family bootstrap admin, canonicalisation also collapses dots
and `+suffix` (`packages/shared/canonicalEmail.ts`), so the stored address
can differ from the canonical breadcrumb value — pull the typed email from
the affected `stakes/{stakeId}` doc's `bootstrap_admin_email` field instead
(the same source `deploy.md`'s B-19 backfill uses) and match on that.

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
- **Present, but `uid` is missing, not a string, or the empty string** →
  `uidForCanonical` (`functions/src/lib/uidLookup.ts`) treats this exactly
  like a missing doc — `if (!data || typeof data.uid !== 'string' || data.uid === '') return null;`
  — so the claim can never mint here either, for the same reason. Fix via
  §3a (the doc-repair step there covers this case too).
- **Present, with a `uid` field that does NOT match the `localId` from the
  `jq` output above** → don't assume either value is "right," and don't
  jump to §3b. This is the dual-provider uid split `signIn.ts` documents
  (`apps/web/src/features/auth/signIn.ts`): a magic-link sign-in and a
  Google sign-in can mint two separate Firebase Auth users for what
  canonicalises to the same address, and whichever one signed in most
  recently is the one `onAuthUserCreate` last pointed `userIndex` at — not
  necessarily the one the admin is stuck using right now. Look the stored
  `uid` up directly in the Authentication console (Authentication → Users →
  search by UID) to see what email/provider it belongs to, and ask the
  admin which sign-in method they're actually using. Fix via §3a, repointing
  `uid` at whichever account is the one the admin is actually authenticating
  as — which may be the `jq` match, or may be neither.
- **Present, with a `uid` field matching the `localId` from the `jq`
  output above** → not this cause. Fix via §3b (the blunter fallback, when
  it applies — see its gating note below), or dig further (e.g. confirm
  `stakes/{stakeId}/kindooManagers/{canonical}` really has `active: true` —
  `computeStakeClaims` reads it to decide `manager`).

## 3a. Fix: repoint `userIndex/{canonical}`, then mint the claim yourself

Covers all three §2 branches that route here: the doc missing entirely, an
invalid `uid` field, and a mismatched `uid` field.

**Step 1 — fix the doc.** Firestore console → `userIndex` collection:

- **Doc missing** → **Add document**. Document ID: the canonical email from
  the breadcrumb (e.g. `admin@csnorth.org`).
- **Doc present, `uid` invalid or mismatched** → open the existing doc and
  edit its `uid` field in place; leave `typedEmail` / `lastSignIn` alone
  unless §2 found those wrong too.

Fields, matching exactly what `onAuthUserCreate` writes
(`functions/src/triggers/onAuthUserCreate.ts`, and the type at
`packages/shared/src/types/userIndex.ts`):

| Field | Type | Value |
| --- | --- | --- |
| `uid` | string | the correct uid — the `localId` from the `jq` output in §2, **unless** §2's mismatch branch identified a different uid as the one the admin actually authenticates as |
| `typedEmail` | string | the `email` field from the matching Auth record |
| `lastSignIn` | timestamp | now |

Save.

**Step 2 — mint the claim yourself; don't rely on the admin's next Complete
Setup click.** `useCompleteSetupMutation`
(`apps/web/src/features/bootstrap/hooks.ts`) is re-issue-then-throw, not
re-issue-then-repoll: on a claim miss it re-issues the `kindooManagers`
write and throws immediately, so it takes a *second* click to see a claim
that mints as a result of the first — and by then the first click's own
`waitForPostFlipAdminAccess` poll has already forced one token refresh,
which is irrelevant here but easy to conflate with the refresh-token
problem in §4. Skip the two-click dependency entirely: fire
`syncManagersClaims` yourself, with the same throwaway-write trick the B-19
backfill in `infra/runbooks/deploy.md` uses on the stake doc, but here on
the manager doc so it fires the right trigger:

Firestore console → `stakes/{stakeId}/kindooManagers/{canonical}`:

- Add a field named `_touch`, type string, any value (e.g. `backfill`) →
  Save.
- Delete the `_touch` field → Save.

Either the add or the delete alone fires `onDocumentWritten` and re-runs
`syncManagersClaims`; doing both just leaves the doc as it was. This now
succeeds — `uidForCanonical` resolves against the doc fixed in Step 1 — and
mints the claim, which revokes the admin's refresh token as a side effect
(same as every other claims-writing trigger in this repo).

**Step 3 — verify it landed before touching §4:**

```bash
out=$(mktemp).json
firebase auth:export "$out" --project staging   # or: --project prod
jq --arg email "<canonical from the breadcrumb>" \
  '.users[] | select(.email == $email) | .customAttributes' "$out"
rm -f "$out"
```

Expected: a JSON string containing
`"stakes":{"<stakeId>":{"manager":true,...}}` for the affected stake. If it
doesn't, Step 1's doc fix didn't take, or something else is blocking the
trigger — go dig further per §2's last bullet before falling back to §3b.

Only once this shows `manager:true` → continue to §4.

## 3b. Fallback: stamp the claim directly

Use this when §2's decision tree puts you on its last bullet —
`userIndex/{canonical}` is present and its `uid` already matches — and
digging further (the `active: true` check, etc.) didn't turn up a fix. Not
merely because the admin needs to be unblocked faster than §3a's round trip:
if `userIndex/{canonical}` is actually missing or wrong (any of §2's other
three branches), this path leaves that doc broken permanently, since it
bypasses the doc `uidForCanonical` reads — every future claim sync for this
admin keeps no-oping on the same lookup miss, indefinitely, not just for
this one incident. Prefer §3a whenever it applies; only fall through to this
path once it doesn't.

This bypasses `syncManagersClaims` entirely and writes the claim with the
Admin SDK.

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

   Note: unlike the sync triggers' `mergeStake` helper
   (`functions/src/lib/applyClaims.ts:214-217`), which deliberately carries
   an existing `bootstrap: true` on this stake's block forward across a
   replace, the literal object above does not — it's a plain overwrite of
   the stake's entry. That's a deliberate simplification of this manual
   path, not an oversight: this stake's `bootstrap` flag exists to let the
   admin read the stake doc pre-flip, and `manager: true` grants the write
   access this recovery is actually for, so dropping `bootstrap` here
   doesn't block anything in this runbook's flow. If you're hand-editing
   this snippet for a case where the admin still needs `bootstrap` preserved
   (e.g. they're not about to flip `setup_complete` immediately), carry the
   existing `stakes[stakeId].bootstrap` value forward explicitly.

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

   `setCustomUserClaims` and `revokeRefreshTokens` both complete inside this
   script before it logs `stamped` — unlike §3a, there's no separate wait
   for a trigger to react. Re-running §2's `jq` check now (against `.email`
   for this admin) will already show `manager:true`; it reconfirms rather
   than diagnoses a race.

This is the blunt path — it skips the trigger and the doc it reads, so it
doesn't fix whatever actually broke `syncManagersClaims` for this admin (if
it wasn't a `userIndex` problem).

## 4. After either fix: the admin needs a full sign-out/sign-in, not a reload

By the time you reach this step, the claim has already been minted and
verified — §3a's Step 3 or §3b's re-run of the `jq` check both confirm
`manager:true` before you get here. Both paths mint via a
`revokeRefreshTokens` call — §3a's indirectly via `syncManagersClaims` →
`applyStakeClaims`, §3b's explicitly in the one-liner. Same caveat as the
B-19 backfill in `infra/runbooks/deploy.md`: a revoked refresh token makes
the SPA's own silent token refresh fail outright, so the admin's current
session cannot pick up the new claim on its own, and clicking Complete Setup
on a stale session can throw an unrelated auth-refresh error instead of
succeeding (`waitForPostFlipAdminAccess` forces a token refresh before
checking claims, and a forced refresh against a revoked refresh token
fails).

Have them sign out completely — close every tab open on the origin, not
just click sign-out and stay on the page — then sign back in. That mints a
new ID token and a new refresh token together, carrying the claim that's
already been minted and verified. They should land back on the bootstrap
wizard with Complete Setup able to succeed on the first click.

## Manual verification

The claim-landed check already happened inline (§3a Step 3, or §3b's note
after its script) — doing it again here, before the admin has even signed
back in, would just re-run the same check on an unchanged state. What's
left to confirm is the actual end-to-end flow:

Admin signs out/in per §4, opens the wizard, clicks **Complete Setup**.
Expected: no toast error, redirect off the wizard, and
`stakes/{stakeId}.setup_complete == true` in the Firestore console.

If Complete Setup still fails at this point, the claim genuinely isn't on
the token the admin is using — re-check that they closed every tab (a
lingering tab can keep serving a cached pre-revoke token) before re-opening
§2's diagnosis.

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
