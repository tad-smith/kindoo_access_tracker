// Shared roster-shape builder for Chunk 5's read-side endpoints.
//
// All four roster endpoints (bishopric Roster, stake Roster, stake
// WardRosters, manager AllSeats) return the same per-scope shape:
//
//   {
//     summary: { scope, ward_name, seat_cap, total_seats,
//                utilization_pct, over_cap },
//     rows:    [ <rosterRow>, ... ]
//   }
//
// Manager AllSeats extends that with multiple summaries (one per scope
// that has seats, after filtering) and filter-option lists.
//
// Centralising the shape here keeps the three read-side UIs renderable
// from one client helper, and keeps the "which fields do we expose?" and
// "what counts against the cap?" decisions in one server-side file.
//
// Reads: Seats tab once via Seats_getByScope / Seats_getAll. Wards and
// Config are read once at the top of every endpoint by the caller and
// passed in via the ctx object — per architecture.md §9's "no N+1 reads"
// rule. This module does not touch CacheService.

const ROSTERS_STAKE_SCOPE_ = 'stake';

// Build a response for a single scope. `scope` is a ward_code or 'stake'.
// `ctx` is whatever Rosters_buildContext_() produced for this request.
//
// Chunk 7: each row is also annotated with `removal_pending: bool` so the
// roster UI can render the X/trashcan as disabled (and a "Removal pending"
// badge) when the row already has an outstanding remove request. We do
// the lookup once per scope (one pass over Requests) rather than per row
// to keep the read pattern bounded — typical pending-remove count for a
// scope is 0-1.
function Rosters_buildResponseForScope(scope, ctx) {
  var key = String(scope);
  var seats = Seats_getByScope(key);
  return Rosters_buildResponseFromSeats_(key, seats, ctx);
}

// Same as above, but for callers that already have the row subset in hand
// (e.g. ApiManager_allSeats reads every seat once, then buckets by scope).
function Rosters_buildResponseFromSeats_(scope, seats, ctx) {
  // Build a per-scope set of canonical emails with a pending remove
  // request. Read Requests once and bucket by scope so the manager
  // AllSeats path (which calls this once per scope) doesn't do N reads.
  var pendingRemoveEmails = Rosters_pendingRemoveEmailsForScope_(scope, ctx);
  var rows = [];
  for (var i = 0; i < seats.length; i++) {
    var mapped = Rosters_mapRow_(seats[i], ctx.today);
    // Auto rows are never removable via the request flow (R-3); leave the
    // badge off so the UI doesn't surface a misleading "removal pending"
    // on an importer-owned row even if a stale request snuck in somehow.
    mapped.removal_pending = (mapped.type !== 'auto') &&
      pendingRemoveEmails[Utils_normaliseEmail(mapped.member_email)] === true;
    rows.push(mapped);
  }
  Rosters_sortRows_(rows, scope, ctx);
  var summary = Rosters_buildSummary_(scope, rows.length, ctx);
  return { summary: summary, rows: rows };
}

