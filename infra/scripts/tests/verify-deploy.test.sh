#!/usr/bin/env bash
#
# verify-deploy.test.sh — unit tests for the pure helpers in
# infra/scripts/lib/verify-deploy.sh.
#
# What it does:
#   Exercises every classification path with synthetic HTTP responses, so the
#   logic that decides "healthy vs IAM-blocked vs not-deployed vs crashing" is
#   provable without a Firebase project and without a network. Also parses the
#   real functions/src/index.ts, so a change to that file's export shape that
#   the parser cannot follow fails here rather than silently producing a
#   vacuous "everything passed" at deploy time.
#
# What it assumes:
#   bash 3.2+, python3 on PATH. No emulators, no credentials, no network.
#
# What it leaves behind:
#   Nothing. Fixtures are written to a `mktemp -d` directory removed on exit.
#
# NOTE ON THE FIXTURES
#   The response bodies below are synthetic, not captured from production. That
#   is deliberate and safe: nothing in verify-deploy.sh pattern-matches on their
#   text. Pass/fail is decided by comparing each probe's signature against the
#   BASELINE probed in the same run, so these fixtures only need to be
#   *structurally* representative — a JSON error envelope vs. a non-JSON edge
#   rejection. If Firebase changes its wire format, the live check re-calibrates
#   itself and these tests keep passing, which is the intended behaviour.
#
# Usage:
#   bash infra/scripts/tests/verify-deploy.test.sh
#   Exit 0 = all green. Exit 1 = at least one failure (each one printed).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=../lib/verify-deploy.sh
source "$SCRIPT_DIR/../lib/verify-deploy.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0

ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}

bad() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
  printf '         expected: %s\n' "$2"
  printf '         actual:   %s\n' "$3"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok "$label"
  else
    bad "$label" "$expected" "$actual"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) ok "$label" ;;
    *) bad "$label" "output containing: $needle" "$haystack" ;;
  esac
}

assert_true() {
  local label="$1"
  shift
  if "$@"; then ok "$label"; else bad "$label" "success (0)" "failure ($?)"; fi
}

assert_false() {
  local label="$1"
  shift
  if "$@"; then bad "$label" "failure (non-zero)" "success (0)"; else ok "$label"; fi
}

# ---------------------------------------------------------------------------
# Recorded/synthetic responses, one per failure mode.
# ---------------------------------------------------------------------------

# A healthy callable rejecting an anonymous call: the callable protocol's own
# JSON error envelope. This is the PASS shape.
BODY_CALLABLE_AUTH='{"error":{"message":"Unauthenticated","status":"UNAUTHENTICATED"}}'

# Cloud Run refusing at the edge because allUsers lacks roles/run.invoker. The
# function never runs; the body is Google's HTML error page, not our JSON. In a
# browser this arrives as a CORS error, because the 403 carries no
# Access-Control-Allow-Origin header.
BODY_RUN_FORBIDDEN='<html><head><title>403 Forbidden</title></head><body><h1>Error: Forbidden</h1><h2>Your client does not have permission to get URL from this server.</h2></body></html>'

# Nothing serving at this URL.
BODY_NOT_FOUND='<html><head><title>404 Not Found</title></head><body><h1>Error: Not Found</h1></body></html>'

# Container failed to start (the missing-runtime-dependency mode).
BODY_CONTAINER_ERROR='<html><head><title>500 Server Error</title></head><body><h1>Error: Server Error</h1><h2>The server encountered an error and could not complete your request.</h2></body></html>'

# A callable that ran and returned a non-auth error — same envelope, different
# status string. Used to prove the signature includes the body, not just the
# HTTP code.
BODY_CALLABLE_INVALID_ARG='{"error":{"message":"missing stakeId","status":"INVALID_ARGUMENT"}}'

BASELINE_SIG="$(vd_signature 401 "$BODY_CALLABLE_AUTH")"

echo "=== verify-deploy.test.sh ==="
echo ""
echo "--- vd_error_status ---"

