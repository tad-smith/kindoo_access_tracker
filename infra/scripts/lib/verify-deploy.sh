#!/usr/bin/env bash
#
# verify-deploy.sh — post-deploy verification for Cloud Functions.
# Shared by infra/scripts/deploy-staging.sh and infra/scripts/deploy-prod.sh.
#
# WHAT IT DOES
#   Runs AFTER `firebase deploy` reports success and answers the question
#   `firebase deploy` cannot: are the functions it just uploaded actually
#   reachable and serving?
#
#   Check 1 — reachability probe. Sends an UNAUTHENTICATED callable POST to
#     every callable exported from functions/src/index.ts and classifies the
#     response. See "CLASSIFICATION" below.
#   Check 2 — deployed set vs source. Compares `firebase functions:list`
#     against the export list in functions/src/index.ts. A *missing* export is
#     an error (stale code / wrong-branch deploy); an *extra* deployed function
#     is a warning (it may be a pending manual delete).
#
# WHY IT EXISTS (incident, 2026-08-02)
#   A staging deploy printed "complete" while the feature was unusable, three
#   distinct ways, all silent:
#     1. Cloud Build's own `npm install` against the generated
#        functions/lib/package.json skipped an optional peer dep, and every
#        function died at container start. `firebase deploy` still said OK.
#        (Systemic fix tracked as T-73 — not implemented here.)
#     2. That failed run left an empty Cloud Run service shell for a brand-new
#        function. The next deploy therefore took the UPDATE path, not create —
#        and Firebase only grants the `allUsers` -> `roles/run.invoker` binding
#        on CREATE. The function deployed "successfully", was healthy, and was
#        still unreachable. The browser reported it as a CORS error, because a
#        Cloud Run 403 on the preflight carries no Access-Control-Allow-Origin
#        header. Deeply misleading symptom for a missing IAM binding. Check 1
#        catches exactly this, and it is the highest-value catch here.
#     3. A deploy run from a checkout that did not contain the function being
#        deployed. Check 2 catches the silent variant of this.
#
# CLASSIFICATION — calibrated, not hardcoded
#   We do NOT assert specific status codes or body shapes from memory; Firebase
#   is free to change them. Instead we calibrate in-run:
#
#     1. Probe a known-good, long-existing callable first (the BASELINE,
#        default `syncApplyFix`, override with VD_BASELINE).
#     2. Sanity-check the baseline against the ONE structural prior in this
#        file: a 4xx that is neither 403 nor 404, carrying a JSON body with an
#        `error` object — i.e. the callable protocol itself rejected the call,
#        which proves the container started and ran our code. If the baseline
#        fails that, abort loudly rather than calibrate against garbage.
#     3. Every other callable is compared to the baseline's SIGNATURE
#        (http status + the body's `error.status` string). Same signature =>
#        healthy. That is the whole pass/fail rule.
#
#   When a callable does NOT match the baseline, the status code is used only
#   to name a LIKELY cause and print a remediation. Those hints never decide
#   pass/fail:
#     403     -> allUsers/run.invoker binding missing (incident #2)
#     404     -> not deployed under this name/region
#     5xx     -> container won't start / crashing (incident #1)
#     000     -> unreachable (DNS/network/timeout)
#     other   -> unknown; status + body excerpt is printed verbatim
#
# WHAT IT ASSUMES
#   - `curl` and `python3` on PATH (python3 is already a dependency of
#     deploy-staging.sh's --from-pr path).
#   - Callables are deployed to us-central1 (firebase-functions v2 default; the
#     repo sets no explicit region and the clients call getFunctions(app) with
#     no region override). Override with VD_REGION if that ever changes.
#   - Every callable rejects an anonymous call the SAME WAY the baseline does.
#     Two parts, and the second is the stronger claim:
#       (a) the auth check comes before any side effect — the repo convention.
#           The probe sends an empty `{"data":{}}` with no Authorization header,
#           so an auth-checking callable rejects before doing anything.
#       (b) the error it throws first carries the same code as the baseline's
#           (today: `unauthenticated`). Pass/fail is signature equality, so a
#           callable that threw `permission-denied` first would signature
#           `403:PERMISSION_DENIED`, miss the baseline, and be reported as
#           `iam-missing` — a false positive naming the wrong cause.
#     Both hold for every current callable. A future one that breaks either is
#     a loud, wrong-cause failure rather than a silent pass; exclude it with
#     VD_SKIP_CALLABLES and note why here.
#   - Only `onCall` exports are probed. Firestore/Auth triggers and scheduled
#     functions are invoked through Eventarc/Scheduler with an OIDC identity and
#     correctly reject anonymous callers, so probing them proves nothing.
#
# WHAT IT LEAVES BEHIND
#   Nothing. Read-only against the project (one unauthenticated POST per
#   callable, plus `firebase functions:list`). Response bodies land in a
#   `mktemp -d` directory that is removed before every return.
#
# ENV OVERRIDES
#   VD_REGION          function region                    (default us-central1)
#   VD_BASELINE        baseline callable name             (default syncApplyFix)
#   VD_TIMEOUT         per-probe curl timeout, seconds    (default 30)
#   VD_SKIP_CALLABLES  space-separated names to not probe (default empty)
#
# USAGE
#   Sourced by the deploy scripts:
#     source infra/scripts/lib/verify-deploy.sh
#     vd_verify_deploy <project-alias> <dry-run 0|1>
#
#   Or standalone, against an already-deployed project:
#     bash infra/scripts/lib/verify-deploy.sh staging
#     bash infra/scripts/lib/verify-deploy.sh prod --dry-run
#
# The pure helpers (vd_error_status / vd_signature / vd_classify /
# vd_remediation / vd_parse_exports / vd_parse_functions_list) take strings and
# return strings with no network access, and are exercised by
# infra/scripts/tests/verify-deploy.test.sh.
#
# Targets bash 3.2 (the macOS system bash) — no associative arrays, no
# `mapfile`, no bare array expansion under `set -u`.

