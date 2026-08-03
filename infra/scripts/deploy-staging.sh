#!/usr/bin/env bash
#
# deploy-staging.sh — operator-triggered deploy of the Firebase port to
# the `kindoo-staging` Firebase project.
#
# What it does:
#   1. Stamps the build version (writes apps/web/src/version.gen.ts and
#      functions/src/version.gen.ts — both gitignored) so the deployed
#      bundle reports its git short SHA + UTC build timestamp.
#   2. Runs typecheck across all workspaces (`tsc -b`).
#   3. Builds the web SPA (`pnpm --filter ./apps/web build`).
#   4. Builds the Cloud Functions (`pnpm --filter ./functions build`).
#   5. Deploys Hosting + Functions + Firestore (rules + indexes) via the
#      Firebase CLI, targeting the `staging` alias defined in .firebaserc.
#   6. Verifies the deploy actually landed: probes every deployed callable
#      unauthenticated and compares the deployed function set against the
#      source exports. See infra/scripts/lib/verify-deploy.sh for the full
#      writeup — `firebase deploy` reporting success does NOT mean the
#      functions are reachable, and we have shipped a broken deploy that
#      way. Skipped under --web-only (no functions were deployed) and
#      under --skip-verify.
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
# What it requires (default mode):
#   - You're on the `main` branch.
#   - Local `main` is up-to-date with `origin/main`.
#   - Working tree is clean. The stamper writes only to gitignored
#     `version.gen.ts` files, so the tree stays clean across runs.
#
# What it requires (`--from-pr <number>` mode):
#   - `gh` CLI installed and authenticated.
#   - Working tree is clean (we move HEAD under you).
#   - PR <number> exists and is OPEN.
#   The main-branch / up-to-date-with-origin guards are skipped — the
#   point of `--from-pr` is to deploy a non-main branch.
#
# How `--from-pr` checks out the PR, and why it is DETACHED:
#   We fetch GitHub's server-side `refs/pull/<number>/head` and check the
#   resulting commit out with `git checkout --detach`. We deliberately do
#   NOT use `gh pr checkout`, which creates and checks out a local branch
#   for the PR head.
#
#   Git allows a branch ref to be checked out in at most ONE worktree at
#   a time. This repo accumulates agent worktrees under
#   `.claude/worktrees/`, so any worktree holding the PR's branch killed
#   the deploy before it started:
#
#     fatal: 'feat/limited-app-access' is already used by worktree at
#            '/Users/tad/projects/Kindoo/.claude/worktrees/fold-limited-access'
#     failed to run git: exit status 128
#
#   That blocked real deploys three separate times, each with a different
#   worktree. Pruning worktrees only ever postponed it. The deploy never
#   needed the branch — only the code at the PR head. A detached HEAD
#   names a commit and claims no branch ref, so worktree locks cannot
#   apply and the failure mode is gone structurally rather than made less
#   likely. Do not "simplify" this back to `gh pr checkout`.
#
#   Two properties worth keeping:
#     - `refs/pull/<n>/head` lives in the BASE repo for every PR,
#       including PRs from forks, so fork PRs resolve with no extra
#       remote and no extra fetch config. `gh pr checkout` handled forks;
#       so does this. (Verified against cli/cli: cross-repo PRs'
#       `headRefOid` matches that repo's `refs/pull/<n>/head`.)
#     - We check out the exact `headRefOid` from `gh pr view` and echo
#       it, so the operator sees the commit being deployed instead of a
#       branch name that is one indirection away from it.
#
# What it leaves behind:
#   - Updated apps/web/src/version.gen.ts and functions/src/version.gen.ts
#     (gitignored; not committed).
#   - apps/web/dist/ and functions/lib/ build artifacts (gitignored).
#   - In `--from-pr` mode: wherever you started is restored on exit
#     (success OR failure) via a `trap` — the branch you were on, or the
#     exact commit if you were already detached. No local branch is
#     created, so nothing is left to clean up.
#
# REQUIRES: Operator task **B1** in docs/firebase-migration.md must be
# complete before this script can run successfully against the cloud:
# real Firebase projects must exist, billing must be linked, service
# accounts must be provisioned. Until B1, this script can be exercised
# in --dry-run mode only.
#
# Usage:
#   bash infra/scripts/deploy-staging.sh                    # full deploy from main
#   bash infra/scripts/deploy-staging.sh --dry-run          # echo every command
#                                                           # without running
#   bash infra/scripts/deploy-staging.sh --from-pr 26       # deploy PR #26's head
#                                                           # commit to staging
#                                                           # (detached checkout;
#                                                           # no merge, no local
#                                                           # branch); restores
#                                                           # where you were on exit
#   bash infra/scripts/deploy-staging.sh --from-pr 26 --dry-run
#   bash infra/scripts/deploy-staging.sh --web-only         # deploy hosting only;
#                                                           # skip the functions
#                                                           # build + skip functions
#                                                           # and firestore deploy
#                                                           # targets. Stamper
#                                                           # still runs (web bundle
#                                                           # needs the version).
#   bash infra/scripts/deploy-staging.sh --from-pr 26 --web-only
#   bash infra/scripts/deploy-staging.sh --skip-verify        # deploy, then
#                                                             # skip step 6's
#                                                             # post-deploy
#                                                             # verification.
#                                                             # Escape hatch for
#                                                             # a knowingly
#                                                             # partial state
#                                                             # (mid-migration,
#                                                             # offline, a
#                                                             # deliberately
#                                                             # broken callable).
#                                                             # Prefer fixing the
#                                                             # failure.
#
# `--web-only` composes with `--from-pr` in either order. It is
# intentionally staging-only — production must always ship the full
# stack so hosting + functions + rules stay in lockstep.
#
# Post-deploy verification can also be run on its own, without deploying:
#   bash infra/scripts/lib/verify-deploy.sh staging