// Build the shared context object once per endpoint (reads Wards + Config
// + pending Requests). Pending remove-requests are pre-bucketed by scope
// so per-scope responses don't each re-read the Requests tab.
function Rosters_buildContext_() {
  var wards = Wards_getAll();
  var byCode = {};
  for (var i = 0; i < wards.length; i++) byCode[wards[i].ward_code] = wards[i];
  var rawCap = Config_get('stake_seat_cap');

  // Pending remove-requests bucketed by scope. Map shape:
  //   { '<scope>': { '<canonical_email>': true, ... }, ... }
  // ApiBishopric / ApiStake roster paths only need one scope's bucket,
  // but the read is cheap (typically 0-5 pending across all scopes) and
  // keeping the bucketing here avoids spreading the Requests read into
  // four different roster endpoints.
  //
  // Catch policy: silence ONLY the "Requests tab missing" case (a brand-
  // new spreadsheet that hasn't run setupSheet yet — extremely rare, but
  // the roster pages should still render so the operator can see what's
  // configured). Header drift (e.g. an existing install that hasn't
  // added the Chunk-7 `completion_note` column) MUST surface — silencing
  // it would let some pages render an enabled X for rows that already
  // have a pending remove while the actual submit / queue / cancel paths
  // throw loudly. That inconsistency is worse than a uniformly loud fail
  // (open-questions.md SD-2: header drift is a "fix by hand" signal,
  // never a quietly-degrade signal).
  var pendingRemovesByScope = {};
  try {
    var pending = Requests_getPending();
    for (var p = 0; p < pending.length; p++) {
      var pr = pending[p];
      if (pr.type !== 'remove') continue;
      var sc = pr.scope || '';
      if (!pendingRemovesByScope[sc]) pendingRemovesByScope[sc] = {};
      pendingRemovesByScope[sc][Utils_normaliseEmail(pr.member_email)] = true;
    }
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    // The literal string thrown by Requests_sheet_() when the tab is
    // missing. Anything else (header drift, sheet locked, etc.) propagates.
    if (msg.indexOf('Requests tab missing') !== 0) {
      throw e;
    }
    Logger.log('[Rosters] Requests tab missing — treating as no pending removes.');
  }

  // Seat counts for stake-portion math. `stake_seat_cap` is the total
  // Kindoo license limit across the entire stake; the "stake portion"
  // shown on stake-facing displays is the capacity left for stake-scope
  // use after wards have taken their share:
  //
  //     stake_portion_cap = stake_seat_cap - wardSeatsCount
  //
  // `Rosters_buildSummary_` for scope 'stake' uses this as the cap
  // (numerator stays the stake-scope row count) so the utilization bar
  // on Stake Roster, the Dashboard's stake row, the AllSeats stake
  // summary, and the over-cap detection all report the stake
  // presidency's own allocation. Over-cap fires when stake-scope >
  // stake_portion_cap, which is mathematically equivalent to
  // total_seats > stake_seat_cap but reads naturally as "stake is N
  // over its portion". Ward-scoped summaries are unchanged.
  //
  // Seats_getAll is CacheService-memoized (Chunk 10.5), so the read is
  // cheap on warm cache.
  var allSeats = Seats_getAll();
  var stakeSeatsCount = 0;
  for (var si = 0; si < allSeats.length; si++) {
    if (String(allSeats[si].scope || '') === ROSTERS_STAKE_SCOPE_) stakeSeatsCount++;
  }
  var wardSeatsCount = allSeats.length - stakeSeatsCount;

  return {
    today:                 Utils_todayIso(),
    wardsByCode:           byCode,
    stakeSeatCap:          (rawCap == null || rawCap === '') ? null : Number(rawCap),
    wardSeatsCount:        wardSeatsCount,
    pendingRemovesByScope: pendingRemovesByScope,
    // Calling-template position indexes — power the auto-row sort
    // (seat.calling_name → template sheet-row position; unmatched seats
    // sort to the bottom of the auto block). Same match semantics as
    // the importer: exact beats wildcard, first-listed wildcard wins.
    wardTemplateIndex:     Rosters_templatePositionIndex_('ward'),
    stakeTemplateIndex:    Rosters_templatePositionIndex_('stake')
  };
}

// Returns the per-scope "canonical email → true" map for pending remove
// requests. Falls back to an empty map when the ctx wasn't built by
// Rosters_buildContext_ (e.g. unit tests, legacy callers).
function Rosters_pendingRemoveEmailsForScope_(scope, ctx) {
  if (!ctx || !ctx.pendingRemovesByScope) return {};
  return ctx.pendingRemovesByScope[String(scope)] || {};
}

// Translate a SeatsRepo object into the UI-agnostic roster shape. Drops
// internal-only fields (source_row_hash, created_by, last_modified_by)
// and computes the temp-seat expiry badge (Chunk-8's expiry trigger hasn't
// shipped, so stale temp rows linger in the Sheet — the badge tells the
// user why utilization is high).
function Rosters_mapRow_(seat, today) {
  var badge = '';
  if (seat.type === 'temp' && seat.end_date) {
    var end = String(seat.end_date);
    if (end < today)        badge = 'expired';
    else if (end === today) badge = 'expires_today';
  }
  return {
    seat_id:          seat.seat_id,
    scope:            seat.scope,
    type:             seat.type,
    member_email:     seat.member_email,
    member_name:      seat.member_name,
    calling_name:     seat.calling_name,
    reason:           seat.reason,
    start_date:       seat.start_date,
    end_date:         seat.end_date,
    building_names:   seat.building_names,
    created_at:       Utils_formatDateTime(seat.created_at),
    // Numeric insertion-time, preserved for Rosters_sortRows_ (the
    // formatted string uses a human format that doesn't sort lexically —
    // `3:45pm` vs `10:30am`). Exposed on the row so future client sorts
    // can reuse it.
    created_at_ms:    (seat.created_at instanceof Date) ? seat.created_at.getTime() : 0,
    last_modified_at: Utils_formatDateTime(seat.last_modified_at),
    expiry_badge:     badge,
    // Default false; Rosters_buildResponseFromSeats_ overrides with true
    // when the row is in the pending-remove set for its scope. Direct
    // callers (duplicate-check previews, queue current-seat previews)
    // get false here, which is correct — those previews aren't part of
    // a roster-wide "click X to start a remove" flow.
    removal_pending:  false
  };
}