assert_eq "extracts error.status from a callable error envelope" \
  "UNAUTHENTICATED" "$(vd_error_status "$BODY_CALLABLE_AUTH")"
assert_eq "empty for an HTML edge rejection" \
  "" "$(vd_error_status "$BODY_RUN_FORBIDDEN")"
assert_eq "empty for an empty body" \
  "" "$(vd_error_status "")"
assert_eq "empty for JSON without an error object" \
  "" "$(vd_error_status '{"result":{"ok":true}}')"
assert_eq "empty for a JSON array" \
  "" "$(vd_error_status '[1,2,3]')"
assert_eq "empty when error.status is not a string" \
  "" "$(vd_error_status '{"error":{"status":7}}')"

echo ""
echo "--- vd_signature ---"

assert_eq "signature is status:error.status" \
  "401:UNAUTHENTICATED" "$(vd_signature 401 "$BODY_CALLABLE_AUTH")"
assert_eq "signature of an edge rejection has no body half" \
  "403:" "$(vd_signature 403 "$BODY_RUN_FORBIDDEN")"
assert_eq "same code + different envelope => different signature" \
  "401:INVALID_ARGUMENT" "$(vd_signature 401 "$BODY_CALLABLE_INVALID_ARG")"

echo ""
echo "--- vd_baseline_is_sane ---"

assert_true "accepts a 4xx callable-protocol rejection" \
  vd_baseline_is_sane 401 "$BODY_CALLABLE_AUTH"
assert_false "rejects a Cloud Run 403 (edge, not our code)" \
  vd_baseline_is_sane 403 "$BODY_RUN_FORBIDDEN"
assert_false "rejects a 404" \
  vd_baseline_is_sane 404 "$BODY_NOT_FOUND"
assert_false "rejects a 5xx" \
  vd_baseline_is_sane 500 "$BODY_CONTAINER_ERROR"
assert_false "rejects a 4xx without a JSON error envelope" \
  vd_baseline_is_sane 401 "Unauthorized"
assert_false "rejects a 200 (an anonymous call must never succeed)" \
  vd_baseline_is_sane 200 '{"result":{"ok":true}}'
assert_false "rejects an unreachable probe" \
  vd_baseline_is_sane 000 ""

echo ""
echo "--- vd_classify (calibrated against baseline $BASELINE_SIG) ---"

assert_eq "matching the baseline signature is healthy" \
  "healthy" "$(vd_classify 401 "$BODY_CALLABLE_AUTH" "$BASELINE_SIG")"
assert_eq "Cloud Run 403 => iam-missing" \
  "iam-missing" "$(vd_classify 403 "$BODY_RUN_FORBIDDEN" "$BASELINE_SIG")"
assert_eq "404 => not-deployed" \
  "not-deployed" "$(vd_classify 404 "$BODY_NOT_FOUND" "$BASELINE_SIG")"
assert_eq "500 => crashing" \
  "crashing" "$(vd_classify 500 "$BODY_CONTAINER_ERROR" "$BASELINE_SIG")"
assert_eq "503 => crashing" \
  "crashing" "$(vd_classify 503 "$BODY_CONTAINER_ERROR" "$BASELINE_SIG")"
assert_eq "000 => unreachable" \
  "unreachable" "$(vd_classify 000 "" "$BASELINE_SIG")"
assert_eq "an unauthenticated 200 is not healthy" \
  "unknown" "$(vd_classify 200 '{"result":{"ok":true}}' "$BASELINE_SIG")"
assert_eq "same status, different envelope, is not healthy" \
  "unknown" "$(vd_classify 401 "$BODY_CALLABLE_INVALID_ARG" "$BASELINE_SIG")"