set -euo pipefail

DRY_RUN=0
FROM_PR=''
WEB_ONLY=0
SKIP_VERIFY=0

USAGE="Usage: $0 [--dry-run] [--from-pr <number>] [--web-only] [--skip-verify]"

# Two-token flag parsing: --from-pr <number>.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-verify)
      SKIP_VERIFY=1
      shift
      ;;
    --from-pr)
      if [[ $# -lt 2 ]]; then
        echo "error: --from-pr requires a PR number argument." >&2
        echo "$USAGE" >&2
        exit 2
      fi
      FROM_PR="$2"
      shift 2
      ;;
    --web-only)
      WEB_ONLY=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "$USAGE" >&2
      exit 2
      ;;
  esac
done

# Validate --from-pr is a positive integer (no leading zeros, no signs, no spaces).
if [[ -n "$FROM_PR" ]]; then
  if ! [[ "$FROM_PR" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: --from-pr value must be a positive integer. Got: '$FROM_PR'" >&2
    exit 2
  fi
fi

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

if [[ -n "$FROM_PR" ]]; then
  echo "=== deploy-staging.sh — testing PR #$FROM_PR on staging ==="
else
  echo "=== deploy-staging.sh — target: kindoo-staging (alias: staging) ==="
fi
echo "    repo root: $REPO_ROOT"
echo "    dry run:   $DRY_RUN"
echo "    from PR:   ${FROM_PR:-<none>}"
echo "    web-only:  $WEB_ONLY"
echo "    verify:    $((1 - SKIP_VERIFY))"
echo ""

# Guard: deploys ship from `main`, full-stop.
#
# Triggered after the hello-on-staging incident (2026-04-28): operator
# deployed Phase 5 from a topic branch forked off main *before* a
# cleanup PR landed; the predeploy build hook ran against the topic
# branch's source, so a `hello` Cloud Function — already removed on
# main — was created on staging.
#
# Three checks, run before the stamper (which writes only to gitignored
# `version.gen.ts` files, so guard re-entry on the next deploy stays
# clean):
#   1. current branch == `main`
#   2. local HEAD == origin/main (after a fresh fetch)
#   3. working tree is clean
#
# No --force / --allow-dirty escape hatch. If the operator really
# needs to override, they can edit the script.
#
# `--from-pr` mode bypasses checks 1 and 2 (the whole point is to
# deploy a non-main branch). Check 3 still applies.
guard_main_clean() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] would: git symbolic-ref --short HEAD must == 'main'"
    echo "[dry-run] would: git fetch origin main"
    echo "[dry-run] would: git rev-parse HEAD must == git rev-parse origin/main"
    echo "[dry-run] would: git status --porcelain must be empty"
    return 0
  fi

  local current_branch
  current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo '<detached>')"
  if [[ "$current_branch" != "main" ]]; then
    echo "error: deploy must run from \`main\`. You are on \`$current_branch\`." >&2
    echo "To deploy: \`git checkout main && git pull --ff-only\`" >&2
    exit 1
  fi

  git fetch origin main >/dev/null 2>&1 || {
    echo "error: \`git fetch origin main\` failed. Check your network and remote." >&2
    exit 1
  }

  local local_sha origin_sha
  local_sha="$(git rev-parse HEAD)"
  origin_sha="$(git rev-parse origin/main)"
  if [[ "$local_sha" != "$origin_sha" ]]; then
    echo "error: local main is not up-to-date with origin/main." >&2
    echo "local:  $local_sha" >&2
    echo "origin: $origin_sha" >&2
    echo "To deploy: \`git pull --ff-only\` (if behind) or push your local commits and merge upstream first (if ahead)." >&2
    exit 1
  fi

  local dirty
  dirty="$(git status --porcelain)"
  if [[ -n "$dirty" ]]; then
    echo "error: working tree has uncommitted changes. Stash or commit before deploying." >&2
    echo "$dirty" >&2
    exit 1
  fi
}

