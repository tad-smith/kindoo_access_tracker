// Classifies a parsed description segment into the intended SBA seat
// shape (auto / manual / temp). Pure function consumed by the
// discrepancy detector.
//
// The classifier walks each individual calling within the segment's
// parens and looks it up against the auto-calling templates for that
// scope. The match rule per the design doc:
//   - All callings match → segment.type = 'auto'
//   - None match         → segment.type = 'manual'
//   - Mixed              → segment.type = 'auto' with reviewMixed = true,
//                          unmatched callings carried in freeText
//   - IsTempUser=true    → segment.type = 'temp' (overrides everything)
//
// Mixed-callings policy: when Kindoo's parens list at least one auto-
// template calling alongside additional non-auto callings, the auto
// calling drives the seat type (the user IS an auto seat). The
// unmatched callings are extra detail Kindoo records that SBA's seat
// doesn't yet — they ride along in `freeText` so the detector can
// surface a review row asking the operator to add them to the SBA
// seat.
//
// Phase 1 of the sync feature; design doc at
// `extension/docs/sync-design.md` §"Classifier".

import type { StakeCallingTemplate, WardCallingTemplate } from '@kindoo/shared';
import type { ParsedSegment } from './parser';

export type IntendedSeatType = 'auto' | 'manual' | 'temp';

export interface IntendedSeatShape {
  /** `'stake'` or a `ward_code`. `null` when the parsed segment did not
   * resolve a scope. */
  scope: 'stake' | string | null;
  /** Resolved seat type. `temp` wins over any other when `IsTempUser`. */
  type: IntendedSeatType;
  /** For `auto`: the matched calling names. For `manual` / `temp`: `[]`. */
  callings: string[];
  /**
   * Raw free-text from the parens that did NOT match any auto template.
   * Empty for pure-auto matches. Carries the operator-typed reason for
   * manual / temp seats.
   */
  freeText: string;
  /**
   * True when some (but not all) callings in the parens matched the
   * auto set. Mixed segments classify as `auto` (the matched calling
   * drives the type) and surface in the report's "review" bucket so
   * the operator can add the unmatched callings to the SBA seat.
   */
  reviewMixed: boolean;
}

/**
 * Templates relevant to a single classification call. The detector
 * provides one of these per scope (collapsed to the appropriate set
 * before calling).
 */
export interface CallingTemplateSets {
  /** Stake-scope auto callings keyed by lowercase name for fast lookup. */
  stakeCallings: Set<string>;
  /** Ward-scope auto callings keyed `wardCode -> Set<lowercaseCallingName>`. */
  wardCallings: Map<string, Set<string>>;
}

/**
 * Build a CallingTemplateSets from the raw template arrays the SW
 * loader returns. The detector builds this once per sync run.
 *
 * The detector cannot resolve which ward a `WardCallingTemplate`
 * belongs to from the template doc alone (Sheet-tab provenance lives
 * outside the doc body). Until that's wired, ward auto matches are
 * derived from the UNION of every ward template — a calling that auto-
 * matches in any ward auto-matches everywhere. Phase 2 may narrow this
 * if the importer starts tagging templates with the source ward; v1
 * single-stake operators use the same per-ward sets in practice.
 */
export function buildCallingTemplateSets(
  stakeCallingTemplates: StakeCallingTemplate[],
  wardCallingTemplates: WardCallingTemplate[],
  wardCodes: string[],
): CallingTemplateSets {
  const stakeCallings = new Set<string>();
  for (const t of stakeCallingTemplates) {
    if (t.auto_kindoo_access) stakeCallings.add(t.calling_name.toLowerCase());
  }
  const allWardCallings = new Set<string>();
  for (const t of wardCallingTemplates) {
    if (t.auto_kindoo_access) allWardCallings.add(t.calling_name.toLowerCase());
  }
  const wardCallings = new Map<string, Set<string>>();
  for (const code of wardCodes) {
    wardCallings.set(code, new Set(allWardCallings));
  }
  return { stakeCallings, wardCallings };
}

/** Resolve the calling set for a scope, defaulting to an empty set. */
function callingsForScope(scope: 'stake' | string | null, sets: CallingTemplateSets): Set<string> {
  if (scope === null) return new Set();
  if (scope === 'stake') return sets.stakeCallings;
  return sets.wardCallings.get(scope) ?? new Set();
}

/** Split the parens body on `,` and trim each calling. */
function splitCallings(parenText: string): string[] {
  return parenText
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Classify one segment + the user's `isTempUser` flag against the auto
 * template sets.
 *
 * Algorithm:
 *   1. `isTempUser === true` → type=`temp`, callings=[], freeText=raw.
 *   2. Segment unresolved scope (parser couldn't match the name) →
 *      type=`manual`, freeText=raw (operator review).
 *   3. Else split the calling text on `,`, look up each against the
 *      scope's auto set. ALL match → `auto`. NONE match → `manual`.
 *      Mixed → `auto` with `reviewMixed=true`; the matched callings
 *      stay in `callings[]` and the unmatched ones go to `freeText`
 *      so the detector can ask the operator to add them to the SBA
 *      seat.
 */
export function classifySegment(
  segment: ParsedSegment,
  isTempUser: boolean,
  sets: CallingTemplateSets,
): IntendedSeatShape {
  if (isTempUser) {
    return {
      scope: segment.scope,
      type: 'temp',
      callings: [],
      freeText: segment.calling,
      reviewMixed: false,
    };
  }

  if (!segment.resolvedScope) {
    // Unresolved scope — operator must judge. Per design doc this is a
    // "manual seat, unknown scope, flag for review" case; the detector
    // adds the review flag separately via the unparseable path. Here
    // we just emit a manual shape.
    return {
      scope: null,
      type: 'manual',
      callings: [],
      freeText: segment.calling,
      reviewMixed: false,
    };
  }

  const candidates = splitCallings(segment.calling);
  if (candidates.length === 0) {
    return {
      scope: segment.scope,
      type: 'manual',
      callings: [],
      freeText: segment.calling,
      reviewMixed: false,
    };
  }

  const autoSet = callingsForScope(segment.scope, sets);
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const c of candidates) {
    if (autoSet.has(c.toLowerCase())) {
      matched.push(c);
    } else {
      unmatched.push(c);
    }
  }

  if (unmatched.length === 0) {
    return {
      scope: segment.scope,
      type: 'auto',
      callings: matched,
      freeText: '',
      reviewMixed: false,
    };
  }

  if (matched.length === 0) {
    return {
      scope: segment.scope,
      type: 'manual',
      callings: [],
      freeText: segment.calling,
      reviewMixed: false,
    };
  }

  // Mixed — the auto calling(s) drive the type; the user IS an auto
  // seat. The unmatched callings are extra detail Kindoo records but
  // SBA doesn't — they ride along in `freeText` so the detector can
  // ask the operator to add them to the SBA seat.
  return {
    scope: segment.scope,
    type: 'auto',
    callings: matched,
    freeText: unmatched.join(', '),
    reviewMixed: true,
  };
}
