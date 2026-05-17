// Discrepancy detector. Compares the union of (SBA seat emails) ∪
// (Kindoo user emails) and emits one row per divergence per the rules
// in `extension/docs/sync-design.md` §"Discrepancy detector".
//
// Pure function. Inputs come from the SW reader (SBA side) + the
// content-script's paginated Kindoo loop. Outputs are rendered by
// `SyncPanel.tsx`.

import { canonicalEmail } from '@kindoo/shared';
import type {
  Building,
  DuplicateGrant,
  Seat,
  Stake,
  StakeCallingTemplate,
  Ward,
  WardCallingTemplate,
} from '@kindoo/shared';
import type { KindooEnvironmentUser } from '../endpoints';
import {
  parseDescription,
  pickPrimarySegment,
  type ParsedDescription,
  type ParsedSegment,
} from './parser';
import {
  buildCallingTemplateSets,
  classifySegment,
  type CallingTemplateSets,
  type IntendedSeatShape,
} from './classifier';
import type { ActiveSite } from './activeSite';

export type DiscrepancyCode =
  | 'sba-only'
  | 'kindoo-only'
  | 'kindoo-unparseable'
  | 'scope-mismatch'
  | 'type-mismatch'
  | 'buildings-mismatch'
  | 'extra-kindoo-calling';

export type Severity = 'drift' | 'review';

/** One row of the report. */
export interface Discrepancy {
  /** Canonical email (used as the row key). */
  canonical: string;
  /** Display email — prefers the Kindoo `Username` typed form, falls
   * back to the SBA seat's `member_email`. */
  displayEmail: string;
  code: DiscrepancyCode;
  severity: Severity;
  /** Plain-English reason rendered under the row. */
  reason: string;
  /** SBA side block — `null` when the user only exists in Kindoo. */
  sba: SbaBlock | null;
  /** Kindoo side block — `null` when the user only exists in SBA. */
  kindoo: KindooBlock | null;
}

export interface SbaBlock {
  scope: string;
  type: Seat['type'];
  callings: string[];
  reason?: string | undefined;
  buildingNames: string[];
}

export interface KindooBlock {
  description: string;
  isTempUser: boolean;
  /** Member display name (`FirstName LastName`) — derived from Kindoo's
   * `FirstName` / `LastName` (or `Username` if neither resolves). The
   * Phase 2 fix dispatcher needs this to populate `memberName` on
   * `kindoo-only` callable payloads (SBA seat schema requires it). */
  memberName: string;
  /** Parsed primary segment's scope (`'stake'` / ward_code / `null`). */
  primaryScope: 'stake' | string | null;
  /** Intended seat shape derived by the classifier from the primary segment. */
  intendedType: IntendedSeatShape['type'] | null;
  /** Auto-matched callings on the primary segment. Empty for manual/temp/unresolved. */
  intendedCallings: string[];
  /** Free-text reason carried by the primary segment (manual/temp parens,
   * or the unmatched-callings remainder on a mixed-auto segment). */
  intendedFreeText: string;
  /** Rule IDs Kindoo currently assigns. */
  ruleIds: number[];
  /** Building names mapped from `ruleIds` via the v2.1 config. */
  buildingNames: string[];
  /**
   * Buildings derived from per-door grants (auto-user reconciliation).
   * `null` when derivation was skipped or failed for this user;
   * `string[]` (possibly empty) when the door-grant chain produced a
   * deterministic set. The detector uses this for auto seats'
   * `buildings-mismatch` comparison; `applyKindooOnly` uses it as the
   * truth when creating an SBA seat from a kindoo-only auto user.
   */
  derivedBuildings: string[] | null;
  /** ISO date `YYYY-MM-DD` derived from Kindoo's `startAccessDoorsDateAtTimeZone`. Only set when the user is temp. */
  startDate?: string;
  /** ISO date `YYYY-MM-DD` derived from Kindoo's `expiryDateAtTimeZone`. Only set when the user is temp. */
  endDate?: string;
}