# Working-tree-clean check used in --from-pr mode (subset of
# guard_main_clean: branch + origin/main checks are intentionally
# skipped).
guard_clean_tree() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] would: git status --porcelain must be empty"
    return 0
  fi

  local dirty
  dirty="$(git status --porcelain)"
  if [[ -n "$dirty" ]]; then
    echo "error: working tree has uncommitted changes. Stash or commit before deploying." >&2
    echo "$dirty" >&2
    exit 1
  fi
}

# --from-pr cleanup. Restores wherever the operator started: the branch
# they were on, or — if they were ALREADY on a detached HEAD when they
# invoked us — the exact commit, still detached.
#
# Handling the already-detached start matters now that this script
# detaches on purpose. Note `git symbolic-ref --short HEAD` (empty when
# detached) rather than `git rev-parse --abbrev-ref HEAD`, which returns
# the literal string `HEAD` on a detached checkout and would turn the
# restore into `git checkout HEAD` — a no-op that silently strands the
# operator on the PR's commit.
#
# The stamper writes only to gitignored `version.gen.ts` files (see
# .gitignore lines 53–56), so we don't need `git checkout --` to discard
# them. Idempotent: safe to call from a trap even if we never moved.
ORIGINAL_BRANCH=''  # branch name, or '' if the operator started detached
ORIGINAL_SHA=''     # commit the operator started on; always set in --from-pr mode
restore_original_ref() {
  if [[ -z "$ORIGINAL_SHA" ]]; then
    return 0
  fi

  local current_branch current_sha where
  current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo '')"
  current_sha="$(git rev-parse HEAD 2>/dev/null || echo '<unknown>')"
  where="${current_branch:-detached HEAD at $current_sha}"

  if [[ -n "$ORIGINAL_BRANCH" ]]; then
    if [[ "$current_branch" == "$ORIGINAL_BRANCH" ]]; then
      return 0
    fi
    echo ""
    echo "=== restoring original branch: $ORIGINAL_BRANCH (was on: $where) ==="
    git checkout "$ORIGINAL_BRANCH" || {
      echo "warn: could not restore branch '$ORIGINAL_BRANCH'. You are on $where." >&2
      return 0
    }
    return 0
  fi

  # Started detached — put HEAD back on the same commit, still detached.
  if [[ -z "$current_branch" && "$current_sha" == "$ORIGINAL_SHA" ]]; then
    return 0
  fi
  echo ""
  echo "=== restoring original detached HEAD: $ORIGINAL_SHA (was on: $where) ==="
  git checkout --detach "$ORIGINAL_SHA" || {
    echo "warn: could not restore detached HEAD '$ORIGINAL_SHA'. You are on $where." >&2
    return 0
  }
}

