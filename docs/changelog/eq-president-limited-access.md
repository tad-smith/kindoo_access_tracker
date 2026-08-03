# Elders Quorum President app access is limited-tier

**Shipped:** 2026-08-02
**Commits:** branches `feat/eq-president-limited-backend`, `feat/eq-president-limited-web`, `feat/eq-president-limited-docs`, folded onto `feat/eq-president-limited`; architecture decision D26.

## What shipped

Where a stake has opted into Elders Quorum President app access (`stake.eq_president_app_access`, D23), the access that calling confers is now **Limited** rather than Full. A limited person may request temporary access only, capped at 90 days, restricted at ward scope to their own ward's building, and may edit or remove only temporary seats — the D25 tier, applied to a calling-derived grant for the first time.

The mechanism is the more consequential half. An importer calling's tier is now **stored on the access record** at the moment the record is written, in a new server-only `importer_limited_callings` map beside `importer_callings`. Nothing classifies a calling by name at read time any more; the read-time classifier D25 shipped as a seam is deleted.

## Deviations from the pre-change spec

The spec was updated in the same change; these are the behavioural deltas it now reflects.

- **The tier is stored, not derived.** `Access.importer_limited_callings?: Record<string, string[]>` names, per scope, the subset of `importer_callings[scope]` that confers limited access, verbatim in the same casing. **Absent means full** — absent field, absent scope key, or empty array. Spec: §3.2, §4, §8; schema §2 / §4.5.
- **The writer stamps at insert.** `LIMITED_TIER_CALLINGS` (exactly `EQ_PRESIDENT_CALLING`) and `filterLimitedTierCallings()` in `packages/shared/src/appAccessCallings.ts` are consulted only on write paths. `syncApplyFix`'s three access helpers — the auto-scope upsert, the scope-clear, and the `kindoo-unparseable` stake-scope reshape — stamp the field in the *same write* as `importer_callings`, so a scope's callings and its tiers cannot be written out of step. `backfillEqPresidentAccess` stamps an entry it inserts. Spec: §8; schema §4.5.
- **`isLimitedAccessCalling()` and `LIMITED_ACCESS_CALLINGS` are deleted.** `scopesFromAccessDoc` (`functions/src/lib/seedClaims.ts`) reads the stored field instead, and its injectable `limitedCallings` parameter is gone. Spec: §4; schema §2 / §4.5.
- **The App Access page reads the stored field per calling.** An importer row renders LIMITED when its calling appears in `importer_limited_callings[scope]`, Full otherwise. A scope holding both a Bishop and an Elders Quorum President labels each row independently. Replaces §5.3's "importer rows render Full, and the page does not classify them by calling name" — the condition that sentence set (the tier must be stored before it is displayed) has been met. Spec: §5.3.
- **A newly-granted Elders Quorum President gets the limited welcome email.** No new branch: `notifyOnAccessGranted` already folded `scopesFromAccessDoc(after).limited` through `isLimitedTier`, and that fold now sees a limited importer calling for the first time. Spec: §9.
- **The access rules gate the new field like the map it describes.** `importer_limited_callings` must be **absent** on a manager create, **byte-equal** on a manager update (via `.get(…, {})` on both sides, so records predating the field compare cleanly), and it is **not** in the update `affectedKeys()` allowlist. Schema §4.5 / §6 / §6.1.
- **The tier is not retroactive.** Only newly inserted entries carry the stamp. Spec: §4, §5.3, §8. See "Known issues" below.

## Decisions made during the change

- **An importer calling's tier is stored on the record, never classified by name at read time.** Recorded as **D26**, amending D23 and reversing D25(b). The load-bearing argument: `syncAccessClaims` fires only on access-doc writes, so a claim re-mints only when the record changes — a constant changing is not a record change. Under D25(b), the moment `EQ_PRESIDENT_CALLING` joined the set, every existing president's claim would still have said full while the App Access page, reading the same constant, labelled them LIMITED. One of those is what the rules enforce and the other is what a manager sees, and there is no principled way to pick which is lying. A stored stamp collapses them onto one record. That D25 already booked "a claim re-mint for existing EQ-President access docs" as a deferred cost is the tell — the cost existed only because the tier wasn't stored.
- **Absent means full, which is what makes this a zero-migration change.** Every access doc in production lacks the field and therefore behaves exactly as before; nothing was backfilled and no refresh token was revoked on deploy, because a doc without the field computes a byte-identical claim block. The same convention already governs `ManualGrant.level` and `StakeClaims.limited` — one rule across the whole tier system, not three.
- **Not-retroactive is inherited from D23(a), not invented here.** Re-tiering live records at deploy time would silently narrow the authority of people using the app today, with no dialog and no operator action to point at — the exact thing D23 made a confirmed second action to avoid. A stake that wants existing presidents converted has the revoke-then-grant path, which is operator-initiated and audited.
- **A manager must not be able to write the stamp.** Rules gate it exactly like `importer_callings` rather than folding it into the manual-side allowlist, because a manager who could set the field could clear their own stamp and promote themselves from limited to full at the next claim mint. Absent-on-create and byte-equal-on-update, compared through `.get(…, {})` so a record written before the field existed doesn't fail the equality on an absent-vs-absent read.
- **`writeAccessForAutoScope`'s existing-doc branch moved from `tx.set(…, {merge: true})` to `tx.update`.** A merge deep-merges nested maps key by key, so a scope that lost its last limited-tier calling would have kept its stale stamp and left the member reading limited on the strength of a calling they no longer hold. The two sibling access helpers already used `update` for the same reason; this brings the third in line. Not a behaviour change for `importer_callings` — the helper already computed that map whole.
- **A parallel map, not a per-scope tier or a reshaped `importer_callings`.** A ward scope can legitimately hold both Bishop and Elders Quorum President, and the App Access page renders one row per (scope, calling), so per-scope granularity could not label rows honestly. Promoting `importer_callings`' values from `string[]` to objects would have changed a shape every reader in the repo already parses, forcing a real migration to buy nothing the parallel map doesn't. See D26 for the full alternatives list.

