// Integration tests for `notifyOnAccessGranted`. The trigger fires on
// every write to an access doc and welcomes the member on the
// no-scopes → some-scopes transition. Resend is mocked at the wrapper
// level (`lib/resend.ts`).
//
// Transitions covered:
//   - create with importer_callings / manual_grants → welcome email
//   - scope ADDED to an existing holder             → silent
//   - non-scope update (name change)                → silent
//   - revoke to zero scopes                         → silent
//   - re-grant after a full revoke                  → fires again
//   - delete                                        → silent
//   - notifications_enabled=false                   → no email, no audit row
//
// A private stake id keeps the `email_send_failed` reads immune to the
// audit rows sibling files fan into the shared `csnorth` stake (see
// `tests/lib/emulator.ts`).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AuditLog, Stake, Ward } from '@kindoo/shared';
import { notifyOnAccessGranted } from '../src/triggers/notifyOnAccessGranted.js';
import {
  _setResendSender,
  type EmailPayload,
  type ResendSender,
  type SendResult,
} from '../src/lib/resend.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'welcome-email-suite';
const MEMBER_CANONICAL = 'jane@gmail.com';

const ACTOR = { email: 'admin@example.com', canonical: 'admin@example.com' };

type AccessDoc = Record<string, unknown>;

function makeEvent(opts: {
  before: AccessDoc | null;
  after: AccessDoc | null;
  memberCanonical?: string;
}): never {
  const before = { exists: opts.before != null, data: () => opts.before ?? undefined };
  const after = { exists: opts.after != null, data: () => opts.after ?? undefined };
  return {
    params: { stakeId: STAKE_ID, memberCanonical: opts.memberCanonical ?? MEMBER_CANONICAL },
    time: new Date().toISOString(),
    data: { before, after },
  } as unknown as never;
}

/** Access doc body. `importer_callings` / `manual_grants` per-test. */
function accessDoc(overrides: AccessDoc = {}): AccessDoc {
  return {
    member_canonical: MEMBER_CANONICAL,
    member_email: 'Jane@Gmail.com',
    member_name: 'Jane Doe',
    importer_callings: {},
    manual_grants: {},
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: ACTOR,
    lastActor: ACTOR,
    ...overrides,
  };
}

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
    last_modified_by: ACTOR,
    lastActor: ACTOR,
    ...overrides,
  };
  await db.doc(`stakes/${STAKE_ID}`).set(stake);
}

async function seedWard(wardCode: string, wardName: string): Promise<void> {
  const { db } = requireEmulators();
  const ward: Ward = {
    ward_code: wardCode,
    ward_name: wardName,
    building_name: 'Greenwood',
    seat_cap: 20,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: ACTOR,
  };
  await db.doc(`stakes/${STAKE_ID}/wards/${wardCode}`).set(ward);
}