if [[ -n "$FROM_PR" ]]; then
  # `gh` auth precheck. Read-only; safe to run in dry-run too.
  if ! gh auth status >/dev/null 2>&1; then
    echo "error: \`gh\` CLI is not authenticated. Run \`gh auth login\` and retry." >&2
    exit 1
  fi

  # Fetch PR metadata. Aborts if the PR doesn't exist. `headRefOid` is the
  # PR head commit — the thing we actually deploy; see the header block.
  # stderr is captured rather than discarded so a field-support or repo
  # -resolution error from `gh` is visible instead of being flattened into
  # a generic "does it exist?".
  PR_JSON="$(gh pr view "$FROM_PR" --json title,headRefName,headRefOid,author,commits,state 2>&1)" || {
    echo "error: could not fetch metadata for PR #$FROM_PR. \`gh\` said:" >&2
    echo "$PR_JSON" >&2
    echo "Does the PR exist? Are you in the right repo?" >&2
    exit 1
  }

  PR_STATE="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("state",""))')"
  if [[ "$PR_STATE" != "OPEN" ]]; then
    echo "error: PR #$FROM_PR is not OPEN (state: $PR_STATE). Refusing to deploy a closed/merged PR's branch." >&2
    exit 1
  fi

  PR_TITLE="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("title",""))')"
  PR_BRANCH="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("headRefName",""))')"
  PR_AUTHOR="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;d=json.load(sys.stdin).get("author") or {};print(d.get("login",""))')"
  PR_COMMITS="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("commits",[])))')"
  PR_HEAD_SHA="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("headRefOid",""))')"

  if [[ -z "$PR_HEAD_SHA" ]]; then
    echo "error: PR #$FROM_PR metadata carries no headRefOid, so there is no commit to deploy." >&2
    echo "Re-run \`gh pr view $FROM_PR --json headRefOid\` to see what \`gh\` returns." >&2
    exit 1
  fi

  echo "PR title: $PR_TITLE"
  echo "PR branch: $PR_BRANCH"
  echo "PR author: $PR_AUTHOR"
  echo "PR head SHA: $PR_HEAD_SHA"
  echo "Commits ahead of main: $PR_COMMITS"
  echo ""

  # Capture where the operator started BEFORE checkout so the trap can put
  # them back. ORIGINAL_BRANCH is empty on an already-detached start, which
  # is a supported state — ORIGINAL_SHA carries the restore target either
  # way.
  ORIGINAL_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo '')"
  ORIGINAL_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
  if [[ -z "$ORIGINAL_SHA" ]]; then
    echo "error: could not resolve HEAD to a commit. Is this a git checkout with at least one commit?" >&2
    exit 1
  fi

  # Install cleanup trap. Fires on success, error, or signal.
  trap restore_original_ref EXIT

  guard_clean_tree

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] would: git fetch origin refs/pull/$FROM_PR/head"
    echo "[dry-run] would: git checkout --detach $PR_HEAD_SHA"
    echo "[dry-run]       (detached — claims no branch ref, so a worktree holding"
    echo "[dry-run]        '$PR_BRANCH' cannot block the deploy)"
    if [[ -n "$ORIGINAL_BRANCH" ]]; then
      echo "[dry-run] on exit (trap): would restore branch '$ORIGINAL_BRANCH'"
    else
      echo "[dry-run] on exit (trap): would restore detached HEAD at $ORIGINAL_SHA"
      echo "[dry-run]       (you invoked this from a detached HEAD; that is supported)"
    fi
    echo "[dry-run] note: version.gen.ts files are gitignored (.gitignore lines 53-56);"
    echo "[dry-run]       no \`git checkout --\` needed to discard stamper output."
  else
    run "git fetch origin refs/pull/$FROM_PR/head"

    # Deploy the exact commit `gh pr view` reported. If that object isn't
    # present after the fetch, `refs/pull/<n>/head` and the PR metadata
    # disagree — GitHub updates the pull ref asynchronously, so a push or
    # force-push racing this run can leave the two seconds apart. Fall
    # back to what we actually fetched and say so loudly; deploying an
    # unnamed commit silently would be worse than either.
    DEPLOY_SHA="$PR_HEAD_SHA"
    if ! git cat-file -e "${PR_HEAD_SHA}^{commit}" 2>/dev/null; then
      DEPLOY_SHA="$(git rev-parse FETCH_HEAD)"
      echo "warn: PR #$FROM_PR head $PR_HEAD_SHA is not among the objects fetched from" >&2
      echo "      refs/pull/$FROM_PR/head. The PR was almost certainly pushed to while this" >&2
      echo "      script was running." >&2
      echo "      Deploying the fetched head instead: $DEPLOY_SHA" >&2
      echo "      Re-run to deploy against fresh metadata if that is not what you want." >&2
    fi

    run "git checkout --detach $DEPLOY_SHA"
    echo "Deploying commit: $DEPLOY_SHA"
  fi
