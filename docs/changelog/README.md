# Changelog

Per-chunk and per-phase record of what shipped and why the spec moved.

## The convention

- **`docs/spec.md` is the live source of truth.** Every commit that changes behaviour also updates the spec, in the same commit. Reading `spec.md` always tells you what the deployed code does — you never have to reconcile "what we said we'd build" with "what actually got built".
- **This directory explains _why_ the spec moved.** Each unit of work closes with a file summarising deviations, decisions, and doc edits. Apps Script work used `chunk-N-<slug>.md` (historical record); Firebase migration work uses `phase-N-<slug>.md` (active going forward).
- **Catch-up recipe**: read `docs/spec.md` plus the latest file in this directory. Older files are the historical trail.

## Other docs, briefly

| Doc | Scope | Cadence of change |
| --- | --- | --- |
| `docs/spec.md` | What the system does right now (authoritative). | Every behaviour change. |
| `docs/architecture.md` | Design decisions (D1, D2, …) + module layout. | Whenever a decision changes. |
| `docs/data-model.md` | Exact Sheet tabs, columns, types. | Whenever a column/tab changes. |
| `docs/build-plan.md` | 11-chunk Apps Script roadmap (historical record). | Per-chunk scope tweaks; mark chunks done. |
| `docs/firebase-migration.md` | 12-phase Firebase migration roadmap. | Updated as phases land. |
| `docs/open-questions.md` | Ambiguities, `[RESOLVED]` trail. | Add items as they surface; resolve on answer. |
| `docs/sheet-setup.md` | Deployment runbook. | Whenever deploy steps change. |
| `docs/changelog/` | **This directory.** Per-chunk / per-phase journal. | One file per unit of work, appended on close. |

## Writing a chunk or phase changelog

When a chunk (Apps Script) or phase (Firebase migration) closes:

1. Make sure the code in the unit's commits and `docs/spec.md` tell the same story (if not, fix one of them in the same unit).
2. Copy `template.md` to `chunk-N-<slug>.md` (Apps Script) or `phase-N-<slug>.md` (Firebase) where `<slug>` is a short kebab-case summary (e.g. `chunk-1-scaffolding.md`, `phase-1-skeleton-emulators.md`). Adapt "chunk" → "phase" wording in the template as needed.
3. Fill in the template. Keep entries terse — link to `architecture.md` D-numbers, `open-questions.md` items, or `firebase-migration.md` F-numbers / phase sections rather than pasting rationale.
4. Commit everything together.

## Filename convention

```
chunk-0-planning.md
chunk-1-scaffolding.md
chunk-2-config-crud.md
chunk-3-importer.md
...
chunk-10-polish.md
phase-1-skeleton-emulators.md
phase-2-auth.md
phase-3-firestore-repos.md
...
phase-12-superadmin.md
```

Chunk 0 is a one-off — the planning phase before any Apps Script code existed. Real chunks start at 1. Note that `chunk-11-cloudflare.md` was superseded by the Firebase cutover (see `docs/firebase-migration.md` Phase 10).
