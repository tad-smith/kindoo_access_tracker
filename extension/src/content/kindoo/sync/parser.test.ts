// Parser tests. Covers every shape variant the design doc lists plus
// the picker-primary helper. Wards / stake supplied inline so the tests
// stay decoupled from real Firestore docs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isFullyIgnored, parseDescription, pickPrimarySegment } from './parser';

const STAKE = { stake_name: 'Colorado Springs North Stake' };
const WARDS = [
  { ward_code: 'CO', ward_name: 'Maple Ward' },
  { ward_code: 'PC', ward_name: 'Pine Creek Ward' },
  { ward_code: 'MO', ward_name: 'Monument Ward' },
];

describe('parseDescription', () => {
  it('parses a single ward segment with one calling', () => {
    const parsed = parseDescription('Maple Ward (Sunday School Teacher)', STAKE, WARDS);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]).toMatchObject({
      rawScopeName: 'Maple Ward',
      scope: 'CO',
      calling: 'Sunday School Teacher',
      resolvedScope: true,
    });
  });

  it('parses a stake-scope segment', () => {
    const parsed = parseDescription('Colorado Springs North Stake (Stake Clerk)', STAKE, WARDS);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]).toMatchObject({
      scope: 'stake',
      calling: 'Stake Clerk',
      resolvedScope: true,
    });
  });

  it('parses two cross-scope segments separated by " | "', () => {
    const parsed = parseDescription(
      'Maple Ward (Elders Quorum President) | Pine Creek Ward (Sunday School Teacher)',
      STAKE,
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]?.scope).toBe('CO');
    expect(parsed.segments[1]?.scope).toBe('PC');
  });

  it('parses three cross-scope segments', () => {
    const parsed = parseDescription(
      'Maple Ward (A) | Pine Creek Ward (B) | Monument Ward (C)',
      STAKE,
      WARDS,
    );
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments.map((s) => s.scope)).toEqual(['CO', 'PC', 'MO']);
  });

  it('preserves a multi-calling parens body as a single comma-separated string', () => {
    const parsed = parseDescription(
      'Maple Ward (Elders Quorum First Counselor, Accompanist)',
      STAKE,
      WARDS,
    );
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.calling).toBe('Elders Quorum First Counselor, Accompanist');
  });

  it('matches scope names case-insensitively and ignores surrounding whitespace', () => {
    const parsed = parseDescription('  MAPLE WARD  (Test)', STAKE, WARDS);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('CO');
  });

  it('flags unparseable when input is empty', () => {
    const parsed = parseDescription('', STAKE, WARDS);
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments).toHaveLength(0);
  });

  it('flags unparseable when the segment has no parens', () => {
    const parsed = parseDescription('Random free text', STAKE, WARDS);
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.resolvedScope).toBe(false);
  });

  it('flags unparseable when the scope name does not match any ward or the stake', () => {
    const parsed = parseDescription('Springfield Ward (Bishop)', STAKE, WARDS);
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments[0]?.resolvedScope).toBe(false);
    expect(parsed.segments[0]?.rawScopeName).toBe('Springfield Ward');
  });

  it('flags unparseable for a Kindoo Manager-style description', () => {
    const parsed = parseDescription('Kindoo Manager - Stake Clerk account', STAKE, WARDS);
    expect(parsed.unparseable).toBe(true);
  });

  it('marks partial-match descriptions as parseable when at least one segment resolves', () => {
    const parsed = parseDescription(
      'Maple Ward (Elders Quorum President) | Unknown Ward (Whatever)',
      STAKE,
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.resolvedScope).toBe(true);
    expect(parsed.segments[1]?.resolvedScope).toBe(false);
  });

  it('keeps the original raw input on the result', () => {
    const input = 'Maple Ward (Sunday School Teacher)';
    const parsed = parseDescription(input, STAKE, WARDS);
    expect(parsed.raw).toBe(input);
  });

  it('handles parens nested in calling text by greedy-matching to the last close paren', () => {
    const parsed = parseDescription('Maple Ward (Sunday School Teacher (Primary))', STAKE, WARDS);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.calling).toBe('Sunday School Teacher (Primary)');
  });

  // ----- kindoo_expected_site_name override -----

  it('resolves stake scope via kindoo_expected_site_name override when present', () => {
    // Staging Firestore: `stake_name` carries a STAGING prefix, but
    // Kindoo's description carries the un-prefixed real name. The
    // override field bridges the gap.
    const stagingStake = {
      stake_name: 'STAGING - Colorado Springs North Stake',
      kindoo_expected_site_name: 'Colorado Springs North Stake',
    };
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk)',
      stagingStake,
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]).toMatchObject({ scope: 'stake', resolvedScope: true });
  });

  it('falls back to stake_name when kindoo_expected_site_name is absent', () => {
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk)',
      { stake_name: 'Colorado Springs North Stake' },
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('stake');
  });

  it('falls back to stake_name when kindoo_expected_site_name is empty / whitespace', () => {
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk)',
      { stake_name: 'Colorado Springs North Stake', kindoo_expected_site_name: '   ' },
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('stake');
  });

  it('does not resolve when neither stake_name nor kindoo_expected_site_name matches', () => {
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk)',
      {
        stake_name: 'STAGING - Colorado Springs North Stake',
        kindoo_expected_site_name: 'Some Other Stake',
      },
      WARDS,
    );
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments[0]?.resolvedScope).toBe(false);
  });

  // ----- the optional " Ward" suffix, and branches -----

  it('resolves a ward when ward_name lacks " Ward" but the description carries it', () => {
    // The trailing " Ward" is optional in SBA. Kindoo always renders
    // it. Both forms must resolve.
    const wardsNoSuffix = [{ ward_code: 'JC', ward_name: 'Jackson Creek' }];
    const parsed = parseDescription(
      'Jackson Creek Ward (Young Women President)',
      STAKE,
      wardsNoSuffix,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('JC');
  });

  it('resolves a ward when neither ward_name nor description carries " Ward"', () => {
    const wardsNoSuffix = [{ ward_code: 'JC', ward_name: 'Jackson Creek' }];
    const parsed = parseDescription('Jackson Creek (Young Women President)', STAKE, wardsNoSuffix);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('JC');
  });

  it('resolves a ward whose ward_name already ends in " Ward" via the suffix form', () => {
    // ward_name with the suffix → only the with-suffix key is
    // registered. Descriptions with the suffix still resolve.
    const wardsWithSuffix = [{ ward_code: 'JC', ward_name: 'Jackson Creek Ward' }];
    const parsed = parseDescription(
      'Jackson Creek Ward (Young Women President)',
      STAKE,
      wardsWithSuffix,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('JC');
  });

  it('resolves an unsuffixed description against a ward_name that includes " Ward"', () => {
    // Behaviour change: the suffix used to be stripped/added only on
    // the ward_name side, so this direction did not resolve. The
    // suffix is now optional in both directions — "Jackson Creek" and
    // "Jackson Creek Ward" name the same unit whichever side each form
    // appears on, so an operator who typed the suffix into SBA is no
    // longer punished for it.
    const wardsWithSuffix = [{ ward_code: 'JC', ward_name: 'Jackson Creek Ward' }];
    const parsed = parseDescription(
      'Jackson Creek (Young Women President)',
      STAKE,
      wardsWithSuffix,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('JC');
  });

  it('resolves a branch under its verbatim name', () => {
    const withBranch = [{ ward_code: 'LB', ward_name: 'Peterson Branch' }];
    const parsed = parseDescription('Peterson Branch (Branch President)', STAKE, withBranch);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]).toMatchObject({
      rawScopeName: 'Peterson Branch',
      scope: 'LB',
      calling: 'Branch President',
      resolvedScope: true,
    });
  });

  it('does not register a " Ward"-suffixed form for a branch', () => {
    // Kindoo renders a branch verbatim; "Peterson Branch Ward" is a name
    // nothing writes, so resolving it would only ever mask a typo.
    const withBranch = [{ ward_code: 'LB', ward_name: 'Peterson Branch' }];
    const parsed = parseDescription('Peterson Branch Ward (Branch President)', STAKE, withBranch);
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments[0]?.resolvedScope).toBe(false);
  });

  it('resolves a branch alongside a ward in a multi-scope description', () => {
    const units = [
      { ward_code: 'LB', ward_name: 'Peterson Branch' },
      { ward_code: 'JC', ward_name: 'Jackson Creek' },
    ];
    const parsed = parseDescription(
      'Peterson Branch (Branch President) | Jackson Creek Ward (Sunday School Teacher)',
      STAKE,
      units,
    );
    expect(parsed.segments.map((s) => s.scope)).toEqual(['LB', 'JC']);
  });
});