export interface DetectInputs {
  stake: Stake;
  wards: Ward[];
  buildings: Building[];
  seats: Seat[];
  wardCallingTemplates: WardCallingTemplate[];
  stakeCallingTemplates: StakeCallingTemplate[];
  /** Every Kindoo environment-user (paginated list flattened). */
  kindooUsers: KindooEnvironmentUser[];
  /**
   * Which Kindoo site the operator's active session is pointed at —
   * resolved by `identifyActiveSite()` from the live EID + SBA config.
   * Scopes the diff to seats / users belonging to that site:
   *   - `home`            → only wards / seats with `kindoo_site_id`
   *                         null / absent (and stake-scope seats).
   *   - `foreign(siteId)` → only wards / seats whose
   *                         `kindoo_site_id === siteId`. Stake-scope
   *                         seats are home-only (Phase 1 policy), so
   *                         they're excluded.
   *   - `unknown`         → caller is responsible for the empty-state
   *                         UX; we still return an empty diff defensively.
   *
   * Optional for backwards compatibility (tests that pre-date Phase 4
   * may not pass one); absence is treated as "no filtering".
   */
  activeSite?: ActiveSite;
}

export interface DetectResult {
  discrepancies: Discrepancy[];
  /** Total SBA seat count — surfaces in the report header. */
  seatCount: number;
  /** Total Kindoo user count — surfaces in the report header. */
  kindooCount: number;
}

/** Build a Map keyed by canonical email for quick lookup. */
function indexSeats(seats: Seat[]): Map<string, Seat> {
  const m = new Map<string, Seat>();
  for (const s of seats) m.set(s.member_canonical, s);
  return m;
}

function indexKindooUsers(users: KindooEnvironmentUser[]): Map<string, KindooEnvironmentUser> {
  const m = new Map<string, KindooEnvironmentUser>();
  for (const u of users) {
    const canon = canonicalEmail(u.username);
    // First-write-wins if Kindoo returns two records for the same canonical
    // email (shouldn't happen, but be defensive).
    if (!m.has(canon)) m.set(canon, u);
  }
  return m;
}

/**
 * Build the SBA side block for a seat. Trivial mapping; lives in its
 * own helper so the detector branches stay readable.
 */
function toSbaBlock(seat: Seat): SbaBlock {
  return {
    scope: seat.scope,
    type: seat.type,
    callings: seat.callings ?? [],
    reason: seat.reason,
    buildingNames: seat.building_names ?? [],
  };
}

/**
 * T-42: a seat's "view" onto one Kindoo site. The detector compares
 * Kindoo's per-site state against this projection, not against the
 * seat's primary fields directly — a seat whose primary lives on
 * another site can still own a grant on the active site through a
 * `duplicate_grants[]` entry.
 *
 * Source of truth resolution:
 *   - The seat's primary contributes when its `kindoo_site_id`
 *     matches the active site.
 *   - Every `duplicate_grants[]` entry whose `kindoo_site_id` matches
 *     contributes too.
 *   - Across contributing grants, the `scope` is taken from the
 *     first contributor (primary if it's there, else the first
 *     same-site duplicate by stable order). `type` comes from the
 *     same. `building_names` is the union across all contributors.
 *   - `callings` carries the per-scope callings of the first
 *     contributor (today's behaviour; segment fan-out at the Kindoo
 *     side classifies one calling list, so the SBA side mirrors).
 *
 * Returns `null` when no grant on the seat targets the active site —
 * the detector treats that as "this seat doesn't exist on this site"
 * and the seat won't surface in either an sba-only or a mismatch row
 * for this view.
 */
