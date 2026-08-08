# Operator-supplied stake ID on Create Stake

**Shipped:** 2026-08-08
**Commits:** PR #259 (`feat/create-stake-custom-slug`).

## What shipped

The Create Stake form (`/superadmin/stakes`, spec §5.4) gained a **Stake ID** field between Stake name and Bootstrap admin email. It holds the `stakes/{stakeId}` doc ID itself, fills itself from the stake name as that name is typed, and can be overwritten — at which point the name stops driving it.

The doc ID is permanent, it appears in URLs, and it was previously a pure function of the display name: `Cottonwood South Stake` could only ever be `cottonwood-south-stake`. Production's own stake ID, `csnorth`, is not a value the form could have produced. Now it is, and the operator can see exactly what they are about to get before they submit.

## Deviations from the pre-change spec

The spec was updated in the same PR; these are the behavioural deltas it now reflects.

- **The slug has two possible sources and one rule.** `createStake` resolves it as `buildingSlug(stake_id)` when the payload carries a `stake_id` that is non-empty after trim, `buildingSlug(stake_name)` otherwise. `CS North` lands at `stakes/cs-north` whether it arrived as the ID or as the name. Spec: §5.4; schema §4.1.
- **A supplied ID that slugifies to empty refuses the write — it never falls back to the name.** `invalid_slug`, no parent doc, no audit row. Spec: §5.4.
- **The Stake ID field auto-fills from the stake name, live.** Every keystroke in the name re-derives `buildingSlug(stake_name)` into the field. Editing the ID **detaches** it and later name edits leave it alone; clearing it back to empty **re-attaches** it, and blurring an empty field refills it from the current name. Spec: §5.4.
- **The field is the preview.** There is no separate "Slug: …" line — the input can only ever hold a canonical value, so a second rendering of the same string would be redundant. The hint under it reads `Lowercase letters, digits, and hyphens — defaults from the stake name.` Spec: §5.4.
- **Typing into the field is sanitized on every keystroke** through the new `sanitizeSlugInput` (`packages/shared/src/slugInput.ts`), so the field cannot hold a value the server would rewrite. Spec: §5.4.
- **Empty still means absent, not `''`.** The form omits `stake_id` from the callable payload entirely when the field is blank; the callable reads a whitespace-only value the same way. Spec: §5.4.
- **The two slug errors follow the input that caused them.** `invalid_slug` / `slug_collision` attach to the Stake ID field when the payload carried one and to the Stake name field when it didn't, with wording to match ("A stake with that ID already exists. Pick a different ID."). Spec: §5.4.
- **`stake_id` is a new optional key on `CreateStakeInput`,** and a non-string value is a shape error (`invalid-argument`), like a non-string `timezone`. Spec: §5.4.

## Decisions made during the change

- **Slugify the operator's input; don't take it verbatim.** Running it through the same rule as the name keeps the doc ID's character set a single guarantee rather than two. The alternative — accept the typed string as-is and validate it against a pattern — means a second rule to keep in agreement with the first, plus a rejection path for input the existing rule would happily have normalised. `CS North` becoming `cs-north` is the point: the operator states intent, the codebase states form.
- **No fallback when a supplied ID slugifies to empty.** The name-derived slug is right there and using it would always "succeed", which is exactly the objection: the caller asked for a specific doc ID, and a permanent identifier silently differing from what was requested is worse than a soft failure they can see and correct. The test pins both halves — no doc at the name-derived slug, no `platformAuditLog` row.
- **No new error code.** `invalid_slug` and `slug_collision` already describe both failures precisely; a second source makes them reachable from another input, not different failures. Adding `invalid_stake_id` would have meant a new envelope member for every caller (extension, direct REST) to learn for no new information. The distinction lives in the form's field-attachment logic, which is where it belongs.
- **The field auto-fills, and it is the preview — a reversal, taken in operator review.** The first cut of this branch shipped the opposite: an inert field that held only what the operator typed, with a separate `Slug: <slug>` line rendering the result. Its stated objection to auto-fill was that a field mirroring the name until you touch it has to answer "what counts as touched", and gets it wrong for the operator who types an ID and then fixes a typo in the name. That objection is answered rather than ignored: "touched" is a per-open detach ref, so a typed ID survives every subsequent name edit, and the flag resets with the fields in the dialog's existing open-transition `reset(EMPTY_DEFAULTS)` effect. What the reversal buys is that the field is populated at rest — the operator reads the real doc ID out of the control they can edit, instead of reading one string and typing another to change it.
- **Clearing re-attaches, and the refill waits for blur.** Empty is the natural spelling of "give me the default back", so it means that rather than "I want no ID". Refilling the instant the field empties would make it impossible to clear-and-retype — the default would reappear under the cursor and the operator's next keystrokes would append to it — so the refill fires on blur, and the field stays empty while they type. The result is the invariant worth stating: at rest the field always shows the ID the stake will actually get.
- **Two slug rules, because a trailing hyphen is meaningful mid-word.** Auto-fill re-derives from the whole name each keystroke, so plain `buildingSlug` is correct there. Direct typing can't use it: `buildingSlug` trims trailing hyphens, so typing `cs North` one character at a time collapses `cs ` to `cs` and the next character lands as `csn` — the operator types `cs North` and gets `csnorth`. `sanitizeSlugInput` is `buildingSlug` with the trailing hyphen kept (leading hyphens are still trimmed — a separator typed before any content has no boundary to preserve), and the hyphen is transient: `buildingSlug` finalizes on blur and again on submit, for a submit that beat the blur. The two helpers are pinned to each other by test — `buildingSlug(sanitizeSlugInput(x)) === buildingSlug(x)` for all `x` — which is the property that makes it safe to rewrite the field under the operator: sanitizing changes what they see, never the doc ID they get.
- **Sanitizing preserves the caret.** Writing the value back drops the cursor to the end, which makes editing the middle of an ID impossible; the handler restores the caret, shifted by whatever the rewrite added or removed.
- **`softFailToFieldError` takes the submitted Stake ID as an argument** rather than reading form state, so the mapper stays pure and the value it branches on is the one that was actually submitted.