# The calibration is what makes this survive a Firebase wire-format change:
# re-baseline on a hypothetical future shape and the same bodies re-classify
# correctly, with no edit to vd_classify.
FUTURE_BODY='{"error":{"status":"UNAUTHENTICATED","code":16,"details":[]}}'
FUTURE_SIG="$(vd_signature 400 "$FUTURE_BODY")"
assert_eq "re-calibrating to a different baseline shape still passes healthy" \
  "healthy" "$(vd_classify 400 "$FUTURE_BODY" "$FUTURE_SIG")"
assert_eq "re-calibrating still catches the IAM 403" \
  "iam-missing" "$(vd_classify 403 "$BODY_RUN_FORBIDDEN" "$FUTURE_SIG")"

echo ""
echo "--- vd_remediation ---"

IAM_FIX="$(vd_remediation iam-missing backfillEqPresidentAccess kindoo-staging)"
assert_contains "iam remediation names the gcloud binding command" \
  "gcloud run services add-iam-policy-binding" "$IAM_FIX"
assert_contains "iam remediation lowercases the service name" \
  "backfilleqpresidentaccess" "$IAM_FIX"
assert_contains "iam remediation carries the project" \
  "--project kindoo-staging" "$IAM_FIX"
assert_contains "iam remediation grants allUsers run.invoker" \
  "--member=allUsers --role=roles/run.invoker" "$IAM_FIX"
assert_contains "iam remediation explains the CORS red herring" \
  "CORS error" "$IAM_FIX"
assert_contains "not-deployed remediation suggests a targeted redeploy" \
  "firebase deploy --only functions:createStake" \
  "$(vd_remediation not-deployed createStake kindoo-prod)"
assert_contains "crashing remediation points at the container logs" \
  "gcloud run services logs read" \
  "$(vd_remediation crashing createStake kindoo-prod)"

echo ""
echo "--- vd_parse_exports ---"

FIXTURE_SRC="$TMP_DIR/src"
mkdir -p "$FIXTURE_SRC/callable" "$FIXTURE_SRC/triggers" "$FIXTURE_SRC/scheduled"

cat >"$FIXTURE_SRC/index.ts" <<'FIXTURE'
// Comment mentioning export { notAnExport } from './nope.js';
export { alphaCallable } from './callable/alphaCallable.js';
export {
  betaTrigger,
  gammaTrigger,
} from './triggers/multi.js';
export { internalName as renamedCallable } from './callable/renamed.js';
export { deltaScheduled } from './scheduled/deltaScheduled.js';
export { lineBrokenCallable, wrappedCallable } from './callable/awkward.js';
export { mixedTrigger, mixedCallable } from './callable/mixed.js';
FIXTURE

cat >"$FIXTURE_SRC/callable/alphaCallable.ts" <<'FIXTURE'
import { onCall } from 'firebase-functions/v2/https';
export const alphaCallable = onCall({ region: 'us-central1' }, async () => ({}));
FIXTURE

# Declared under its local name, exported under an alias. The alias is what
# Firebase deploys, so discovery has to bridge the two.
cat >"$FIXTURE_SRC/callable/renamed.ts" <<'FIXTURE'
import { onCall } from 'firebase-functions/v2/https';
export const internalName = onCall<{ a: string }, void>(async () => {});
FIXTURE

# Definition shapes a same-line regex would miss. Dropping a real callable is
# the dangerous direction — it shrinks the probe set silently.
cat >"$FIXTURE_SRC/callable/awkward.ts" <<'FIXTURE'
import { onCall } from 'firebase-functions/v2/https';

export const lineBrokenCallable =
  onCall(
    { memory: '512MiB' },
    async () => ({}),
  );

export const wrappedCallable = withTracing(
  onCall(async () => ({})),
);
FIXTURE

# One module, one trigger and one callable. Each must classify on its own.
cat >"$FIXTURE_SRC/callable/mixed.ts" <<'FIXTURE'
import { onCall } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
export const mixedTrigger = onDocumentWritten('c/{id}', async () => {});
export const mixedCallable = onCall(async () => ({}));
FIXTURE