function projectSeatForSite(
  seat: Seat,
  wards: Ward[],
  activeSite: ActiveSite | undefined,
): SbaBlock | null {
  if (!activeSite || activeSite.kind === 'unknown') return null;
  const wardSite = (wardCode: string): string | null => {
    if (wardCode === 'stake') return null;
    const ward = wards.find((w) => w.ward_code === wardCode);
    return ward ? (ward.kindoo_site_id ?? null) : null;
  };
  // Match by seat-level field when present; fall back to scope→ward
  // lookup so legacy seats (pre-migration) still classify.
  const grantSite = (
    grantKindooSiteId: string | null | undefined,
    grantScope: string,
  ): string | null => {
    if (grantKindooSiteId !== undefined && grantKindooSiteId !== null) {
      return grantKindooSiteId;
    }
    if (grantKindooSiteId === null) return null;
    return wardSite(grantScope);
  };

  const wantSiteId: string | null = activeSite.kind === 'home' ? null : activeSite.siteId;

  type Contributor = {
    scope: string;
    type: Seat['type'];
    callings: string[];
    reason: string | undefined;
    buildings: string[];
  };
  const contributors: Contributor[] = [];
  // Primary first (preserves "primary wins on scope/type" when it
  // matches the active site).
  if (grantSite(seat.kindoo_site_id, seat.scope) === wantSiteId) {
    contributors.push({
      scope: seat.scope,
      type: seat.type,
      callings: seat.callings ?? [],
      reason: seat.reason,
      buildings: seat.building_names ?? [],
    });
  }
  for (const dup of seat.duplicate_grants ?? []) {
    if (grantSite(dup.kindoo_site_id, dup.scope) !== wantSiteId) continue;
    contributors.push({
      scope: dup.scope,
      type: dup.type,
      callings: dup.callings ?? [],
      reason: dup.reason,
      // Within-site duplicates may leave `building_names` unset and
      // inherit from the ward's `building_name`. Parallel-site
      // duplicates always carry their own `building_names`.
      buildings: dup.building_names ?? wardBuildingsForScope(dup.scope, wards),
    });
  }
  if (contributors.length === 0) return null;
  const first = contributors[0]!;
  const unioned: string[] = [];
  const seen = new Set<string>();
  for (const c of contributors) {
    for (const b of c.buildings) {
      if (seen.has(b)) continue;
      seen.add(b);
      unioned.push(b);
    }
  }
  return {
    scope: first.scope,
    type: first.type,
    callings: first.callings,
    reason: first.reason,
    buildingNames: unioned,
  };
}

/** Lookup ward → its declared `building_name` (single string) → array
 *  for downstream union math. Returns an empty array when the ward
 *  isn't in the catalogue or carries no building. */
function wardBuildingsForScope(scope: string, wards: Ward[]): string[] {
  if (scope === 'stake') return [];
  const w = wards.find((x) => x.ward_code === scope);
  if (!w || !w.building_name) return [];
  return [w.building_name];
}

/**
 * T-42: pick the parsed segment whose scope's Kindoo site matches the
 * active site. Mirrors `pickPrimarySegment`'s `prefer auto > stake >
 * ward-alpha` tiebreaker but pre-filters by site. Returns `null` when
 * no segment resolves to the active site.
 */
function pickSegmentForSite(
  parsed: ParsedDescription,
  sets: CallingTemplateSets,
  stake: Stake,
  wards: Ward[],
  activeSite: ActiveSite | undefined,
): ParsedSegment | null {
  if (!activeSite || activeSite.kind === 'unknown') return null;
  const wantSiteId: string | null = activeSite.kind === 'home' ? null : activeSite.siteId;
  const segmentSite = (segment: ParsedSegment): string | null | undefined => {
    if (!segment.resolvedScope || segment.scope === null) return undefined;
    if (segment.scope === 'stake') return null; // stake-scope is home-only.
    const w = wards.find((x) => x.ward_code === segment.scope);
    return w ? (w.kindoo_site_id ?? null) : undefined;
  };
  const filtered = parsed.segments.filter((s) => segmentSite(s) === wantSiteId);
  if (filtered.length === 0) return null;
  // Reuse `pickPrimarySegment`'s tiebreaker by wrapping the filter in
  // a ParsedDescription shell (`raw` / `unparseable` aren't used by
  // the picker).
  return pickPrimarySegment({ segments: filtered, unparseable: false, raw: parsed.raw }, sets);
}

/**
 * Map Kindoo rule IDs back to SBA building names via
 * `building.kindoo_rule.rule_id`. Rules with no matching SBA building
 * surface as `'(unknown rule X)'` for the report.
 */
function ruleIdsToBuildingNames(ruleIds: number[], buildings: Building[]): string[] {
  const out: string[] = [];
  for (const rid of ruleIds) {
    const b = buildings.find((bldg) => bldg.kindoo_rule?.rule_id === rid);
    out.push(b ? b.building_name : `(unknown rule ${rid})`);
  }
  return out;
}

/** True iff two string sets are equal regardless of order or duplicates. */
function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    // Count-distinct compare; some duplicate rules could repeat.
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size !== sb.size) return false;
    for (const v of sa) if (!sb.has(v)) return false;
    return true;
  }
  const sa = new Set(a);
  for (const v of b) if (!sa.has(v)) return false;
  return true;
}

