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
#   3. Runs the test suite (`pnpm test`).
#   4. Builds the web SPA (`pnpm --filter ./apps/web build`).
#   5. Builds the Cloud Functions (`pnpm --filter ./functions build`).
#   6. Deploys Hosting + Functions + Firestore (rules + indexes) via the
#      Firebase CLI, targeting the `staging` alias defined in .firebaserc.
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

# Step 3: tests.
run "pnpm test"

# Step 4: build web.
run "pnpm --filter ./apps/web build"

# Step 5: build functions.
run "pnpm --filter ./functions build"

# Step 6: deploy via Firebase CLI.
# Note on what gets deployed:
#   --only hosting,functions,firestore covers everything Phase 1 produces.
#   firestore deploy = rules + indexes (firebase.json points at firestore/
#   firestore.rules and firestore/firestore.indexes.json).
run "firebase deploy --project staging --only hosting,functions,firestore"

echo ""
echo "=== deploy-staging.sh complete ==="
