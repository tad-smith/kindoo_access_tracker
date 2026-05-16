// Component tests for the v2.1 / Phase 5 ConfigurePanel wizard. Mocks
// the extensionApi boundary (Firestore reads + batched write) and the
// Kindoo client (localStorage + multipart-form API). The wizard's
// internal state machine is what's under test, not the lower layers.
//
// Phase 5 — wizard scopes to one Kindoo site per run. The active
// Kindoo session decides which site (home or a specific foreign site);
// buildings are filtered to that site's `kindoo_site_id`. Unknown
// active site → refuse.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getStakeConfigMock = vi.fn();
const writeKindooConfigMock = vi.fn();
const readKindooSessionMock = vi.fn();
const getEnvironmentsMock = vi.fn();
const getEnvironmentRulesMock = vi.fn();

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    getStakeConfig: (...args: unknown[]) => getStakeConfigMock(...args),
    writeKindooConfig: (...args: unknown[]) => writeKindooConfigMock(...args),
  };
});

vi.mock('../content/kindoo/auth', () => ({
  readKindooSession: (...args: unknown[]) => readKindooSessionMock(...args),
}));

vi.mock('../content/kindoo/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../content/kindoo/endpoints')>(
    '../content/kindoo/endpoints',
  );
  return {
    ...actual,
    getEnvironments: (...args: unknown[]) => getEnvironmentsMock(...args),
    getEnvironmentRules: (...args: unknown[]) => getEnvironmentRulesMock(...args),
  };
});

async function renderConfigure(
  opts: {
    email?: string | null;
    onComplete?: () => void;
    onCancel?: () => void;
  } = {},
) {
  const { ConfigurePanel } = await import('./ConfigurePanel');
  return render(
    <ConfigurePanel
      email={opts.email ?? 'mgr@example.com'}
      onComplete={opts.onComplete ?? vi.fn()}
      onCancel={opts.onCancel ?? (() => undefined)}
    />,
  );
}

interface BundleOpts {
  stake_name?: string;
  kindoo_expected_site_name?: string;
  kindoo_config?: { site_id: number; site_name: string };
  buildings?: Array<{
    building_id: string;
    building_name: string;
    kindoo_rule?: { rule_id: number; rule_name: string };
    kindoo_site_id?: string | null;
  }>;
  kindooSites?: Array<{
    id: string;
    display_name: string;
    kindoo_expected_site_name: string;
    kindoo_eid?: number | null;
  }>;
}

function bundle(overrides: BundleOpts = {}) {
  const stake: Record<string, unknown> = {
    stake_id: 'csnorth',
    stake_name: overrides.stake_name ?? 'Colorado Springs North Stake',
  };
  if (overrides.kindoo_expected_site_name !== undefined) {
    stake.kindoo_expected_site_name = overrides.kindoo_expected_site_name;
  }
  if (overrides.kindoo_config !== undefined) {
    stake.kindoo_config = overrides.kindoo_config;
  }
  return {
    stake,
    buildings: overrides.buildings ?? [
      { building_id: 'cordera', building_name: 'Cordera Building' },
      { building_id: 'pine-creek', building_name: 'Pine Creek Building' },
    ],
    wards: [],
    kindooSites: overrides.kindooSites ?? [],
  };
}