/** Sort comparator for the final report. */
function compareDiscrepancies(a: Discrepancy, b: Discrepancy): number {
  // drift first, then review.
  if (a.severity !== b.severity) return a.severity === 'drift' ? -1 : 1;
  return a.displayEmail.localeCompare(b.displayEmail);
}

/**
 * Run the full discrepancy detection. Returns the sorted row list plus
 * the two counters that surface in the report header.
 */
export function detect(inputs: DetectInputs): DetectResult {
  const sets = buildCallingTemplateSets(
    inputs.stakeCallingTemplates,
    inputs.wardCallingTemplates,
    inputs.wards.map((w) => w.ward_code),
  );

  // Active-site filter: scope the union of (seats, kindoo users) to
  // grants belonging to the active Kindoo site. `unknown` returns an
  // empty diff up front (the panel renders an empty-state recovery
  // message instead).
  //
  // T-42: per-site fan-out. A seat is visible on the active site when
  // ANY of (primary, duplicate_grants[]) targets that site; a Kindoo
  // user is visible on the active site when ANY parsed segment
  // resolves to a scope on that site. Pre-T-42 the active-site filter
  // keyed off the seat's primary scope and the parsed primary segment
  // alone; that collapsed a multi-site Description down to one site
  // and lost the user's visibility on the other site.
  if (inputs.activeSite && inputs.activeSite.kind === 'unknown') {
    return {
      discrepancies: [],
      seatCount: 0,
      kindooCount: 0,
    };
  }

  // Project each seat onto the active site (primary if its
  // `kindoo_site_id` matches; else any same-site duplicate). Seats
  // with no grant on the active site are filtered out — they belong
  // to a different site's manager view.
  type ProjectedSeat = { seat: Seat; sbaBlock: SbaBlock };
  const projectedSeats: ProjectedSeat[] = [];
  for (const seat of inputs.seats) {
    if (!inputs.activeSite) {
      // No active-site context — preserve pre-T-42 behaviour (don't
      // filter; project against the seat's primary fields directly).
      projectedSeats.push({ seat, sbaBlock: toSbaBlock(seat) });
      continue;
    }
    const projected = projectSeatForSite(seat, inputs.wards, inputs.activeSite);
    if (projected) projectedSeats.push({ seat, sbaBlock: projected });
  }
  const filteredKindooUsers = filterKindooUsersByActiveSite(
    inputs.kindooUsers,
    inputs.stake,
    inputs.wards,
    sets,
    inputs.activeSite,
  );

  const seatsByEmail = new Map<string, ProjectedSeat>();
  for (const p of projectedSeats) seatsByEmail.set(p.seat.member_canonical, p);
  const kindooByEmail = indexKindooUsers(filteredKindooUsers);

  const allCanonical = new Set<string>([...seatsByEmail.keys(), ...kindooByEmail.keys()]);
  const discrepancies: Discrepancy[] = [];

  // T-42: when an active-site is set, primary segment for the Kindoo
  // side is the one whose scope resolves to that site (not whichever
  // segment wins the unfiltered `pickPrimarySegment` race). The
  // SBA-side `sbaBlock` is already projected onto the active site.
  const pickRelevantSegment = (parsed: ParsedDescription): ParsedSegment | null => {
    if (inputs.activeSite) {
      return pickSegmentForSite(parsed, sets, inputs.stake, inputs.wards, inputs.activeSite);
    }
    return pickPrimarySegment(parsed, sets);
  };

  for (const canon of allCanonical) {
    const projected = seatsByEmail.get(canon) ?? null;
    const seat = projected?.seat ?? null;
    const sbaBlock = projected?.sbaBlock ?? null;
    const kuser = kindooByEmail.get(canon) ?? null;
    const displayEmail = kuser?.username ?? seat?.member_email ?? canon;

    // 1. sba-only — seat present, no Kindoo user.
    if (seat && sbaBlock && !kuser) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'sba-only',
        severity: 'drift',
        reason: 'SBA has a seat for this member, but the user is not present in Kindoo.',
        sba: sbaBlock,
        kindoo: null,
      });
      continue;
    }

    // 2. kindoo-only — Kindoo user present, no SBA seat.
    if (!seat && kuser) {
      const parsed = parseDescription(kuser.description, inputs.stake, inputs.wards);
      const primary = pickRelevantSegment(parsed);
      const intended = primary ? classifySegment(primary, kuser.isTempUser, sets) : null;
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-only',
        severity: 'drift',
        reason: 'Kindoo has a user for this email, but SBA has no seat for them.',
        sba: null,
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
      });
      continue;
    }

    // From here both sides exist.
    if (!seat || !sbaBlock || !kuser) continue;

    const parsed = parseDescription(kuser.description, inputs.stake, inputs.wards);

    // 3. kindoo-unparseable — description does not parse at all.
    if (parsed.unparseable) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-unparseable',
        severity: 'review',
        reason:
          "Kindoo description does not match the 'Scope (Calling)' convention; cannot classify intended seat shape.",
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings, sets),
      });
      continue;
    }

    const primary = pickRelevantSegment(parsed);
    if (!primary) {
      // Shouldn't be reachable when unparseable=false and the filter
      // already kept this user, but be defensive.
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-unparseable',
        severity: 'review',
        reason: 'Kindoo description has no resolvable primary segment.',
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings, sets),
      });
      continue;
    }
    const intended = classifySegment(primary, kuser.isTempUser, sets);

    // 4. extra-kindoo-calling — Kindoo's parens list at least one auto
    // calling plus additional non-auto calling(s). The auto calling
    // drives the seat type (the user IS an auto seat); the extras are
    // detail Kindoo records but SBA's seat does not. Surface as a
    // review so the operator can add the extras to the SBA seat.
    if (intended.reviewMixed) {
      const extras = intended.freeText || 'non-auto';
      const sbaCallings = sbaBlock.callings.length > 0 ? sbaBlock.callings.join(', ') : '(none)';
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'extra-kindoo-calling',
        severity: 'review',
        reason: `Kindoo lists additional calling(s) [${extras}] beyond SBA's auto seat callings [${sbaCallings}]; add the extra calling(s) to the SBA seat.`,
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
      });
      continue;
    }

    // 5. scope-mismatch — parsed primary scope differs from seat.scope.
    if (intended.scope !== sbaBlock.scope) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'scope-mismatch',
        severity: 'drift',
        reason: `Primary scope differs: SBA=${sbaBlock.scope}, Kindoo=${intended.scope ?? '(unresolved)'}.`,
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
      });
      continue;
    }

    // 6. type-mismatch — intended type differs from seat.type.
    if (intended.type !== sbaBlock.type) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'type-mismatch',
        severity: 'drift',
        reason: `Seat type differs: SBA=${sbaBlock.type}, Kindoo intends=${intended.type}.`,
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
      });
      continue;
    }

    // 7. buildings-mismatch — Kindoo rule set vs SBA building → RID mapping.
    //
    // Manual / temp seats: SBA's v2.2 provision flow writes via
    // `saveAccessRule`, so AccessSchedules is the authoritative
    // building-access signal. Compare directly.
    //
    // Auto seats: door access lands via Church Access Automation's
    // direct grants (keyed by VidName), which the bulk listing's
    // AccessSchedules array does NOT expose. The sync orchestrator
    // derives the effective building set via per-user door-grant calls
    // (`sync/buildingsFromDoors.ts`) and stamps it onto
    // `kuser.derivedBuildings` BEFORE detect(). When derivation
    // succeeded (non-null), compare against it; when it failed
    // (`null`), skip the check — same Phase 1 fallback as before.
    let kindooBuildingsForCompare: string[] | null = null;
    if (intended.type === 'manual' || intended.type === 'temp') {
      kindooBuildingsForCompare = ruleIdsToBuildingNames(
        kuser.accessSchedules.map((s) => s.ruleId),
        inputs.buildings,
      );
    } else if (
      intended.type === 'auto' &&
      kuser.derivedBuildings !== null &&
      kuser.derivedBuildings !== undefined
    ) {
      kindooBuildingsForCompare = kuser.derivedBuildings;
    }
    if (kindooBuildingsForCompare !== null) {
      const expectedBuildings = sbaBlock.buildingNames;
      if (!setsEqual(expectedBuildings, kindooBuildingsForCompare)) {
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'buildings-mismatch',
          severity: 'drift',
          reason: `Building access differs: SBA=[${expectedBuildings.join(', ')}], Kindoo=[${kindooBuildingsForCompare.join(', ')}].`,
          sba: sbaBlock,
          kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
        });
        continue;
      }
    }
    // No discrepancy — skip.
  }

  discrepancies.sort(compareDiscrepancies);
  return {
    discrepancies,
    seatCount: projectedSeats.length,
    kindooCount: filteredKindooUsers.length,
  };
}