// Two units in one stake can contest a variant key. The web-side
// uniqueness guard rejects new such pairs, but a stake that already
// holds one must not be mis-attributed in the meantime. Each test that
// asserts on the warn uses its own unit names — the warn is deduped by
// (key, pair) for the life of the module.
describe('parseDescription — unit name collisions', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives a contested key to the first unit registered, not the last', () => {
    const units = [
      { ward_code: 'C1', ward_name: 'Cedar' },
      { ward_code: 'C2', ward_name: 'Cedar Ward' },
    ];
    expect(parseDescription('Cedar Ward (Bishop)', STAKE, units).segments[0]?.scope).toBe('C1');
    expect(parseDescription('Cedar (Bishop)', STAKE, units).segments[0]?.scope).toBe('C1');
  });

  it('resolves the same way whichever order the colliding units arrive in', () => {
    const reversed = [
      { ward_code: 'C2', ward_name: 'Cedar Ward' },
      { ward_code: 'C1', ward_name: 'Cedar' },
    ];
    // Same pair, opposite array order: the winner is whoever is first,
    // so the result is a function of the config rather than of the
    // order Firestore happened to hand the wards over.
    expect(parseDescription('Cedar Ward (Bishop)', STAKE, reversed).segments[0]?.scope).toBe('C2');
    expect(parseDescription('Cedar (Bishop)', STAKE, reversed).segments[0]?.scope).toBe('C2');
  });

  it('keeps the branch on the shared key and leaves the ward its own key', () => {
    // "Olive Branch" yields only `olive branch`; "Olive Branch Ward"
    // yields `olive branch` + `olive branch ward`. They contest the
    // first; the second is uncontested and must still resolve.
    const units = [
      { ward_code: 'OB', ward_name: 'Olive Branch' },
      { ward_code: 'OW', ward_name: 'Olive Branch Ward' },
    ];
    expect(
      parseDescription('Olive Branch (Branch President)', STAKE, units).segments[0],
    ).toMatchObject({ scope: 'OB', resolvedScope: true });
    expect(parseDescription('Olive Branch Ward (Bishop)', STAKE, units).segments[0]).toMatchObject({
      scope: 'OW',
      resolvedScope: true,
    });
  });

  it('leaves non-colliding units untouched when a colliding pair is present', () => {
    const units = [
      { ward_code: 'C1', ward_name: 'Cedar' },
      { ward_code: 'C2', ward_name: 'Cedar Ward' },
      { ward_code: 'PC', ward_name: 'Pine Creek Ward' },
    ];
    expect(parseDescription('Pine Creek Ward (Bishop)', STAKE, units).segments[0]?.scope).toBe(
      'PC',
    );
    expect(parseDescription('Pine Creek (Bishop)', STAKE, units).segments[0]?.scope).toBe('PC');
  });

  it('warns naming both ward_codes and the contested key', () => {
    const units = [
      { ward_code: 'A1', ward_name: 'Aspen' },
      { ward_code: 'A2', ward_name: 'Aspen Ward' },
    ];
    parseDescription('Aspen Ward (Bishop)', STAKE, units);
    const messages = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(2); // one per contested key: "aspen", "aspen ward"
    for (const m of messages) {
      expect(m).toContain('[sba-ext]');
      expect(m).toContain('A1');
      expect(m).toContain('A2');
    }
    expect(messages.some((m) => m.includes('"aspen"'))).toBe(true);
    expect(messages.some((m) => m.includes('"aspen ward"'))).toBe(true);
  });

  it('warns for a branch / ward collision', () => {
    const units = [
      { ward_code: 'F1', ward_name: 'Fig Branch' },
      { ward_code: 'F2', ward_name: 'Fig Branch Ward' },
    ];
    parseDescription('Fig Branch (Branch President)', STAKE, units);
    const messages = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('[sba-ext]');
    expect(messages[0]).toContain('"fig branch"');
    expect(messages[0]).toContain('F1');
    expect(messages[0]).toContain('F2');
  });

  it('warns once per contested pair, not once per parsed description', () => {
    // parseDescription runs once per Kindoo user per Sync pass; a
    // per-call warn would emit hundreds of identical lines.
    const units = [
      { ward_code: 'B1', ward_name: 'Birch' },
      { ward_code: 'B2', ward_name: 'Birch Ward' },
    ];
    parseDescription('Birch Ward (Bishop)', STAKE, units);
    parseDescription('Birch (Bishop)', STAKE, units);
    parseDescription('Birch Ward (Clerk)', STAKE, units);
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(2); // "birch", "birch ward"
  });

  it('does not treat a unit re-registering its own key as a collision', () => {
    // Defensive: the variants list is already de-duplicated, and a
    // duplicated ward doc names the same unit either way.
    const units = [
      { ward_code: 'JC', ward_name: 'Jackson Creek' },
      { ward_code: 'JC', ward_name: 'Jackson Creek Ward' },
    ];
    expect(parseDescription('Jackson Creek Ward (Bishop)', STAKE, units).segments[0]?.scope).toBe(
      'JC',
    );
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });
});