else
  guard_main_clean
fi

# Step 1: stamp version. Always runs — the web bundle reads
# version.gen.ts at build time, so even --web-only needs it.
run "node infra/scripts/stamp-version.js"

# Step 2: typecheck across workspaces.
run "pnpm typecheck"

# Step 3: build web. `build:staging` invokes `vite build --mode staging`,
# which loads `apps/web/.env.staging` (and skips `.env.production`).
# Without the explicit mode, vite defaults to mode=production, picks up
# `.env.production`, and bakes the prod Firebase config into the staging
# bundle.
run "pnpm --filter ./apps/web build:staging"

# Step 3a: emit THIRD_PARTY_LICENSES.txt into the freshly-built dist/
# (T-20). Runs `node` directly — NOT via `pnpm run …` — so the child
# shell has no `npm_lifecycle_*` / `PNPM_SCRIPT_*` env vars in scope.
# The emit script itself spawns `pnpm licenses list` to walk the
# workspace runtime graph; pnpm 10 detects nested-script env and
# refuses the inner invocation with exit 1 / empty stderr on some
# deploy hosts, so we cannot chain this inside the `build:staging`
# pnpm script. Invoking from a clean shell here sidesteps that.
run "node apps/web/scripts/emit-third-party-licenses.mjs"

# Step 4: build functions. Skipped under --web-only since we won't
# deploy them.
if [[ "$WEB_ONLY" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] skip: pnpm --filter ./functions build (--web-only)"
  else
    echo "[skip] pnpm --filter ./functions build (--web-only)"
  fi
else
  run "pnpm --filter ./functions build"
fi

# Step 5: deploy via Firebase CLI.
# Note on what gets deployed:
#   Default: --only hosting,functions,firestore covers everything
#   Phase 1 produces. firestore deploy = rules + indexes (firebase.json
#   points at firestore/firestore.rules and firestore/firestore.indexes.json).
#   --web-only: --only hosting — narrows to the SPA bundle. Functions
#   and rules+indexes already on staging keep their current revision.
if [[ "$WEB_ONLY" -eq 1 ]]; then
  run "firebase deploy --project staging --only hosting"
else
  run "firebase deploy --project staging --only hosting,functions,firestore"
fi

# Step 6: post-deploy verification.
#
# `firebase deploy` exiting 0 means the API accepted our requests. It does
# NOT mean the functions are reachable: a function can deploy "successfully"
# and still be 403'd at the Cloud Run edge (missing allUsers invoker
# binding), or 500 on every request (container fails to start), or simply
# not be there (deployed from a checkout that lacks it). All three have
# shipped from this script. See infra/scripts/lib/verify-deploy.sh.
#
# Skipped under --web-only: no functions were deployed, so there is nothing
# new to verify and the currently-live functions are not this deploy's
# concern.
if [[ "$WEB_ONLY" -eq 1 ]]; then
  echo ""
  echo "[skip] post-deploy verification (--web-only: no functions deployed)"
elif [[ "$SKIP_VERIFY" -eq 1 ]]; then
  echo ""
  echo "[skip] post-deploy verification (--skip-verify)"
  echo "       The deploy is UNVERIFIED. To check it now:"
  echo "         bash infra/scripts/lib/verify-deploy.sh staging"
else
  # shellcheck source=lib/verify-deploy.sh
  source "$SCRIPT_DIR/lib/verify-deploy.sh"
  if ! vd_verify_deploy staging "$DRY_RUN"; then
    echo ""
    echo "=== deploy-staging.sh: DEPLOYED, BUT VERIFICATION FAILED ===" >&2
    echo "The upload succeeded; the functions above are not usable. Fix them" >&2
    echo "before telling anyone staging is ready." >&2
    exit 1
  fi
fi

echo ""
echo "=== deploy-staging.sh complete ==="
