// Integration tests for `notifyOnRequestWrite`. The trigger fires on
// every write to a request doc and dispatches the matching
// notification per `docs/spec.md` §9. Resend is mocked at the
// wrapper level (`lib/resend.ts`).
//
// Lifecycle transitions covered:
//   - create with status='pending' → managers get new-request email
//   - pending → complete → requester gets completed email
//   - pending → rejected → requester gets rejected email
//   - pending → cancelled → managers get cancelled email
//   - non-status update on a pending request → no email
//   - notifications_enabled=false → no email, no audit row
//   - Resend error (returned + thrown) → email_send_failed audit row

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AccessRequest, AuditLog, Stake } from '@kindoo/shared';
import { notifyOnRequestWrite } from '../src/triggers/notifyOnRequestWrite.js';
import {
  _setResendSender,
  type EmailPayload,
  type ResendSender,
  type SendResult,
} from '../src/lib/resend.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';
const REQUEST_ID = 'req-1';

type SendCall = EmailPayload;

function makeEvent(opts: {
  before: AccessRequest | null;
  after: AccessRequest | null;
  time?: string;
}): never {
  const time = opts.time ?? new Date().toISOString();
  const before = {
    exists: opts.before != null,
    data: () => opts.before ?? undefined,
  };
  const after = {
    exists: opts.after != null,
    data: () => opts.after ?? undefined,
  };
  return {
    params: { stakeId: STAKE_ID, requestId: REQUEST_ID },
    time,
    data: { before, after },
  } as unknown as never;
}

const baseRequest: AccessRequest = {
  request_id: REQUEST_ID,
  type: 'add_manual',
  scope: 'GE',
  member_email: 'Subject@gmail.com',
  member_canonical: 'subject@gmail.com',
  member_name: 'Subject Person',
  reason: 'Bishop',
  comment: '',
  building_names: ['Greenwood'],
  status: 'pending',
  requester_email: 'Bish@gmail.com',
  requester_canonical: 'bish@gmail.com',
  requested_at: Timestamp.now(),
  lastActor: { email: 'Bish@gmail.com', canonical: 'bish@gmail.com' },
};

async function seedStake(overrides: Partial<Stake> = {}): Promise<void> {
  const { db } = requireEmulators();
  const stake: Stake = {
    stake_id: STAKE_ID,
    stake_name: 'CSNorth Stake',
    created_at: Timestamp.now(),
    created_by: 'admin@example.com',
    callings_sheet_id: 'sheet-id',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
    expiry_hour: 3,
    import_day: 'SUNDAY',
    import_hour: 4,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'admin@example.com', canonical: 'admin@example.com' },
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
    ...overrides,
  };
  await db.doc(`stakes/${STAKE_ID}`).set(stake);
}

