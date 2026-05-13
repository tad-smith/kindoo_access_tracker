// Component tests for the v2.1 ConfigurePanel wizard. Mocks the
// extensionApi boundary (Firestore reads + batched write) and the
// Kindoo client (localStorage + multipart-form API). The wizard's
// internal state machine is what's under test, not the lower layers.

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

function bundle(
  overrides: {
    stake_name?: string;
    buildings?: Array<{
      building_id: string;
      building_name: string;
      kindoo_rule?: { rule_id: number; rule_name: string };
    }>;
  } = {},
) {
  return {
    stake: {
      stake_id: 'csnorth',
      stake_name: overrides.stake_name ?? 'Colorado Springs North Stake',
    },
    buildings: overrides.buildings ?? [
      { building_id: 'cordera', building_name: 'Cordera Building' },
      { building_id: 'pine-creek', building_name: 'Pine Creek Building' },
    ],
  };
}

describe('ConfigurePanel', () => {
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

  it('shows the mismatch error and disables Continue when site names differ', async () => {
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(bundle({ stake_name: 'Colorado Springs North Stake' }));
    getEnvironmentsMock.mockResolvedValue([{ EID: 27994, Name: 'Wrong Stake' }]);

    await renderConfigure();
    await waitFor(() => expect(screen.getByTestId('sba-configure-mismatch')).toBeInTheDocument());
    expect(screen.getByTestId('sba-configure-continue')).toBeDisabled();
  });

  it('happy path: matches, advances to rules step, all rules assigned, save calls writeKindooConfig', async () => {
    const onComplete = vi.fn();
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(bundle());
    getEnvironmentsMock.mockResolvedValue([
      { EID: 27994, Name: 'Colorado Springs North Stake' },
      { EID: 99999, Name: 'Some Other Site' },
    ]);
    getEnvironmentRulesMock.mockResolvedValue([
      { RID: 6248, Name: 'Cordera Doors' },
      { RID: 6249, Name: 'Pine Creek Doors' },
    ]);
    writeKindooConfigMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    await renderConfigure({ onComplete });

    await waitFor(() => expect(screen.getByTestId('sba-configure-match')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-configure-continue'));

    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());

    // Save disabled until every building has a rule.
    expect(screen.getByTestId('sba-configure-save')).toBeDisabled();

    await user.selectOptions(screen.getByTestId('sba-configure-rule-cordera'), '6248');
    expect(screen.getByTestId('sba-configure-save')).toBeDisabled();
    await user.selectOptions(screen.getByTestId('sba-configure-rule-pine-creek'), '6249');
    expect(screen.getByTestId('sba-configure-save')).toBeEnabled();

    await user.click(screen.getByTestId('sba-configure-save'));

    await waitFor(() => expect(writeKindooConfigMock).toHaveBeenCalledTimes(1));
    expect(writeKindooConfigMock).toHaveBeenCalledWith({
      siteId: 27994,
      siteName: 'Colorado Springs North Stake',
      buildingRules: [
        { buildingId: 'cordera', ruleId: 6248, ruleName: 'Cordera Doors' },
        { buildingId: 'pine-creek', ruleId: 6249, ruleName: 'Pine Creek Doors' },
      ],
    });
    expect(onComplete).toHaveBeenCalled();
  });

  it('reconfigure pre-fills existing kindoo_rule selections', async () => {
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'tok', eid: 27994 },
    });
    getStakeConfigMock.mockResolvedValue(
      bundle({
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

    const user = userEvent.setup();
    await renderConfigure();

    await waitFor(() => expect(screen.getByTestId('sba-configure-match')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-configure-continue'));

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
        buildings: [{ building_id: 'cordera', building_name: 'Cordera Building' }],
      }),
    );
    getEnvironmentsMock.mockResolvedValue([{ EID: 27994, Name: 'Colorado Springs North Stake' }]);
    getEnvironmentRulesMock.mockResolvedValue([{ RID: 6248, Name: 'Cordera Doors' }]);
    writeKindooConfigMock.mockRejectedValue(new Error('permission-denied: not a manager'));

    const onComplete = vi.fn();
    const user = userEvent.setup();
    await renderConfigure({ onComplete });

    await waitFor(() => expect(screen.getByTestId('sba-configure-match')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-configure-continue'));
    await waitFor(() => expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('sba-configure-rule-cordera'), '6248');
    await user.click(screen.getByTestId('sba-configure-save'));

    await waitFor(() => expect(screen.getByTestId('sba-configure-save-error')).toBeInTheDocument());
    expect(onComplete).not.toHaveBeenCalled();
    // Form still rendered.
    expect(screen.getByTestId('sba-configure-rules')).toBeInTheDocument();
  });
});
