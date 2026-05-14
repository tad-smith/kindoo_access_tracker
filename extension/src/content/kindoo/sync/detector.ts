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
import { buildCallingTemplateSets, classifySegment, type IntendedSeatShape } from './classifier';

export type DiscrepancyCode =
  | 'sba-only'
  | 'kindoo-only'
  | 'kindoo-unparseable'
  | 'scope-mismatch'
  | 'type-mismatch'
  | 'buildings-mismatch'
  | 'mixed-callings';

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
  /** Parsed primary segment's scope (`'stake'` / ward_code / `null`). */
  primaryScope: 'stake' | string | null;
  /** Intended seat shape derived by the classifier from the primary segment. */
  intendedType: IntendedSeatShape['type'] | null;
  /** Rule IDs Kindoo currently assigns. */
  ruleIds: number[];
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
  const seatsByEmail = indexSeats(inputs.seats);
  const kindooByEmail = indexKindooUsers(inputs.kindooUsers);

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
      const primary = pickPrimarySegment(parsed);
      const intended = primary ? classifySegment(primary, kuser.isTempUser, sets) : null;
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-only',
        severity: 'drift',
        reason: 'Kindoo has a user for this email, but SBA has no seat for them.',
        sba: null,
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings),
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
        kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings),
      });
      continue;
    }

    const primary = pickPrimarySegment(parsed);
    if (!primary) {
      // Shouldn't be reachable when unparseable=false, but be defensive.
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-unparseable',
        severity: 'review',
        reason: 'Kindoo description has no resolvable primary segment.',
        sba: toSbaBlock(seat),
        kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings),
      });
      continue;
    }
    const intended = classifySegment(primary, kuser.isTempUser, sets);

    // 4. mixed-callings — classifier flagged it; emit review before drift checks.
    if (intended.reviewMixed) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'mixed-callings',
        severity: 'review',
        reason:
          "Kindoo description's primary segment has a mix of auto-template and non-auto callings; manual review required.",
        sba: toSbaBlock(seat),
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings),
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
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings),
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
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings),
      });
      continue;
    }

    // 7. buildings-mismatch — Kindoo rule set vs SBA building → RID mapping.
    const expectedBuildings = seat.building_names ?? [];
    const kindooBuildings = ruleIdsToBuildingNames(
      kuser.accessSchedules.map((s) => s.ruleId),
      inputs.buildings,
    );
    if (!setsEqual(expectedBuildings, kindooBuildings)) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'buildings-mismatch',
        severity: 'drift',
        reason: `Building access differs: SBA=[${expectedBuildings.join(', ')}], Kindoo=[${kindooBuildings.join(', ')}].`,
        sba: toSbaBlock(seat),
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings),
      });
      continue;
    }
    // No discrepancy — skip.
  }

  discrepancies.sort(compareDiscrepancies);
  return {
    discrepancies,
    seatCount: inputs.seats.length,
    kindooCount: inputs.kindooUsers.length,
  };
}

function buildKindooBlock(
  kuser: KindooEnvironmentUser,
  parsed: ParsedDescription,
  intended: IntendedSeatShape | null,
  _buildings: Building[],
): KindooBlock {
  const primary = pickPrimarySegment(parsed);
  return {
    description: kuser.description,
    isTempUser: kuser.isTempUser,
    primaryScope: primary?.scope ?? null,
    intendedType: intended?.type ?? null,
    ruleIds: kuser.accessSchedules.map((s) => s.ruleId),
  };
}