# ---------------------------------------------------------------------------
# Pure helpers — no network, no filesystem beyond the paths handed in.
# ---------------------------------------------------------------------------

# Extract `.error.status` from a callable-protocol JSON error body.
# Echoes the empty string for non-JSON bodies, or JSON without that field.
vd_error_status() {
  printf '%s' "${1-}" | python3 -c '
import json, sys
try:
    body = json.loads(sys.stdin.read() or "null")
except Exception:
    print("")
    raise SystemExit(0)
if isinstance(body, dict) and isinstance(body.get("error"), dict):
    status = body["error"].get("status")
    print(status if isinstance(status, str) else "")
else:
    print("")
' 2>/dev/null || printf '\n'
}

# True (0) when the body is JSON carrying an `error` object — the callable
# protocol's error envelope, whatever field names it puts inside it.
vd_has_error_envelope() {
  local verdict
  verdict="$(printf '%s' "${1-}" | python3 -c '
import json, sys
try:
    body = json.loads(sys.stdin.read() or "null")
except Exception:
    print("no")
    raise SystemExit(0)
print("yes" if isinstance(body, dict) and isinstance(body.get("error"), dict) else "no")
' 2>/dev/null || printf 'no')"
  [[ "$verdict" == "yes" ]]
}

# Response signature: "<http-status>:<error.status>". This is the value compared
# against the baseline's. Both halves matter — a Cloud Run edge rejection and a
# callable-protocol rejection can share a status code but never a body shape.
vd_signature() {
  local status="${1-}" body="${2-}"
  printf '%s:%s' "$status" "$(vd_error_status "$body")"
}

# Baseline sanity gate. The single structural prior in this file: a healthy
# callable answering an unauthenticated call rejects it itself — a 4xx that is
# neither the Cloud Run edge's 403 nor a 404, with the callable protocol's JSON
# error envelope in the body.
vd_baseline_is_sane() {
  local status="${1-}" body="${2-}"
  [[ "$status" =~ ^4[0-9][0-9]$ ]] || return 1
  [[ "$status" != "403" && "$status" != "404" ]] || return 1
  vd_has_error_envelope "$body"
}

# Classify one probe against the calibrated baseline signature.
# Echoes one of: healthy | iam-missing | not-deployed | crashing | unreachable |
# unknown
vd_classify() {
  local status="${1-}" body="${2-}" baseline_sig="${3-}"

  if [[ "$(vd_signature "$status" "$body")" == "$baseline_sig" ]]; then
    printf 'healthy'
    return 0
  fi

  case "$status" in
    000) printf 'unreachable' ;;
    403) printf 'iam-missing' ;;
    404) printf 'not-deployed' ;;
    5??) printf 'crashing' ;;
    *) printf 'unknown' ;;
  esac
}