function mockSender(responses: SendResult[] = []): { sender: ResendSender; calls: EmailPayload[] } {
  const calls: EmailPayload[] = [];
  const sender: ResendSender = {
    send: async (payload) => {
      calls.push(payload);
      return responses.shift() ?? { ok: true, id: 'mid-default' };
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

describe.skipIf(!hasEmulators())('notifyOnAccessGranted', () => {
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

  it('first grant via importer_callings sends one email carrying text and html', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: null,
        after: accessDoc({ importer_callings: { GE: ['Bishop'] } }),
      }),
    );

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.to).toEqual(['Jane@Gmail.com']);
    expect(c.from).toContain('CSNorth Stake');
    expect(c.subject).toBe(
      '[Stake Building Access] You can now request building access for Greenwood Ward',
    );
    expect(c.text).toContain('Hi Jane Doe,');
    expect(c.text).toContain('Open the app: https://stakebuildingaccess.org/');
    expect(c.text).toContain(
      'For more details read the full documentation here: https://stakebuildingaccess.org/help/requesting-access.html',
    );
    expect(c.html).toContain('<strong>Greenwood Ward</strong>');
    expect(c.html).toContain('href="https://stakebuildingaccess.org/"');
  });

  it('first grant via manual_grants only also fires', async () => {
    await seedStake();
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: null,
        after: accessDoc({
          manual_grants: {
            stake: [
              { grant_id: 'g1', reason: 'Clerk', granted_by: ACTOR, granted_at: Timestamp.now() },
            ],
          },
        }),
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe(
      '[Stake Building Access] You can now request building access for the Stake',
    );
  });

  it('adding a scope to an existing holder sends nothing', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: accessDoc({ importer_callings: { GE: ['Bishop'] } }),
        after: accessDoc({ importer_callings: { GE: ['Bishop'], stake: ['Stake Clerk'] } }),
      }),
    );

    expect(calls).toHaveLength(0);
  });

  it('an unrelated update on a holder sends nothing', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: accessDoc({ importer_callings: { GE: ['Bishop'] } }),
        after: accessDoc({ member_name: 'Jane R. Doe', importer_callings: { GE: ['Bishop'] } }),
      }),
    );

    expect(calls).toHaveLength(0);
  });

  it('revoking to zero scopes is silent; a later re-grant fires again', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    const granted = accessDoc({ importer_callings: { GE: ['Bishop'] } });
    const revoked = accessDoc({ importer_callings: { GE: [] } });

    await notifyOnAccessGranted.run(makeEvent({ before: granted, after: revoked }));
    expect(calls).toHaveLength(0);

    await notifyOnAccessGranted.run(makeEvent({ before: revoked, after: granted }));
    expect(calls).toHaveLength(1);
  });

  it('a doc delete sends nothing', async () => {
    await seedStake();
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({ before: accessDoc({ importer_callings: { GE: ['Bishop'] } }), after: null }),
    );

    expect(calls).toHaveLength(0);
  });

  it('notifications_enabled=false sends nothing and writes no audit row', async () => {
    await seedStake({ notifications_enabled: false });
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: null,
        after: accessDoc({ importer_callings: { stake: ['Stake Clerk'] } }),
      }),
    );

    expect(calls).toHaveLength(0);
    expect(await readEmailFailedAudits()).toHaveLength(0);
  });

  it('web_base_url_override rewrites both links in the text and html parts', async () => {
    await seedStake({ web_base_url_override: 'https://kindoo.csnorth.org' });
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: null,
        after: accessDoc({ importer_callings: { stake: ['Stake Clerk'] } }),
      }),
    );

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.text).toContain('Open the app: https://kindoo.csnorth.org/');
    expect(c.text).toContain('https://kindoo.csnorth.org/help/requesting-access.html');
    expect(c.text).not.toContain('stakebuildingaccess.org/');
    expect(c.html).toContain('href="https://kindoo.csnorth.org/"');
    expect(c.html).toContain('href="https://kindoo.csnorth.org/help/requesting-access.html"');
    expect(c.html).not.toContain('href="https://stakebuildingaccess.org/"');
  });

  it('a gmail recipient gets the Continue-with-Google copy', async () => {
    await seedStake();
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: null,
        after: accessDoc({ importer_callings: { stake: ['Stake Clerk'] } }),
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('Continue with Google');
    expect(calls[0]!.text).not.toContain('Send me a sign-in link');
    expect(calls[0]!.html).toContain('Continue with Google');
  });

  it('a non-gmail recipient gets the magic-link copy', async () => {
    await seedStake();
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: null,
        after: accessDoc({
          member_email: 'Jane@csnorth.org',
          importer_callings: { stake: ['Stake Clerk'] },
        }),
        memberCanonical: 'jane@csnorth.org',
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('Send me a sign-in link');
    expect(calls[0]!.text).not.toContain('Continue with Google');
    expect(calls[0]!.html).toContain('Send me a sign-in link');
  });

  it('a Resend error writes exactly one accessGranted email_send_failed audit row', async () => {
    await seedStake();
    const { sender, calls } = mockSender([
      { ok: false, error: { message: '500 server error', code: 'rate_limit_exceeded' } },
    ]);
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: null,
        after: accessDoc({ importer_callings: { stake: ['Stake Clerk'] } }),
      }),
    );

    expect(calls).toHaveLength(1);
    const audits = await readEmailFailedAudits();
    expect(audits).toHaveLength(1);
    const row = audits[0]!;
    expect(row.actor_canonical).toBe('EmailService');
    expect(row.entity_type).toBe('system');
    // Deterministic tail so a retried invocation overwrites this row.
    expect(
      row.audit_id.endsWith(`_system_email_send_failed_accessGranted_${MEMBER_CANONICAL}`),
    ).toBe(true);
    const after = row.after as Record<string, unknown>;
    expect(after['type']).toBe('accessGranted');
    expect(after['error_message']).toBe('500 server error');
    expect(after['source']).toBe(MEMBER_CANONICAL);
  });

  it('falls back to the doc-id canonical when member_email is missing', async () => {
    await seedStake();
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    const doc = accessDoc({ importer_callings: { stake: ['Stake Clerk'] } });
    delete doc['member_email'];
    await notifyOnAccessGranted.run(makeEvent({ before: null, after: doc }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toEqual([MEMBER_CANONICAL]);
  });

  it('renders seeded ward names and falls back to the raw code for unseeded ones', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    const { sender, calls } = mockSender();
    restoreSender = _setResendSender(sender);

    await notifyOnAccessGranted.run(
      makeEvent({
        before: null,
        after: accessDoc({
          importer_callings: { stake: ['Stake Clerk'], GE: ['Bishop'], ZZ: ['Bishop'] },
        }),
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe(
      '[Stake Building Access] You can now request building access for the Stake, Greenwood Ward, and ZZ',
    );
  });
});
