# Operator-supplied stake ID on Create Stake

**Shipped:** 2026-08-08
**Commits:** PR #259 (`feat/create-stake-custom-slug`).

## What shipped

The Create Stake form (`/superadmin/stakes`, spec §5.4) gained an optional **Stake ID** field between Stake name and Bootstrap admin email. Fill it in and it becomes the `stakes/{stakeId}` doc ID; leave it empty and the ID is derived from the stake name exactly as before.

The doc ID is permanent, it appears in URLs, and it was previously a pure function of the display name — `Cottonwood South Stake` could only ever be `cottonwood-south-stake`. Production's own stake ID, `csnorth`, is not a value the form could have produced. Now it is.

## Deviations from the pre-change spec

The spec was updated in the same PR; these are the behavioural deltas it now reflects.

- **The slug has two possible sources and one rule.** `createStake` resolves it as `buildingSlug(stake_id)` when the payload carries a `stake_id` that is non-empty after trim, `buildingSlug(stake_name)` otherwise. A typed `CS North` lands at `stakes/cs-north` exactly as a stake *named* `CS North` would. Spec: §5.4; schema §4.1.
- **A typed ID that slugifies to empty refuses the write — it never falls back to the name.** `invalid_slug`, no parent doc, no audit row. Spec: §5.4.
- **The field holds only what the operator typed.** No auto-fill from the stake name, no sync effect; editing the name afterwards leaves a typed ID untouched. The slug preview moved out from under the name field to under the Stake ID field. Spec: §5.4.
- **Empty means absent, not `''`.** The form omits `stake_id` from the callable payload entirely when the field is blank. The callable also reads a whitespace-only value as "derive from the name". Spec: §5.4.
- **The two slug errors follow the input that caused them.** `invalid_slug` / `slug_collision` attach to the Stake ID field when one was typed and to the Stake name field when it wasn't, with wording to match ("A stake with that ID already exists. Pick a different ID."). Spec: §5.4.
- **`stake_id` is a new optional key on `CreateStakeInput`,** and a non-string value is a shape error (`invalid-argument`), like a non-string `timezone`. Spec: §5.4.

## Decisions made during the change

- **Slugify the typed ID; don't take it verbatim.** Running the operator's input through the same `buildingSlug` as the name is what keeps the doc ID's character set a single guarantee rather than two. The alternative — accept the typed string as-is and validate it against a pattern — means a second rule to keep in agreement with the first, plus a rejection path for input the existing rule would happily have normalised. `CS North` becoming `cs-north` is the whole point: the operator states intent, the codebase states form.
- **No fallback when a typed ID slugifies to empty.** The name-derived slug is right there and using it would always "succeed", which is exactly the objection: the operator asked for a specific doc ID, and a permanent identifier silently differing from what was requested is a worse outcome than a soft failure they can see and correct. The test pins both halves — no doc at the name-derived slug, no `platformAuditLog` row.
- **No new error code.** `invalid_slug` and `slug_collision` already describe both failures precisely; a typed source makes them reachable from a second input, not different failures. Adding `invalid_stake_id` would have meant a new envelope member for every caller (extension, direct REST) to learn for no new information. The field-attachment logic is where the distinction lives, and it lives in the form.
- **No auto-fill and no sync effect on the field.** A field that mirrors the name until you touch it has to answer "what counts as touched", and it gets that wrong at exactly the moment it matters — the operator who types an ID, then fixes a typo in the name, and has their ID quietly rewritten. An empty field that means "use the name" needs no such state. The cost is that the operator who wants the name-derived slug *as a starting point* has to read it off the preview and type it; that is the rarer case.
- **The slug preview moved under the Stake ID field.** It is the preview *of that field's* result, and the callable's rule is mirrored client-side so the preview is what the server computes. Under the name field it would now sometimes show a slug the name had nothing to do with.
- **`softFailToFieldError` takes the submitted Stake ID as an argument** rather than reading form state, so the mapper stays pure and the value it branches on is the one that was actually submitted.

No new `architecture.md` D-number. Nothing here establishes or narrows a design axis: the slug rule, the collision check, the transaction, and the audit row are all the ones Phase 12.3 shipped (`phase-12.3-create-stake.md`, F19). This is a second input feeding the existing rule.

## What didn't change (load-bearing non-changes)

- **The stake doc still stores no `stake_id` field.** The payload key shares a name with the field F19 originally specified and later removed; identity remains the doc ID alone (`firebase-schema.md` §4.1). `CreateStakeInput.stake_id` is a request parameter that never lands as a document field.
- **Collision detection is untouched** — same existence check inside the same transaction that writes the parent doc, same `slug_collision` code. A typed ID that collides is caught by the identical path a name-derived one is, which is why a concurrent retry stays safe.
- **The `platformAuditLog` row is unchanged.** Its `entity_id` follows the doc ID actually written, which is what it always did; nothing there had to learn where the slug came from.
- **No Firestore rules change and no index.** `stakes/{stakeId}` create is Admin-SDK-only through the callable, and no rule ever constrained the doc ID's shape, so a hand-picked slug needs no rules edit.
- **`buildingSlug` is untouched.** Same helper, same lowercase-ASCII-alnum-with-internal-hyphens rule that wards, buildings, and organizations key on.
- **Nothing about the bootstrap flow moved.** `bootstrap_admin_email` handling, `setup_complete=false`, the seeded `eq_president_app_access: false`, and the wizard's operator pre-step are all as they were.
- **No rename path was added.** Firestore doc IDs are not renameable and this change does not pretend otherwise — it moves the decision earlier, to the one moment it can be made.

## Known issues / deferred work

- **Nothing checks that a typed ID *relates* to the stake.** An operator can name a stake `Cottonwood South` and give it the ID `zzz`. That is the point of the field — the ID is the operator's call — but it means the Stake List's name and ID columns can disagree with each other by intent, and no guard distinguishes that from a typo.
- **A wrong ID is fixable only by deleting the stake doc and creating it again**, which is safe only before the stake has data. There is no in-app delete; it is a Firestore console operation.
- **No user-guide edits.** The Stake List is superadmin-only and no end-user guide covers it.
