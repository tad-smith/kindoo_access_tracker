# Rename user-facing "Urgent" label to "Emergency"

**Shipped:** 2026-06-07
**Commits:** PR #231 (branch `rename-urgent-to-emergency`)

## What shipped

The user-facing request-priority label changed from "Urgent" to "Emergency" everywhere it shows to a person: the New Request form checkbox ("Emergency?") and its comment-required hint, the manager Queue's top section heading ("Emergency Requests"), the extension request-card badge, and the manager new-request email line ("Emergency: yes"). The shared zod validation message for the comment-required rule reads "marked an emergency."

## Why

Copy-only. "Urgent" undersold the gravity of the flag in practice; "Emergency" reads as the exceptional case it is meant to mark. No behaviour, gating, sectioning, or sort logic changed — the today+7 / `comparison_date` partition that drives the priority section is untouched.

## What did NOT change

The data-model field is still named `urgent` — this is a label rename, not a schema change. `AccessRequest.urgent` (the boolean), the Firestore rule (`urgent is bool`), the `affectedKeys()` immutability allowlists, the CSS classes (`kd-urgent-block`, `kd-urgent-row`, `kd-urgent-hint`, `sba-badge-urgent`), and the test ids (`new-request-urgent`, `queue-section-urgent`, `sba-queue-section-urgent`) all keep the `urgent` identifier. The on-disk and over-the-wire shape is byte-identical to before, so no data migration and no rules change. Future readers: when a doc says `urgent`, that is the field; the user sees "Emergency".

## Doc edits

- `docs/spec.md` — §"New Kindoo Request" form field now labelled "Emergency?"; the web Requests Queue and the extension queue-panel priority sections renamed Urgent → Emergency, each with an explicit field-name-`urgent` / displayed-label-"Emergency" note; the requests-collection bullet (§ data model) notes the same.
- `docs/firebase-schema.md` — §4.7 Request `urgent` field comment notes it renders as the "Emergency" label/badge; field name and immutability invariant unchanged.

`docs/firebase-migration.md` Phase 10.3 was left as-is: it is the historical phase-plan record of what that phase delivered under the "Urgent" label, not live spec.