# Mentions onCall in prose only — must NOT be classified as a callable.
cat >"$FIXTURE_SRC/triggers/multi.ts" <<'FIXTURE'
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
/* Fans audit rows. Unlike an onCall( handler, this is Eventarc-driven. */
export const betaTrigger = onDocumentWritten('a/{id}', async () => {});
// Sibling of the above; still not an onCall handler.
export const gammaTrigger = onDocumentWritten('b/{id}', async () => {});
FIXTURE

cat >"$FIXTURE_SRC/scheduled/deltaScheduled.ts" <<'FIXTURE'
import { onSchedule } from 'firebase-functions/v2/scheduler';
export const deltaScheduled = onSchedule('every day 03:00', async () => {});
FIXTURE

PARSED="$(vd_parse_exports "$FIXTURE_SRC/index.ts")"
PARSED_NAMES="$(printf '%s\n' "$PARSED" | cut -f1 | sort | tr '\n' ' ')"
assert_eq "parses single-line, multi-line and aliased exports; skips comments" \
  "alphaCallable betaTrigger deltaScheduled gammaTrigger lineBrokenCallable mixedCallable mixedTrigger renamedCallable wrappedCallable " \
  "$PARSED_NAMES"
assert_eq "records the local name alongside the exported one" \
  "renamedCallable	./callable/renamed.js	internalName" \
  "$(printf '%s\n' "$PARSED" | grep '^renamedCallable')"

assert_false "returns non-zero for a missing index.ts" \
  vd_parse_exports "$FIXTURE_SRC/does-not-exist.ts"

echo ""
echo "--- vd_filter_callables ---"

FILTERED="$(printf '%s\n' "$PARSED" | vd_filter_callables "$FIXTURE_SRC" | sort | tr '\n' ' ')"
assert_eq "finds every callable shape and no triggers or scheduled jobs" \
  "alphaCallable lineBrokenCallable mixedCallable renamedCallable wrappedCallable " \
  "$FILTERED"

echo ""
echo "--- vd_parse_functions_list ---"

assert_eq "reads the {result:[...]} envelope by id" \
  "createStake
syncApplyFix" \
  "$(vd_parse_functions_list '{"status":"success","result":[{"id":"syncApplyFix"},{"id":"createStake"}]}')"
assert_eq "falls back to the basename of a full resource path" \
  "markRequestComplete" \
  "$(vd_parse_functions_list '[{"name":"projects/p/locations/us-central1/functions/markRequestComplete"}]')"
assert_eq "de-duplicates and sorts" \
  "a
b" \
  "$(vd_parse_functions_list '[{"id":"b"},{"id":"a"},{"id":"b"}]')"
assert_false "fails on non-JSON so the caller can warn instead of asserting" \
  vd_parse_functions_list 'Error: Failed to authenticate'
assert_false "fails on an empty list rather than reporting nothing deployed" \
  vd_parse_functions_list '{"result":[]}'

echo ""
echo "--- vd_callable_url ---"

assert_eq "builds the default-region callable URL" \
  "https://us-central1-kindoo-staging.cloudfunctions.net/syncApplyFix" \
  "$(vd_callable_url syncApplyFix kindoo-staging)"
assert_eq "honours VD_REGION" \
  "https://europe-west1-kindoo-prod.cloudfunctions.net/createStake" \
  "$(VD_REGION=europe-west1 vd_callable_url createStake kindoo-prod)"

echo ""
echo "--- vd_resolve_project_id (real .firebaserc) ---"

assert_eq "resolves the staging alias" \
  "kindoo-staging" "$(vd_resolve_project_id "$REPO_ROOT" staging)"
assert_eq "resolves the prod alias" \
  "kindoo-prod" "$(vd_resolve_project_id "$REPO_ROOT" prod)"
assert_eq "passes an unknown value through as a literal project id" \
  "some-other-project" "$(vd_resolve_project_id "$REPO_ROOT" some-other-project)"

echo ""
echo "--- against the real functions/src/index.ts ---"