describe('ConfigurePanel — common', () => {
  beforeEach(() => {
    getStakeConfigMock.mockReset();
    writeKindooConfigMock.mockReset();
    readKindooSessionMock.mockReset();
    getEnvironmentsMock.mockReset();
    getEnvironmentRulesMock.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('renders the "no Kindoo session" recovery when localStorage has no token', async () => {
    readKindooSessionMock.mockReturnValue({ ok: false, error: 'no-token' });
    await renderConfigure();
    await waitFor(() => expect(screen.getByTestId('sba-configure-no-kindoo')).toBeInTheDocument());
    expect(screen.getByText(/Sign into Kindoo first/)).toBeInTheDocument();
  });
});

describe('ConfigurePanel — active = home', () => {
  beforeEach(() => {
    getStakeConfigMock.mockReset();
    writeKindooConfigMock.mockReset();
    readKindooSessionMock.mockReset();
    getEnvironmentsMock.mockReset();
    getEnvironmentRulesMock.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('happy path: home session lands on the rules step, save writes kindooSiteId=null', async () => {
    const onComplete = vi.fn();
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(bundle());
    getEnvironmentsMock.mockResolvedValue([
      { EID: 27994, Name: 'Colorado Springs North Stake' },
      { EID: 4321, Name: 'East Stake' },
    ]);
    getEnvironmentRulesMock.mockResolvedValue([
      { RID: 6248, Name: 'Cordera Doors' },
      { RID: 6249, Name: 'Pine Creek Doors' },
    ]);
    writeKindooConfigMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    await renderConfigure({ onComplete });

    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());
    // Header reflects the active site.
    expect(screen.getByText('Configuring: Colorado Springs North Stake')).toBeInTheDocument();

    expect(screen.getByTestId('sba-configure-save')).toBeDisabled();

    await user.selectOptions(screen.getByTestId('sba-configure-rule-cordera'), '6248');
    await user.selectOptions(screen.getByTestId('sba-configure-rule-pine-creek'), '6249');
    expect(screen.getByTestId('sba-configure-save')).toBeEnabled();

    await user.click(screen.getByTestId('sba-configure-save'));

    await waitFor(() => expect(writeKindooConfigMock).toHaveBeenCalledTimes(1));
    expect(writeKindooConfigMock).toHaveBeenCalledWith({
      kindooSiteId: null,
      siteId: 27994,
      siteName: 'Colorado Springs North Stake',
      buildingRules: [
        { buildingId: 'cordera', ruleId: 6248, ruleName: 'Cordera Doors' },
        { buildingId: 'pine-creek', ruleId: 6249, ruleName: 'Pine Creek Doors' },
      ],
    });
    expect(onComplete).toHaveBeenCalled();
  });

  it('matches the home site by name when kindoo_config is not yet set (first run)', async () => {
    // No kindoo_config on stake — first-run path. EID is captured fresh
    // from the session; the resolver matches by name.
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({ buildings: [{ building_id: 'cordera', building_name: 'Cordera Building' }] }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 27994, Name: 'Colorado Springs North Stake' }]);
    getEnvironmentRulesMock.mockResolvedValue([{ RID: 6248, Name: 'Cordera Doors' }]);

    await renderConfigure();
    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());
    expect(screen.getByText('Configuring: Colorado Springs North Stake')).toBeInTheDocument();
  });

  it('filters out foreign-site buildings from the home wizard', async () => {
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({
        kindoo_config: { site_id: 27994, site_name: 'Colorado Springs North Stake' },
        buildings: [
          { building_id: 'cordera', building_name: 'Cordera Building' }, // home
          { building_id: 'pine-creek', building_name: 'Pine Creek Building', kindoo_site_id: null }, // home
          {
            building_id: 'foothills',
            building_name: 'Foothills Building',
            kindoo_site_id: 'east-stake',
          },
        ],
        kindooSites: [
          {
            id: 'east-stake',
            display_name: 'East Stake (Foothills Building)',
            kindoo_expected_site_name: 'East Stake',
            kindoo_eid: 4321,
          },
        ],
      }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 27994, Name: 'Colorado Springs North Stake' }]);
    getEnvironmentRulesMock.mockResolvedValue([
      { RID: 6248, Name: 'Cordera Doors' },
      { RID: 6249, Name: 'Pine Creek Doors' },
    ]);

    await renderConfigure();
    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());

    expect(screen.getByTestId('sba-configure-rule-cordera')).toBeInTheDocument();
    expect(screen.getByTestId('sba-configure-rule-pine-creek')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-configure-rule-foothills')).toBeNull();
  });

  it('uses kindoo_expected_site_name override in the header', async () => {
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({
        stake_name: 'STAGING - Colorado Springs North Stake',
        kindoo_expected_site_name: 'Colorado Springs North Stake',
        kindoo_config: { site_id: 27994, site_name: 'Colorado Springs North Stake' },
        buildings: [{ building_id: 'cordera', building_name: 'Cordera Building' }],
      }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 27994, Name: 'Colorado Springs North Stake' }]);
    getEnvironmentRulesMock.mockResolvedValue([{ RID: 6248, Name: 'Cordera Doors' }]);

    await renderConfigure();
    await waitFor(() =>
      expect(screen.getByText('Configuring: Colorado Springs North Stake')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Configuring: STAGING - Colorado Springs North Stake')).toBeNull();
  });
});

