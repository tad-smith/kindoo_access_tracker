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
  buildWelcomeHtmlBody,
  buildWelcomeSubject,
  buildWelcomeTextBody,
  formatScopeList,
  scopeLabel,
  type WelcomeEmailOpts,
} from '../src/services/EmailService.js';

const STAKE: Pick<Stake, 'stake_name'> = { stake_name: 'CSNorth Stake' };

// The derived `{Name} ({Calling})` requester label, resolved by the
// service layer and passed into the pure builders.
const REQUESTER_LABEL = 'John Smith (Bishop)';

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

const WELCOME_GMAIL: WelcomeEmailOpts = {
  stakeName: 'CSNorth Stake',
  memberName: 'Jane Doe',
  memberEmail: 'jane@gmail.com',
  scopeList: 'the Stake and Greenwood Ward',
  appLink: 'https://stakebuildingaccess.org/',
  guideLink: 'https://stakebuildingaccess.org/help/requesting-access.html',
  isGmail: true,
};

const WELCOME_NON_GMAIL: WelcomeEmailOpts = {
  ...WELCOME_GMAIL,
  memberEmail: 'jane@csnorth.org',
  isGmail: false,
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

  // ---- buildLink: per-stake override --------------------------------------

  it('buildLink prefers the stake web_base_url_override over the param', () => {
    expect(buildLink('/my-requests', { web_base_url_override: 'https://kindoo.csnorth.org' })).toBe(
      'https://kindoo.csnorth.org/my-requests',
    );
  });

  it('buildLink strips a trailing slash from the override', () => {
    expect(
      buildLink('/my-requests', { web_base_url_override: 'https://kindoo.csnorth.org/' }),
    ).toBe('https://kindoo.csnorth.org/my-requests');
  });

  it('buildLink falls back to the param when the override is absent / empty / whitespace', () => {
    expect(buildLink('/my-requests', {})).toBe('https://stakebuildingaccess.org/my-requests');
    expect(buildLink('/my-requests', { web_base_url_override: '' })).toBe(
      'https://stakebuildingaccess.org/my-requests',
    );
    expect(buildLink('/my-requests', { web_base_url_override: '   ' })).toBe(
      'https://stakebuildingaccess.org/my-requests',
    );
  });

  it('buildLink uses the override even when the param is unset', () => {
    delete process.env['WEB_BASE_URL'];
    expect(buildLink('/', { web_base_url_override: 'https://kindoo.csnorth.org' })).toBe(
      'https://kindoo.csnorth.org/',
    );
  });

  // ---- scopeLabel ----------------------------------------------------------

  it('scopeLabel renders Stake / WARD-CODE-UPPER', () => {
    expect(scopeLabel('stake')).toBe('Stake');
    expect(scopeLabel('ge')).toBe('GE');
    expect(scopeLabel('GE')).toBe('GE');
  });

  // ---- new-request ---------------------------------------------------------

  it('new-request subject names the requester (name + calling) and the scope', () => {
    const subject = buildNewRequestSubject(baseRequest, REQUESTER_LABEL);
    expect(subject).toBe('[Stake Building Access] New request from John Smith (Bishop) (GE)');
  });

  it('new-request subject falls back to the raw email when no label is derived', () => {
    const subject = buildNewRequestSubject(baseRequest, baseRequest.requester_email);
    expect(subject).toBe('[Stake Building Access] New request from Bish@gmail.com (GE)');
  });

  it('new-request body uses the add_manual lead verb and the requester label', () => {
    const link = buildLink('/manager/queue');
    const body = buildNewRequestBody(baseRequest, link, REQUESTER_LABEL);
    expect(body).toContain('John Smith (Bishop) submitted a new manual-add request');
    expect(body).toContain('Subject Person');
    expect(body).toContain('Subject@gmail.com');
    expect(body).toContain('Reason:    Bishop');
    expect(body).toContain('Review the queue: https://stakebuildingaccess.org/manager/queue');
  });

  it('new-request body falls back to the raw email when the label is the email', () => {
    const body = buildNewRequestBody(
      baseRequest,
      buildLink('/manager/queue'),
      baseRequest.requester_email,
    );
    expect(body).toContain('Bish@gmail.com submitted a new manual-add request');
  });

  it('new-request body uses the add_temp lead verb and includes dates', () => {
    const req: AccessRequest = {
      ...baseRequest,
      type: 'add_temp',
      start_date: '2026-05-01',
      end_date: '2026-05-15',
    };
    const body = buildNewRequestBody(req, buildLink('/manager/queue'), REQUESTER_LABEL);
    expect(body).toContain('requested temp access for');
    expect(body).toContain('Dates:     2026-05-01 to 2026-05-15');
  });

  it('new-request body uses the remove lead verb', () => {
    const req: AccessRequest = { ...baseRequest, type: 'remove' };
    const body = buildNewRequestBody(req, buildLink('/manager/queue'), REQUESTER_LABEL);
    expect(body).toContain('requested removal of');
  });

  it('new-request body surfaces the urgent flag when set', () => {
    const urgent: AccessRequest = { ...baseRequest, urgent: true, comment: 'needed today' };
    const body = buildNewRequestBody(urgent, buildLink('/manager/queue'), REQUESTER_LABEL);
    expect(body).toContain('Emergency: yes');
  });

  it('new-request body omits the urgent flag when unset/false', () => {
    expect(
      buildNewRequestBody(baseRequest, buildLink('/manager/queue'), REQUESTER_LABEL),
    ).not.toContain('Emergency:');
    const explicit: AccessRequest = { ...baseRequest, urgent: false };
    expect(
      buildNewRequestBody(explicit, buildLink('/manager/queue'), REQUESTER_LABEL),
    ).not.toContain('Emergency:');
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

  it('cancelled subject + body name the canceller (name + calling)', () => {
    const req: AccessRequest = { ...baseRequest, status: 'cancelled' };
    const subject = buildCancelledSubject(req, REQUESTER_LABEL);
    expect(subject).toBe('[Stake Building Access] Request cancelled by John Smith (Bishop)');
    const body = buildCancelledBody(req, buildLink('/manager/queue'), REQUESTER_LABEL);
    expect(body).toContain('John Smith (Bishop) cancelled their request');
    expect(body).toContain('Open the queue:');
  });

  it('cancelled subject + body fall back to the raw email when no label is derived', () => {
    const req: AccessRequest = { ...baseRequest, status: 'cancelled' };
    expect(buildCancelledSubject(req, req.requester_email)).toBe(
      '[Stake Building Access] Request cancelled by Bish@gmail.com',
    );
    const body = buildCancelledBody(req, buildLink('/manager/queue'), req.requester_email);
    expect(body).toContain('Bish@gmail.com cancelled their request');
  });

  // ---- over-cap ------------------------------------------------------------

  it('over-cap subject is a plain top-line warning (no import-source suffix)', () => {
    expect(buildOverCapSubject()).toBe('[Stake Building Access] Over-cap warning');
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

  // ---- welcome (first app-access grant) ------------------------------------

  it('formatScopeList renders Stake alone as "the Stake"', () => {
    expect(formatScopeList(['Stake'])).toBe('the Stake');
  });

  it('formatScopeList passes a single ward name through', () => {
    expect(formatScopeList(['Greenwood Ward'])).toBe('Greenwood Ward');
  });

  it('formatScopeList joins two labels with "and"', () => {
    expect(formatScopeList(['Greenwood Ward', 'Cedar Ward'])).toBe('Greenwood Ward and Cedar Ward');
  });

  it('formatScopeList joins three or more labels with an Oxford comma', () => {
    expect(formatScopeList(['Greenwood Ward', 'Cedar Ward', 'Maple Ward'])).toBe(
      'Greenwood Ward, Cedar Ward, and Maple Ward',
    );
  });

  it('formatScopeList puts the Stake ahead of the wards the caller ordered', () => {
    expect(formatScopeList(['Stake', 'Greenwood Ward'])).toBe('the Stake and Greenwood Ward');
  });

  it('welcome subject names the scope list', () => {
    expect(buildWelcomeSubject('the Stake and Greenwood Ward')).toBe(
      '[Stake Building Access] You can now request building access for the Stake and Greenwood Ward',
    );
  });

  it('welcome text body (gmail) renders the Continue-with-Google instructions', () => {
    expect(buildWelcomeTextBody(WELCOME_GMAIL)).toBe(
      [
        'Hi Jane Doe,',
        '',
        "You've been given access to Stake Building Access, the app CSNorth Stake uses to manage access to its buildings. You can now sign in and request building access for the Stake and Greenwood Ward.",
        '',
        'Open the app: https://stakebuildingaccess.org/',
        '',
        'Signing in: this is a Gmail address, so on the sign-in page just click "Continue with Google" and choose this account (jane@gmail.com). No password needed.',
        '',
        'For more details read the full documentation here: https://stakebuildingaccess.org/help/requesting-access.html',
      ].join('\n'),
    );
  });

  it('welcome text body (non-gmail) renders the magic-link instructions', () => {
    expect(buildWelcomeTextBody(WELCOME_NON_GMAIL)).toBe(
      [
        'Hi Jane Doe,',
        '',
        "You've been given access to Stake Building Access, the app CSNorth Stake uses to manage access to its buildings. You can now sign in and request building access for the Stake and Greenwood Ward.",
        '',
        'Open the app: https://stakebuildingaccess.org/',
        '',
        'Signing in: on the sign-in page, enter this email address (jane@csnorth.org) and click "Send me a sign-in link". You\'ll receive an email with a link that signs you in — no password needed.',
        '',
        'For more details read the full documentation here: https://stakebuildingaccess.org/help/requesting-access.html',
      ].join('\n'),
    );
  });

  it('welcome text body picks exactly one sign-in variant', () => {
    const gmail = buildWelcomeTextBody(WELCOME_GMAIL);
    expect(gmail).toContain('Continue with Google');
    expect(gmail).not.toContain('Send me a sign-in link');

    const other = buildWelcomeTextBody(WELCOME_NON_GMAIL);
    expect(other).toContain('Send me a sign-in link');
    expect(other).not.toContain('Continue with Google');
  });

  it('welcome text body greets with Hello, when no member name is known', () => {
    const opts: WelcomeEmailOpts = { ...WELCOME_GMAIL };
    delete opts.memberName;
    expect(buildWelcomeTextBody(opts).startsWith('Hello,\n')).toBe(true);
  });

  it('welcome html body carries both links, the scope list, and the gmail copy', () => {
    const html = buildWelcomeHtmlBody(WELCOME_GMAIL);
    expect(html).toContain('href="https://stakebuildingaccess.org/"');
    expect(html).toContain('href="https://stakebuildingaccess.org/help/requesting-access.html"');
    expect(html).toContain('<strong>the Stake and Greenwood Ward</strong>');
    expect(html).toContain('Hi Jane Doe,');
    expect(html).toContain('Continue with Google');
    expect(html).not.toContain('Send me a sign-in link');
  });

  it('welcome html body carries the non-gmail copy', () => {
    const html = buildWelcomeHtmlBody(WELCOME_NON_GMAIL);
    expect(html).toContain('Send me a sign-in link');
    expect(html).not.toContain('Continue with Google');
  });

  it('welcome html body escapes user data in names', () => {
    const html = buildWelcomeHtmlBody({
      ...WELCOME_GMAIL,
      memberName: '<b>Bob</b> & Sons',
      stakeName: 'Smith & <Jones> Stake',
    });
    expect(html).toContain('Hi &lt;b&gt;Bob&lt;/b&gt; &amp; Sons,');
    expect(html).toContain('Smith &amp; &lt;Jones&gt; Stake');
    expect(html).not.toContain('<b>Bob</b>');
  });
});