describe('pickPrimarySegment', () => {
  it('picks the stake-scope segment when present', () => {
    const parsed = parseDescription(
      'Maple Ward (A) | Colorado Springs North Stake (B) | Pine Creek Ward (C)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed);
    expect(primary?.scope).toBe('stake');
  });

  it('picks the alphabetically-first ward when only wards resolve', () => {
    const parsed = parseDescription(
      'Pine Creek Ward (A) | Maple Ward (B) | Monument Ward (C)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed);
    // ward_code ordering: CO < MO < PC.
    expect(primary?.scope).toBe('CO');
  });

  it('returns null when nothing resolved', () => {
    const parsed = parseDescription('Random text', STAKE, WARDS);
    expect(pickPrimarySegment(parsed)).toBeNull();
  });

  it('returns the lone resolved segment when only one resolves', () => {
    const parsed = parseDescription('Maple Ward (A) | Springfield Ward (B)', STAKE, WARDS);
    expect(pickPrimarySegment(parsed)?.scope).toBe('CO');
  });

  it('prefers a ward app-access segment over a non-app-access stake segment', () => {
    // Restored app-access preference (hard-coded lists, not templates):
    // a non-app-access stake calling must not steal primary from a real
    // ward app-access match. Technology Specialist is not in the stake
    // app-access list; Bishop is a ward app-access calling.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Technology Specialist) | Maple Ward (Bishop)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed);
    expect(primary?.scope).toBe('CO');
  });

  it('still prefers the stake segment when it grants app access', () => {
    // Both segments grant app access for their scope → tie-break falls
    // back to stake-first ordering.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk) | Maple Ward (Bishop)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed);
    expect(primary?.scope).toBe('stake');
  });

  it('falls back to stake-first when no segment grants app access', () => {
    // Neither calling is in its scope's app-access list → preference is
    // inert; stake-first ordering applies.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Technology Specialist) | Maple Ward (Sunday School Teacher)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed);
    expect(primary?.scope).toBe('stake');
  });

  it('prefers the EQ President ward segment when the stake opts in', () => {
    // Elders Quorum President grants ward app access only under
    // `eqPresidentAccess`; with it on, the non-app-access stake segment
    // loses primary to the ward.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Technology Specialist) | Maple Ward (Elders Quorum President)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed, { eqPresidentAccess: true });
    expect(primary?.scope).toBe('CO');
  });

  it('leaves the EQ President ward segment inert when the stake has not opted in', () => {
    // Same description, gate off → neither segment grants app access, so
    // the preference is inert and stake-first ordering applies.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Technology Specialist) | Maple Ward (Elders Quorum President)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed, { eqPresidentAccess: false });
    expect(primary?.scope).toBe('stake');
  });

  it('keeps stake-first when the opted-in EQ President ties a stake app-access calling', () => {
    // Gate on → both segments grant app access for their scope, so the
    // existing stake-first tiebreak still wins.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk) | Maple Ward (Elders Quorum President)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed, { eqPresidentAccess: true });
    expect(primary?.scope).toBe('stake');
  });
});

// ---- Ignored wards ---------------------------------------------------
//
// `stake.kindoo_ignored_wards` names wards of a neighbouring SBA stake
// that share one of our Kindoo sites. Their segments are stripped so
// Sync never sees them.

describe('parseDescription — stake.kindoo_ignored_wards', () => {
  const IGNORING = {
    ...STAKE,
    kindoo_ignored_wards: ['Aspen Grove Ward', 'Black Forest 2nd Ward'],
  };

  it('strips a segment naming an ignored ward and counts it', () => {
    const parsed = parseDescription('Aspen Grove Ward (Bishop)', IGNORING, WARDS);
    expect(parsed.segments).toHaveLength(0);
    expect(parsed.ignoredCount).toBe(1);
    expect(isFullyIgnored(parsed)).toBe(true);
  });

  it('matches case-insensitively and tolerates surrounding whitespace', () => {
    const parsed = parseDescription('  aspen grove ward   (Bishop)', IGNORING, WARDS);
    expect(parsed.ignoredCount).toBe(1);
    expect(isFullyIgnored(parsed)).toBe(true);
  });

  it('keeps the surviving segment when only one of two is ignored', () => {
    const parsed = parseDescription(
      'Aspen Grove Ward (Bishop) | Maple Ward (Ward Clerk)',
      IGNORING,
      WARDS,
    );
    expect(parsed.ignoredCount).toBe(1);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]).toMatchObject({ scope: 'CO', calling: 'Ward Clerk' });
    expect(parsed.unparseable).toBe(false);
    expect(isFullyIgnored(parsed)).toBe(false);
  });

  it('drops every segment when the description names two ignored wards', () => {
    const parsed = parseDescription(
      'Aspen Grove Ward (Bishop) | Black Forest 2nd Ward (Ward Clerk)',
      IGNORING,
      WARDS,
    );
    expect(parsed.ignoredCount).toBe(2);
    expect(isFullyIgnored(parsed)).toBe(true);
  });

  it('never strips a segment that resolved to one of our own wards', () => {
    // An entry colliding with a ward we own (renamed after the entry was
    // added, say) is inert — the resolved segment wins.
    const collides = { ...STAKE, kindoo_ignored_wards: ['Maple Ward'] };
    const parsed = parseDescription('Maple Ward (Bishop)', collides, WARDS);
    expect(parsed.ignoredCount).toBe(0);
    expect(parsed.segments[0]).toMatchObject({ scope: 'CO', resolvedScope: true });
    expect(isFullyIgnored(parsed)).toBe(false);
  });

  it('never strips the stake segment', () => {
    const collides = { ...STAKE, kindoo_ignored_wards: ['Colorado Springs North Stake'] };
    const parsed = parseDescription('Colorado Springs North Stake (Stake Clerk)', collides, WARDS);
    expect(parsed.ignoredCount).toBe(0);
    expect(parsed.segments[0]).toMatchObject({ scope: 'stake' });
  });

  it('does not strip a longer name that merely starts with an entry', () => {
    const parsed = parseDescription('Aspen Grove Ward Annex (Bishop)', IGNORING, WARDS);
    expect(parsed.ignoredCount).toBe(0);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.unparseable).toBe(true);
  });

  it('does not strip on a calling that merely contains an entry', () => {
    const parsed = parseDescription('Maple Ward (Aspen Grove Ward Liaison)', IGNORING, WARDS);
    expect(parsed.ignoredCount).toBe(0);
    expect(parsed.segments).toHaveLength(1);
  });

  it('strips a bare no-parens segment naming an ignored ward', () => {
    const parsed = parseDescription('Aspen Grove Ward', IGNORING, WARDS);
    expect(parsed.ignoredCount).toBe(1);
    expect(isFullyIgnored(parsed)).toBe(true);
  });

  it('leaves a malformed non-parens description alone', () => {
    // Decided semantics: the match is on the segment's scope-name
    // portion, which for this shape is the whole string.
    const parsed = parseDescription('Aspen Grove Ward - Bishop', IGNORING, WARDS);
    expect(parsed.ignoredCount).toBe(0);
    expect(parsed.unparseable).toBe(true);
    expect(isFullyIgnored(parsed)).toBe(false);
  });

  it('reports ignoredCount 0 with no list configured', () => {
    const parsed = parseDescription('Aspen Grove Ward (Bishop)', STAKE, WARDS);
    expect(parsed.ignoredCount).toBe(0);
    expect(parsed.unparseable).toBe(true);
    expect(isFullyIgnored(parsed)).toBe(false);
  });

  it('separates a blank description from a fully-ignored one', () => {
    // Both leave `segments` empty; only the latter is fully ignored.
    const blank = parseDescription('', IGNORING, WARDS);
    expect(blank.segments).toHaveLength(0);
    expect(blank.ignoredCount).toBe(0);
    expect(isFullyIgnored(blank)).toBe(false);
  });
});