## What didn't change (load-bearing non-changes)

- **`importer_callings`' shape.** Still `Record<scope, string[]>` of bare calling strings. Every existing reader parses it unchanged; the tier lives in a sibling map rather than inside it.
- **Every existing access record.** Nothing was migrated, rewritten, or backfilled. Absent means full, so a doc written before this change reads exactly as it did.
- **The D23 opt-in itself.** `stake.eq_president_app_access` is unchanged — same opt-in defaulting, same `=== true` read idiom, same Config-tab switch, same flip-triggered dialog, same `backfillEqPresidentAccess` signature and merge-only semantics. D26 says what tier the opt-in confers; it does not touch who gets access.
- **Who gets app access at all.** `WARD_APP_ACCESS_CALLINGS` and `STAKE_APP_ACCESS_CALLINGS` are byte-for-byte unchanged, the stake set is still never gated, and the match is still the exact title — the quorum's counselors and its secretary still grant nothing.
- **Everything D25 enforces.** The `ManualGrant.level` marker, the derived per-stake `limited` claim and its never-written-`false` rule, the two creation-time enforcement layers (UI + rules, deliberately no `markRequestComplete` third layer), the id-first ward-building resolution, and `canRemoveSeat`'s one deliberate extra strictness all behave as before. Only where the importer half of the tier comes from moved.
- **The claim shape.** `StakeClaims.limited?: boolean` is the same field with the same semantics, computed by the same `isLimitedTier` / `isActiveManagerDoc` fold. An active Kindoo Manager is still never limited, and one full grant anywhere in the stake still makes the whole stake block full.
- **The fail-toward-more-access rule.** A non-array value, a non-string entry, or a name absent from the scope's `importer_callings` all leave the calling full-tier — the same direction `manual_grants[].level` degrades in.
- **The doc-existence test.** The rules' delete predicate and the server helpers still read only `importer_callings` and `manual_grants`, so a stale tier stamp can never keep an otherwise-empty access doc alive.
- **The welcome email's fire condition and its copy machinery.** It still fires on the no-scopes → at-least-one-scope transition and still branches one word on `isLimitedTier`. The Elders Quorum President case is new input to an unchanged branch.

## Spec / doc edits in this change

- `docs/spec.md` — §3.2 access-doc bullet gains the third map; §4 the positive-evidence list now cites the stored field, plus a new "tier is stored, never inferred" paragraph carrying the not-retroactive consequence; §5.3 App Access page rewritten off "importer rows render Full"; §8 the app-access calling lists gain the tier sentence, `syncApplyFix`'s stamp, a "neither is the limited tier" paragraph beside D23's non-retroactivity, and the backfill's grant/revoke stamp behaviour; §9 welcome-email tier note.
- `docs/architecture.md` — added **D26**; cites the amended D23 and the reversed D25(b). D23's and D25's rows are unedited.
- `docs/firebase-schema.md` — §2 claim-derivation evidence list; §4.5 the new field in the shape block, a replacement "Access tier — `importer_limited_callings`" passage with the not-retroactive and malformed-data rules, the Sync and backfill writer paragraphs, the Read-by line, and three invariants.
- `docs/user-guide/kindoo-managers.html` — §8 Ward-row tier annotation, the Elders Quorum Presidents subsection (tier + what it means in practice + a third "a full grant outranks it" bullet), a not-retroactive callout with the revoke-then-grant recipe, the corrected "calling-based access is full, with one exception" callout, the delete-and-re-add callout scoped to manual grants, §12 troubleshooting entry, §13 glossary. Version 1.2 → 1.3.
- `docs/user-guide/creating-requests.html` — §1 "Who you are in the app" and "Full access and limited access" now name the Elders Quorum President calling as a source of limited access. Version 1.2 → 1.3.
- `docs/changelog/eq-president-limited-access.md` — this entry.

Deliberately **not** edited: `docs/architecture.md` D25's row and `docs/changelog/limited-app-access.md`. Both describe what PR #244 shipped, and the repo's practice is that a superseding decision names the clause it reverses rather than rewriting the earlier record (D20 → D19, D22 → D3, D23 → D17(a)). Read D25(b) with D26 beside it.

## Migration note

None. The field is absent on every existing access doc and absent means full, so nothing changed shape and no claim block moved. The **only** way an existing record acquires the stamp is a write that inserts the calling.

## Known issues / deferred work

- **The tier is not retroactive, deliberately.** An Elders Quorum President who already held calling-derived access when this shipped keeps **Full** access. Their claim, the rules, and the App Access page all agree — all three read the same untouched record — so this is not drift and should not be filed as one. They convert only when that scope is next written: released and re-called, a Sync drift fix that rewrites their callings, or an operator-run revoke-then-grant cycle.
- **A grant pass alone converts nobody.** `backfillEqPresidentAccess`'s grant direction skips a scope whose entry already carries the calling — pre-existing idempotence, unchanged here. Converting existing presidents means turning the setting off and running **Revoke access now**, then turning it back on and running **Grant access now**. They cannot sign in between the two passes, which is why the manager guide tells operators to do both together.
- **A stake can therefore hold presidents at two different tiers for a while.** That is legible rather than hidden: every App Access row states the level it actually carries.
