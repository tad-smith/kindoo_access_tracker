#!/usr/bin/env bash
#
# deploy-staging.sh — operator-triggered deploy of the Firebase port to
# the `kindoo-staging` Firebase project.
#
# What it does:
#   1. Stamps the build version (writes apps/web/src/version.ts and
#      functions/src/version.ts) so the deployed bundle reports its
#      git short SHA + UTC build timestamp.
#   2. Runs typecheck across all workspaces (`tsc -b`).
#   3. Builds the web SPA (`pnpm --filter ./apps/web build`).
#   4. Builds the Cloud Functions (`pnpm --filter ./functions build`).
#   5. Deploys Hosting + Functions + Firestore (rules + indexes) via the
#      Firebase CLI, targeting the `staging` alias defined in .firebaserc.
#
# Steps were: stamp / typecheck / test / build-web / build-functions /
# firebase deploy. Step 3 (test) was removed because the local script
# doesn't boot emulators; CI is the test gate. The operator triggers
# deploys only after CI is green on `main`, and CI already runs
# lint + typecheck + unit + rules + integration + e2e + build against
# the same commit. An operator who wants belt-and-suspenders local
# verification can run `pnpm test` themselves before invoking this
# script.
#
# What it assumes:
#   - You're at the repo root (the script tolerates being invoked from
#     any cwd; it cds to repo root).
#   - pnpm + node 20+ + firebase-tools are installed.
#   - You're signed in: `firebase login`.
#   - The .firebaserc `staging` alias resolves to a real Firebase project
#     under your Google account.
#
# What it leaves behind:
#   - Updated apps/web/src/version.ts and functions/src/version.ts
#     (these get committed by the operator post-deploy).
#   - apps/web/dist/ and functions/lib/ build artifacts (gitignored).
#
# REQUIRES: Operator task **B1** in docs/firebase-migration.md must be
# complete before this script can run successfully against the cloud:
# real Firebase projects must exist, billing must be linked, service
# accounts must be provisioned. Until B1, this script can be exercised
# in --dry-run mode only.
#
# Usage:
#   bash infra/scripts/deploy-staging.sh                # full deploy
#   bash infra/scripts/deploy-staging.sh --dry-run      # echo every
#                                                       # command
#                                                       # without running

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# cd to repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    echo "[run] $*"
    eval "$*"
  fi
}

echo "=== deploy-staging.sh — target: kindoo-staging (alias: staging) ==="
echo "    repo root: $REPO_ROOT"
echo "    dry run:   $DRY_RUN"
echo ""

# Step 1: stamp version.
run "node infra/scripts/stamp-version.js"

# Step 2: typecheck across workspaces.
run "pnpm typecheck"

# Step 3: build web.
run "pnpm --filter ./apps/web build"

# Step 4: build functions.
run "pnpm --filter ./functions build"

# Step 5: deploy via Firebase CLI.
# Note on what gets deployed:
#   --only hosting,functions,firestore covers everything Phase 1 produces.
#   firestore deploy = rules + indexes (firebase.json points at firestore/
#   firestore.rules and firestore/firestore.indexes.json).
run "firebase deploy --project staging --only hosting,functions,firestore"

echo ""
echo "=== deploy-staging.sh complete ==="