/**
 * T-42: keep Kindoo users with ANY parsed segment whose scope resolves
 * to the active Kindoo site. Pre-T-42 the filter looked at the
 * unfiltered `pickPrimarySegment` result and collapsed a multi-site
 * Description down to one site; that lost the user's visibility on
 * the other site.
 *
 * Unparseable / unresolvable Kindoo users:
 *   - Home site: keep so the historical `kindoo-only` /
 *     `kindoo-unparseable` rows still surface.
 *   - Foreign site: drop — we can't claim the user without a resolved
 *     scope, and if they belonged to OUR foreign-site wards they'd
 *     already have a seat (the seat side short-circuits).
 *
 * Backwards compat: when no `activeSite` is passed, return every
 * user. Pre-Phase-4 callers (older tests) rely on this.
 */
function filterKindooUsersByActiveSite(
  users: KindooEnvironmentUser[],
  stake: Stake,
  wards: Ward[],
  sets: CallingTemplateSets,
  activeSite: ActiveSite | undefined,
): KindooEnvironmentUser[] {
  if (!activeSite) return users;
  if (activeSite.kind === 'unknown') return [];
  return users.filter((u) => {
    const parsed = parseDescription(u.description, stake, wards);
    // Find ANY segment whose scope sits on the active site.
    const matched = pickSegmentForSite(parsed, sets, stake, wards, activeSite);
    if (matched) return true;
    // No matching segment. Preserve historical "show unparseable users
    // on home" behaviour: if home AND every segment is unresolved,
    // keep so `kindoo-only` / `kindoo-unparseable` still surfaces.
    if (activeSite.kind !== 'home') return false;
    const anyResolved = parsed.segments.some((s) => s.resolvedScope);
    return !anyResolved;
  });
}

