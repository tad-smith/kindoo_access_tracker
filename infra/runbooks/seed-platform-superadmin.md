# Seed a platform superadmin (Phase 12 / 12.1)

Operator runbook for adding (or removing) an entry in the
`platformSuperadmins/{canonical}` collection. Each write here is
picked up by the `syncSuperadminClaims` Cloud Function trigger, which
mints or revokes the `isPlatformSuperadmin: true` custom claim on the
matching Firebase Auth user. The claim gates the Superadmin nav
section (Stake List page; ships in 12.2) and any future
superadmin-only surface.

Console-only by design — see `docs/firebase-migration.md` Phase 12
operator-resolved decision #2 and `docs/firebase-schema.md` §3.2.
There is no in-app UI for adding or removing superadmins, and there
will not be one. The chicken-and-egg of "who creates the first
superadmin?" plus the operator's preference to keep this surface
small means the Firestore console is the management surface.

## When to run this

- **Before 12.2's Stake List page renders for a fresh project.** A
  zero-role superadmin (no manager / stake / bishopric grant on any
  stake) needs the `isPlatformSuperadmin: true` claim to reach
  `/superadmin/stakes`; otherwise the SPA routes them to "not
  authorized." Seed at least one entry before the first superadmin
  signs in for that purpose.
- **To add additional superadmins.** Any operator with Firestore
  console access can add another superadmin entry.
- **To revoke a superadmin.** Delete the doc; the trigger revokes the
  claim and forces a refresh on the affected user's next request.

## Prereqs

- Firestore console access to the target project (`kindoo-staging`
  for rehearsal, `kindoo-prod` for live). Project Editor or Datastore
  Admin role is sufficient.
- The **typed-form** email of the user — exactly as registered with
  Google. Case, dots, and `+suffix` matter for display; the runbook
  computes the canonical form (the doc ID) from it.

## Steps

### 1. Compute the canonical email

The doc ID is the canonical form. Per
[`packages/shared/src/canonicalEmail.ts`](../../packages/shared/src/canonicalEmail.ts):

1. Lowercase + trim the typed email.
2. **For `@gmail.com` / `@googlemail.com` only**: strip dots from the
   local-part, drop everything from `+` onward, fold the domain to
   `gmail.com`.
3. Non-Gmail addresses keep their dots and `+suffix` literally.

Examples:

| Typed | Canonical (= doc ID) |
| --- | --- |
| `Super.Admin@gmail.com` | `superadmin@gmail.com` |
| `Super+work@googlemail.com` | `super@gmail.com` |
| `Operator@example.org` | `operator@example.org` |
| `O.PERATOR@example.org` | `o.perator@example.org` |

If you're not sure, the same `canonicalEmail()` function is exposed
in the SPA — sign in as anyone, open DevTools, and run:

```js
// In an authenticated SPA session:
(await import('/src/lib/canonicalEmail.js')).canonicalEmail('Typed.Email@gmail.com')
```

### 2. Create the document in the Firestore console

1. Open
   <https://console.firebase.google.com/project/kindoo-staging/firestore/data/~2FplatformSuperadmins>
   (or substitute `kindoo-prod` for live).
2. If the `platformSuperadmins` collection does not exist yet, click
   **Start collection** and name it `platformSuperadmins`.
3. Click **Add document** (or **Start collection** → next step) and
   set:
   - **Document ID:** the canonical email from step 1 (e.g.
     `superadmin@gmail.com`). The doc ID IS the canonical email; there
     is no separate `canonical` field.
   - **Fields** (per
     [`docs/firebase-schema.md`](../../docs/firebase-schema.md) §3.2):

     | Field | Type | Value |
     | --- | --- | --- |
     | `email` | string | the **typed-form** email, e.g. `Super.Admin@gmail.com` |
     | `addedAt` | timestamp | now |
     | `addedBy` | string | canonical email of the operator making the change (typically your own) |
     | `notes` | string (optional) | free-form rationale (e.g. "bootstrap superadmin 2026-05-18") |

4. Click **Save**.

The `syncSuperadminClaims` trigger fires within a few seconds. If the
target user has already signed in at least once (i.e.
`userIndex/{canonical}` exists), the trigger calls
`setCustomUserClaims` with `isPlatformSuperadmin: true` and then
`revokeRefreshTokens` so the next request the user makes picks up
fresh claims.

If the target user has **never signed in**, the trigger short-circuits
(it cannot resolve the canonical → uid without a `userIndex` entry).
That is not an error — the claim will land at first sign-in via
`onAuthUserCreate`, which calls `seedClaimsFromRoleData` and reads the
`platformSuperadmins/{canonical}` doc as part of building the initial
claim set. See "Edge cases" below.

### 3. Verify

The fastest path is to have the target user sign in to the SPA and
inspect their token in DevTools:

```js
// In an authenticated SPA session (the superadmin's session):
const auth = (await import('firebase/auth')).getAuth();
const tokenResult = await auth.currentUser.getIdTokenResult(/* forceRefresh */ true);
console.log(tokenResult.claims.isPlatformSuperadmin);
// Expected: true
```

