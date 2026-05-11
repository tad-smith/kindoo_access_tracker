# Changelog

Per-phase record of what shipped and why the spec moved.

## The convention

- **`docs/spec.md` is the live source of truth.** Every commit that changes behaviour also updates the spec, in the same commit. Reading `spec.md` always tells you what the deployed code does — you never have to reconcile "what we said we'd build" with "what actually got built".
- **This directory explains _why_ the spec moved.** Each phase closes with a file summarising deviations, decisions, and doc edits. Active filename convention: `phase-N-<slug>.md`.
- **Catch-up recipe**: read `docs/spec.md` plus the latest file in this directory. Older files are the historical trail.

## Other docs, briefly

| Doc | Scope | Cadence of change |
| --- | --- | --- |
| `docs/spec.md` | What the system does right now (authoritative). | Every behaviour change. |
| `docs/architecture.md` | Design decisions (D1, D2, …) + module layout. | Whenever a decision changes. |
| `docs/firebase-schema.md` | Authoritative Firestore data model + rules + indexes. | Whenever a collection / rule / index changes. |
| `docs/firebase-migration.md` | Phase plan (Phase A complete; Phase 12 deferred). | Updated as phases land. |
| `docs/open-questions.md` | Ambiguities, `[RESOLVED]` trail. | Add items as they surface; resolve on answer. |
| `docs/changelog/` | **This directory.** Per-phase journal. | One file per phase, appended on close. |

## Writing a phase changelog

When a phase closes:

1. Make sure the code in the phase's commits and `docs/spec.md` tell the same story (if not, fix one of them in the same phase).
2. Copy `template.md` to `phase-N-<slug>.md` where `<slug>` is a short kebab-case summary (e.g. `phase-1-skeleton-emulators.md`).
3. Fill in the template. Keep entries terse — link to `architecture.md` D-numbers, `open-questions.md` items, or `firebase-migration.md` F-numbers / phase sections rather than pasting rationale.
4. Commit everything together.

## Filename convention

```
phase-1-skeleton-emulators.md
phase-2-auth-and-claims.md
phase-3-firestore-schema-rules.md
...
phase-11-cutover.md
```

## History

The Apps Script era (chunks 0–11) used `chunk-N-<slug>.md` files. Those were removed from the repo on 2026-05-11 as part of the post-Phase-11 cleanup; the per-chunk history is preserved in git history.
