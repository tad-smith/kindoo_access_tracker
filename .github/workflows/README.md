# .github/workflows/

GitHub Actions workflows for the Stake Building Access repository.

| Workflow | Source-of-truth | Triggers |
|---|---|---|
| `test.yml` | **`infra/ci/workflows/test.yml`** is the source-of-truth | Push to `main`; all PRs. Lints, typechecks, runs the test suite, builds. The file in this directory is a verbatim copy. |

## Why two copies of test.yml?

GitHub Actions only reads workflow files from `.github/workflows/` — it ignores files anywhere else in the repo. But `infra/ci/workflows/` is the conventional home for CI config in this monorepo so it's discoverable next to the rest of the operational tooling.

The two files are kept in sync by convention: edit `infra/ci/workflows/test.yml` first, then copy to `.github/workflows/test.yml`. A future enhancement is to symlink, but symlinks across some Windows-Git-client setups behave inconsistently, so for now we copy and keep both committed verbatim.

When updating `test.yml`, edit `infra/ci/workflows/test.yml` and copy it to here:

```bash
cp infra/ci/workflows/test.yml .github/workflows/test.yml
```

A pre-commit lint check could enforce parity.