describe('ConfigurePanel — active = foreign', () => {
  beforeEach(() => {
    getStakeConfigMock.mockReset();
    writeKindooConfigMock.mockReset();
    readKindooSessionMock.mockReset();
    getEnvironmentsMock.mockReset();
    getEnvironmentRulesMock.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('renders only foreign-site buildings, header shows the foreign display name, save writes kindooSiteId', async () => {
    const onComplete = vi.fn();
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 4321 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({
        kindoo_config: { site_id: 27994, site_name: 'Colorado Springs North Stake' },
        buildings: [
          { building_id: 'cordera', building_name: 'Cordera Building' }, // home
          {
            building_id: 'foothills',
            building_name: 'Foothills Building',
            kindoo_site_id: 'east-stake',
          },
        ],
        kindooSites: [
          {
            id: 'east-stake',
            display_name: 'East Stake (Foothills Building)',
            kindoo_expected_site_name: 'East Stake',
            kindoo_eid: 4321,
          },
        ],
      }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 4321, Name: 'East Stake' }]);
    getEnvironmentRulesMock.mockResolvedValue([{ RID: 8001, Name: 'Foothills Doors' }]);
    writeKindooConfigMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    await renderConfigure({ onComplete });

    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());
    expect(screen.getByText('Configuring: East Stake (Foothills Building)')).toBeInTheDocument();

    // Home building filtered out; foreign building present.
    expect(screen.queryByTestId('sba-configure-rule-cordera')).toBeNull();
    expect(screen.getByTestId('sba-configure-rule-foothills')).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('sba-configure-rule-foothills'), '8001');
    await user.click(screen.getByTestId('sba-configure-save'));

    await waitFor(() => expect(writeKindooConfigMock).toHaveBeenCalledTimes(1));
    expect(writeKindooConfigMock).toHaveBeenCalledWith({
      kindooSiteId: 'east-stake',
      siteId: 4321,
      siteName: 'East Stake',
      buildingRules: [{ buildingId: 'foothills', ruleId: 8001, ruleName: 'Foothills Doors' }],
    });
    expect(onComplete).toHaveBeenCalled();
  });

  it('auto-populates kindoo_eid via name match when the foreign site doc has no EID yet', async () => {
    // The foreign KindooSite doc has no kindoo_eid — the resolver
    // matches by `kindoo_expected_site_name` and the save payload
    // carries the active session's EID so the SW backfills the doc.
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 4321 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({
        kindoo_config: { site_id: 27994, site_name: 'Colorado Springs North Stake' },
        buildings: [
          {
            building_id: 'foothills',
            building_name: 'Foothills Building',
            kindoo_site_id: 'east-stake',
          },
        ],
        kindooSites: [
          {
            id: 'east-stake',
            display_name: 'East Stake (Foothills Building)',
            kindoo_expected_site_name: 'East Stake',
            // kindoo_eid omitted — first-encounter path
          },
        ],
      }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 4321, Name: 'East Stake' }]);
    getEnvironmentRulesMock.mockResolvedValue([{ RID: 8001, Name: 'Foothills Doors' }]);
    writeKindooConfigMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    await renderConfigure();

    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());
    expect(screen.getByText('Configuring: East Stake (Foothills Building)')).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('sba-configure-rule-foothills'), '8001');
    await user.click(screen.getByTestId('sba-configure-save'));

    await waitFor(() => expect(writeKindooConfigMock).toHaveBeenCalledTimes(1));
    expect(writeKindooConfigMock).toHaveBeenCalledWith({
      kindooSiteId: 'east-stake',
      siteId: 4321,
      siteName: 'East Stake',
      buildingRules: [{ buildingId: 'foothills', ruleId: 8001, ruleName: 'Foothills Doors' }],
    });
  });
});

