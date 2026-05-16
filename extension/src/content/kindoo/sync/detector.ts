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
  Seat,
  Stake,
  StakeCallingTemplate,
  Ward,
  WardCallingTemplate,
} from '@kindoo/shared';
import type { KindooEnvironmentUser } from '../endpoints';
import { parseDescription, pickPrimarySegment, type ParsedDescription } from './parser';
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
  // wards belonging to the active Kindoo site. `unknown` returns an
  // empty diff up front (the panel renders an empty-state recovery
  // message instead). `home` / `foreign` build a ward_code allow-set
  // and filter both sides through it.
  if (inputs.activeSite && inputs.activeSite.kind === 'unknown') {
    return {
      discrepancies: [],
      seatCount: 0,
      kindooCount: 0,
    };
  }
  const activeWardCodes = computeActiveWardCodes(inputs.wards, inputs.activeSite);
  const stakeAllowed = !inputs.activeSite || inputs.activeSite.kind === 'home';
  const filteredSeats = filterSeatsByActiveSite(inputs.seats, activeWardCodes, stakeAllowed);
  const filteredKindooUsers = filterKindooUsersByActiveSite(
    inputs.kindooUsers,
    inputs.stake,
    inputs.wards,
    sets,
    activeWardCodes,
    stakeAllowed,
  );

  const seatsByEmail = indexSeats(filteredSeats);
  const kindooByEmail = indexKindooUsers(filteredKindooUsers);

  const allCanonical = new Set<string>([...seatsByEmail.keys(), ...kindooByEmail.keys()]);
  const discrepancies: Discrepancy[] = [];

  for (const canon of allCanonical) {
    const seat = seatsByEmail.get(canon) ?? null;
    const kuser = kindooByEmail.get(canon) ?? null;
    const displayEmail = kuser?.username ?? seat?.member_email ?? canon;

    // 1. sba-only — seat present, no Kindoo user.
    if (seat && !kuser) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'sba-only',
        severity: 'drift',
        reason: 'SBA has a seat for this member, but the user is not present in Kindoo.',
        sba: toSbaBlock(seat),
        kindoo: null,
      });
      continue;
    }

    // 2. kindoo-only — Kindoo user present, no SBA seat.
    if (!seat && kuser) {
      const parsed = parseDescription(kuser.description, inputs.stake, inputs.wards);
      const primary = pickPrimarySegment(parsed, sets);
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
    if (!seat || !kuser) continue;

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
        sba: toSbaBlock(seat),
        kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings, sets),
      });
      continue;
    }

    const primary = pickPrimarySegment(parsed, sets);
    if (!primary) {
      // Shouldn't be reachable when unparseable=false, but be defensive.
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-unparseable',
        severity: 'review',
        reason: 'Kindoo description has no resolvable primary segment.',
        sba: toSbaBlock(seat),
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
      const sbaCallings =
        seat.callings && seat.callings.length > 0 ? seat.callings.join(', ') : '(none)';
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'extra-kindoo-calling',
        severity: 'review',
        reason: `Kindoo lists additional calling(s) [${extras}] beyond SBA's auto seat callings [${sbaCallings}]; add the extra calling(s) to the SBA seat.`,
        sba: toSbaBlock(seat),
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
      });
      continue;
    }

    // 5. scope-mismatch — parsed primary scope differs from seat.scope.
    if (intended.scope !== seat.scope) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'scope-mismatch',
        severity: 'drift',
        reason: `Primary scope differs: SBA=${seat.scope}, Kindoo=${intended.scope ?? '(unresolved)'}.`,
        sba: toSbaBlock(seat),
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
      });
      continue;
    }

    // 6. type-mismatch — intended type differs from seat.type.
    if (intended.type !== seat.type) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'type-mismatch',
        severity: 'drift',
        reason: `Seat type differs: SBA=${seat.type}, Kindoo intends=${intended.type}.`,
        sba: toSbaBlock(seat),
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
      const expectedBuildings = seat.building_names ?? [];
      if (!setsEqual(expectedBuildings, kindooBuildingsForCompare)) {
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'buildings-mismatch',
          severity: 'drift',
          reason: `Building access differs: SBA=[${expectedBuildings.join(', ')}], Kindoo=[${kindooBuildingsForCompare.join(', ')}].`,
          sba: toSbaBlock(seat),
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
    seatCount: filteredSeats.length,
    kindooCount: filteredKindooUsers.length,
  };
}

/**
 * Build the allow-set of ward codes for the active Kindoo site.
 *
 *   - `home`            → wards with `kindoo_site_id` null / absent.
 *   - `foreign(siteId)` → wards with `kindoo_site_id === siteId`.
 *   - missing           → every ward (backwards compat for callers that
 *                         pre-date Phase 4 and don't pass an
 *                         `activeSite`).
 */
function computeActiveWardCodes(
  wards: Ward[],
  activeSite: ActiveSite | undefined,
): Set<string> | null {
  if (!activeSite) return null;
  const out = new Set<string>();
  for (const w of wards) {
    const homeBound = w.kindoo_site_id === null || w.kindoo_site_id === undefined;
    if (activeSite.kind === 'home' && homeBound) {
      out.add(w.ward_code);
    } else if (activeSite.kind === 'foreign' && w.kindoo_site_id === activeSite.siteId) {
      out.add(w.ward_code);
    }
  }
  return out;
}

/**
 * Keep only seats whose scope belongs to the active Kindoo site.
 * Stake-scope seats are home-only (per Phase 1 policy — see
 * `docs/spec.md` §15).
 */
function filterSeatsByActiveSite(
  seats: Seat[],
  activeWardCodes: Set<string> | null,
  stakeAllowed: boolean,
): Seat[] {
  if (activeWardCodes === null) return seats;
  return seats.filter((s) => {
    if (s.scope === 'stake') return stakeAllowed;
    return activeWardCodes.has(s.scope);
  });
}

/**
 * Keep only Kindoo users whose parsed Description resolves to a scope
 * (ward or stake) belonging to the active Kindoo site. Users whose
 * Description resolves to OTHER wards belong to another site's manager;
 * they're excluded entirely from the report (no `kindoo-only` drift
 * row). Unparseable Kindoo users on a foreign site are also dropped
 * (not our responsibility to classify).
 *
 * On the home site, the historical behavior must be preserved exactly
 * — including emitting `kindoo-only` rows for unparseable users with
 * no SBA seat. That's why we bypass the filter when active is home AND
 * the parsed primary is `null` (unparseable / unresolved).
 */
function filterKindooUsersByActiveSite(
  users: KindooEnvironmentUser[],
  stake: Stake,
  wards: Ward[],
  sets: CallingTemplateSets,
  activeWardCodes: Set<string> | null,
  stakeAllowed: boolean,
): KindooEnvironmentUser[] {
  if (activeWardCodes === null) return users;
  return users.filter((u) => {
    const parsed = parseDescription(u.description, stake, wards);
    const primary = pickPrimarySegment(parsed, sets);
    if (!primary || primary.scope === null) {
      // Unparseable / unresolvable. On home, keep so the historical
      // `kindoo-only` / `kindoo-unparseable` rows still surface. On
      // foreign, drop — we can't claim the user without a resolved
      // scope, and if they belong to OUR foreign-site wards they'd
      // already have a seat (which short-circuits the kindoo-side path).
      return stakeAllowed;
    }
    if (primary.scope === 'stake') return stakeAllowed;
    return activeWardCodes.has(primary.scope);
  });
}

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
