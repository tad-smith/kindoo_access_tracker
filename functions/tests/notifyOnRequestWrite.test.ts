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
import type { AccessRequest, AuditLog, Stake, Ward } from '@kindoo/shared';
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
    stake_name: 'CSNorth Stake',
    created_at: Timestamp.now(),
    created_by: 'admin@example.com',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
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

// Emails render the ward NAME. Seeding is per-test so the unseeded
// fallback (raw code) stays covered too.
async function seedWard(wardCode: string, wardName: string): Promise<void> {
  const { db } = requireEmulators();
  const ward: Ward = {
    ward_code: wardCode,
    ward_name: wardName,
    building_name: 'Greenwood',
    seat_cap: 20,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  };
  await db.doc(`stakes/${STAKE_ID}/wards/${wardCode}`).set(ward);
}

async function seedManager(
  canonical: string,
  active: boolean,
  email = canonical,
  name = canonical,
): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/kindooManagers/${canonical}`).set({
    member_canonical: canonical,
    member_email: email,
    name,
    active,
    added_at: Timestamp.now(),
    added_by: { email: 'admin@example.com', canonical: 'admin@example.com' },
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

// Seed the requester's `access` doc so the manager-bound emails render
// `{Name} ({Calling})` derived live for the request's scope (GE).
async function seedRequesterAccess(): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/access/${baseRequest.requester_canonical}`).set({
    member_canonical: baseRequest.requester_canonical,
    member_email: baseRequest.requester_email,
    member_name: 'John Smith',
    importer_callings: { GE: ['Bishop'] },
    manual_grants: {},
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'admin@example.com', canonical: 'admin@example.com' },
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
  // Scope to THIS test's request. Under the CI integration config sibling
  // files write real request docs to `stakes/csnorth/requests/*`, each of
  // which fires the DEPLOYED `notifyOnRequestWrite` trigger; with no
  // Resend key in the emulator that trigger writes its own
  // `email_send_failed` row. Those rows carry a different `request_id`, so
  // filtering on ours keeps the count immune to cross-file leftovers.
  return snap.docs
    .map((d) => d.data() as AuditLog)
    .filter((row) => (row.after as Record<string, unknown> | null)?.['request_id'] === REQUEST_ID);
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

  it('on create (pending) sends a new-request email naming the requester by name + calling', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    await seedRequesterAccess();
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
    expect(c.subject).toContain('New request from John Smith (Bishop) — Greenwood Ward');
    expect(c.text).toContain('John Smith (Bishop) submitted a new manual-add request');
    expect(c.text).toContain('Ward:      Greenwood Ward');
    expect(c.text).toContain('Request:   Manual access');
    expect(c.text).toContain('https://stakebuildingaccess.org/manager/queue');
    // Both parts ship, and the HTML says the same thing.
    expect(c.html).toContain('John Smith (Bishop) submitted a new manual-add request');
    expect(c.html).toContain('>Greenwood Ward</td>');
    expect(c.html).toContain('>Manual access</td>');
    expect(c.html).toContain('>Review the queue</a>');
  });

  // The raw code is the fallback when the wards collection has no match.
  it('falls back to the raw scope code when the ward is not seeded', async () => {
    await seedStake();
    await seedRequesterAccess();
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1-noward' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls[0]!.subject).toContain('New request from John Smith (Bishop) — GE');
    expect(calls[0]!.text).toContain('Ward:      GE');
    expect(calls[0]!.html).toContain('>GE</td>');
  });

  it('renders a stake-scoped request as Scope: Stake', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1-stake' }]);
    restoreSender = _setResendSender(sender);

    const req: AccessRequest = { ...baseRequest, scope: 'stake' };
    await notifyOnRequestWrite.run(makeEvent({ before: null, after: req }));

    expect(calls[0]!.subject).toContain('— Stake');
    expect(calls[0]!.text).toContain('Scope:     Stake');
    expect(calls[0]!.html).toContain('>Scope</th>');
    expect(calls[0]!.html).toContain('>Stake</td>');
  });

  // The resolved unit name is the only unit-type discriminator, so the
  // row label has to come off the wards read, not off `req.scope`.
  it('renders a branch-scoped request as Branch, not Ward', async () => {
    await seedStake();
    await seedWard('LB', 'Peterson Branch');
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1-branch' }]);
    restoreSender = _setResendSender(sender);

    const req: AccessRequest = { ...baseRequest, scope: 'LB' };
    await notifyOnRequestWrite.run(makeEvent({ before: null, after: req }));

    expect(calls[0]!.text).toContain('Branch:    Peterson Branch');
    expect(calls[0]!.text).not.toContain('Ward:');
    expect(calls[0]!.html).toContain('>Branch</th>');
    expect(calls[0]!.html).toContain('>Peterson Branch</td>');
  });

  it('on create (pending) falls back to the raw email when no requester access doc exists', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1b' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain('New request from Bish@gmail.com — Greenwood Ward');
    expect(calls[0]!.text).toContain('Bish@gmail.com submitted a new manual-add request');
  });

  // A Kindoo Manager may submit in any scope without an `access` row, so
  // the label falls back to their `kindooManagers` doc.
  it('names a manager-submitted request "{Name} (Kindoo Manager)" when the requester has no access doc', async () => {
    await seedStake();
    await seedManager(
      baseRequest.requester_canonical,
      true,
      baseRequest.requester_email,
      'Manager Mary',
    );
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1c' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain('New request from Manager Mary (Kindoo Manager) — GE');
    expect(calls[0]!.text).toContain(
      'Manager Mary (Kindoo Manager) submitted a new manual-add request',
    );
  });

  // Access doc wins on both fields when it carries a calling for the scope.
  it('prefers the access-derived calling over "Kindoo Manager" for a manager who also holds access', async () => {
    await seedStake();
    await seedRequesterAccess();
    await seedManager(
      baseRequest.requester_canonical,
      true,
      baseRequest.requester_email,
      'Manager Mary',
    );
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1d' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain('New request from John Smith (Bishop) — GE');
  });

  // An inactive manager doc contributes nothing — same output as before
  // the fallback existed.
  it("falls back to the raw email when the requester's manager doc is inactive", async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    await seedManager(
      baseRequest.requester_canonical,
      false,
      baseRequest.requester_email,
      'Manager Mary',
    );
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1e' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain('New request from Bish@gmail.com — GE');
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
    expect(calls[0]!.subject).toBe(
      '[Stake Building Access] Your request for Subject Person has been completed',
    );
    expect(calls[0]!.text).toContain('Your manual access request for Subject Person');
    expect(calls[0]!.text).toContain('https://stakebuildingaccess.org/my-requests');
    expect(calls[0]!.html).toContain('>View your requests</a>');
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
    expect(calls[0]!.text).toContain(
      'Note from the manager: Seat already removed at completion time (no-op).',
    );
    expect(calls[0]!.html).toContain('>Note from the manager</th>');
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
    expect(calls[0]!.subject).toBe(
      '[Stake Building Access] Your request for Subject Person was rejected',
    );
    expect(calls[0]!.text).toContain('Reason given: Already has access.');
    expect(calls[0]!.html).toContain(
      'was <span style="color:#9b2c1c;font-weight:600">rejected</span>.',
    );
  });

  it('on pending → cancelled sends a cancelled email naming the requester by name + calling', async () => {
    await seedStake();
    await seedRequesterAccess();
    await seedManager('alice@gmail.com', true);
    await seedManager('carol@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-5' }]);
    restoreSender = _setResendSender(sender);

    const before: AccessRequest = { ...baseRequest, status: 'pending' };
    const after: AccessRequest = { ...baseRequest, status: 'cancelled' };
    await notifyOnRequestWrite.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.to.sort()).toEqual(['alice@gmail.com', 'carol@gmail.com']);
    expect(calls[0]!.subject).toContain('Request cancelled by John Smith (Bishop) — GE');
    expect(calls[0]!.text).toContain('John Smith (Bishop) cancelled their manual access request');
    expect(calls[0]!.html).toContain('John Smith (Bishop) cancelled their manual access request');
    expect(calls[0]!.html).toContain('>Open the queue</a>');
  });

  // Same `kindooManagers` backstop as the new-request path, pinned at the
  // cancelled call site: a manager who cancels an any-scope request they
  // submitted has no `access` row for that scope.
  it('names a cancelled manager-submitted request "{Name} (Kindoo Manager)" when the requester has no access doc', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    await seedManager(
      baseRequest.requester_canonical,
      true,
      baseRequest.requester_email,
      'Manager Mary',
    );
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-5b' }]);
    restoreSender = _setResendSender(sender);

    const before: AccessRequest = { ...baseRequest, status: 'pending' };
    const after: AccessRequest = { ...baseRequest, status: 'cancelled' };
    await notifyOnRequestWrite.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain('Request cancelled by Manager Mary (Kindoo Manager)');
    expect(calls[0]!.text).toContain(
      'Manager Mary (Kindoo Manager) cancelled their manual access request',
    );
  });

  it('on pending → cancelled falls back to the raw email when neither an access nor a manager doc names the requester', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-5c' }]);
    restoreSender = _setResendSender(sender);

    const before: AccessRequest = { ...baseRequest, status: 'pending' };
    const after: AccessRequest = { ...baseRequest, status: 'cancelled' };
    await notifyOnRequestWrite.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain('Request cancelled by Bish@gmail.com');
    expect(calls[0]!.text).toContain('Bish@gmail.com cancelled their manual access request');
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

  // The override is stake-wide, not welcome-email-specific: every email
  // this stake sends links the override host.
  it('web_base_url_override rewrites the link in the request emails too', async () => {
    await seedStake({ web_base_url_override: 'https://kindoo.csnorth.org/' });
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-override' }]);
    restoreSender = _setResendSender(sender);

    await notifyOnRequestWrite.run(makeEvent({ before: null, after: baseRequest }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('Review the queue: https://kindoo.csnorth.org/manager/queue');
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