async function seedManager(canonical: string, active: boolean, email = canonical): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/kindooManagers/${canonical}`).set({
    member_canonical: canonical,
    member_email: email,
    name: canonical,
    active,
    added_at: Timestamp.now(),
    added_by: { email: 'admin@example.com', canonical: 'admin@example.com' },
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

function mockSender(
  responses: SendResult[] | ((payload: EmailPayload) => SendResult | Promise<SendResult>),
): { sender: ResendSender; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const sender: ResendSender = {
    send: async (payload) => {
      calls.push(payload);
      if (typeof responses === 'function') {
        return responses(payload);
      }
      const next = responses.shift() ?? { ok: true, id: 'mid-default' };
      return next;
    },
  };
  return { sender, calls };
}

async function readEmailFailedAudits(): Promise<AuditLog[]> {
  const { db } = requireEmulators();
  const snap = await db
    .collection(`stakes/${STAKE_ID}/auditLog`)
    .where('action', '==', 'email_send_failed')
    .get();
  return snap.docs.map((d) => d.data() as AuditLog);
}

describe.skipIf(!hasEmulators())('notifyOnRequestWrite', () => {
  let restoreSender: (() => void) | undefined;

  beforeAll(async () => {
    await clearEmulators();
    process.env['WEB_BASE_URL'] = 'https://stakebuildingaccess.org';
  });
  beforeEach(() => {
    restoreSender = undefined;
  });
  afterEach(async () => {
    if (restoreSender) restoreSender();
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
    delete process.env['WEB_BASE_URL'];
  });

  it('on create (pending) sends a new-request email to active managers', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    await seedManager('bob@gmail.com', false); // inactive — excluded
    await seedManager('carol@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.from).toContain('CSNorth Stake');
    expect(c.from).toContain('<noreply@mail.stakebuildingaccess.org>');
    expect(c.to.sort()).toEqual(['alice@gmail.com', 'carol@gmail.com']);
    expect(c.subject).toContain('New request from Bish@gmail.com');
    expect(c.text).toContain('submitted a new manual-add request');
    expect(c.text).toContain('https://stakebuildingaccess.org/manager/queue');
  });

  it('on pending → complete sends a completed email to the requester only', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-2' }]);
    restoreSender = _setResendSender(sender);

    const before: AccessRequest = { ...baseRequest, status: 'pending' };
    const after: AccessRequest = {
      ...baseRequest,
      status: 'complete',
      completer_email: 'Mgr@gmail.com',
      completer_canonical: 'mgr@gmail.com',
      completed_at: Timestamp.now(),
    };
    await notifyOnRequestWrite.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toEqual(['Bish@gmail.com']);
    expect(calls[0]!.subject).toContain('has been completed');
    expect(calls[0]!.text).toContain('Your request for manual access');
    expect(calls[0]!.text).toContain('https://stakebuildingaccess.org/my-requests');
  });

  it('R-1 race: completed email surfaces the completion_note', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-3' }]);
    restoreSender = _setResendSender(sender);

    const before: AccessRequest = { ...baseRequest, type: 'remove', status: 'pending' };
    const after: AccessRequest = {
      ...before,
      status: 'complete',
      completion_note: 'Seat already removed at completion time (no-op).',
    };
    await notifyOnRequestWrite.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('Note: Seat already removed at completion time (no-op).');
  });

  it('on pending → rejected sends a rejected email surfacing the reason', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-4' }]);
    restoreSender = _setResendSender(sender);

    const before: AccessRequest = { ...baseRequest, status: 'pending' };
    const after: AccessRequest = {
      ...baseRequest,
      status: 'rejected',
      rejection_reason: 'Already has access.',
    };
    await notifyOnRequestWrite.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toEqual(['Bish@gmail.com']);
    expect(calls[0]!.subject).toContain('Your request was rejected');
    expect(calls[0]!.text).toContain('Reason:    Already has access.');
  });

  it('on pending → cancelled sends a cancelled email to managers', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    await seedManager('carol@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-5' }]);
    restoreSender = _setResendSender(sender);

    const before: AccessRequest = { ...baseRequest, status: 'pending' };
    const after: AccessRequest = { ...baseRequest, status: 'cancelled' };
    await notifyOnRequestWrite.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.to.sort()).toEqual(['alice@gmail.com', 'carol@gmail.com']);
    expect(calls[0]!.subject).toContain('Request cancelled by Bish@gmail.com');
  });

  it('non-status update on a pending request does not send anything', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([]);
    restoreSender = _setResendSender(sender);

    const before: AccessRequest = { ...baseRequest, status: 'pending' };
    const after: AccessRequest = { ...baseRequest, status: 'pending', urgent: true };
    await notifyOnRequestWrite.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(0);
  });

  it('notifications_enabled=false short-circuits every send', async () => {
    await seedStake({ notifications_enabled: false });
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(0);
    const audits = await readEmailFailedAudits();
    expect(audits).toHaveLength(0);
  });

  it('Resend returns ok:false → writes one email_send_failed audit row, does not throw', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([
      { ok: false, error: { message: '500 server error', code: 'rate_limit_exceeded' } },
    ]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    const audits = await readEmailFailedAudits();
    expect(audits).toHaveLength(1);
    const row = audits[0]!;
    expect(row.action).toBe('email_send_failed');
    expect(row.entity_type).toBe('system');
    expect(row.actor_canonical).toBe('EmailService');
    const after = row.after as Record<string, unknown>;
    expect(after['type']).toBe('newRequest');
    expect(after['error_message']).toBe('500 server error');
    expect(after['error_code']).toBe('rate_limit_exceeded');
    expect(after['request_id']).toBe(REQUEST_ID);
  });

  it('Resend wrapper throwing surfaces the same audit row (network timeout shape)', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    // The wrapper itself catches throws and converts to {ok:false}; we
    // simulate the post-wrap shape directly.
    const { sender, calls } = mockSender([
      { ok: false, error: { message: 'network timeout', code: 'TimeoutError' } },
    ]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    const audits = await readEmailFailedAudits();
    expect(audits).toHaveLength(1);
    const after = audits[0]!.after as Record<string, unknown>;
    expect(after['error_code']).toBe('TimeoutError');
  });

  it('uses notifications_reply_to when set', async () => {
    await seedStake({ notifications_reply_to: 'clerk@example.org' });
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-rt' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.replyTo).toBe('clerk@example.org');
  });

  it('omits replyTo when notifications_reply_to is unset/blank', async () => {
    await seedStake({ notifications_reply_to: '   ' });
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-nort' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.replyTo).toBeUndefined();
  });
});
