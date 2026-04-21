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
function Rosters_buildResponseForScope(scope, ctx) {
  var key = String(scope);
  var seats = Seats_getByScope(key);
  return Rosters_buildResponseFromSeats_(key, seats, ctx);
}

// Same as above, but for callers that already have the row subset in hand
// (e.g. ApiManager_allSeats reads every seat once, then buckets by scope).
function Rosters_buildResponseFromSeats_(scope, seats, ctx) {
  var rows = [];
  for (var i = 0; i < seats.length; i++) {
    rows.push(Rosters_mapRow_(seats[i], ctx.today));
  }
  Rosters_sortRows_(rows);
  var summary = Rosters_buildSummary_(scope, rows.length, ctx);
  return { summary: summary, rows: rows };
}

// Build the shared context object once per endpoint (reads Wards + Config).
function Rosters_buildContext_() {
  var wards = Wards_getAll();
  var byCode = {};
  for (var i = 0; i < wards.length; i++) byCode[wards[i].ward_code] = wards[i];
  var rawCap = Config_get('stake_seat_cap');
  return {
    today:        Utils_todayIso(),
    wardsByCode:  byCode,
    stakeSeatCap: (rawCap == null || rawCap === '') ? null : Number(rawCap)
  };
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
    person_email:     seat.person_email,
    person_name:      seat.person_name,
    calling_name:     seat.calling_name,
    reason:           seat.reason,
    start_date:       seat.start_date,
    end_date:         seat.end_date,
    building_names:   seat.building_names,
    created_at:       Rosters_formatDate_(seat.created_at),
    last_modified_at: Rosters_formatDate_(seat.last_modified_at),
    expiry_badge:     badge
  };
}

// Sort rule — identical on every roster so the three UIs can share a
// renderer without re-sorting:
//   1. auto first, manual next, temp last (utilization intuition: auto =
//      auditable callings; manual = explicit ward decisions; temp =
//      time-boxed and the one the user actually needs to see expiring).
//   2. within auto: by calling_name, tiebreak person_name.
//   3. within manual: by person_name, tiebreak person_email.
//   4. within temp: by end_date asc (soonest-expiring first), tiebreak
//      person_name. Blank end_date sorts last.
function Rosters_sortRows_(rows) {
  var typeOrder = { auto: 0, manual: 1, temp: 2 };
  rows.sort(function (a, b) {
    var ta = typeOrder[a.type] == null ? 99 : typeOrder[a.type];
    var tb = typeOrder[b.type] == null ? 99 : typeOrder[b.type];
    if (ta !== tb) return ta - tb;
    if (a.type === 'auto') {
      return Rosters_strCmp_(a.calling_name, b.calling_name) ||
             Rosters_strCmp_(a.person_name,  b.person_name);
    }
    if (a.type === 'manual') {
      return Rosters_strCmp_(a.person_name,  b.person_name) ||
             Rosters_strCmp_(a.person_email, b.person_email);
    }
    if (a.type === 'temp') {
      var ae = a.end_date ? String(a.end_date) : '\uFFFF';
      var be = b.end_date ? String(b.end_date) : '\uFFFF';
      return Rosters_strCmp_(ae, be) ||
             Rosters_strCmp_(a.person_name, b.person_name);
    }
    return 0;
  });
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
//   seat_cap          — number or null when Wards is missing a cap
//   total_seats       — count of rows in this scope (auto + manual + temp,
//                        incl. past-end-date temps per Chunk-5 "Utilization
//                        math includes every seat row regardless of type")
//   utilization_pct   — total_seats / seat_cap, or 0 when cap missing
//   over_cap          — boolean; true iff seat_cap > 0 AND total_seats > cap
function Rosters_buildSummary_(scope, totalSeats, ctx) {
  var cap, wardName;
  if (scope === ROSTERS_STAKE_SCOPE_) {
    cap = ctx.stakeSeatCap;
    wardName = 'Stake';
  } else {
    var ward = ctx.wardsByCode ? ctx.wardsByCode[scope] : null;
    cap = ward ? (ward.seat_cap == null ? null : Number(ward.seat_cap)) : null;
    wardName = ward ? ward.ward_name : ('Ward ' + scope);
  }
  var utilization = (cap && cap > 0) ? totalSeats / cap : 0;
  var overCap = cap != null && cap > 0 && totalSeats > cap;
  return {
    scope:           scope,
    ward_name:       wardName,
    seat_cap:        cap,
    total_seats:     totalSeats,
    utilization_pct: utilization,
    over_cap:        overCap
  };
}

// google.script.run auto-serialises Date objects unreliably — stringify
// to an ISO-ish form here so the wire shape is always predictable.
function Rosters_formatDate_(d) {
  if (!d) return null;
  if (d instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss z');
  }
  return String(d);
}
