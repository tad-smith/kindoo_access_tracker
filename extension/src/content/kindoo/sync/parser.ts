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

import {
  filterAppAccessCallings,
  kindooScopeNameVariants,
  matchesIgnoredWard,
  type AppAccessOptions,
  type Stake,
  type Ward,
} from '@kindoo/shared';

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
  /** Surviving segments — those the stake's ignore list did not drop. */
  segments: ParsedSegment[];
  /** True when no surviving segment could be resolved (e.g. random text,
   * Kindoo Manager descriptions). Distinct from "no segments at all". */
  unparseable: boolean;
  /** Original input, preserved for diagnostic rendering. */
  raw: string;
  /** How many segments `stake.kindoo_ignored_wards` removed. Lets callers
   * tell a fully-ignored description (another stake's user) apart from a
   * blank one — both leave `segments` empty. See `isFullyIgnored`. */
  ignoredCount: number;
}

const SEGMENT_RE = /^(.+?)\s*\((.+)\)\s*$/;

function normalise(s: string): string {
  return s.trim().toLowerCase();
}

/** Collision signatures already warned about — see `buildWardLookup`. */
const warnedCollisions = new Set<string>();

/**
 * Normalised variant → `ward_code`, with **first registration winning**.
 *
 * Two units in one stake can produce overlapping variant sets: `"Maple"`
 * and `"Maple Ward"` both yield `maple` + `maple ward`, and a branch
 * `"Olive Branch"` overlaps a ward `"Olive Branch Ward"` on
 * `olive branch`. Last-write-wins would hand the contested key to
 * whichever unit happened to come later in `wards` and silently
 * attribute the other unit's Kindoo users to it — Sync then proposes
 * seat writes against the wrong unit, which is worse than not resolving
 * at all. First-wins makes the outcome independent of array order; the
 * warn makes the config error visible in DevTools. The real fix is
 * renaming one of the two units in SBA.
 *
 * The warn is deduped across calls: `parseDescription` runs once per
 * Kindoo user per Sync pass, and a name collision persists for the whole
 * run — one line per contested pair, not several hundred.
 */
function buildWardLookup(wards: Array<Pick<Ward, 'ward_code' | 'ward_name'>>): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const w of wards) {
    for (const key of kindooScopeNameVariants(w.ward_name)) {
      const owner = lookup.get(key);
      if (owner === undefined) {
        lookup.set(key, w.ward_code);
        continue;
      }
      // The variants list is de-duplicated, but a unit re-registering
      // its own key is still not a collision.
      if (owner === w.ward_code) continue;
      const signature = `${key}|${owner}|${w.ward_code}`;
      if (warnedCollisions.has(signature)) continue;
      warnedCollisions.add(signature);
      console.warn(
        `[sba-ext] parseDescription: unit name collision on "${key}" — units ` +
          `${owner} and ${w.ward_code} both claim it. Keeping ${owner}; descriptions ` +
          `naming "${key}" will not resolve to ${w.ward_code}. Rename one unit in SBA.`,
      );
    }
  }
  return lookup;
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
 * Unit matching registers each ward under every form Kindoo could
 * render it as (`kindooScopeNameVariants`). The trailing `" Ward"` is
 * optional in SBA, so a ward stored either way resolves against a
 * description written either way. A branch has one form — Kindoo never
 * renders `"Limon Branch Ward"`. Two units whose variant sets overlap
 * contest a key; the first one registered keeps it and the collision is
 * warned about — see `buildWardLookup`.
 *
 * Returns `unparseable: true` when no segment resolves — including the
 * case of an empty string, a non-conforming string with no parens, or
 * Kindoo Manager descriptions like `"Kindoo Manager - Stake Clerk"`.
 *
 * Segments naming a ward on `stake.kindoo_ignored_wards` are dropped
 * before any of that, and counted in `ignoredCount`. Only UNRESOLVED
 * segments are eligible: a ward this stake owns resolves, so the ignore
 * list can never hide our own scope even if an entry collides with a
 * ward name (renamed after the entry was added, say).
 */
