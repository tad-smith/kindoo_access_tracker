# Chunk 10.7 — Callings-sheet Name column

**Shipped:** 2026-04-22
**Commits:** <pending>

## What shipped

The stake's callings spreadsheet gained a new `Name` column (Col D, left of `Personal Email(s)`). The importer now reads it, populates `Seats.person_name` from it, and pushes display-name corrections into existing auto-seat rows in place — so rosters show real names without having to wait for a calling churn.

## Deviations from the pre-chunk spec

None. This chunk is a response to a one-way LCR-side format change; spec §8 and `architecture.md` §14's Importer bullets were rewritten in the same commits.

## Decisions made during the chunk

- **In-place `person_name` update on unchanged `source_row_hash`.** The hash keys on `(scope, calling, email)` and deliberately excludes name — an LCR rename shouldn't churn the seat_id / audit trail. But that leaves a "stale-name" gap: rows that already existed before the Name column shipped, and future LCR name corrections, would never reach the sheet. The importer now runs a third diff branch for rows whose hash is in both current and desired: when `person_name` drifts, call a new repo helper `Seats_updateAutoName(hash, newName, 'Importer')` that mutates only `person_name` + `last_modified_*` on the existing auto row, and emit one `update` AuditLog row per change. Chose this over (a) add name to the hash (too noisy — every name typo fix would delete-and-insert), and (b) one-time manual purge of all auto rows (fragile operator step). Recorded in-line in `architecture.md` §14 rather than a numbered D — it's a small refinement of the existing idempotency rules, not a new architectural axis.
- **Comma-split on the Name cell for multi-person callings.** LCR puts multiple people's names in a single Col D cell as a comma-delimited list while emails continue to spread across Col E, F, G, … Pair `names[i]` with `emails[i]` by position; overflow emails fall back to `person_name=''` rather than failing the row. No attempt to handle `"Smith, Jr."` quoted-comma edge case — LCR's export convention is bare "First Last", we'll revisit if it surfaces.
- **Strict "Name" header match, not substring.** The Personal-Email header check is a substring match (`contains 'personal email'`) because LCR wobbles between "Personal Email", "Personal Email(s)", and trailing `Note:` blurbs. The Name header is treated stricter — exact equality (case-insensitive, trimmed) — so a cell like `"Organization Name"` on some unrelated export can't accidentally satisfy the header detection.

## Spec / doc edits in this chunk

- `docs/spec.md` — §8 column table and per-tab parse bullets rewritten: Col D is now `Name`, Col E is the personal-email column, Col F+ are additional emails. Added the in-place `person_name` update branch to the diff description.
- `docs/architecture.md` — §14 Importer bullets: header-detection now requires Col D = `Name` and Col E = `Personal Email`; new prose describing the in-place name-update diff branch (and why `person_name` is deliberately outside the hash); `last_import_summary` example line gained the `N name updates` chip.

## Deferred

Nothing. This is a bounded source-format change.

## Next

On the first post-cutover import every auto seat whose `person_name` was stored as `''` will receive an `update` AuditLog row — expect a one-time flurry of `Seat.update` rows scaling with the roster size (~250 at target scale). Subsequent imports only emit `update` rows for actual LCR name corrections.
