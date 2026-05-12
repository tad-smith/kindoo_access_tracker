// Integration tests for `notifyOnOverCap`. The trigger fires on every
// write to a stake doc and dispatches the over-cap email when the
// `last_over_caps_json` field transitions from empty to non-empty per
// `docs/spec.md` §9.
//
// Continuing-overcap (`[A] -> [A, B]`) and resolving-overcap
// (`[A] -> []`) deliberately do NOT fire — operators are notified
// once when a pool tips over.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { OverCapEntry, Stake } from '@kindoo/shared';
import { notifyOnOverCap } from '../src/triggers/notifyOnOverCap.js';
import {
  _setResendSender,
  type EmailPayload,
  type ResendSender,
  type SendResult,
} from '../src/lib/resend.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';

function makeEvent(opts: { before: Stake | null; after: Stake | null; time?: string }): never {
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
    params: { stakeId: STAKE_ID },
    time,
    data: { before, after },
  } as unknown as never;
}

function buildStake(overrides: Partial<Stake> = {}): Stake {
  return {
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
    last_modified_by: { email: 'Importer', canonical: 'Importer' },
    lastActor: { email: 'Importer', canonical: 'Importer' },
    ...overrides,
  };
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

function mockSender(responses: SendResult[]): { sender: ResendSender; calls: EmailPayload[] } {
  const calls: EmailPayload[] = [];
  const sender: ResendSender = {
    send: async (payload) => {
      calls.push(payload);
      return responses.shift() ?? { ok: true, id: 'mid-default' };
    },
  };
  return { sender, calls };
}

const overCapPool: OverCapEntry = { pool: 'GE', count: 25, cap: 20, over_by: 5 };

describe.skipIf(!hasEmulators())('notifyOnOverCap', () => {
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

  it('empty → non-empty fires the over-cap email to active managers', async () => {
    await seedManager('alice@gmail.com', true);
    await seedManager('bob@gmail.com', false); // inactive
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-1' }]);
    restoreSender = _setResendSender(sender);

    const before = buildStake({ last_over_caps_json: [] });
    const after = buildStake({
      last_over_caps_json: [overCapPool],
      last_import_triggered_by: 'manual',
    });
    await notifyOnOverCap.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.to).toEqual(['alice@gmail.com']);
    expect(c.subject).toContain('Over-cap warning after manual import');
    expect(c.text).toContain('GE: 25 of 20 (over by 5)');
    expect(c.text).toContain('https://stakebuildingaccess.org/manager/seats');
  });

  it('uses the weekly source label when the importer was triggered weekly', async () => {
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-w' }]);
    restoreSender = _setResendSender(sender);

    const before = buildStake({ last_over_caps_json: [] });
    const after = buildStake({
      last_over_caps_json: [overCapPool],
      last_import_triggered_by: 'weekly',
    });
    await notifyOnOverCap.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain('Over-cap warning after weekly import');
  });

  it('continuing-overcap (non-empty → non-empty) does NOT fire', async () => {
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([]);
    restoreSender = _setResendSender(sender);

    const before = buildStake({ last_over_caps_json: [overCapPool] });
    const after = buildStake({
      last_over_caps_json: [overCapPool, { pool: 'CO', count: 22, cap: 20, over_by: 2 }],
    });
    await notifyOnOverCap.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(0);
  });

  it('resolving-overcap (non-empty → empty) does NOT fire', async () => {
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([]);
    restoreSender = _setResendSender(sender);

    const before = buildStake({ last_over_caps_json: [overCapPool] });
    const after = buildStake({ last_over_caps_json: [] });
    await notifyOnOverCap.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(0);
  });

  it('on create (no before) with non-empty over-caps fires', async () => {
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-create' }]);
    restoreSender = _setResendSender(sender);

    const after = buildStake({
      last_over_caps_json: [overCapPool],
      last_import_triggered_by: 'manual',
    });
    await notifyOnOverCap.run(makeEvent({ before: null, after }));

    expect(calls).toHaveLength(1);
  });

  it('notifications_enabled=false suppresses the send', async () => {
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([]);
    restoreSender = _setResendSender(sender);

    const before = buildStake({ last_over_caps_json: [] });
    const after = buildStake({
      last_over_caps_json: [overCapPool],
      notifications_enabled: false,
    });
    await notifyOnOverCap.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(0);
  });

  it('defaults source to manual when last_import_triggered_by is absent', async () => {
    await seedManager('alice@gmail.com', true);
    const { sender, calls } = mockSender([{ ok: true, id: 'mid-default' }]);
    restoreSender = _setResendSender(sender);

    const before = buildStake({ last_over_caps_json: [] });
    const after = buildStake({ last_over_caps_json: [overCapPool] });
    delete (after as { last_import_triggered_by?: 'manual' | 'weekly' }).last_import_triggered_by;

    await notifyOnOverCap.run(makeEvent({ before, after }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain('after manual import');
  });
});
