// Unit tests for the pure builders in EmailService — no Firestore or
// Resend involvement. Subject + body shape per `docs/spec.md` §9.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AccessRequest, RequestType, Stake } from '@kindoo/shared';
import {
  buildCancelledHtmlBody,
  buildCancelledSubject,
  buildCancelledTextBody,
  buildCompletedHtmlBody,
  buildCompletedSubject,
  buildCompletedTextBody,
  buildFromAddress,
  buildLink,
  buildNewRequestHtmlBody,
  buildNewRequestSubject,
  buildNewRequestTextBody,
  buildOverCapHtmlBody,
  buildOverCapSubject,
  buildOverCapTextBody,
  buildRejectedHtmlBody,
  buildRejectedSubject,
  buildRejectedTextBody,
  buildWelcomeHtmlBody,
  buildWelcomeSubject,
  buildWelcomeTextBody,
  formatScopeList,
  type LabelledPool,
  type RequestEmailOpts,
  type RequesterNamedEmailOpts,
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

// Resolved by the service layer from `stakes/{id}/wards` before the pure
// builders see it — a builder never handles a raw ward code.
const WARD = 'Greenwood Ward';
const QUEUE_LINK = 'https://stakebuildingaccess.org/manager/queue';
const MY_LINK = 'https://stakebuildingaccess.org/my-requests';
const SEATS_LINK = 'https://stakebuildingaccess.org/manager/seats';

function requestOpts(over: Partial<RequestEmailOpts> = {}): RequestEmailOpts {
  return { req: baseRequest, scope: WARD, link: MY_LINK, ...over };
}

function managerOpts(over: Partial<RequesterNamedEmailOpts> = {}): RequesterNamedEmailOpts {
  return {
    req: baseRequest,
    scope: WARD,
    link: QUEUE_LINK,
    requesterLabel: REQUESTER_LABEL,
    ...over,
  };
}

const WELCOME_GMAIL: WelcomeEmailOpts = {
  stakeName: 'CSNorth Stake',
  memberName: 'Jane Doe',
  memberEmail: 'jane@gmail.com',
  scopeList: 'the Stake and Greenwood Ward',
  appLink: 'https://stakebuildingaccess.org/',
  guideLink: 'https://stakebuildingaccess.org/help/requesting-access.html',
  isGmail: true,
  isLimited: false,
};

// Same links as full — only the subject and opening sentence differ.
const WELCOME_LIMITED: WelcomeEmailOpts = {
  ...WELCOME_GMAIL,
  scopeList: 'Greenwood Ward',
  isLimited: true,
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

  it('buildLink accepts an http:// override', () => {
    expect(buildLink('/my-requests', { web_base_url_override: 'http://kindoo.csnorth.org' })).toBe(
      'http://kindoo.csnorth.org/my-requests',
    );
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

  it('buildLink ignores an override with no http(s) scheme', () => {
    expect(buildLink('/my-requests', { web_base_url_override: 'kindoo.csnorth.org' })).toBe(
      'https://stakebuildingaccess.org/my-requests',
    );
    expect(buildLink('/my-requests', { web_base_url_override: 'javascript:alert(1)' })).toBe(
      'https://stakebuildingaccess.org/my-requests',
    );
  });

  it('buildLink still throws when the param is unset and the override is rejected', () => {
    delete process.env['WEB_BASE_URL'];
    expect(() => buildLink('/', { web_base_url_override: 'kindoo.csnorth.org' })).toThrow(
      /WEB_BASE_URL/,
    );
  });

  it('buildLink uses the override even when the param is unset', () => {
    delete process.env['WEB_BASE_URL'];
    expect(buildLink('/', { web_base_url_override: 'https://kindoo.csnorth.org' })).toBe(
      'https://kindoo.csnorth.org/',
    );
  });

  // ---- scope + type rendering ----------------------------------------------

  // The builders never see a raw ward code — the service layer resolves it —
  // but they do choose the row's label off `req.scope`.
  it('labels the scope row Ward for a ward and Scope for the stake pool', () => {
    expect(buildNewRequestTextBody(managerOpts())).toContain('Ward:      Greenwood Ward');
    const stake = managerOpts({ req: { ...baseRequest, scope: 'stake' }, scope: 'Stake' });
    expect(buildNewRequestTextBody(stake)).toContain('Scope:     Stake');
    expect(buildNewRequestHtmlBody(stake)).toContain('<th style="text-align:left');
    expect(buildNewRequestHtmlBody(stake)).toContain('>Scope</th>');
    expect(buildNewRequestHtmlBody(stake)).toContain('>Stake</td>');
  });

  it('renders a human label for every request type, never the raw enum', () => {
    const expected: Record<RequestType, string> = {
      add_manual: 'Manual access',
      add_temp: 'Temporary access',
      remove: 'Removal',
      edit_auto: 'Auto-seat edit',
      edit_manual: 'Manual-seat edit',
      edit_temp: 'Temporary-seat edit',
    };
    for (const [type, label] of Object.entries(expected) as [RequestType, string][]) {
      const o = managerOpts({ req: { ...baseRequest, type } });
      expect(buildNewRequestTextBody(o)).toContain(`Request:   ${label}`);
      expect(buildNewRequestTextBody(o)).not.toContain(`Request:   ${type}`);
      expect(buildNewRequestHtmlBody(o)).toContain(`>${label}</td>`);
      expect(buildNewRequestHtmlBody(o)).not.toContain(`>${type}<`);
      // The leads read off the same map, so row and sentence can't drift.
      const c = requestOpts({ req: { ...baseRequest, type } });
      expect(buildCompletedTextBody(c)).toContain(
        `Your ${label.toLowerCase()} request for Subject Person has been completed.`,
      );
    }
  });

  // The new-request lead is the one place the wording is per-type prose
  // rather than derived from TYPE_LABEL, so pin all six.
  it('opens the new-request lead with the right verb for every type', () => {
    const leads: Record<RequestType, string> = {
      add_manual: 'submitted a new manual-add request for Subject Person.',
      add_temp: 'requested temporary access for Subject Person.',
      remove: 'requested removal of access for Subject Person.',
      edit_auto: 'requested an edit to the auto seat for Subject Person.',
      edit_manual: 'requested an edit to the manual seat for Subject Person.',
      edit_temp: 'requested an edit to the temporary seat for Subject Person.',
    };
    for (const [type, lead] of Object.entries(leads) as [RequestType, string][]) {
      const o = managerOpts({ req: { ...baseRequest, type } });
      expect(buildNewRequestTextBody(o)).toContain(`John Smith (Bishop) ${lead}`);
      expect(buildNewRequestHtmlBody(o)).toContain(`John Smith (Bishop) ${lead}`);
    }
  });

  // No user-facing string abbreviates "temporary".
  it('never abbreviates temporary in a lead or a row', () => {
    for (const type of ['add_temp', 'edit_temp'] as RequestType[]) {
      const o = managerOpts({ req: { ...baseRequest, type } });
      for (const body of [buildNewRequestTextBody(o), buildNewRequestHtmlBody(o)]) {
        expect(body).not.toMatch(/\btemp\b/);
      }
    }
  });

  // ---- new-request ---------------------------------------------------------

  it('new-request subject names the requester (name + calling) and the ward', () => {
    expect(buildNewRequestSubject(managerOpts())).toBe(
      '[Stake Building Access] New request from John Smith (Bishop) — Greenwood Ward',
    );
  });

  it('new-request subject falls back to the raw email when no label is derived', () => {
    expect(buildNewRequestSubject(managerOpts({ requesterLabel: 'Bish@gmail.com' }))).toBe(
      '[Stake Building Access] New request from Bish@gmail.com — Greenwood Ward',
    );
  });

  it('new-request text body renders the lead verb and the detail rows', () => {
    expect(buildNewRequestTextBody(managerOpts())).toBe(
      [
        'John Smith (Bishop) submitted a new manual-add request for Subject Person.',
        '',
        'Request:   Manual access',
        'Ward:      Greenwood Ward',
        'Member:    Subject Person',
        '           Subject@gmail.com',
        'Reason:    Bishop',
        '',
        'Review the queue: https://stakebuildingaccess.org/manager/queue',
      ].join('\n'),
    );
  });

  it('new-request html body carries the same rows, the mailto and the button', () => {
    const html = buildNewRequestHtmlBody(managerOpts());
    expect(html).toContain(
      'John Smith (Bishop) submitted a new manual-add request for Subject Person.',
    );
    expect(html).toContain('>Request</th>');
    expect(html).toContain('>Manual access</td>');
    expect(html).toContain('>Greenwood Ward</td>');
    expect(html).toContain('Subject Person<br /><a href="mailto:Subject@gmail.com"');
    expect(html).toContain('>Bishop</td>');
    expect(html).toContain(
      `<a href="${QUEUE_LINK}" style="display:inline-block;background-color:#2b6cb0`,
    );
    expect(html).toContain('>Review the queue</a>');
    expect(html).not.toContain('<h1');
  });

  it('new-request body falls back to the raw email when the label is the email', () => {
    const o = managerOpts({ requesterLabel: baseRequest.requester_email });
    expect(buildNewRequestTextBody(o)).toContain('Bish@gmail.com submitted a new manual-add');
    expect(buildNewRequestHtmlBody(o)).toContain('Bish@gmail.com submitted a new manual-add');
  });

  it('new-request body uses the add_temp lead verb and includes dates', () => {
    const o = managerOpts({
      req: {
        ...baseRequest,
        type: 'add_temp',
        start_date: '2026-05-01',
        end_date: '2026-05-15',
      },
    });
    expect(buildNewRequestTextBody(o)).toContain('requested temporary access for Subject Person.');
    expect(buildNewRequestHtmlBody(o)).toContain('requested temporary access for Subject Person.');
    expect(buildNewRequestTextBody(o)).toContain('Dates:     2026-05-01 to 2026-05-15');
    expect(buildNewRequestHtmlBody(o)).toContain('>Dates</th>');
    expect(buildNewRequestHtmlBody(o)).toContain('>2026-05-01 to 2026-05-15</td>');
  });

  // The seat comes off, not the person — "removal of access for X".
  it('new-request body uses the remove lead verb', () => {
    const o = managerOpts({ req: { ...baseRequest, type: 'remove' } });
    expect(buildNewRequestTextBody(o)).toContain('requested removal of access for Subject Person.');
    expect(buildNewRequestHtmlBody(o)).toContain('requested removal of access for Subject Person.');
  });

  it('new-request body surfaces the urgent flag as a Yes chip', () => {
    const o = managerOpts({ req: { ...baseRequest, urgent: true, comment: 'needed today' } });
    expect(buildNewRequestTextBody(o)).toContain('Emergency: Yes');
    expect(buildNewRequestTextBody(o)).toContain('Comment:   needed today');
    const html = buildNewRequestHtmlBody(o);
    expect(html).toContain('>Emergency</th>');
    expect(html).toContain('<span style="display:inline-block;background-color:#fbe9e7');
    expect(html).toContain('>Yes</span>');
    expect(html).not.toContain('>yes<');
  });

  it('new-request body omits the urgent flag when unset/false', () => {
    for (const o of [managerOpts(), managerOpts({ req: { ...baseRequest, urgent: false } })]) {
      expect(buildNewRequestTextBody(o)).not.toContain('Emergency');
      expect(buildNewRequestHtmlBody(o)).not.toContain('Emergency');
    }
  });

  // Conditional rows drop out of both parts together.
  it('new-request body omits the reason, comment and dates rows when absent', () => {
    const o = managerOpts({
      req: { ...baseRequest, type: 'add_temp', reason: '', comment: '' },
    });
    for (const body of [buildNewRequestTextBody(o), buildNewRequestHtmlBody(o)]) {
      expect(body).not.toContain('Reason');
      expect(body).not.toContain('Comment');
      expect(body).not.toContain('Dates');
    }
  });

  // `personName` falls back to the address, so a nameless member still
  // reads sensibly in the lead as well as the Member row.
  it('new-request body renders the address alone when the member has no name', () => {
    const o = managerOpts({ req: { ...baseRequest, member_name: '' } });
    expect(buildNewRequestTextBody(o)).toContain(
      'submitted a new manual-add request for Subject@gmail.com.',
    );
    expect(buildNewRequestHtmlBody(o)).toContain(
      'submitted a new manual-add request for Subject@gmail.com.',
    );
    expect(buildNewRequestTextBody(o)).toContain('Member:    Subject@gmail.com');
    expect(buildNewRequestHtmlBody(o)).toContain(
      '<a href="mailto:Subject@gmail.com" style="color:#2b6cb0">Subject@gmail.com</a>',
    );
    expect(buildNewRequestHtmlBody(o)).not.toContain('<br />');
  });

  // ---- completed -----------------------------------------------------------

  it('completed subject names the member, not their address', () => {
    expect(buildCompletedSubject(requestOpts())).toBe(
      '[Stake Building Access] Your request for Subject Person has been completed',
    );
  });

  it('completed subject + lead fall back to the address when the member has no name', () => {
    const o = requestOpts({ req: { ...baseRequest, member_name: '' } });
    expect(buildCompletedSubject(o)).toBe(
      '[Stake Building Access] Your request for Subject@gmail.com has been completed',
    );
    expect(buildCompletedTextBody(o)).toContain(
      'Your manual access request for Subject@gmail.com has been completed.',
    );
    expect(buildCompletedHtmlBody(o)).toContain(
      'Your manual access request for Subject@gmail.com has been completed.',
    );
  });

  it('completed text body renders the lead and the detail rows', () => {
    expect(
      buildCompletedTextBody(requestOpts({ req: { ...baseRequest, status: 'complete' } })),
    ).toBe(
      [
        'Your manual access request for Subject Person has been completed.',
        '',
        'Request:   Manual access',
        'Ward:      Greenwood Ward',
        'Member:    Subject Person',
        '           Subject@gmail.com',
        '',
        'View your requests: https://stakebuildingaccess.org/my-requests',
      ].join('\n'),
    );
  });

  it('completed html body carries the same rows and the button', () => {
    const html = buildCompletedHtmlBody(requestOpts());
    expect(html).toContain('Your manual access request for Subject Person has been completed.');
    expect(html).toContain('>Manual access</td>');
    expect(html).toContain('>Greenwood Ward</td>');
    expect(html).toContain(`<a href="${MY_LINK}"`);
    expect(html).toContain('>View your requests</a>');
  });

  it('completed body surfaces completion_note for the R-1 race', () => {
    const o = requestOpts({
      req: {
        ...baseRequest,
        type: 'remove',
        status: 'complete',
        completion_note: 'Seat already removed at completion time (no-op).',
      },
    });
    expect(buildCompletedTextBody(o)).toContain(
      'Note from the manager: Seat already removed at completion time (no-op).',
    );
    expect(buildCompletedHtmlBody(o)).toContain('>Note from the manager</th>');
    expect(buildCompletedHtmlBody(o)).toContain(
      '>Seat already removed at completion time (no-op).</td>',
    );
  });

  it('completed body omits the note row when no completion_note is set', () => {
    const o = requestOpts({ req: { ...baseRequest, status: 'complete' } });
    expect(buildCompletedTextBody(o)).not.toContain('Note from the manager');
    expect(buildCompletedHtmlBody(o)).not.toContain('Note from the manager');
  });

  // ---- rejected ------------------------------------------------------------

  const rejected: AccessRequest = {
    ...baseRequest,
    status: 'rejected',
    rejection_reason: 'Already has access through a stake calling.',
  };

  it('rejected subject names the member', () => {
    expect(buildRejectedSubject(requestOpts({ req: rejected }))).toBe(
      '[Stake Building Access] Your request for Subject Person was rejected',
    );
  });

  it('rejected text body renders the lead and the reason row', () => {
    expect(buildRejectedTextBody(requestOpts({ req: rejected }))).toBe(
      [
        'Your manual access request for Subject Person was rejected.',
        '',
        'Request:   Manual access',
        'Ward:      Greenwood Ward',
        'Member:    Subject Person',
        '           Subject@gmail.com',
        'Reason given: Already has access through a stake calling.',
        '',
        'View your requests: https://stakebuildingaccess.org/my-requests',
      ].join('\n'),
    );
  });

  it('rejected html body reddens the word "rejected" in the lead', () => {
    const html = buildRejectedHtmlBody(requestOpts({ req: rejected }));
    expect(html).toContain('was <span style="color:#9b2c1c;font-weight:600">rejected</span>.</p>');
    expect(html).toContain('>Reason given</th>');
    expect(html).toContain('>Already has access through a stake calling.</td>');
  });

  // The red span is the rejected email's alone.
  it('no other html body carries the red rejected span', () => {
    const red = '<span style="color:#9b2c1c;font-weight:600">rejected</span>';
    expect(buildNewRequestHtmlBody(managerOpts())).not.toContain(red);
    expect(buildCompletedHtmlBody(requestOpts())).not.toContain(red);
    expect(buildCancelledHtmlBody(managerOpts())).not.toContain(red);
    expect(buildOverCapHtmlBody({ pools: labelledPools, link: SEATS_LINK })).not.toContain(red);
    expect(buildWelcomeHtmlBody(WELCOME_GMAIL)).not.toContain(red);
  });

  // The text part keeps the plain word — no markup leaks into it.
  it('rejected text body says rejected without markup', () => {
    const text = buildRejectedTextBody(requestOpts({ req: rejected }));
    expect(text).toContain('was rejected.');
    expect(text).not.toContain('<span');
  });

  it('rejected body says so explicitly when no reason was given', () => {
    const o = requestOpts({ req: { ...baseRequest, status: 'rejected' } });
    expect(buildRejectedTextBody(o)).toContain('Reason given: (not provided)');
    expect(buildRejectedHtmlBody(o)).toContain('>(not provided)</td>');
  });

  // ---- cancelled -----------------------------------------------------------

  it('cancelled subject names the canceller (name + calling) and the ward', () => {
    expect(
      buildCancelledSubject(managerOpts({ req: { ...baseRequest, status: 'cancelled' } })),
    ).toBe('[Stake Building Access] Request cancelled by John Smith (Bishop) — Greenwood Ward');
  });

  it('cancelled text body renders the lead and the detail rows', () => {
    expect(
      buildCancelledTextBody(managerOpts({ req: { ...baseRequest, status: 'cancelled' } })),
    ).toBe(
      [
        'John Smith (Bishop) cancelled their manual access request for Subject Person.',
        '',
        'Request:   Manual access',
        'Ward:      Greenwood Ward',
        'Member:    Subject Person',
        '           Subject@gmail.com',
        '',
        'Open the queue: https://stakebuildingaccess.org/manager/queue',
      ].join('\n'),
    );
  });

  it('cancelled html body carries the same rows and the button', () => {
    const html = buildCancelledHtmlBody(managerOpts());
    expect(html).toContain('John Smith (Bishop) cancelled their manual access request');
    expect(html).toContain('>Greenwood Ward</td>');
    expect(html).toContain('>Open the queue</a>');
  });

  it('cancelled subject + body fall back to the raw email when no label is derived', () => {
    const o = managerOpts({ requesterLabel: baseRequest.requester_email });
    expect(buildCancelledSubject(o)).toBe(
      '[Stake Building Access] Request cancelled by Bish@gmail.com — Greenwood Ward',
    );
    expect(buildCancelledTextBody(o)).toContain('Bish@gmail.com cancelled their manual access');
    expect(buildCancelledHtmlBody(o)).toContain('Bish@gmail.com cancelled their manual access');
  });

  // ---- over-cap ------------------------------------------------------------

  const labelledPools: LabelledPool[] = [
    { pool: 'stake', label: 'Stake', count: 22, cap: 20, over_by: 2 },
    { pool: 'GE', label: 'Greenwood Ward', count: 25, cap: 20, over_by: 5 },
  ];

  it('over-cap subject counts the pools in words', () => {
    expect(buildOverCapSubject(labelledPools)).toBe(
      '[Stake Building Access] Two seat pools are over their cap',
    );
    expect(buildOverCapSubject([labelledPools[0]!])).toBe(
      '[Stake Building Access] One seat pool is over its cap',
    );
  });

  it('over-cap text body leads with the count and lists every pool by name', () => {
    expect(buildOverCapTextBody({ pools: labelledPools, link: SEATS_LINK })).toBe(
      [
        'Two seat pools are over their cap.',
        '',
        '  Stake: 22 of 20 (over by 2)',
        '  Greenwood Ward: 25 of 20 (over by 5)',
        '',
        'View seats: https://stakebuildingaccess.org/manager/seats',
      ].join('\n'),
    );
  });

  it('over-cap text body reads singular for one pool', () => {
    const body = buildOverCapTextBody({ pools: [labelledPools[1]!], link: SEATS_LINK });
    expect(body.startsWith('One seat pool is over its cap.\n')).toBe(true);
  });

  it('over-cap html body renders a figures table with a +N chip', () => {
    const html = buildOverCapHtmlBody({ pools: labelledPools, link: SEATS_LINK });
    expect(html).toContain('<p style="margin:0 0 16px">Two seat pools are over their cap.</p>');
    expect(html).toContain('>Pool</th>');
    expect(html).toContain('>Seats</th>');
    expect(html).toContain('>Cap</th>');
    expect(html).toContain('>Over by</th>');
    expect(html).toContain('>Greenwood Ward</td>');
    expect(html).toContain('font-variant-numeric:tabular-nums">25</td>');
    expect(html).toContain('>+5</span>');
    expect(html).toContain('>+2</span>');
    expect(html).toContain('>View seats</a>');
  });

  it('over-cap html body reads singular for one pool', () => {
    const html = buildOverCapHtmlBody({ pools: [labelledPools[1]!], link: SEATS_LINK });
    expect(html).toContain('One seat pool is over its cap.');
  });

  // ---- quote safety across every html builder -------------------------------

  // Regression: a raw `"` inside an inline style or an interpolated value
  // terminates the `style="…"` / `href="…"` attribute early and every
  // declaration after it is silently dropped by the mail client.
  const nasty: AccessRequest = {
    ...baseRequest,
    type: 'add_temp',
    member_name: 'Ann "Q" <b>Smith</b> & Co',
    member_email: 'ann+"q"@example.com',
    reason: 'Ward "Clerk" & <helper>',
    comment: 'Needs it "today" & <urgent>',
    rejection_reason: 'Already "covered" & <done>',
    completion_note: 'Seat "already" gone & <noop>',
    urgent: true,
    start_date: '2026-05-01',
    end_date: '2026-05-15',
  };
  const nastyManager: RequesterNamedEmailOpts = {
    req: nasty,
    scope: 'Green"wood" & <Ward>',
    link: QUEUE_LINK,
    requesterLabel: 'Bob "B" O\'Hara (Bishop & Clerk)',
  };
  const nastyRequest: RequestEmailOpts = { req: nasty, scope: nastyManager.scope, link: MY_LINK };

  it('no html attribute value is truncated by a raw double quote', () => {
    const bodies = [
      buildNewRequestHtmlBody(nastyManager),
      buildCompletedHtmlBody(nastyRequest),
      buildRejectedHtmlBody(nastyRequest),
      buildCancelledHtmlBody(nastyManager),
      buildOverCapHtmlBody({
        pools: [{ pool: 'GE', label: 'Green"wood" & <Ward>', count: 25, cap: 20, over_by: 5 }],
        link: SEATS_LINK,
      }),
      buildWelcomeHtmlBody({ ...WELCOME_GMAIL, memberName: 'Jane "JD" Doe' }),
    ];
    for (const html of bodies) {
      // Every quoted attribute must close right before the tag end or the
      // next attribute — never mid-value.
      for (const m of html.matchAll(/(?:style|href)="[^"]*"(.?)/g)) {
        expect(['>', ' ']).toContain(m[1]);
      }
      // And the escaping is real, not just parser-safe.
      expect(html).not.toContain('<b>Smith</b>');
      expect(html).not.toContain(' & ');
    }
  });

  it('escapes user data in every rendered field', () => {
    const html = buildNewRequestHtmlBody(nastyManager);
    expect(html).toContain('Ann &quot;Q&quot; &lt;b&gt;Smith&lt;/b&gt; &amp; Co');
    expect(html).toContain('Green&quot;wood&quot; &amp; &lt;Ward&gt;');
    expect(html).toContain('Ward &quot;Clerk&quot; &amp; &lt;helper&gt;');
    expect(html).toContain('Needs it &quot;today&quot; &amp; &lt;urgent&gt;');
    expect(html).toContain('Bob &quot;B&quot; O&#39;Hara (Bishop &amp; Clerk)');
    expect(html).toContain('mailto:ann+&quot;q&quot;@example.com');
    expect(buildRejectedHtmlBody(nastyRequest)).toContain(
      'Already &quot;covered&quot; &amp; &lt;done&gt;',
    );
    expect(buildCompletedHtmlBody(nastyRequest)).toContain(
      'Seat &quot;already&quot; gone &amp; &lt;noop&gt;',
    );
  });

  // The text part carries the same content, unescaped.
  it('text parts carry the raw user data, no entities', () => {
    for (const text of [
      buildNewRequestTextBody(nastyManager),
      buildCompletedTextBody(nastyRequest),
      buildRejectedTextBody(nastyRequest),
      buildCancelledTextBody(nastyManager),
    ]) {
      expect(text).toContain('Ann "Q" <b>Smith</b> & Co');
      expect(text).toContain('Green"wood" & <Ward>');
      expect(text).not.toContain('&quot;');
      expect(text).not.toContain('&amp;');
    }
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
    expect(buildWelcomeSubject('the Stake and Greenwood Ward', false)).toBe(
      '[Stake Building Access] You can now request building access for the Stake and Greenwood Ward',
    );
  });

  it('welcome subject says "temporary" for a limited recipient', () => {
    expect(buildWelcomeSubject('Greenwood Ward', true)).toBe(
      '[Stake Building Access] You can now request temporary building access for Greenwood Ward',
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

  // D25 limited tier. It differs from full in exactly one word, in two
  // places — the subject and the opening sentence. Nothing else.
  it('welcome text body (limited) says temporary building access', () => {
    expect(buildWelcomeTextBody(WELCOME_LIMITED)).toBe(
      [
        'Hi Jane Doe,',
        '',
        "You've been given access to Stake Building Access, the app CSNorth Stake uses to manage access to its buildings. You can now sign in and request temporary building access for Greenwood Ward.",
        '',
        'Open the app: https://stakebuildingaccess.org/',
        '',
        'Signing in: this is a Gmail address, so on the sign-in page just click "Continue with Google" and choose this account (jane@gmail.com). No password needed.',
        '',
        'For more details read the full documentation here: https://stakebuildingaccess.org/help/requesting-access.html',
      ].join('\n'),
    );
  });

  it('welcome text body (limited, non-gmail) composes both branches', () => {
    const opts: WelcomeEmailOpts = {
      ...WELCOME_LIMITED,
      memberEmail: WELCOME_NON_GMAIL.memberEmail,
      isGmail: false,
    };
    expect(buildWelcomeTextBody(opts)).toBe(
      [
        'Hi Jane Doe,',
        '',
        "You've been given access to Stake Building Access, the app CSNorth Stake uses to manage access to its buildings. You can now sign in and request temporary building access for Greenwood Ward.",
        '',
        'Open the app: https://stakebuildingaccess.org/',
        '',
        'Signing in: on the sign-in page, enter this email address (jane@csnorth.org) and click "Send me a sign-in link". You\'ll receive an email with a link that signs you in — no password needed.',
        '',
        'For more details read the full documentation here: https://stakebuildingaccess.org/help/requesting-access.html',
      ].join('\n'),
    );
  });

  // Guards against the limited branch leaking into the default path.
  it('welcome text body (full) carries no limited copy', () => {
    const full = buildWelcomeTextBody(WELCOME_GMAIL);
    expect(full).not.toContain('temporary building access');
    expect(full).toContain('request building access for the Stake and Greenwood Ward');
  });

  // The tiers deliberately share one guide URL — no anchor variant.
  it('both tiers link the same guide URL', () => {
    const guide = 'For more details read the full documentation here: ';
    const full = buildWelcomeTextBody(WELCOME_GMAIL);
    const limited = buildWelcomeTextBody(WELCOME_LIMITED);
    const tail = (body: string): string => body.slice(body.lastIndexOf(guide) + guide.length);
    expect(tail(limited)).toBe(tail(full));
    expect(tail(full)).toBe('https://stakebuildingaccess.org/help/requesting-access.html');
    expect(limited).not.toContain('#temporary');
    expect(buildWelcomeHtmlBody(WELCOME_LIMITED)).not.toContain('#temporary');
  });

  it('welcome html body (limited) says temporary building access', () => {
    const html = buildWelcomeHtmlBody(WELCOME_LIMITED);
    expect(html).toContain('request temporary building access for <strong>Greenwood Ward</strong>');
    expect(html).toContain('href="https://stakebuildingaccess.org/help/requesting-access.html"');
  });

  it('welcome html body (full) carries no limited copy', () => {
    const html = buildWelcomeHtmlBody(WELCOME_GMAIL);
    expect(html).not.toContain('temporary building access');
  });

  it('welcome html body has no heading element', () => {
    for (const opts of [WELCOME_GMAIL, WELCOME_LIMITED]) {
      const html = buildWelcomeHtmlBody(opts);
      expect(html).not.toContain('<h1');
      // The greeting is now the first element inside the wrapper.
      expect(html.split('\n')[1]).toBe('<p style="margin:0 0 16px">Hi Jane Doe,</p>');
    }
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

  // Regression: a raw `"` inside an inline style (an unquoted-with-double-
  // quotes font name) terminates the `style="…"` attribute early and every
  // declaration after it is silently dropped by the mail client.
  it('welcome html wrapper style survives attribute parsing intact', () => {
    const html = buildWelcomeHtmlBody(WELCOME_GMAIL);
    // `[^"]*` stops at the first `"` — exactly where a parser would.
    const wrapperStyle = /^<div style="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(wrapperStyle).toContain('max-width:560px');
    expect(wrapperStyle).toContain('padding:24px');
    expect(wrapperStyle).toContain('font-size:16px');
    expect(wrapperStyle).toContain('margin:0 auto');
  });

  it('no welcome html attribute value is truncated by a raw double quote', () => {
    const html = buildWelcomeHtmlBody({ ...WELCOME_GMAIL, memberName: 'Jane "JD" Doe' });
    // Every quoted attribute must close right before the tag end or the
    // next attribute — never mid-value.
    for (const m of html.matchAll(/(?:style|href)="[^"]*"(.?)/g)) {
      expect(['>', ' ']).toContain(m[1]);
    }
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
