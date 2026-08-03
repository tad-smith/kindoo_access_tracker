// Unit tests for the remote-apply runner — request resolution plus the
// outcome → job-doc serialisation the phone renders.
//
// Every `RemoteApplyOutcomeCode` is covered here because the phone
// branches on `code` and shows `message` verbatim: a wrong mapping is
// invisible on the desktop and misleading on the phone.

import { describe, expect, it, vi } from 'vitest';
import type { AccessRequest } from '@kindoo/shared';
import type { RemoteApplyJobRef, StakeConfigBundle } from '../../lib/extensionApi';
import type { ApplyRequestResult } from '../kindoo/applyRequest';
import { runRemoteApplyJob, toJobResult } from './runner';

const STAKE_ID = 'csnorth';

function bundle(): StakeConfigBundle {
  return {
    stake: { stake_id: STAKE_ID, stake_name: 'CS North' } as unknown as StakeConfigBundle['stake'],
    buildings: [],
    wards: [],
    kindooSites: [],
  };
}

function job(overrides: Partial<RemoteApplyJobRef> = {}): RemoteApplyJobRef {
  return { jobId: 'j1', requestId: 'r1', stakeId: STAKE_ID, ...overrides };
}

function request(): AccessRequest {
  return { request_id: 'r1', type: 'add_manual', scope: 'stake' } as unknown as AccessRequest;
}

/** Runner with both external calls stubbed. */
function deps(opts: {
  pending?: AccessRequest[];
  pendingError?: Error;
  apply?: ApplyRequestResult;
  applyError?: Error;
}) {
  const getMyPendingRequestsMock = vi.fn(async () => {
    if (opts.pendingError) throw opts.pendingError;
    return { requests: opts.pending ?? [request()] };
  });
  const applyRequestMock = vi.fn(async () => {
    if (opts.applyError) throw opts.applyError;
    return opts.apply ?? ({ status: 'failed', code: 'error', message: 'unset' } as const);
  });
  return {
    mocks: { getMyPendingRequestsMock, applyRequestMock },
    deps: {
      getMyPendingRequests: getMyPendingRequestsMock,
      applyRequest: applyRequestMock,
    } as never,
  };
}

describe('toJobResult — outcome serialisation', () => {
  it('maps an applied outcome onto status "applied" with the note as the message', () => {
    const result = toJobResult({
      status: 'applied',
      note: 'Added Test User to Kindoo with access to Maple Building.',
      kindooUid: 'uid-1',
      overCaps: [],
    });
    expect(result.status).toBe('applied');
    expect(result.outcome).toEqual({
      code: 'applied',
      message: 'Added Test User to Kindoo with access to Maple Building.',
      kindoo_uid: 'uid-1',
      provisioning_note: 'Added Test User to Kindoo with access to Maple Building.',
    });
  });

  it('omits kindoo_uid entirely on the no-op remove path (Firestore rejects undefined)', () => {
    const result = toJobResult({
      status: 'applied',
      note: 'Test User was not in Kindoo (no-op).',
      kindooUid: null,
      overCaps: [],
    });
    expect(result.outcome).not.toHaveProperty('kindoo_uid');
  });

  it('maps Kindoo-done / SBA-failed onto "partial" with code sba_incomplete', () => {
    // The critical mapping: access HAS changed in Kindoo. Reporting
    // this as `failed` would send the manager to re-apply something
    // that already happened.
    const result = toJobResult({
      status: 'partial',
      note: 'Added Test User to Kindoo.',
      kindooUid: 'uid-1',
      message: 'SBA is down.',
      markCompleteInput: {
        stakeId: STAKE_ID,
        requestId: 'r1',
        completionNote: 'n',
        provisioningNote: 'n',
      },
    });
    expect(result.status).toBe('partial');
    expect(result.outcome.code).toBe('sba_incomplete');
    expect(result.outcome.message).toContain('Applied in Kindoo');
    expect(result.outcome.message).toContain('SBA is down.');
    expect(result.outcome.message).toContain('Finish it on your desktop.');
    expect(result.outcome.kindoo_uid).toBe('uid-1');
    expect(result.outcome.provisioning_note).toBe('Added Test User to Kindoo.');
  });

  it.each([
    [
      'site_mismatch',
      "This request needs to be provisioned on 'East Stake'. You are currently in 'CS North'. Switch Kindoo sites and try again.",
    ],
    ['kindoo_session_lost', 'Sign into Kindoo first, then retry.'],
    ['building_rule_missing', 'Buildings have no Kindoo Access Rule mapped: Maple Building.'],
    ['error', 'Kindoo API error (http-error): boom'],
  ] as const)('passes a %s failure through verbatim', (code, message) => {
    const result = toJobResult({ status: 'failed', code, message });
    expect(result).toEqual({ status: 'failed', outcome: { code, message } });
  });
});

describe('runRemoteApplyJob', () => {
  it('resolves the request from the live queue and applies it', async () => {
    const applied: ApplyRequestResult = {
      status: 'applied',
      note: 'Added.',
      kindooUid: 'uid-1',
      overCaps: [],
    };
    const { mocks, deps: d } = deps({ apply: applied });

    const result = await runRemoteApplyJob({
      stakeId: STAKE_ID,
      bundle: bundle(),
      job: job(),
      deps: d,
    });

    expect(mocks.getMyPendingRequestsMock).toHaveBeenCalledWith({ stakeId: STAKE_ID });
    expect(mocks.applyRequestMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('applied');
  });

  it('refuses when the request is no longer pending', async () => {
    // The phone's snapshot can be minutes stale; the desktop is the one
    // that re-checks.
    const { mocks, deps: d } = deps({ pending: [] });

    const result = await runRemoteApplyJob({
      stakeId: STAKE_ID,
      bundle: bundle(),
      job: job(),
      deps: d,
    });

    expect(result.status).toBe('failed');
    expect(result.outcome.code).toBe('request_not_pending');
    expect(result.outcome.message).toMatch(/no longer pending/);
    expect(mocks.applyRequestMock).not.toHaveBeenCalled();
  });

  it('reports a queue-read failure as a terminal error rather than hanging the job', async () => {
    const { deps: d } = deps({ pendingError: new Error('permission-denied') });

    const result = await runRemoteApplyJob({
      stakeId: STAKE_ID,
      bundle: bundle(),
      job: job(),
      deps: d,
    });

    expect(result.status).toBe('failed');
    expect(result.outcome.code).toBe('error');
    expect(result.outcome.message).toContain('permission-denied');
  });

  it('terminates the job even if applyRequest throws unexpectedly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps: d } = deps({ applyError: new Error('unexpected') });

    const result = await runRemoteApplyJob({
      stakeId: STAKE_ID,
      bundle: bundle(),
      job: job(),
      deps: d,
    });

    expect(result).toEqual({
      status: 'failed',
      outcome: { code: 'error', message: 'unexpected' },
    });
  });
});