# Human remediation for a classification. $2 = function name, $3 = project id.
vd_remediation() {
  local verdict="${1-}" name="${2-}" project="${3-}" region="${VD_REGION:-us-central1}"
  local lower
  lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"

  case "$verdict" in
    iam-missing)
      printf 'Cloud Run rejected the call at the edge, before the function ran.\n'
      printf 'Likely cause: the allUsers -> roles/run.invoker binding is missing.\n'
      printf 'Firebase grants it only when it CREATES the service, so a function\n'
      printf 'whose first deploy left a broken shell never gets it. In a browser\n'
      printf 'this surfaces as a CORS error, not as a 403.\n'
      printf 'Fix:\n'
      printf '  gcloud run services add-iam-policy-binding %s \\\n' "$lower"
      printf '    --region %s --project %s \\\n' "$region" "$project"
      printf '    --member=allUsers --role=roles/run.invoker\n'
      ;;
    not-deployed)
      printf 'No function is serving at this URL (404).\n'
      printf 'Likely cause: never deployed, deployed under a different name, or\n'
      printf 'living in a region other than %s.\n' "$region"
      printf 'Fix: check `firebase functions:list --project %s`, then redeploy:\n' "$project"
      printf '  firebase deploy --only functions:%s --project %s\n' "$name" "$project"
      ;;
    crashing)
      printf 'The container returned a server error — failing to start, or\n'
      printf 'crashing on request. A runtime dependency missing from the generated\n'
      printf 'functions/lib/package.json is the known cause (T-73).\n'
      printf 'Fix: read the startup logs, then correct functions/package.json deps:\n'
      printf '  gcloud run services logs read %s --region %s --project %s --limit 50\n' \
        "$lower" "$region" "$project"
      ;;
    unreachable)
      printf 'The probe never got a response (DNS, network, or timeout after %ss).\n' \
        "${VD_TIMEOUT:-30}"
      printf 'Fix: check connectivity, then re-run the verification standalone:\n'
      printf '  bash infra/scripts/lib/verify-deploy.sh <alias>\n'
      ;;
    unknown)
      printf 'The response did not match the baseline and does not fit a known\n'
      printf 'failure shape. Either Firebase changed its response format (in which\n'
      printf 'case re-calibrate this script) or this is a novel failure.\n'
      printf 'Fix: probe it by hand and compare against the baseline callable:\n'
      printf '  curl -i -X POST -H "Content-Type: application/json" -d %s \\\n' "'{\"data\":{}}'"
      printf '    https://%s-%s.cloudfunctions.net/%s\n' "$region" "$project" "$name"
      ;;
    *)
      printf 'No remediation for verdict: %s\n' "$verdict"
      ;;
  esac
}

# Parse `export { a, b as c } from './dir/mod.js';` statements out of an
# index.ts. Emits one "<exported-name><TAB><module-path><TAB><local-name>" line
# per export. Multi-line export blocks are handled; line comments are ignored.
#
# The exported name is what Firebase deploys under; the local name is what the
# module actually declares. For `export { internalName as publicName }` those
# differ, and vd_filter_callables needs the local one to find the declaration.
vd_parse_exports() {
  local index_file="${1-}"
  [[ -f "$index_file" ]] || return 1
  python3 - "$index_file" <<'PY'
import re, sys

src = open(sys.argv[1], encoding="utf-8").read()
# Strip line comments so a commented-out export never counts.
src = re.sub(r"(?m)^\s*//.*$", "", src)

for names, module in re.findall(r"export\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]", src):
    for raw in names.split(","):
        entry = raw.strip()
        if not entry:
            continue
        # `X as Y` is declared as X and exported as Y.
        if " as " in entry:
            local, exported = (part.strip() for part in entry.split(" as ", 1))
        else:
            local = exported = entry
        if exported in ("type", "default"):
            continue
        print(f"{exported}\t{module}\t{local}")
PY
}