REAL_EXPORTS="$(vd_parse_exports "$REPO_ROOT/functions/src/index.ts")"
REAL_NAMES="$(printf '%s\n' "$REAL_EXPORTS" | cut -f1 | sort -u)"
REAL_CALLABLES="$(printf '%s\n' "$REAL_EXPORTS" | vd_filter_callables "$REPO_ROOT/functions/src" | sort -u)"

if [[ "$(printf '%s\n' "$REAL_NAMES" | wc -l | tr -d ' ')" -ge 10 ]]; then
  ok "parses a plausible number of exports from the live index.ts"
else
  bad "parses a plausible number of exports from the live index.ts" \
    ">= 10 exports" "$(printf '%s\n' "$REAL_NAMES" | wc -l | tr -d ' ')"
fi

assert_contains "finds the default baseline callable" \
  "syncApplyFix" "$REAL_CALLABLES"
assert_contains "the full export list includes a Firestore trigger" \
  "auditAccessWrites" "$REAL_NAMES"

# Cross-check the discovery mechanism against an independent signal: the repo's
# convention that callables live in functions/src/callable/. Discovery reads
# `onCall` out of the declaration; this reads the directory. If they disagree,
# either a callable moved out of that directory or discovery silently dropped
# one — and a silently-shrunk probe set is precisely the vacuous pass this file
# is meant to prevent. Failing here is the intended prompt to go look.
REAL_BY_DIRECTORY="$(printf '%s\n' "$REAL_EXPORTS" | awk -F'\t' '$2 ~ /^\.\/callable\// {print $1}' | sort -u)"
assert_eq "every export under callable/ is discovered, and nothing else is" \
  "$REAL_BY_DIRECTORY" "$REAL_CALLABLES"

if printf '%s\n' "$REAL_CALLABLES" | grep -qx 'auditAccessWrites'; then
  bad "does not misclassify a Firestore trigger as a callable" \
    "auditAccessWrites absent from callables" "$REAL_CALLABLES"
else
  ok "does not misclassify a Firestore trigger as a callable"
fi

if printf '%s\n' "$REAL_CALLABLES" | grep -qx 'reconcileAuditGaps'; then
  bad "does not misclassify a scheduled function as a callable" \
    "reconcileAuditGaps absent from callables" "$REAL_CALLABLES"
else
  ok "does not misclassify a scheduled function as a callable"
fi

echo ""
echo "--- vd_verify_deploy --dry-run (must not touch the network) ---"

DRY_OUT="$(vd_verify_deploy staging 1 2>&1)"
DRY_RC=$?
assert_eq "dry-run exits 0" "0" "$DRY_RC"
assert_contains "dry-run resolves the project" "kindoo-staging" "$DRY_OUT"
assert_contains "dry-run lists the URLs it would probe" \
  "https://us-central1-kindoo-staging.cloudfunctions.net/syncApplyFix" "$DRY_OUT"
assert_contains "dry-run states it probed nothing" "nothing probed" "$DRY_OUT"
assert_contains "dry-run previews the functions:list comparison" \
  "firebase functions:list --project staging --json" "$DRY_OUT"

echo ""
echo "--- vd_verify_deploy end-to-end, network stubbed ---"

# Each scenario runs in a subshell that shadows vd_probe / firebase / sleep, so
# the full orchestration — calibration, the per-function table, the
# source-vs-deployed diff, the failure report and the exit code — is exercised
# with zero network. This is the only way to prove the reporting path short of a
# real deploy.
#
# run_scenario names one function to break and the shape to break it with;
# every other callable answers like a healthy one.

# The default baseline vd_verify_deploy calibrates on, restated here so the
# broken-baseline scenario can target it.
VD_BASELINE_FOR_TEST="syncApplyFix"

STUB_LIST_ALL="$(printf '%s\n' "$REAL_NAMES" | python3 -c '
import json, sys
names = [n for n in sys.stdin.read().split() if n]
print(json.dumps({"status": "success", "result": [{"id": n} for n in names]}))
')"

