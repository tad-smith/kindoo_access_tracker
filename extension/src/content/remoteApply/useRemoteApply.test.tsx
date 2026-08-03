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

function makeBundle(): StakeConfigBundle {
  return {
    stake: { stake_id: STAKE_ID } as unknown as StakeConfigBundle['stake'],
    buildings: [],
    wards: [],
    kindooSites: [],
  };
}

const BUNDLE: StakeConfigBundle = makeBundle();

/** Imported lazily so each test gets a module instance bound to its own
 * mocks (`vi.resetModules()` runs between tests). */
async function probeComponent() {
  const { useRemoteApply } = await import('./useRemoteApply');
  return function Probe({ bundle = BUNDLE }: { bundle?: StakeConfigBundle }) {
    useRemoteApply({ stakeId: STAKE_ID, bundle });
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

  // The silent-failure guard. `TabbedShell` hosts this hook alongside
  // the lifted queue fetch, so it re-renders on every refetch. If the
  // loop keyed on `bundle` identity, a host that rebuilt the object per
  // render would restart the loop faster than its first (0ms) tick can
  // land — `drive()` bails on `stopped`, `lastHeartbeatAt` resets to 0
  // each construction, and the heartbeat never publishes. No error is
  // logged; the phone simply never sees a desktop. Passing a fresh
  // bundle here is the only shape that catches it.
  it('keeps one loop running when the host re-renders with a fresh bundle object', async () => {
    const Probe = await probeComponent();
    enabled = true;
    const view = render(<Probe bundle={makeBundle()} />);
    await waitFor(() => expect(startRemoteApplyLoop).toHaveBeenCalledTimes(1));
    const stop = startRemoteApplyLoop.mock.results[0]?.value as RemoteApplyLoopHandle;

    view.rerender(<Probe bundle={makeBundle()} />);
    view.rerender(<Probe bundle={makeBundle()} />);

    expect(startRemoteApplyLoop).toHaveBeenCalledTimes(1);
    expect(stop.stop).not.toHaveBeenCalled();
  });

  it('serves the latest bundle to a tick that runs after a reconfigure', async () => {
    // The flip side of not restarting: the loop must not be pinned to
    // the bundle it was constructed with, or a mid-session reconfigure
    // would provision against stale building / site config.
    const Probe = await probeComponent();
    enabled = true;
    const first = makeBundle();
    const view = render(<Probe bundle={first} />);
    await waitFor(() => expect(startRemoteApplyLoop).toHaveBeenCalledTimes(1));
    const args = startRemoteApplyLoop.mock.calls[0]?.[0] as RemoteApplyLoopArgs;
    expect(args.bundle).toBe(first);

    const next = makeBundle();
    view.rerender(<Probe bundle={next} />);
    expect(args.bundle).toBe(next);
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