// Re-export `DuplicateGrant` for callers that import via the detector
// barrel; surfaces typing parity with `Seat`.
export type { DuplicateGrant };

function buildKindooBlock(
  kuser: KindooEnvironmentUser,
  parsed: ParsedDescription,
  intended: IntendedSeatShape | null,
  buildings: Building[],
  sets: CallingTemplateSets,
): KindooBlock {
  const primary = pickPrimarySegment(parsed, sets);
  const ruleIds = kuser.accessSchedules.map((s) => s.ruleId);
  const block: KindooBlock = {
    description: kuser.description,
    isTempUser: kuser.isTempUser,
    memberName: deriveMemberName(kuser),
    primaryScope: primary?.scope ?? null,
    intendedType: intended?.type ?? null,
    intendedCallings: intended?.callings ?? [],
    intendedFreeText: intended?.freeText ?? '',
    ruleIds,
    buildingNames: ruleIdsToBuildingNames(ruleIds, buildings),
    derivedBuildings: kuser.derivedBuildings ?? null,
  };
  if (kuser.isTempUser) {
    const start = toIsoDate(kuser.startAccessDoorsDateAtTimeZone);
    const end = toIsoDate(kuser.expiryDateAtTimeZone);
    if (start) block.startDate = start;
    if (end) block.endDate = end;
  }
  return block;
}

/**
 * Derive a display name from the Kindoo user record. Kindoo's bulk
 * listing returns `FirstName` / `LastName` for most users; fall back to
 * the username when both are absent so callers always have a non-empty
 * string (the `memberName` field on `kindoo-only` payloads is required
 * server-side).
 */
function deriveMemberName(kuser: KindooEnvironmentUser): string {
  const first = typeof kuser.FirstName === 'string' ? kuser.FirstName.trim() : '';
  const last = typeof kuser.LastName === 'string' ? kuser.LastName.trim() : '';
  const joined = [first, last].filter((s) => s.length > 0).join(' ');
  if (joined.length > 0) return joined;
  const displayName = typeof kuser.DisplayName === 'string' ? kuser.DisplayName.trim() : '';
  if (displayName.length > 0) return displayName;
  return kuser.username;
}

/**
 * Strip the time component off Kindoo's `YYYY-MM-DDTHH:MM` date strings.
 * Returns `null` when the input is falsy or doesn't match the expected
 * shape; the caller decides whether to omit the field entirely.
 */
function toIsoDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1]! : null;
}