# Same set, minus markRequestComplete, plus a stale leftover.
STUB_LIST_DRIFTED="$(printf '%s\n' "$REAL_NAMES" | python3 -c '
import json, sys
names = [n for n in sys.stdin.read().split() if n and n != "markRequestComplete"]
names.append("helloLeftover")
print(json.dumps({"status": "success", "result": [{"id": n} for n in names]}))
')"

run_scenario() {
  # $1 = function to break (or "" for none), $2 = kind, $3 = functions:list JSON
  #
  # The vd_stub_* prefix matters: bash scopes `local` dynamically, so a stub
  # reading a plainly-named variable would see vd_verify_deploy's local of the
  # same name instead of ours.
  local vd_stub_bad="$1" vd_stub_kind="$2" vd_stub_list="$3"
  (
    vd_probe() {
      local url="$1" body_file="$2"
      local fn="${url##*/}"
      local kind_for_fn="healthy"
      [[ "$fn" == "$vd_stub_bad" ]] && kind_for_fn="$vd_stub_kind"
      case "$kind_for_fn" in
        iam)
          printf '%s' "$BODY_RUN_FORBIDDEN" >"$body_file"
          printf '403'
          ;;
        missing)
          printf '%s' "$BODY_NOT_FOUND" >"$body_file"
          printf '404'
          ;;
        crash)
          printf '%s' "$BODY_CONTAINER_ERROR" >"$body_file"
          printf '500'
          ;;
        *)
          printf '%s' "$BODY_CALLABLE_AUTH" >"$body_file"
          printf '401'
          ;;
      esac
    }
    sleep() { :; }
    firebase() { printf '%s' "$vd_stub_list"; }
    vd_verify_deploy staging 0 2>&1
  )
}

SCENARIO_OUT="$(run_scenario "" "" "$STUB_LIST_ALL")"
SCENARIO_RC=$?
assert_eq "all-healthy scenario exits 0" "0" "$SCENARIO_RC"
assert_contains "all-healthy scenario reports PASSED" \
  "post-deploy verification PASSED" "$SCENARIO_OUT"
assert_contains "all-healthy scenario labels the baseline" \
  "healthy (baseline)" "$SCENARIO_OUT"
assert_contains "all-healthy scenario confirms the deployed set matches" \
  "deployed set matches functions/src/index.ts" "$SCENARIO_OUT"

SCENARIO_OUT="$(run_scenario "createStake" "iam" "$STUB_LIST_ALL")"
SCENARIO_RC=$?
assert_eq "IAM-403 scenario exits non-zero" "1" "$SCENARIO_RC"
assert_contains "IAM-403 scenario flags the function in the table" \
  "FAIL — iam-missing" "$SCENARIO_OUT"
assert_contains "IAM-403 scenario prints the exact binding command" \
  "gcloud run services add-iam-policy-binding createstake" "$SCENARIO_OUT"
assert_contains "IAM-403 scenario says the deploy itself shipped" \
  "The deploy itself shipped" "$SCENARIO_OUT"

SCENARIO_OUT="$(run_scenario "createStake" "missing" "$STUB_LIST_ALL")"
SCENARIO_RC=$?
assert_eq "404 scenario exits non-zero" "1" "$SCENARIO_RC"
assert_contains "404 scenario classifies as not-deployed" \
  "FAIL — not-deployed" "$SCENARIO_OUT"

SCENARIO_OUT="$(run_scenario "createStake" "crash" "$STUB_LIST_ALL")"
SCENARIO_RC=$?
assert_eq "5xx scenario exits non-zero" "1" "$SCENARIO_RC"
assert_contains "5xx scenario classifies as crashing" \
  "FAIL — crashing" "$SCENARIO_OUT"
assert_contains "5xx scenario points at the container logs" \
  "gcloud run services logs read createstake" "$SCENARIO_OUT"