No new `architecture.md` D-number. Nothing here establishes or narrows a design axis: the slug rule, the collision check, the transaction, and the audit row are all the ones Phase 12.3 shipped (`phase-12.3-create-stake.md`, F19). This is a second input feeding the existing rule.

## What didn't change (load-bearing non-changes)

- **The callable did not change when the form was redesigned.** Auto-fill is entirely a web-side change; no `functions/` code moved for it. It works because `buildingSlug` is idempotent — an untouched autofilled ID resolves to precisely the doc ID the callable would have derived from the name itself.
- **`buildingSlug` is untouched,** and remains the authoritative rule. `sanitizeSlugInput` is its typing-time counterpart, not its replacement: nothing but a live text field calls it, and every value that leaves the field passes through `buildingSlug` before it is used.
- **The stake doc still stores no `stake_id` field.** The payload key shares a name with the field F19 originally specified and later removed; identity remains the doc ID alone (`firebase-schema.md` §4.1). `CreateStakeInput.stake_id` is a request parameter that never lands as a document field.
- **Collision detection is untouched** — same existence check inside the same transaction that writes the parent doc, same `slug_collision` code. A supplied ID that collides is caught by the identical path a name-derived one is, which is why a concurrent retry stays safe.
- **The `platformAuditLog` row is unchanged.** Its `entity_id` follows the doc ID actually written, which is what it always did; nothing there had to learn where the slug came from.
- **No Firestore rules change and no index.** `stakes/{stakeId}` create is Admin-SDK-only through the callable, and no rule ever constrained the doc ID's shape, so a hand-picked slug needs no rules edit.
- **The omit-when-empty payload path survives** even though the field is now almost never empty. It is what a name with no ASCII letters or digits still produces, and an absent key remains a different instruction from `''`.
- **Nothing about the bootstrap flow moved.** `bootstrap_admin_email` handling, `setup_complete=false`, the seeded `eq_president_app_access: false`, and the wizard's operator pre-step are all as they were.
- **No rename path was added.** Firestore doc IDs are not renameable and this change does not pretend otherwise — it moves the decision earlier, to the one moment it can be made.

## Known issues / deferred work

- **Nothing checks that an ID *relates* to the stake.** An operator can name a stake `Cottonwood South` and give it the ID `zzz`. That is the point of the field — the ID is the operator's call — but it means the Stake List's name and ID columns can disagree by intent, and no guard distinguishes that from a typo.
- **A wrong ID is fixable only by deleting the stake doc and creating it again,** which is safe only before the stake has data. There is no in-app delete; it is a Firestore console operation.
- **Two server paths are now unreachable from the SPA and are kept as defense-in-depth for non-SDK callers.** Sanitize-on-input means the field cannot hold an unslugifiable value, so `invalid_slug` against the Stake ID never fires from the form; and because the field is populated whenever the name slugifies, `slug_collision` against the Stake *name* is equally out of reach. Both remain the callable's answer to an extension client or a direct REST POST.
- **No user-guide edits.** The Stake List is superadmin-only and no end-user guide covers it.
