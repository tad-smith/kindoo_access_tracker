// Unit tests for the React binding that owns the remote-apply loop.
//
// The opt-out path is the one worth pinning. Revoking consent has to
// clear BOTH levels of the mailbox: the profile-wide flag, which is what
// actually gates the phone's button, and this tab's `desktops/{siteKey}`
// doc, which is what NAMES a Kindoo site as covered. Leaving the desktop
// doc behind means the phone spends a full staleness window telling the
// manager their desktop is on "East Stake" while the button under it is
// dead.

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_APPLY_HOME_SITE_KEY } from '@kindoo/shared';
import type { StakeConfigBundle } from '../../lib/extensionApi';
import type { RemoteApplyLoopArgs, RemoteApplyLoopHandle } from './loop';

const writeRemotePresence = vi.fn(async () => undefined);
const startRemoteApplyLoop = vi.fn<(args: RemoteApplyLoopArgs) => RemoteApplyLoopHandle>();
/** Read by the mocked `useRemoteApplyEnabled`; tests flip it and then
 * re-render, which is how the real toggle reaches this hook. */
let enabled = false;

vi.mock('../../lib/extensionApi', () => ({
  writeRemotePresence: (...args: unknown[]) => writeRemotePresence(...(args as [])),
}));

vi.mock('./loop', () => ({
  startRemoteApplyLoop: (args: RemoteApplyLoopArgs) => startRemoteApplyLoop(args),
}));

vi.mock('../../lib/remoteApplyPrefs', () => ({
  useRemoteApplyEnabled: () => ({ enabled, loaded: true, setEnabled: vi.fn() }),
}));

const STAKE_ID = 'csnorth';

/** Stable identity: the hook's effect keys on `bundle`, so a fresh
 * object per render would restart the loop on every render. */
const BUNDLE: StakeConfigBundle = {
  stake: { stake_id: STAKE_ID } as unknown as StakeConfigBundle['stake'],
  buildings: [],
  wards: [],
  kindooSites: [],
};

/** Imported lazily so each test gets a module instance bound to its own
 * mocks (`vi.resetModules()` runs between tests). */
async function probeComponent() {
  const { useRemoteApply } = await import('./useRemoteApply');
  return function Probe() {
    useRemoteApply({ stakeId: STAKE_ID, bundle: BUNDLE });
    return null;
  };
}

function handle(): RemoteApplyLoopHandle {
  return { stop: vi.fn(), tick: vi.fn(async () => undefined) };
}

describe('useRemoteApply', () => {
  beforeEach(() => {
    writeRemotePresence.mockReset();
    writeRemotePresence.mockResolvedValue(undefined);
    startRemoteApplyLoop.mockReset();
    startRemoteApplyLoop.mockImplementation(() => handle());
    enabled = false;
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('clears this tab’s desktop doc, not just the flag, when the opt-in goes off', async () => {
    startRemoteApplyLoop.mockImplementation((args) => {
      args.onSitePublished?.('east-stake');
      return handle();
    });
    const Probe = await probeComponent();
    enabled = true;
    const view = render(<Probe />);
    await waitFor(() => expect(startRemoteApplyLoop).toHaveBeenCalled());

    enabled = false;
    view.rerender(<Probe />);
    await waitFor(() => expect(writeRemotePresence).toHaveBeenCalled());

    expect(writeRemotePresence).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, siteKey: 'east-stake' }),
    );
  });

  it('sends no site to clear when this tab never published one', async () => {
    // A tab whose EID mapped to no configured site publishes nothing, so
    // there is no desktop doc to delete — and naming one anyway could
    // delete a sibling tab's.
    const Probe = await probeComponent();
    enabled = true;
    const view = render(<Probe />);
    await waitFor(() => expect(startRemoteApplyLoop).toHaveBeenCalled());

    enabled = false;
    view.rerender(<Probe />);
    await waitFor(() => expect(writeRemotePresence).toHaveBeenCalled());

    expect(writeRemotePresence).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, siteKey: null }),
    );
  });

  it('clears the site this tab published last, after a mid-session site switch', async () => {
    startRemoteApplyLoop.mockImplementation((args) => {
      args.onSitePublished?.(REMOTE_APPLY_HOME_SITE_KEY);
      args.onSitePublished?.('east-stake');
      return handle();
    });
    const Probe = await probeComponent();
    enabled = true;
    const view = render(<Probe />);
    await waitFor(() => expect(startRemoteApplyLoop).toHaveBeenCalled());

    enabled = false;
    view.rerender(<Probe />);
    await waitFor(() => expect(writeRemotePresence).toHaveBeenCalled());

    expect(writeRemotePresence).toHaveBeenCalledWith(
      expect.objectContaining({ siteKey: 'east-stake' }),
    );
  });

  it('publishes nothing on a first mount that was never opted in', async () => {
    // `enabled: false` here would create a presence doc for a manager
    // who never consented.
    const Probe = await probeComponent();
    enabled = false;
    render(<Probe />);

    await waitFor(() => expect(startRemoteApplyLoop).not.toHaveBeenCalled());
    expect(writeRemotePresence).not.toHaveBeenCalled();
  });
});