If the user was already signed in when you added the doc, they may
need to refresh the page (or wait up to ~1 hour for the idle-token
refresh window — see `docs/architecture.md` D15 / `spec.md` §4 on
claim staleness). The `revokeRefreshTokens` call the trigger makes
forces the next request from that session to mint a new ID token with
the fresh claim.

Once 12.2 (Stake List page) ships, the UI-level verification is: sign
in, expect to see the **Superadmin** section in the app shell's nav,
expect the **Stake List** entry to navigate to `/superadmin/stakes`.

### 4. Removal

To revoke a superadmin, delete the doc:

1. Open
   <https://console.firebase.google.com/project/kindoo-staging/firestore/data/~2FplatformSuperadmins>
   (or `kindoo-prod`).
2. Click into the `platformSuperadmins/{canonical}` doc.
3. Click the trash-can icon → **Delete document** → confirm.

The trigger fires on the delete event, calls `setCustomUserClaims`
without `isPlatformSuperadmin` (effectively dropping the field), and
calls `revokeRefreshTokens` to force the next request from the
revoked user to mint a fresh token. The Superadmin nav section
disappears on next page load.

## Edge cases

### Target Auth user doesn't exist yet (never signed in)

The trigger consults `userIndex/{canonical}` to translate canonical
email → uid. Before the user's first sign-in, there is no `userIndex`
entry, so the trigger short-circuits — see
[`functions/src/triggers/syncSuperadminClaims.ts`](../../functions/src/triggers/syncSuperadminClaims.ts):

```ts
const uid = await uidForCanonical(memberCanonical);
if (!uid) return;
```

The doc you added is still there. On the user's first sign-in,
`onAuthUserCreate` writes the `userIndex` entry AND calls
`seedClaimsFromRoleData`, which reads
`platformSuperadmins/{canonical}` and seeds the
`isPlatformSuperadmin` claim as part of the initial claim set. The
user lands on the SPA already carrying the claim.

No action needed — this is the supported bootstrap path.

### Doc-ID / canonical mismatch

Symptom: you wrote `platformSuperadmins/Super.Admin@gmail.com`
(typed form) instead of `platformSuperadmins/superadmin@gmail.com`
(canonical). The trigger fires on the doc-ID-as-canonical assumption
and looks up `userIndex/Super.Admin@gmail.com` — which does not
exist, because `userIndex` is canonical-keyed. The claim never
lands.

Debug:

1. Read `userIndex/{computed-canonical}` for the target user. If the
   doc exists, the canonical you should have used is the doc ID.
2. Delete the mis-keyed `platformSuperadmins/{wrong}` doc and recreate
   at the canonical doc ID.

### First superadmin ever (chicken-and-egg)

There is no in-app way to add the first superadmin, by design. The
operator's GCP project-owner role bypasses Firestore rules, so the
first `platformSuperadmins/{canonical}` doc is created from the
console as described above. Subsequent additions can come from any
existing superadmin who also has Firestore console access — the
rules forbid writes to `platformSuperadmins` from the app surface, so
the console is the only path regardless of who is signed in.

### Wrong typed-form email on the `email` field

The trigger doesn't read the `email` field (it only checks doc
existence), so a wrong typed-form value won't break the claim sync.
It will show up wrong in any future audit-row rendering of the doc.
Fix by editing the doc in the console.

### Claim seems to land on the wrong user

The `email` field on the doc and the `customClaims.canonical` field
on the resulting auth token must point at the same human. If the
canonical-email computation collapsed two distinct typed forms onto
the same canonical key (Gmail dot/`+suffix` cases — see
`packages/shared/src/canonicalEmail.ts`), both users share the same
`userIndex/{canonical}` doc and the same `platformSuperadmins`
entry. That is the intended behavior: Gmail treats those addresses
as one identity, so SBA does too.

## Rotation / multi-superadmin

There is no rotation procedure beyond add-then-remove. Adding a
second superadmin is a separate doc-create step against the same
collection; removing the first is a doc-delete. Both writes fire the
trigger independently.

## See also

- [`docs/firebase-schema.md` §3.2](../../docs/firebase-schema.md) —
  `platformSuperadmins` collection authoritative schema.
- [`docs/firebase-migration.md`](../../docs/firebase-migration.md)
  Phase 12 — sub-deliverable 12.1 (this runbook) and 12.2 (Stake
  List page, the first UI consumer of the claim).
- [`functions/src/triggers/syncSuperadminClaims.ts`](../../functions/src/triggers/syncSuperadminClaims.ts) —
  the trigger code.
- [`functions/src/lib/applyClaims.ts`](../../functions/src/lib/applyClaims.ts) —
  `applySuperadminClaim`, which performs the `setCustomUserClaims`
  + `revokeRefreshTokens` round-trip.
- [`functions/tests/syncSuperadminClaims.e2e.test.ts`](../../functions/tests/syncSuperadminClaims.e2e.test.ts) —
  emulator-driven end-to-end test that exercises the full
  doc-write → claim-mint → claim-revoke flow.