export function parseDescription(
  raw: string,
  stake: Pick<Stake, 'stake_name' | 'kindoo_expected_site_name' | 'kindoo_ignored_wards'>,
  wards: Array<Pick<Ward, 'ward_code' | 'ward_name'>>,
): ParsedDescription {
  const input = raw ?? '';
  if (input.trim().length === 0) {
    return { segments: [], unparseable: true, raw: input, ignoredCount: 0 };
  }

  const ignoredWards = stake.kindoo_ignored_wards;
  const expectedSiteName = stake.kindoo_expected_site_name?.trim();
  const stakeKey = normalise(
    expectedSiteName && expectedSiteName.length > 0 ? expectedSiteName : stake.stake_name,
  );
  const wardLookup = buildWardLookup(wards);

  const rawSegments = input.split(' | ');
  const segments: ParsedSegment[] = [];
  let ignoredCount = 0;
  const pushSegment = (segment: ParsedSegment): void => {
    // Ignore-eligible only while unresolved — a scope that matched one
    // of our own wards or the stake is ours regardless of the list.
    if (!segment.resolvedScope && matchesIgnoredWard(segment.rawScopeName, ignoredWards)) {
      ignoredCount++;
      return;
    }
    segments.push(segment);
  };

  for (const rawSeg of rawSegments) {
    const m = rawSeg.match(SEGMENT_RE);
    if (!m) {
      // No parens shape — record an unresolved segment so the detector
      // can render the raw text in the report.
      pushSegment({
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

    pushSegment({ rawScopeName, scope, calling, resolvedScope });
  }

  const unparseable = segments.every((s) => !s.resolvedScope);
  return { segments, unparseable, raw: input, ignoredCount };
}

/**
 * Did the stake's ignore list consume the whole description? True only
 * when at least one segment was dropped AND nothing survived — i.e. the
 * user belongs entirely to another SBA stake's wards and Sync should
 * not see them at all.
 *
 * The `ignoredCount > 0` half matters: a blank description also leaves
 * `segments` empty, and that one is a real review row.
 */
export function isFullyIgnored(parsed: ParsedDescription): boolean {
  return parsed.ignoredCount > 0 && parsed.segments.length === 0;
}

/** True iff any calling in `segment.calling` (split on `,`) grants app
 * access for the segment's own scope — ward callings for ward scopes,
 * the stake list for `'stake'`. Uses the hard-coded app-access lists,
 * plus the stake-gated ward calling when `opts.eqPresidentAccess`. */
function segmentGrantsAppAccess(segment: ParsedSegment, opts?: AppAccessOptions): boolean {
  if (!segment.resolvedScope || segment.scope === null) return false;
  const callings = segment.calling.split(',').map((c) => c.trim());
  return filterAppAccessCallings(segment.scope, callings, opts).length > 0;
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
 *
 * `opts` carries the per-stake app-access gates (currently just
 * `eqPresidentAccess`). Omitting it means every gate is off, which must
 * match the server's read of an absent `stake.eq_president_app_access`.
 */
export function pickPrimarySegment(
  parsed: ParsedDescription,
  opts?: AppAccessOptions,
): ParsedSegment | null {
  const resolved = parsed.segments.filter((s) => s.resolvedScope);
  if (resolved.length === 0) return null;

  // Prefer app-access-granting segments when at least one exists.
  const appAccess = resolved.filter((s) => segmentGrantsAppAccess(s, opts));
  const pool = appAccess.length > 0 ? appAccess : resolved;

  const stakeSeg = pool.find((s) => s.scope === 'stake');
  if (stakeSeg) return stakeSeg;
  // Wards — sort alphabetically by ward_code.
  const wardsSorted = [...pool].sort((a, b) => String(a.scope).localeCompare(String(b.scope)));
  return wardsSorted[0] ?? null;
}
