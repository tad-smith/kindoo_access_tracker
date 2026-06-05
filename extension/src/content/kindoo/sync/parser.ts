// Parses a Kindoo `Description` string into one or more scope+calling
// segments. The convention extension v2.2 writes is:
//
//   Scope Name (Calling)
//   Scope Name (Calling A, Calling B)
//   Scope Name A (Calling A) | Scope Name B (Calling B)
//
// `|` separates segments when one person holds qualifying callings in
// multiple scopes; the calling string inside the parens may itself be
// comma-separated when one segment carries multiple matching callings.
//
// The parser does not classify auto-vs-manual — it just splits and
// resolves scope names against the known wards + stake. The detector
// consumes its output.
//
// Phase 1 of the sync feature; design doc at
// `extension/docs/sync-design.md` §"Description parser".

import { filterAppAccessCallings, type Stake, type Ward } from '@kindoo/shared';

/** One scope+calling segment within a parsed description. */
export interface ParsedSegment {
  /** Scope name exactly as it appeared in the description (`"Maple Ward"`). */
  rawScopeName: string;
  /** `'stake'` or a `ward_code` once the name resolves; `null` when unresolved. */
  scope: 'stake' | string | null;
  /** Free-text inside the parens, untrimmed of internal commas. */
  calling: string;
  /** `true` when `rawScopeName` matched a known ward or the stake. */
  resolvedScope: boolean;
}

export interface ParsedDescription {
  segments: ParsedSegment[];
  /** True when no segment could be resolved (e.g. random text, Kindoo
   * Manager descriptions). Distinct from "no segments at all". */
  unparseable: boolean;
  /** Original input, preserved for diagnostic rendering. */
  raw: string;
}

const SEGMENT_RE = /^(.+?)\s*\((.+)\)\s*$/;

function normalise(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Parse a Kindoo description into resolved scope+calling segments.
 *
 * `stake` and `wards` are the resolution targets. Resolution is
 * case-insensitive and trims surrounding whitespace; otherwise exact
 * match.
 *
 * Stake matching honours `stake.kindoo_expected_site_name` when set —
 * mirrors the wizard, lets staging stake docs carry a `"STAGING - "`
 * prefix in `stake_name` without breaking parsing of real Kindoo
 * descriptions. Falls back to `stake_name` when the override is absent
 * or empty.
 *
 * Ward matching registers each ward under two keys: the bare
 * `ward_name` and `ward_name + " Ward"`. SBA stores ward names without
 * the trailing `" Ward"` suffix (`"Jackson Creek"`) but Kindoo
 * descriptions carry the full form (`"Jackson Creek Ward"`); both
 * variants resolve. Wards whose `ward_name` already ends in `" Ward"`
 * register only the single key (`Map.set` collapses duplicates).
 *
 * Returns `unparseable: true` when no segment resolves — including the
 * case of an empty string, a non-conforming string with no parens, or
 * Kindoo Manager descriptions like `"Kindoo Manager - Stake Clerk"`.
 */
export function parseDescription(
  raw: string,
  stake: Pick<Stake, 'stake_name' | 'kindoo_expected_site_name'>,
  wards: Array<Pick<Ward, 'ward_code' | 'ward_name'>>,
): ParsedDescription {
  const input = raw ?? '';
  if (input.trim().length === 0) {
    return { segments: [], unparseable: true, raw: input };
  }

  const expectedSiteName = stake.kindoo_expected_site_name?.trim();
  const stakeKey = normalise(
    expectedSiteName && expectedSiteName.length > 0 ? expectedSiteName : stake.stake_name,
  );
  const wardLookup = new Map<string, string>();
  for (const w of wards) {
    const baseKey = normalise(w.ward_name);
    wardLookup.set(baseKey, w.ward_code);
    // Kindoo descriptions render the ward with a " Ward" suffix
    // (e.g. "Jackson Creek Ward") while SBA stores `ward_name`
    // without it ("Jackson Creek"). Register both forms so the
    // exact-match lookup succeeds regardless of which form the
    // description carries.
    const suffixKey = normalise(`${w.ward_name} Ward`);
    if (suffixKey !== baseKey) {
      wardLookup.set(suffixKey, w.ward_code);
    }
  }

  const rawSegments = input.split(' | ');
  const segments: ParsedSegment[] = [];
  for (const rawSeg of rawSegments) {
    const m = rawSeg.match(SEGMENT_RE);
    if (!m) {
      // No parens shape — record an unresolved segment so the detector
      // can render the raw text in the report.
      segments.push({
        rawScopeName: rawSeg.trim(),
        scope: null,
        calling: '',
        resolvedScope: false,
      });
      continue;
    }
    const rawScopeName = m[1]!.trim();
    const calling = m[2]!.trim();
    const key = normalise(rawScopeName);

    let scope: 'stake' | string | null = null;
    let resolvedScope = false;
    if (key === stakeKey && stakeKey.length > 0) {
      scope = 'stake';
      resolvedScope = true;
    } else {
      const wardCode = wardLookup.get(key);
      if (wardCode !== undefined) {
        scope = wardCode;
        resolvedScope = true;
      }
    }

    segments.push({ rawScopeName, scope, calling, resolvedScope });
  }

  const unparseable = segments.every((s) => !s.resolvedScope);
  return { segments, unparseable, raw: input };
}

/** True iff any calling in `segment.calling` (split on `,`) grants app
 * access for the segment's own scope — ward callings for ward scopes,
 * the stake list for `'stake'`. Uses the hard-coded app-access lists. */
function segmentGrantsAppAccess(segment: ParsedSegment): boolean {
  if (!segment.resolvedScope || segment.scope === null) return false;
  const callings = segment.calling.split(',').map((c) => c.trim());
  return filterAppAccessCallings(segment.scope, callings).length > 0;
}

/**
 * Pick the primary segment from a list of resolved segments. Prefer a
 * segment whose calling grants app access (per the hard-coded
 * per-scope lists) so a non-app-access stake segment doesn't steal
 * primary from a real ward app-access match — the two-segment
 * ward-priority case observed in production (stake/Technology
 * Specialist + ward/Bishop where the seat lives on the ward). Among
 * equally-ranked segments — and as the fallback when none grant app
 * access — apply SBA's `pickPrimaryScope` ordering: stake-scope first,
 * then alphabetical by `ward_code`. Returns `null` when no segment
 * resolved.
 */
export function pickPrimarySegment(parsed: ParsedDescription): ParsedSegment | null {
  const resolved = parsed.segments.filter((s) => s.resolvedScope);
  if (resolved.length === 0) return null;

  // Prefer app-access-granting segments when at least one exists.
  const appAccess = resolved.filter(segmentGrantsAppAccess);
  const pool = appAccess.length > 0 ? appAccess : resolved;

  const stakeSeg = pool.find((s) => s.scope === 'stake');
  if (stakeSeg) return stakeSeg;
  // Wards — sort alphabetically by ward_code.
  const wardsSorted = [...pool].sort((a, b) => String(a.scope).localeCompare(String(b.scope)));
  return wardsSorted[0] ?? null;
}