# Filter vd_parse_exports output down to the callables. Reads
# "<name><TAB><module>" lines on stdin and emits the names that are defined by
# an `onCall` in their module.
# $1 = directory the module paths are relative to (functions/src).
#
# Scoping, and which way to be wrong. Comments are stripped, then the module is
# split at top-level `export` boundaries and we look for `onCall` inside the
# chunk belonging to this name. That deliberately tolerates definitions this
# check cannot predict — a line-broken `export const x =\n  onCall(`, or a
# wrapper like `withAuth(onCall(...))` — because the two errors are not
# symmetric: wrongly INCLUDING a non-callable produces a loud false failure an
# operator will see and can silence with VD_SKIP_CALLABLES, while wrongly
# EXCLUDING a real callable silently shrinks the probe set and reports a
# vacuous pass. That silent direction is exactly the class of bug this whole
# file exists to catch, so the scan biases toward inclusion.
#
# The program reaches python via `-c "$(cat <<'PY' … PY)"` rather than as a
# plain heredoc, because a heredoc on stdin would displace the TSV this function
# reads. Going through a quoted heredoc (rather than a single-quoted `-c`
# argument) keeps the Python free to contain quotes of any kind.
vd_filter_callables() {
  local src_dir="${1-}"
  python3 -c "$(
    cat <<'PY'
import re, sys

src_dir = sys.argv[1]
cache = {}

def callable_names(path):
    """Names in `path` whose `export const NAME = ...` declaration mentions onCall."""
    if path in cache:
        return cache[path]
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        cache[path] = set()
        return cache[path]

    # Strip comments so prose mentioning onCall cannot promote a trigger.
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    text = re.sub(r"(?m)^\s*//.*$", "", text)

    found = set()
    # Each top-level `export` starts a new declaration; the chunk runs to the
    # next one. `onCall` anywhere in that chunk means this export is a callable,
    # however it is spelled or wrapped.
    starts = [m.start() for m in re.finditer(r"(?m)^export\b", text)]
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(text)
        chunk = text[start:end]
        head = re.match(r"export\s+(?:const|let|var|function)\s+([A-Za-z0-9_$]+)", chunk)
        if head and re.search(r"\bonCall\b", chunk):
            found.add(head.group(1))
    cache[path] = found
    return found

for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 2 or not parts[0]:
        continue
    exported, module = parts[0], parts[1]
    # The declaration carries the local name; the deploy carries the exported one.
    local = parts[2] if len(parts) > 2 and parts[2] else exported
    # './callable/foo.js' -> '<src_dir>/callable/foo.ts'
    rel = module[2:] if module.startswith("./") else module
    path = f"{src_dir}/{rel}"
    if path.endswith(".js"):
        path = path[:-3] + ".ts"
    if local in callable_names(path):
        print(exported)
PY
  )" "$src_dir"
}

# Extract deployed function names from `firebase functions:list --json` output.
# Tolerant of shape drift: accepts a bare list or {result: [...]}, and reads
# `id`, else `functionName`, else the basename of `name` (which may be a full
# resource path). Returns 1 if the payload cannot be understood.
vd_parse_functions_list() {
  local out
  out="$(printf '%s' "${1-}" | python3 -c '
import json, sys

try:
    doc = json.loads(sys.stdin.read() or "null")
except Exception:
    raise SystemExit(1)

items = doc.get("result") if isinstance(doc, dict) else doc
if not isinstance(items, list):
    raise SystemExit(1)

names = []
for item in items:
    if not isinstance(item, dict):
        continue
    value = item.get("id") or item.get("functionName") or item.get("name") or ""
    if isinstance(value, str) and value:
        names.append(value.rsplit("/", 1)[-1])

if not names:
    raise SystemExit(1)
print("\n".join(sorted(set(names))))
' 2>/dev/null)" || return 1
  printf '%s\n' "$out"
}

# Resolve a .firebaserc alias (or a literal project id) to a project id.
vd_resolve_project_id() {
  local repo_root="${1-}" alias="${2-}"
  local rc="$repo_root/.firebaserc"
  [[ -f "$rc" ]] || return 0
  python3 - "$rc" "$alias" <<'PY' 2>/dev/null || true
import json, sys

rc_path, alias = sys.argv[1], sys.argv[2]
try:
    projects = json.load(open(rc_path, encoding="utf-8")).get("projects", {})
except Exception:
    projects = {}
# An alias wins; otherwise assume the caller passed a literal project id.
print(projects.get(alias, alias))
PY
}