// Sort rule — identical on every roster so the three UIs can share a
// renderer without re-sorting:
//   1. auto first, manual next, temp last.
//   2. within auto: by the seat's calling_name's position in the
//      configured CallingTemplate for this scope (stake uses
//      StakeCallingTemplate; every ward uses WardCallingTemplate). Exact
//      template rows beat wildcard rows (same match rule as the
//      importer). Seats whose calling_name matches no template row sort
//      to the END of the auto block. Tiebreak within a position:
//      member_name.
//   3. within manual & temp: by insertion date (created_at asc).
//      Tiebreak: member_name.
// `scope` + `ctx` let the auto sort pick the right template index; a
// missing ctx degrades gracefully (every auto row ties on position and
// falls through to member_name order).
function Rosters_sortRows_(rows, scope, ctx) {
  var typeOrder = { auto: 0, manual: 1, temp: 2 };
  var tplIdx = null;
  if (ctx) {
    tplIdx = (String(scope) === ROSTERS_STAKE_SCOPE_)
      ? ctx.stakeTemplateIndex
      : ctx.wardTemplateIndex;
  }
  rows.sort(function (a, b) {
    var ta = typeOrder[a.type] == null ? 99 : typeOrder[a.type];
    var tb = typeOrder[b.type] == null ? 99 : typeOrder[b.type];
    if (ta !== tb) return ta - tb;

    if (a.type === 'auto') {
      var pa = tplIdx ? Rosters_templatePosition_(tplIdx, a.calling_name) : 0;
      var pb = tplIdx ? Rosters_templatePosition_(tplIdx, b.calling_name) : 0;
      if (pa !== pb) {
        // Guard against Infinity - Infinity = NaN: handle unmatched
        // explicitly so two unmatched rows don't return NaN and
        // destabilise V8's sort.
        if (pa === Infinity) return 1;
        if (pb === Infinity) return -1;
        return pa - pb;
      }
      return Rosters_strCmp_(a.member_name, b.member_name);
    }

    // manual + temp: insertion order (oldest first). created_at_ms is
    // zero when the cell was blank; zero sorts first which is the only
    // reasonable answer for "unknown insertion time" (practically none
    // of these exist -- every write path stamps a Date).
    var am = Number(a.created_at_ms) || 0;
    var bm = Number(b.created_at_ms) || 0;
    if (am !== bm) return am - bm;
    return Rosters_strCmp_(a.member_name, b.member_name);
  });
}

// Template position lookup (same match rules as Importer_templateMatch_):
// exact match wins; otherwise the first wildcard row whose pattern
// matches. Returns Infinity when no template row matches, so unmatched
// autos sort to the bottom of the auto block in Rosters_sortRows_.
function Rosters_templatePositionIndex_(kind) {
  var rows = Templates_getAll(kind);
  var exact = {};
  var wildcards = [];
  for (var i = 0; i < rows.length; i++) {
    var name = rows[i].calling_name;
    if (!name) continue;
    if (name.indexOf('*') === -1) {
      exact[name] = i;
    } else {
      wildcards.push({ position: i, regex: Importer_wildcardToRegex_(name) });
    }
  }
  return { exact: exact, wildcards: wildcards };
}

function Rosters_templatePosition_(index, callingName) {
  var name = callingName == null ? '' : String(callingName);
  if (name && Object.prototype.hasOwnProperty.call(index.exact, name)) {
    return index.exact[name];
  }
  for (var i = 0; i < index.wildcards.length; i++) {
    if (index.wildcards[i].regex.test(name)) return index.wildcards[i].position;
  }
  return Infinity;
}

