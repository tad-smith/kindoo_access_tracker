# Changelog

Per-chunk record of what shipped and why the spec moved.

## The convention

- **`docs/spec.md` is the live source of truth.** Every commit that changes behaviour also updates the spec, in the same commit. Reading `spec.md` always tells you what the deployed code does — you never have to reconcile "what we said we'd build" with "what actually got built".
- **This directory explains _why_ the spec moved.** Each chunk closes with a `chunk-N-<slug>.md` file summarising deviations, decisions, and doc edits.
- **Catch-up recipe**: read `docs/spec.md` plus the latest file in this directory. Older chunk files are the historical trail.

## Other docs, briefly

| Doc | Scope | Cadence of change |
| --- | --- | --- |
| `docs/spec.md` | What the system does right now (authoritative). | Every behaviour change. |
| `docs/architecture.md` | Design decisions (D1, D2, …) + module layout. | Whenever a decision changes. |
| `docs/data-model.md` | Exact Sheet tabs, columns, types. | Whenever a column/tab changes. |
| `docs/build-plan.md` | 11-chunk roadmap. | Per-chunk scope tweaks; mark chunks done. |
| `docs/open-questions.md` | Ambiguities, `[RESOLVED]` trail. | Add items as they surface; resolve on answer. |
| `docs/sheet-setup.md` | Deployment runbook. | Whenever deploy steps change. |
| `docs/changelog/` | **This directory.** Per-chunk journal. | One file per chunk, appended on close. |

## Writing a chunk changelog

When a chunk closes:

1. Make sure the code in the chunk's commits and `docs/spec.md` tell the same story (if not, fix one of them in the same chunk).
2. Copy `template.md` to `chunk-N-<slug>.md` where `<slug>` is a short kebab-case summary (e.g. `chunk-1-scaffolding.md`).
3. Fill in the template. Keep entries terse — link to `architecture.md` D-numbers or `open-questions.md` items rather than pasting rationale.
4. Commit everything together.

## Filename convention

```
chunk-0-planning.md
chunk-1-scaffolding.md
chunk-2-config-crud.md
chunk-3-importer.md
...
chunk-11-cloudflare-worker.md
```

Chunk 0 is a one-off — the planning phase before any code existed. Real chunks start at 1.