vd_callable_url() {
  printf 'https://%s-%s.cloudfunctions.net/%s' "${VD_REGION:-us-central1}" "${2-}" "${1-}"
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

# POST an unauthenticated callable request. Writes the body to $2, echoes the
# HTTP status ("000" when curl never got a response).
vd_probe() {
  local url="${1-}" body_file="${2-}"
  local code
  code="$(curl -sS -X POST "$url" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json' \
    --data '{"data":{}}' \
    --max-time "${VD_TIMEOUT:-30}" \
    -o "$body_file" \
    -w '%{http_code}' 2>/dev/null || true)"
  [[ "$code" =~ ^[0-9]{3}$ ]] || code="000"
  printf '%s' "$code"
}

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

# vd_verify_deploy <project-alias> <dry-run 0|1>
# Returns 0 when everything verified, 1 otherwise.
vd_verify_deploy() {
  local alias="${1-}" dry_run="${2-0}"
  local region="${VD_REGION:-us-central1}"
  local baseline_name="${VD_BASELINE:-syncApplyFix}"

  local script_dir repo_root index_file src_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../../.." && pwd)"
  index_file="$repo_root/functions/src/index.ts"
  src_dir="$repo_root/functions/src"

  echo ""
  echo "=== post-deploy verification — $alias ==="

  if [[ ! -f "$index_file" ]]; then
    echo "error: cannot find $index_file — nothing to verify against." >&2
    return 1
  fi

  # Expected exports (all of them) and the callable subset.
  local exports_tsv expected_all callables
  exports_tsv="$(vd_parse_exports "$index_file" || true)"
  expected_all="$(printf '%s\n' "$exports_tsv" | cut -f1 | grep -v '^[[:space:]]*$' | sort -u || true)"
  callables="$(printf '%s\n' "$exports_tsv" | vd_filter_callables "$src_dir" | sort -u || true)"

  # Honour the skip list.
  local skip
  for skip in ${VD_SKIP_CALLABLES:-}; do
    callables="$(printf '%s\n' "$callables" | grep -vx -- "$skip" || true)"
  done

  if [[ -z "$expected_all" || -z "$callables" ]]; then
    echo "error: derived zero exports or zero callables from functions/src/index.ts." >&2
    echo "       Refusing to report a vacuous pass — check vd_parse_exports /" >&2
    echo "       vd_filter_callables in infra/scripts/lib/verify-deploy.sh against" >&2
    echo "       the current shape of index.ts." >&2
    return 1
  fi

  echo "    region:    $region"
  echo "    baseline:  $baseline_name"
  echo "    exports:   $(printf '%s\n' "$expected_all" | wc -l | tr -d ' ') (source: functions/src/index.ts)"
  echo "    callables: $(printf '%s\n' "$callables" | wc -l | tr -d ' ')"

  if ! printf '%s\n' "$callables" | grep -qx -- "$baseline_name"; then
    echo "error: baseline callable '$baseline_name' is not exported from index.ts." >&2
    echo "       Calibration needs a long-existing callable that is known good." >&2
    echo "       Set VD_BASELINE to one of:" >&2
    printf '%s\n' "$callables" | sed 's/^/         /' >&2
    return 1
  fi

  local project_id
  project_id="$(vd_resolve_project_id "$repo_root" "$alias")"

  if [[ "$dry_run" -eq 1 ]]; then
    echo ""
    echo "[dry-run] would resolve alias '$alias' -> project '${project_id:-<unresolved>}'"
    echo "[dry-run] would calibrate against baseline callable: $baseline_name"
    echo "[dry-run] would POST an unauthenticated {\"data\":{}} to each of:"
    local fn_preview
    while IFS= read -r fn_preview; do
      if [[ -n "$fn_preview" ]]; then
        echo "[dry-run]   $(vd_callable_url "$fn_preview" "${project_id:-<project>}")"
      fi
    done <<EOF
$callables
EOF
    echo "[dry-run] would run: firebase functions:list --project $alias --json"
    echo "[dry-run] would compare that list against these source exports:"
    printf '%s\n' "$expected_all" | sed 's/^/[dry-run]   /'
    echo "[dry-run] nothing probed."
    return 0
  fi

  if [[ -z "$project_id" ]]; then
    echo "error: could not resolve alias '$alias' to a project id via .firebaserc." >&2
    return 1
  fi
  echo "    project:   $project_id"
  echo ""

  local tmp_dir
  tmp_dir="$(mktemp -d)"

  # --- Check 1: calibrate on the baseline, then probe every callable. ---
  local baseline_status baseline_body baseline_sig
  baseline_status="$(vd_probe "$(vd_callable_url "$baseline_name" "$project_id")" "$tmp_dir/baseline")"
  baseline_body="$(cat "$tmp_dir/baseline" 2>/dev/null || true)"

  # One retry, same as the per-callable loop below. The baseline is probed
  # first, so on a sparsely-trafficked project (staging) it is the request most
  # likely to eat a cold start and overrun the probe timeout. Without this, a
  # slow container start aborts the entire run with BASELINE CALIBRATION FAILED
  # and a "check connectivity" remediation that points nowhere useful.
  if ! vd_baseline_is_sane "$baseline_status" "$baseline_body"; then
    echo "  baseline '$baseline_name' answered HTTP $baseline_status — retrying once"
    echo "  in case that was a cold start."
    sleep 3
    baseline_status="$(vd_probe "$(vd_callable_url "$baseline_name" "$project_id")" "$tmp_dir/baseline")"
    baseline_body="$(cat "$tmp_dir/baseline" 2>/dev/null || true)"
  fi

  if ! vd_baseline_is_sane "$baseline_status" "$baseline_body"; then
    echo "error: BASELINE CALIBRATION FAILED." >&2
    echo "       Probed '$baseline_name' and got HTTP $baseline_status." >&2
    echo "       A healthy callable rejects an unauthenticated call itself, with a" >&2
    echo "       JSON error envelope. This response is not that, so there is nothing" >&2
    echo "       trustworthy to compare the other callables against." >&2
    echo "" >&2
    echo "       Either the baseline is itself broken — in which case:" >&2
    vd_remediation "$(vd_classify "$baseline_status" "$baseline_body" '<none>')" \
      "$baseline_name" "$project_id" | sed 's/^/         /' >&2
    echo "" >&2
    echo "       — or Firebase changed the callable protocol's error shape, in which" >&2
    echo "       case update vd_baseline_is_sane in infra/scripts/lib/verify-deploy.sh." >&2
    echo "" >&2
    echo "       Response body (first 400 chars):" >&2
    printf '%s' "$baseline_body" | head -c 400 | sed 's/^/         /' >&2
    echo "" >&2
    rm -rf "$tmp_dir"
    return 1
  fi

  baseline_sig="$(vd_signature "$baseline_status" "$baseline_body")"
  echo "  calibrated on '$baseline_name': HTTP $baseline_status, signature '$baseline_sig'."
  echo "  Any callable answering with that signature is healthy — it ran our code"
  echo "  and rejected the anonymous call itself."
  echo ""

  printf '  %-34s %-6s %s\n' "FUNCTION" "HTTP" "RESULT"
  printf '  %-34s %-6s %s\n' "$baseline_name" "$baseline_status" "healthy (baseline)"

  # bash 3.2: newline-delimited string instead of an array, so `set -u` never
  # trips on an empty expansion. Entries are "name|verdict|status".
  local failures='' failure_count=0
  local fn status body verdict
  while IFS= read -r fn; do
    [[ -n "$fn" ]] || continue
    [[ "$fn" != "$baseline_name" ]] || continue

    status="$(vd_probe "$(vd_callable_url "$fn" "$project_id")" "$tmp_dir/probe")"
    body="$(cat "$tmp_dir/probe" 2>/dev/null || true)"
    verdict="$(vd_classify "$status" "$body" "$baseline_sig")"

    # One retry for the transient shapes — a cold start racing the probe
    # timeout should not be reported as a crash.
    if [[ "$verdict" == "crashing" || "$verdict" == "unreachable" ]]; then
      sleep 3
      status="$(vd_probe "$(vd_callable_url "$fn" "$project_id")" "$tmp_dir/probe")"
      body="$(cat "$tmp_dir/probe" 2>/dev/null || true)"
      verdict="$(vd_classify "$status" "$body" "$baseline_sig")"
    fi

    if [[ "$verdict" == "healthy" ]]; then
      printf '  %-34s %-6s %s\n' "$fn" "$status" "healthy"
    else
      printf '  %-34s %-6s %s\n' "$fn" "$status" "FAIL — $verdict"
      failures="${failures}${fn}|${verdict}|${status}
"
      failure_count=$((failure_count + 1))
    fi
  done <<EOF
$callables
EOF
  echo ""

  # --- Check 2: deployed set vs source exports. ---
  local list_json deployed missing extra
  list_json="$(firebase functions:list --project "$alias" --json 2>/dev/null || true)"
  if deployed="$(vd_parse_functions_list "$list_json")"; then
    missing="$(comm -23 <(printf '%s\n' "$expected_all") <(printf '%s\n' "$deployed") || true)"
    extra="$(comm -13 <(printf '%s\n' "$expected_all") <(printf '%s\n' "$deployed") || true)"

    if [[ -z "$missing" && -z "$extra" ]]; then
      echo "  deployed set matches functions/src/index.ts ($(printf '%s\n' "$deployed" | wc -l | tr -d ' ') functions)."
    fi
    if [[ -n "$extra" ]]; then
      echo "  warning: deployed but not exported from source (pending delete?):"
      printf '%s\n' "$extra" | sed 's/^/    /'
    fi
    if [[ -n "$missing" ]]; then
      echo "  ERROR: exported from source but NOT deployed:"
      printf '%s\n' "$missing" | sed 's/^/    /'
      failures="${failures}<deployed-set>|source-not-deployed|-
"
      failure_count=$((failure_count + 1))
    fi
  else
    echo "  warning: could not read \`firebase functions:list --project $alias --json\`."
    echo "           Skipping the source-vs-deployed comparison; the probe results"
    echo "           above still stand."
  fi

  rm -rf "$tmp_dir"

  # --- Verdict. ---
  echo ""
  if [[ "$failure_count" -eq 0 ]]; then
    echo "=== post-deploy verification PASSED ==="
    return 0
  fi

  echo "=== post-deploy verification FAILED ($failure_count) ==="
  echo ""
  echo "The deploy itself shipped. These are not usable:"
  echo ""
  local entry name_out verdict_out status_out
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    name_out="${entry%%|*}"
    verdict_out="${entry#*|}"
    status_out="${verdict_out#*|}"
    verdict_out="${verdict_out%%|*}"
    if [[ "$name_out" == "<deployed-set>" ]]; then
      echo "  * source exports are missing from the deployed set."
      echo "    Likely cause: the deploy ran from a checkout that does not contain"
      echo "    them, or the functions deploy partially failed."
      echo "    Fix: confirm \`git rev-parse HEAD\` is the commit you meant, then:"
      echo "      pnpm --filter ./functions build"
      echo "      firebase deploy --only functions --project $alias"
    else
      echo "  * $name_out — $verdict_out (HTTP $status_out)"
      vd_remediation "$verdict_out" "$name_out" "$project_id" | sed 's/^/    /'
    fi
    echo ""
  done <<EOF
$failures
EOF
  echo "Re-run this check on its own once fixed:"
  echo "  bash infra/scripts/lib/verify-deploy.sh $alias"
  return 1
}

# ---------------------------------------------------------------------------
# Standalone entry point. No-op when sourced.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -uo pipefail
  vd_alias=''
  vd_dry=0
  # Flags and the alias in any order — `--dry-run staging` and `staging
  # --dry-run` both work, and a lone `--dry-run` does not become the alias.
  for vd_arg in "$@"; do
    case "$vd_arg" in
      --dry-run) vd_dry=1 ;;
      -*)
        echo "Unknown argument: $vd_arg" >&2
        echo "Usage: $0 [staging|prod|<project-id>] [--dry-run]" >&2
        exit 2
        ;;
      *)
        if [[ -n "$vd_alias" ]]; then
          echo "error: more than one project given ('$vd_alias' and '$vd_arg')." >&2
          echo "Usage: $0 [staging|prod|<project-id>] [--dry-run]" >&2
          exit 2
        fi
        vd_alias="$vd_arg"
        ;;
    esac
  done
  vd_verify_deploy "${vd_alias:-staging}" "$vd_dry"
fi
