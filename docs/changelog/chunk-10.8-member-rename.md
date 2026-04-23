# Chunk 10.8 — `target_*` / `person_*` → `member_*` rename

**Shipped:** 2026-04-23
**Commits:** <pending>

## What shipped

Single vocabulary for the person referred to by a Seat or a Request: everywhere the code or UI said `target_email` / `target_name` / `person_email` / `person_name`, it now says `member_email` / `member_name`. The visible form labels, column headers (on rosters and MyRequests), queue cards, confirmation dialogs, and request-lifecycle emails say "Member" instead of "Target" / "Person".

New Request form polish landed in the same commit: Member email / Member name labels explicitly show `(required)`, the Member name field is now required (client `required` attr + matching server-side check in `RequestsService_submit` for add_manual / add_temp — the check is skipped on remove, which carries the name through from the source seat), and the Start / End date inputs moved to sit directly under the Request type selector so the dates appear next to the choice that made them relevant.

Bug fix: the Start / End date row was visually unhiding on Manual requests because `.new-request-form .form-row.temp-only { display: flex }` outranked the generic `.hidden { display: none }` on specificity. Added explicit `.form-row.temp-only.hidden { display: none }` overrides in both the New Request form and the seat-edit modal (same bug class, pre-existing since Chunk 6 but only surfaced now).

## Deviations from the pre-chunk spec

None. The rename is a terminology refinement; all behaviour is preserved.

## Decisions made during the chunk

- **One term across both tabs.** Seats used `person_*`; Requests used `target_*`. Two synonyms for the same concept made the schema harder to read and forced the UI to pick one ("Person" column header on rosters, "Target" column header on MyRequests, "Target email" field on the New Request form). Collapsed to `member_*` everywhere.
- **Historical changelogs stay as-is.** Chunk-3 / 5 / 6 / 7 / 10.7 entries continue to reference the names that existed at the time. Those files are point-in-time records; anyone reading the chain in order sees 10.8 rename the field. Rewriting history was rejected.

## Spec / doc edits in this chunk

- `docs/spec.md` — §3.2 column bullets (Seats + Requests), §5 UI-field descriptions, §6 request-lifecycle guards, §9 email template for completion, §8 importer parse step.
- `docs/architecture.md` — §14 Importer prose (idempotency hash + in-place name update).
- `docs/data-model.md` — Seats + Requests tab column tables; example AuditLog row payloads.
- `docs/sheet-setup.md` — tab-9 Seats and tab-10 Requests header rows.
- `docs/build-plan.md` — Chunk-6 / 7 sub-task descriptions that referenced `target_email` / `person_email` / `targetEmail`.
- `docs/open-questions.md` — A-6, I-8, R-2, R-3 prose (active entries only; `[RESOLVED]` history untouched).

## Operator migration steps (required before pushing this code)

The Seats and Requests tabs' row-1 header cells are strict-compared against `SEATS_HEADERS_` / `REQUESTS_HEADERS_`. **Pushing this commit without first editing the live Sheet headers will make every Seats / Requests read throw `Seats header drift at column N` / `Requests header drift at column N`.** Column positions are unchanged, so no data migration on existing rows.

1. Open the backing Sheet.
2. On the **Seats** tab, edit row 1:
   - `person_email` → `member_email`
   - `person_name`  → `member_name`
3. On the **Requests** tab, edit row 1:
   - `target_email` → `member_email`
   - `target_name`  → `member_name`
4. Push: `npm run push`.
5. Spot-check the manager Dashboard, All Seats page, and Requests Queue — they should all load without a header-drift toast.

Historical `AuditLog` rows keep their old JSON keys in `before_json` / `after_json`. The AuditLog page does NOT fall back to the old key names, so the per-row identity summary on pre-10.8 rows may render as `'(unknown)'` or skip the member-identifying keys entirely — the raw JSON in the expanded `<details>` block still shows everything. Acceptable because the AuditLog is low-traffic and the historical rows can be read by eye.

## Deferred

Nothing.

## Next

Nothing specific. The rename unblocks `New Kindoo Request` form polish work (member name required, date inputs repositioned) that landed in the same commit.
