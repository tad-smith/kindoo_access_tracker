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
// resolves scope names against the known wards + stake. The classifier
// consumes its output.
//
// Phase 1 of the sync feature; design doc at
// `extension/docs/sync-design.md` §"Description parser".

import type { Stake, Ward } from '@kindoo/shared';

/** One scope+calling segment within a parsed description. */
export interface ParsedSegment {
  /** Scope name exactly as it appeared in the description (`"Cordera Ward"`). */
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
 * Returns `unparseable: true` when no segment resolves — including the
 * case of an empty string, a non-conforming string with no parens, or
 * Kindoo Manager descriptions like `"Kindoo Manager - Stake Clerk"`.
 */
export function parseDescription(
  raw: string,
  stake: Pick<Stake, 'stake_name'>,
  wards: Array<Pick<Ward, 'ward_code' | 'ward_name'>>,
): ParsedDescription {
  const input = raw ?? '';
  if (input.trim().length === 0) {
    return { segments: [], unparseable: true, raw: input };
  }

  const stakeKey = normalise(stake.stake_name);
  const wardLookup = new Map<string, string>();
  for (const w of wards) {
    wardLookup.set(normalise(w.ward_name), w.ward_code);
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

/**
 * Pick the primary segment from a list of resolved segments. Mirrors
 * SBA's existing `pickPrimaryScope` ordering: stake-scope wins; ties
 * among wards break alphabetically by `ward_code`. Returns `null` when
 * no segment resolved.
 */
export function pickPrimarySegment(parsed: ParsedDescription): ParsedSegment | null {
  const resolved = parsed.segments.filter((s) => s.resolvedScope);
  if (resolved.length === 0) return null;
  const stakeSeg = resolved.find((s) => s.scope === 'stake');
  if (stakeSeg) return stakeSeg;
  // Wards — sort alphabetically by ward_code.
  const wardsSorted = [...resolved].sort((a, b) => String(a.scope).localeCompare(String(b.scope)));
  return wardsSorted[0] ?? null;
}