function Rosters_strCmp_(a, b) {
  var x = String(a == null ? '' : a).toLowerCase();
  var y = String(b == null ? '' : b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// summary fields (mirrors the "roster response" block in the Chunk-5
// prompt):
//   scope             — 'stake' or ward_code, verbatim from the seats
//   ward_name         — 'Stake' for stake; Wards.ward_name for a ward_code;
//                        a diagnostic 'Ward <code>' fallback if the ward
//                        row was deleted but seats remain (shouldn't
//                        happen; Wards_delete has no cascade today).
//   seat_cap          — For a ward: the configured per-ward cap, or
//                        null when unset. For the stake: the STAKE
//                        PORTION cap — what's left of the total license
//                        after wards have taken their share
//                        (`stake_seat_cap - wardSeatsCount`, clamped to
//                        0; null when `stake_seat_cap` is unset).
//   total_seats       — Count of rows in this scope (auto + manual +
//                        temp, incl. past-end-date temps per Chunk-5
//                        "Utilization math includes every seat row
//                        regardless of type"). For stake this is the
//                        stake-scope sub-pool count — NOT the stake-
//                        wide total — so paired with the portion cap
//                        it reads as "stake presidency's allocation vs
//                        their own assignments".
//   utilization_pct   — total_seats / seat_cap, or 0 when cap missing
//   over_cap          — boolean; true iff seat_cap > 0 AND total_seats > cap.
//                        For stake this fires iff ward usage + stake-
//                        scope usage > total license, expressed in
//                        portion terms.
function Rosters_buildSummary_(scope, totalSeats, ctx) {
  var cap, wardName;
  if (scope === ROSTERS_STAKE_SCOPE_) {
    wardName = 'Stake';
    var licenseCap = (ctx && ctx.stakeSeatCap != null) ? Number(ctx.stakeSeatCap) : null;
    if (licenseCap == null || isNaN(licenseCap)) {
      cap = null;
    } else {
      // Stake portion = total license - wards' current seats. Clamp at
      // 0 so display never shows a negative cap; in that edge case
      // every stake-scope seat counts as over.
      var wards = (ctx && typeof ctx.wardSeatsCount === 'number') ? ctx.wardSeatsCount : 0;
      cap = Math.max(0, licenseCap - wards);
    }
  } else {
    var ward = ctx.wardsByCode ? ctx.wardsByCode[scope] : null;
    cap = ward ? (ward.seat_cap == null ? null : Number(ward.seat_cap)) : null;
    wardName = ward ? ward.ward_name : ('Ward ' + scope);
  }
  var utilization = (cap && cap > 0) ? totalSeats / cap : 0;
  // Stake edge case: if the portion cap clamped to 0 AND any stake-
  // scope seats exist, that's an over-cap condition (wards have
  // consumed the whole license and stake-scope is bleeding past it).
  // Fall-through to the generic > check otherwise.
  var overCap = cap != null && (
    (cap === 0 && totalSeats > 0 && scope === ROSTERS_STAKE_SCOPE_) ||
    (cap > 0 && totalSeats > cap)
  );
  return {
    scope:           scope,
    ward_name:       wardName,
    seat_cap:        cap,
    total_seats:     totalSeats,
    utilization_pct: utilization,
    over_cap:        overCap
  };
}

// Stake summary in TOTAL-vs-LICENSE terms (as opposed to the stake-
// portion view Rosters_buildSummary_ returns). Used by the manager
// Dashboard's Utilization card, which wants full seat counts across
// the whole stake so managers see license-level pressure at a glance.
// Other stake-facing views (Stake Roster, AllSeats stake card, Import
// banner, over-cap email) stay on the portion math.
//
//   total_seats = every seat in the system
//   seat_cap    = stake_seat_cap (license limit; null when unset)
//   over_cap    = total_seats > license
function Rosters_buildStakeTotalSummary_(allSeatsCount, ctx) {
  var licenseCap = (ctx && ctx.stakeSeatCap != null) ? Number(ctx.stakeSeatCap) : null;
  if (licenseCap != null && isNaN(licenseCap)) licenseCap = null;
  var utilization = (licenseCap && licenseCap > 0) ? allSeatsCount / licenseCap : 0;
  var overCap = licenseCap != null && licenseCap > 0 && allSeatsCount > licenseCap;
  return {
    scope:           ROSTERS_STAKE_SCOPE_,
    ward_name:       'Stake',
    seat_cap:        licenseCap,
    total_seats:     allSeatsCount,
    utilization_pct: utilization,
    over_cap:        overCap
  };
}