SCENARIO_OUT="$(run_scenario "$VD_BASELINE_FOR_TEST" "crash" "$STUB_LIST_ALL")"
SCENARIO_RC=$?
assert_eq "broken-baseline scenario exits non-zero" "1" "$SCENARIO_RC"
assert_contains "broken-baseline scenario refuses to calibrate" \
  "BASELINE CALIBRATION FAILED" "$SCENARIO_OUT"
assert_contains "broken-baseline scenario names the alternative explanation" \
  "Firebase changed the callable protocol" "$SCENARIO_OUT"

SCENARIO_OUT="$(run_scenario "" "" "$STUB_LIST_DRIFTED")"
SCENARIO_RC=$?
assert_eq "deployed-set drift exits non-zero" "1" "$SCENARIO_RC"
assert_contains "a source export absent from the deploy is an ERROR" \
  "ERROR: exported from source but NOT deployed:" "$SCENARIO_OUT"
assert_contains "the missing export is named" "markRequestComplete" "$SCENARIO_OUT"
assert_contains "an unexpected deployed function is only a warning" \
  "warning: deployed but not exported from source" "$SCENARIO_OUT"
assert_contains "the extra function is named" "helloLeftover" "$SCENARIO_OUT"
assert_contains "drift remediation points at a rebuild + redeploy" \
  "firebase deploy --only functions --project staging" "$SCENARIO_OUT"

SCENARIO_OUT="$(
  vd_probe() { printf '%s' "$BODY_CALLABLE_AUTH" >"$2"; printf '401'; }
  firebase() { printf 'Error: not authenticated'; }
  vd_verify_deploy staging 0 2>&1
)"
SCENARIO_RC=$?
assert_eq "an unreadable functions:list does not fail the run" "0" "$SCENARIO_RC"
assert_contains "an unreadable functions:list warns and keeps the probe results" \
  "Skipping the source-vs-deployed comparison" "$SCENARIO_OUT"

# The baseline is probed first, so on a sparsely-trafficked project it is the
# request most likely to eat a cold start. A single slow response must not abort
# the whole run.
# The counter lives in a file: vd_probe is called inside a command
# substitution, so a shell variable would be incremented in a subshell and lost.
: >"$TMP_DIR/attempts"
SCENARIO_OUT="$(
  vd_probe() {
    printf 'x' >>"$TMP_DIR/attempts"
    if [[ "$(wc -c <"$TMP_DIR/attempts" | tr -d ' ')" -eq 1 ]]; then
      : >"$2"
      printf '000'
    else
      printf '%s' "$BODY_CALLABLE_AUTH" >"$2"
      printf '401'
    fi
  }
  sleep() { :; }
  firebase() { printf '%s' "$STUB_LIST_ALL"; }
  vd_verify_deploy staging 0 2>&1
)"
SCENARIO_RC=$?
assert_eq "a cold-start timeout on the baseline retries instead of aborting" \
  "0" "$SCENARIO_RC"
assert_contains "the baseline retry is announced" \
  "retrying once" "$SCENARIO_OUT"
assert_contains "the run continues to PASSED after the retry succeeds" \
  "post-deploy verification PASSED" "$SCENARIO_OUT"

echo ""
echo "--- standalone argument parsing ---"

VD_LIB="$SCRIPT_DIR/../lib/verify-deploy.sh"
assert_contains "flag-before-alias still targets the named project" \
  "would resolve alias 'prod'" "$(bash "$VD_LIB" --dry-run prod 2>&1)"
assert_contains "alias-before-flag works too" \
  "would resolve alias 'prod'" "$(bash "$VD_LIB" prod --dry-run 2>&1)"
assert_contains "a lone --dry-run defaults to staging, not to '--dry-run'" \
  "would resolve alias 'staging'" "$(bash "$VD_LIB" --dry-run 2>&1)"
assert_false "an unknown flag is rejected" bash "$VD_LIB" staging --bogus

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "=== verify-deploy.test.sh: $PASS passed, 0 failed ==="
  exit 0
fi
echo "=== verify-deploy.test.sh: $PASS passed, $FAIL FAILED ==="
exit 1
