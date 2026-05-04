// Unit tests for the pure builders in EmailService — no Firestore or
// Resend involvement. Subject + body shape per `docs/spec.md` §9.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AccessRequest, OverCapEntry, Stake } from '@kindoo/shared';
import {
  buildCancelledBody,
  buildCancelledSubject,
  buildCompletedBody,
  buildCompletedSubject,
  buildFromAddress,
  buildLink,
  buildNewRequestBody,
  buildNewRequestSubject,
  buildOverCapBody,
  buildOverCapSubject,
  buildRejectedBody,
  buildRejectedSubject,
  scopeLabel,
} from '../src/services/EmailService.js';

const STAKE: Pick<Stake, 'stake_name'> = { stake_name: 'CSNorth Stake' };

const baseRequest: AccessRequest = {
  request_id: 'req-1',
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

describe('EmailService — pure builders', () => {
  beforeEach(() => {
    process.env['WEB_BASE_URL'] = 'https://stakebuildingaccess.org';
  });
  afterEach(() => {
    delete process.env['WEB_BASE_URL'];
  });

  // ---- buildFromAddress ----------------------------------------------------

  it('buildFromAddress interpolates the stake name into the display string', () => {
    const from = buildFromAddress(STAKE);
    expect(from).toBe(
      'CSNorth Stake — Stake Building Access <noreply@mail.stakebuildingaccess.org>',
    );
  });

  it('buildFromAddress falls back to a generic display when stake_name is empty', () => {
    const from = buildFromAddress({ stake_name: '' });
    expect(from).toContain('Stake Building Access — Stake Building Access');
    expect(from).toContain('<noreply@mail.stakebuildingaccess.org>');
  });

  // ---- buildLink -----------------------------------------------------------

  it('buildLink concatenates WEB_BASE_URL with a route', () => {
    expect(buildLink('/manager/queue')).toBe('https://stakebuildingaccess.org/manager/queue');
  });

  it('buildLink tolerates a missing leading slash', () => {
    expect(buildLink('manager/queue')).toBe('https://stakebuildingaccess.org/manager/queue');
  });

  it('buildLink throws cleanly when WEB_BASE_URL is unset', () => {
    delete process.env['WEB_BASE_URL'];
    expect(() => buildLink('/manager/queue')).toThrow(/WEB_BASE_URL/);
  });

  // ---- scopeLabel ----------------------------------------------------------

  it('scopeLabel renders Stake / WARD-CODE-UPPER', () => {
    expect(scopeLabel('stake')).toBe('Stake');
    expect(scopeLabel('ge')).toBe('GE');
    expect(scopeLabel('GE')).toBe('GE');
  });

  // ---- new-request ---------------------------------------------------------

  it('new-request subject names the requester and the scope', () => {
    const subject = buildNewRequestSubject(baseRequest);
    expect(subject).toBe('[Stake Building Access] New request from Bish@gmail.com (GE)');
  });

  it('new-request body uses the add_manual lead verb', () => {
    const link = buildLink('/manager/queue');
    const body = buildNewRequestBody(baseRequest, link);
    expect(body).toContain('Bish@gmail.com submitted a new manual-add request');
    expect(body).toContain('Subject Person');
    expect(body).toContain('Subject@gmail.com');
    expect(body).toContain('Reason:    Bishop');
    expect(body).toContain('Review the queue: https://stakebuildingaccess.org/manager/queue');
  });

  it('new-request body uses the add_temp lead verb and includes dates', () => {
    const req: AccessRequest = {
      ...baseRequest,
      type: 'add_temp',
      start_date: '2026-05-01',
      end_date: '2026-05-15',
    };
    const body = buildNewRequestBody(req, buildLink('/manager/queue'));
    expect(body).toContain('requested temp access for');
    expect(body).toContain('Dates:     2026-05-01 to 2026-05-15');
  });

  it('new-request body uses the remove lead verb', () => {
    const req: AccessRequest = { ...baseRequest, type: 'remove' };
    const body = buildNewRequestBody(req, buildLink('/manager/queue'));
    expect(body).toContain('requested removal of');
  });

  it('new-request body surfaces the urgent flag when set', () => {
    const urgent: AccessRequest = { ...baseRequest, urgent: true, comment: 'needed today' };
    const body = buildNewRequestBody(urgent, buildLink('/manager/queue'));
    expect(body).toContain('Urgent:    yes');
  });

  it('new-request body omits the urgent flag when unset/false', () => {
    expect(buildNewRequestBody(baseRequest, buildLink('/manager/queue'))).not.toContain('Urgent:');
    const explicit: AccessRequest = { ...baseRequest, urgent: false };
    expect(buildNewRequestBody(explicit, buildLink('/manager/queue'))).not.toContain('Urgent:');
  });

  // ---- completed -----------------------------------------------------------

  it('completed subject + body name the member and acknowledge the type', () => {
    const req: AccessRequest = { ...baseRequest, status: 'complete' };
    const subject = buildCompletedSubject(req);
    expect(subject).toBe(
      '[Stake Building Access] Your request for Subject@gmail.com has been completed',
    );
    const body = buildCompletedBody(req, buildLink('/my-requests'));
    expect(body).toContain('Your request for manual access for Subject@gmail.com');
    expect(body).toContain('View your requests: https://stakebuildingaccess.org/my-requests');
  });

  it('completed body surfaces completion_note for the R-1 race', () => {
    const req: AccessRequest = {
      ...baseRequest,
      type: 'remove',
      status: 'complete',
      completion_note: 'Seat already removed at completion time (no-op).',
    };
    const body = buildCompletedBody(req, buildLink('/my-requests'));
    expect(body).toContain('Note: Seat already removed at completion time (no-op).');
  });

  it('completed body omits the Note line when no completion_note is set', () => {
    const req: AccessRequest = { ...baseRequest, status: 'complete' };
    const body = buildCompletedBody(req, buildLink('/my-requests'));
    expect(body).not.toContain('Note:');
  });

  // ---- rejected ------------------------------------------------------------

  it('rejected body surfaces rejection_reason', () => {
    const req: AccessRequest = {
      ...baseRequest,
      status: 'rejected',
      rejection_reason: 'Already has access through a stake calling.',
    };
    expect(buildRejectedSubject(req)).toBe('[Stake Building Access] Your request was rejected');
    const body = buildRejectedBody(req, buildLink('/my-requests'));
    expect(body).toContain('Reason:    Already has access through a stake calling.');
    expect(body).toContain('View your requests:');
  });

  it('rejected body falls back gracefully if rejection_reason missing', () => {
    const req: AccessRequest = { ...baseRequest, status: 'rejected' };
    const body = buildRejectedBody(req, buildLink('/my-requests'));
    expect(body).toContain('(not provided)');
  });

  // ---- cancelled -----------------------------------------------------------

  it('cancelled subject + body name the canceller', () => {
    const req: AccessRequest = { ...baseRequest, status: 'cancelled' };
    const subject = buildCancelledSubject(req);
    expect(subject).toBe('[Stake Building Access] Request cancelled by Bish@gmail.com');
    const body = buildCancelledBody(req, buildLink('/manager/queue'));
    expect(body).toContain('Bish@gmail.com cancelled their request');
    expect(body).toContain('Open the queue:');
  });

  // ---- over-cap ------------------------------------------------------------

  it('over-cap subject names the import source', () => {
    expect(buildOverCapSubject('manual')).toBe(
      '[Stake Building Access] Over-cap warning after manual import',
    );
    expect(buildOverCapSubject('weekly')).toBe(
      '[Stake Building Access] Over-cap warning after weekly import',
    );
  });

  it('over-cap body lists every pool with count / cap / over-by', () => {
    const pools: OverCapEntry[] = [
      { pool: 'stake', count: 22, cap: 20, over_by: 2 },
      { pool: 'GE', count: 25, cap: 20, over_by: 5 },
    ];
    const body = buildOverCapBody(pools, buildLink('/manager/seats'));
    expect(body).toContain('Stake: 22 of 20 (over by 2)');
    expect(body).toContain('GE: 25 of 20 (over by 5)');
    expect(body).toContain('View seats: https://stakebuildingaccess.org/manager/seats');
  });
});