describe('ConfigurePanel — unknown site', () => {
  beforeEach(() => {
    getStakeConfigMock.mockReset();
    writeKindooConfigMock.mockReset();
    readKindooSessionMock.mockReset();
    getEnvironmentsMock.mockReset();
    getEnvironmentRulesMock.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('refuses with a clear message when the active site is not configured in SBA', async () => {
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 9999 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({
        kindoo_config: { site_id: 27994, site_name: 'Colorado Springs North Stake' },
      }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 9999, Name: 'Some Other Stake' }]);

    await renderConfigure();
    await waitFor(() =>
      expect(screen.getByTestId('sba-configure-unknown-site')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Some Other Stake/)).toBeInTheDocument();
    expect(screen.getByText(/isn.t configured in SBA/)).toBeInTheDocument();
    // No rules are fetched in this state.
    expect(getEnvironmentRulesMock).not.toHaveBeenCalled();
  });
});

describe('ConfigurePanel — reconfigure prefill + save error', () => {
  beforeEach(() => {
    getStakeConfigMock.mockReset();
    writeKindooConfigMock.mockReset();
    readKindooSessionMock.mockReset();
    getEnvironmentsMock.mockReset();
    getEnvironmentRulesMock.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('reconfigure pre-fills existing kindoo_rule selections on the home site', async () => {
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({
        kindoo_config: { site_id: 27994, site_name: 'Colorado Springs North Stake' },
        buildings: [
          {
            building_id: 'cordera',
            building_name: 'Cordera Building',
            kindoo_rule: { rule_id: 6248, rule_name: 'Cordera Doors' },
          },
          { building_id: 'pine-creek', building_name: 'Pine Creek Building' },
        ],
      }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 27994, Name: 'Colorado Springs North Stake' }]);
    getEnvironmentRulesMock.mockResolvedValue([
      { RID: 6248, Name: 'Cordera Doors' },
      { RID: 6249, Name: 'Pine Creek Doors' },
    ]);

    await renderConfigure();

    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());

    const corderaSelect = screen.getByTestId('sba-configure-rule-cordera') as HTMLSelectElement;
    expect(corderaSelect.value).toBe('6248');
    const pineSelect = screen.getByTestId('sba-configure-rule-pine-creek') as HTMLSelectElement;
    expect(pineSelect.value).toBe('');
    // Pine still missing → Save remains disabled.
    expect(screen.getByTestId('sba-configure-save')).toBeDisabled();
  });

  it('renders the save error inline and leaves the form usable on writeKindooConfig failure', async () => {
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({
        kindoo_config: { site_id: 27994, site_name: 'Colorado Springs North Stake' },
        buildings: [{ building_id: 'cordera', building_name: 'Cordera Building' }],
      }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 27994, Name: 'Colorado Springs North Stake' }]);
    getEnvironmentRulesMock.mockResolvedValue([{ RID: 6248, Name: 'Cordera Doors' }]);
    writeKindooConfigMock.mockRejectedValue(new Error('permission-denied: not a manager'));

    const onComplete = vi.fn();
    const user = userEvent.setup();
    await renderConfigure({ onComplete });

    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('sba-configure-rule-cordera'), '6248');
    await user.click(screen.getByTestId('sba-configure-save'));

    await waitFor(() => expect(screen.getByTestId('sba-configure-save-error')).toBeInTheDocument());
    expect(onComplete).not.toHaveBeenCalled();
    // Form still rendered.
    expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument();
  });
});
