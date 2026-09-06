// Typed wrappers for the notification emails the system ships per
// `docs/spec.md` §9. Each wrapper:
//
//   1. Short-circuits if `stake.notifications_enabled === false` (the
//      operator kill-switch). This kill-switch is email-only; push has
//      its own per-user prefs.
//   2. Builds a typed payload (subject + HTML body + plain-text
//      fallback + from-address + optional reply-to).
//   3. Hands it to the Resend wrapper (`lib/resend.ts`).
//   4. On Resend error or thrown exception, writes one
//      `email_send_failed` audit row directly via Admin SDK and logs;
//      never re-throws (best-effort delivery).
//
// Body templates are pure functions exported for unit-testing without
// any Firestore dependency. Trigger code feeds them stake + request +
// link data; service-level functions wire the I/O — including the one
// wards read that turns every `scope` into a ward name.
//
// Every email ships both parts. The two must always say the same thing:
// the plain-text fallback is what a text-only client renders, so the
// only permitted difference is markup.

import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  AUDIT_TTL_MS,
  REQUESTER_GUIDE_PATH,
  auditId,
  deriveRequesterDisplay,
  formatRequesterLabel,
  isGmailAddress,
  // Resolves a ward_code to its display `ward_name`. Every email renders
  // the name, never the raw code.
  scopeLabel,
  unitType,
} from '@kindoo/shared';
import type {
  Access,
  AccessRequest,
  AuditLog,
  KindooManager,
  OverCapEntry,
  RequestType,
  Stake,
  Ward,
} from '@kindoo/shared';
import { WEB_BASE_URL } from '../lib/params.js';
import { getResendSender, type EmailPayload } from '../lib/resend.js';

/** Verified envelope per T-04. Display-name is interpolated per stake. */
const ENVELOPE = 'noreply@mail.stakebuildingaccess.org';

const SCOPE_LABEL_STAKE = 'Stake';

// Every verb ends in `for` — the lead appends the subject person.
const TYPE_LEAD_VERB: Record<RequestType, string> = {
  add_manual: 'submitted a new manual-add request for',
  add_temp: 'requested temporary access for',
  remove: 'requested removal of access for',
  edit_auto: 'requested an edit to the auto seat for',
  edit_manual: 'requested an edit to the manual seat for',
  edit_temp: 'requested an edit to the temporary seat for',
};

/** Detail-row rendering of `request.type`. Never show the raw enum. */
const TYPE_LABEL: Record<RequestType, string> = {
  add_manual: 'Manual access',
  add_temp: 'Temporary access',
  remove: 'Removal',
  edit_auto: 'Auto-seat edit',
  edit_manual: 'Manual-seat edit',
  edit_temp: 'Temporary-seat edit',
};

/** Spelled-out counts for the over-cap lead; numerals past the list. */
const COUNT_WORDS = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
];

// ---------------------------------------------------------------------------
// Helpers — pure, exported for tests.
// ---------------------------------------------------------------------------

/**
 * Build the `From:` header. Display name interpolated from the stake;
 * envelope is fixed to the verified mail subdomain.
 */
export function buildFromAddress(stake: Pick<Stake, 'stake_name'>): string {
  const stakeName = stake.stake_name?.trim() || 'Stake Building Access';
  return `${stakeName} — Stake Building Access <${ENVELOPE}>`;
}

/**
 * Read the stake's base URL and append a route. The per-stake
 * `web_base_url_override` wins over the `WEB_BASE_URL` param — see
 * {@link resolveBaseUrl} for the guard on it.
 *
 * Throws if neither is set — the trigger surface catches and writes an
 * `email_send_failed` audit row, so deploy-time misconfiguration is
 * visible-but-not-silent.
 *
 * Firebase params do NOT populate `process.env` automatically; their
 * values are reached via `.value()` at runtime. `StringParam.value()`
 * returns `''` for unset params, so the empty-check below catches both
 * "missing" and "empty string" the same way.
 */
export function buildLink(route: string, stake?: Pick<Stake, 'web_base_url_override'>): string {
  const base = resolveBaseUrl(stake);
  if (!base) {
    throw new Error('WEB_BASE_URL is not set on the function. Set it at deploy time.');
  }
  const trimmed = base.replace(/\/+$/, '');
  const path = route.startsWith('/') ? route : `/${route}`;
  return `${trimmed}${path}`;
}

/**
 * The override applies only when it trims to a non-empty `http(s)://`
 * string; anything else is logged and ignored, falling back to the
 * `WEB_BASE_URL` param exactly as if the field were absent. The scheme
 * check is the whole validation — the field is operator-only and set by
 * hand in the Firestore console, but it drives every link in every
 * email this stake sends, so a typo shouldn't be silent.
 */
function resolveBaseUrl(stake?: Pick<Stake, 'web_base_url_override'>): string {
  const override = stake?.web_base_url_override?.trim();
  if (!override) return WEB_BASE_URL.value();
  if (override.startsWith('https://') || override.startsWith('http://')) return override;
  logger.warn('web_base_url_override ignored — needs an http:// or https:// scheme', { override });
  return WEB_BASE_URL.value();
}

// ---------------------------------------------------------------------------
// Shared presentation primitives.
//
// Inline styles only — mail clients drop <style> blocks. Font names quote
// with SINGLE quotes: these strings land inside double-quoted `style="…"`
// attributes, and a `"` would terminate the attribute early and drop every
// declaration after it.
// ---------------------------------------------------------------------------

const WRAPPER =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;" +
  'font-size:16px;line-height:1.5;color:#1a202c;max-width:560px;margin:0 auto;padding:24px';
const PARA = 'margin:0 0 16px';
const BUTTON =
  'display:inline-block;background-color:#2b6cb0;color:#ffffff;text-decoration:none;' +
  'padding:12px 24px;border-radius:6px;font-weight:600';
/** Trailing call-to-action; the table above it carries the gap. */
const BUTTON_PARA = 'margin:0;text-align:center';
const LINK = 'color:#2b6cb0';
const TABLE = 'width:100%;border-collapse:collapse;margin:0 0 20px';
const TH =
  'text-align:left;padding:8px 0;border-bottom:1px solid #e2e8f0;color:#5c6b7a;font-size:13px;' +
  'font-weight:600;white-space:nowrap;vertical-align:top;width:34%';
const TD = 'text-align:left;padding:8px 0;border-bottom:1px solid #e2e8f0;vertical-align:top';
/** Figure columns: right-aligned, tabular so digits line up. */
const TH_NUM =
  'text-align:right;padding:8px 0;border-bottom:1px solid #e2e8f0;color:#5c6b7a;font-size:13px;' +
  'font-weight:600;white-space:nowrap;vertical-align:top';
const TD_NUM =
  'text-align:right;padding:8px 0;border-bottom:1px solid #e2e8f0;vertical-align:top;' +
  'font-variant-numeric:tabular-nums';
/** Chip for the one value per email that wants the reader's eye. */
const FLAG =
  'display:inline-block;background-color:#fbe9e7;color:#9b2c1c;border-radius:4px;' +
  'padding:2px 8px;font-size:13px;font-weight:600';
/** Same red as FLAG's text, for the one word the rejected lead emphasises. */
const REJECTED_WORD = '<span style="color:#9b2c1c;font-weight:600">rejected</span>';

/** Member names, stake names and ward names are user data. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Text-part label column. Values wrap under the label, not the margin. */
const TEXT_LABEL_WIDTH = 10;

function textRow(label: string, ...values: string[]): string {
  const head = `${label}:`.padEnd(TEXT_LABEL_WIDTH);
  const indent = ' '.repeat(head.length + 1);
  return values.map((v, i) => (i === 0 ? `${head} ${v}` : `${indent}${v}`)).join('\n');
}

/** One label/value row. `value` is HTML — callers escape their own data. */
function htmlRow(label: string, value: string): string {
  return `<tr><th style="${TH}">${escapeHtml(label)}</th><td style="${TD}">${value}</td></tr>`;
}

/**
 * The shape every notification email shares: a lead paragraph, a table of
 * detail rows, and one centered button. `lead` and `rows` are HTML.
 */
function htmlDocument(opts: { lead: string; rows: string[]; link: string; cta: string }): string {
  return [
    `<div style="${WRAPPER}">`,
    `<p style="${PARA}">${opts.lead}</p>`,
    `<table role="presentation" style="${TABLE}">`,
    ...opts.rows,
    `</table>`,
    `<p style="${BUTTON_PARA}"><a href="${escapeHtml(opts.link)}" style="${BUTTON}">${opts.cta}</a></p>`,
    `</div>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Subject + body builders. Pure; unit-tested independently of I/O. The
// service layer resolves `scope` to a ward name before calling in.
// ---------------------------------------------------------------------------

/** Everything the four request-lifecycle emails render from. */
export type RequestEmailOpts = {
  req: AccessRequest;
  /** `req.scope` resolved through the shared `scopeLabel`. */
  scope: string;
  link: string;
};

/** The two manager-bound emails also name who submitted. */
export type RequesterNamedEmailOpts = RequestEmailOpts & {
  /** `{Name} ({Calling})`, falling back to the raw email. */
  requesterLabel: string;
};

/** An over-cap pool with its `pool` resolved to a ward name. */
export type LabelledPool = OverCapEntry & { label: string };

export type OverCapEmailOpts = { pools: LabelledPool[]; link: string };

// ---- new request (managers) ------------------------------------------------

export function buildNewRequestSubject(o: RequesterNamedEmailOpts): string {
  return `[Stake Building Access] New request from ${o.requesterLabel} — ${o.scope}`;
}

export function buildNewRequestTextBody(o: RequesterNamedEmailOpts): string {
  const { req } = o;
  const lines: string[] = [
    newRequestLead(o),
    '',
    textRow('Request', TYPE_LABEL[req.type]),
    textRow(scopeRowLabel(req.scope, o.scope), o.scope),
    textRow('Member', ...memberLines(req)),
  ];
  if (req.reason) lines.push(textRow('Reason', req.reason));
  if (hasDates(req)) lines.push(textRow('Dates', dateRange(req)));
  if (req.comment) lines.push(textRow('Comment', req.comment));
  if (req.urgent === true) lines.push(textRow('Emergency', 'Yes'));
  lines.push('', `Review the queue: ${o.link}`);
  return lines.join('\n');
}

export function buildNewRequestHtmlBody(o: RequesterNamedEmailOpts): string {
  const { req } = o;
  const rows: string[] = [
    htmlRow('Request', escapeHtml(TYPE_LABEL[req.type])),
    htmlRow(scopeRowLabel(req.scope, o.scope), escapeHtml(o.scope)),
    htmlRow('Member', memberCell(req)),
  ];
  if (req.reason) rows.push(htmlRow('Reason', escapeHtml(req.reason)));
  if (hasDates(req)) rows.push(htmlRow('Dates', escapeHtml(dateRange(req))));
  if (req.comment) rows.push(htmlRow('Comment', escapeHtml(req.comment)));
  if (req.urgent === true) rows.push(htmlRow('Emergency', `<span style="${FLAG}">Yes</span>`));
  return htmlDocument({
    lead: escapeHtml(newRequestLead(o)),
    rows,
    link: o.link,
    cta: 'Review the queue',
  });
}

// ---- completed (requester) -------------------------------------------------

export function buildCompletedSubject(o: RequestEmailOpts): string {
  return `[Stake Building Access] Your request for ${personName(o.req)} has been completed`;
}

export function buildCompletedTextBody(o: RequestEmailOpts): string {
  const { req } = o;
  const lines: string[] = [
    `${requestLeadStem(req)} has been completed.`,
    '',
    textRow('Request', TYPE_LABEL[req.type]),
    textRow(scopeRowLabel(req.scope, o.scope), o.scope),
    textRow('Member', ...memberLines(req)),
  ];
  if (req.reason) lines.push(textRow('Reason', req.reason));
  if (req.completion_note) lines.push(textRow('Note from the manager', req.completion_note));
  lines.push('', `View your requests: ${o.link}`);
  return lines.join('\n');
}

export function buildCompletedHtmlBody(o: RequestEmailOpts): string {
  const { req } = o;
  const rows: string[] = [
    htmlRow('Request', escapeHtml(TYPE_LABEL[req.type])),
    htmlRow(scopeRowLabel(req.scope, o.scope), escapeHtml(o.scope)),
    htmlRow('Member', memberCell(req)),
  ];
  if (req.reason) rows.push(htmlRow('Reason', escapeHtml(req.reason)));
  if (req.completion_note) {
    rows.push(htmlRow('Note from the manager', escapeHtml(req.completion_note)));
  }
  return htmlDocument({
    lead: `${escapeHtml(requestLeadStem(req))} has been completed.`,
    rows,
    link: o.link,
    cta: 'View your requests',
  });
}

// ---- rejected (requester) --------------------------------------------------

export function buildRejectedSubject(o: RequestEmailOpts): string {
  return `[Stake Building Access] Your request for ${personName(o.req)} was rejected`;
}

export function buildRejectedTextBody(o: RequestEmailOpts): string {
  const { req } = o;
  return [
    `${requestLeadStem(req)} was rejected.`,
    '',
    textRow('Request', TYPE_LABEL[req.type]),
    textRow(scopeRowLabel(req.scope, o.scope), o.scope),
    textRow('Member', ...memberLines(req)),
    textRow('Reason given', rejectionReason(req)),
    '',
    `View your requests: ${o.link}`,
  ].join('\n');
}

export function buildRejectedHtmlBody(o: RequestEmailOpts): string {
  const { req } = o;
  return htmlDocument({
    lead: `${escapeHtml(requestLeadStem(req))} was ${REJECTED_WORD}.`,
    rows: [
      htmlRow('Request', escapeHtml(TYPE_LABEL[req.type])),
      htmlRow(scopeRowLabel(req.scope, o.scope), escapeHtml(o.scope)),
      htmlRow('Member', memberCell(req)),
      htmlRow('Reason given', escapeHtml(rejectionReason(req))),
    ],
    link: o.link,
    cta: 'View your requests',
  });
}

// ---- cancelled (managers) --------------------------------------------------

export function buildCancelledSubject(o: RequesterNamedEmailOpts): string {
  return `[Stake Building Access] Request cancelled by ${o.requesterLabel} — ${o.scope}`;
}

export function buildCancelledTextBody(o: RequesterNamedEmailOpts): string {
  const { req } = o;
  const lines: string[] = [
    cancelledLead(o),
    '',
    textRow('Request', TYPE_LABEL[req.type]),
    textRow(scopeRowLabel(req.scope, o.scope), o.scope),
    textRow('Member', ...memberLines(req)),
  ];
  if (req.reason) lines.push(textRow('Reason', req.reason));
  lines.push('', `Open the queue: ${o.link}`);
  return lines.join('\n');
}

export function buildCancelledHtmlBody(o: RequesterNamedEmailOpts): string {
  const { req } = o;
  const rows: string[] = [
    htmlRow('Request', escapeHtml(TYPE_LABEL[req.type])),
    htmlRow(scopeRowLabel(req.scope, o.scope), escapeHtml(o.scope)),
    htmlRow('Member', memberCell(req)),
  ];
  if (req.reason) rows.push(htmlRow('Reason', escapeHtml(req.reason)));
  return htmlDocument({
    lead: escapeHtml(cancelledLead(o)),
    rows,
    link: o.link,
    cta: 'Open the queue',
  });
}

// ---- over-cap (managers) ---------------------------------------------------

export function buildOverCapSubject(pools: LabelledPool[]): string {
  return `[Stake Building Access] ${overCapLead(pools.length)}`;
}

export function buildOverCapTextBody(o: OverCapEmailOpts): string {
  const lines: string[] = [`${overCapLead(o.pools.length)}.`, ''];
  for (const p of o.pools) {
    lines.push(`  ${p.label}: ${p.count} of ${p.cap} (over by ${p.over_by})`);
  }
  lines.push('', `View seats: ${o.link}`);
  return lines.join('\n');
}

export function buildOverCapHtmlBody(o: OverCapEmailOpts): string {
  const rows = o.pools.map(
    (p) =>
      `<tr><td style="${TD}">${escapeHtml(p.label)}</td>` +
      `<td style="${TD_NUM}">${p.count}</td>` +
      `<td style="${TD_NUM}">${p.cap}</td>` +
      `<td style="${TD_NUM}"><span style="${FLAG}">+${p.over_by}</span></td></tr>`,
  );
  return [
    `<div style="${WRAPPER}">`,
    `<p style="${PARA}">${overCapLead(o.pools.length)}.</p>`,
    `<table role="presentation" style="${TABLE}">`,
    `<tr><th style="${TH}">Pool</th><th style="${TH_NUM}">Seats</th>` +
      `<th style="${TH_NUM}">Cap</th><th style="${TH_NUM}">Over by</th></tr>`,
    ...rows,
    `</table>`,
    `<p style="${BUTTON_PARA}"><a href="${escapeHtml(o.link)}" style="${BUTTON}">View seats</a></p>`,
    `</div>`,
  ].join('\n');
}

// ---- expired temp seats / sync reminder (managers) --------------------------

/**
 * One temp grant that expired more than a day ago and is still in SBA,
 * flattened out of the seat carrying it. A seat can contribute more
 * than one — an expired grant can sit alongside a live one.
 */
export type ExpiredTempGrant = {
  memberName: string;
  memberEmail: string;
  /** Raw `scope` — `'stake'` or a ward_code. The service layer labels it. */
  scope: string;
  /** ISO `YYYY-MM-DD` the grant ran through. */
  endDate: string;
};

/** An expired grant with its `scope` resolved to a display name. */
export type LabelledExpiredTempGrant = ExpiredTempGrant & { label: string };

/**
 * One Kindoo site the stake operates that nobody has synced lately.
 *
 * The reminder's second, independent condition. It shares the mail with
 * the expired seats above because the two share one instruction — run
 * Sync — and a manager who gets two separate mails saying the same thing
 * learns to open neither.
 */
export type StaleSyncSite = {
  /** `syncHeartbeats/{stakeId}/sites` doc id — `remoteApplySiteKey` form. */
  siteKey: string;
  /** What the manager sees in Kindoo's own site switcher. */
  siteName: string;
  /** Stake-local `YYYY-MM-DD` the last Sync completed on. */
  lastSyncDate: string;
  /** Whole stake-local days since `lastSyncDate`. */
  daysSince: number;
};

export type SyncReminderEmailOpts = {
  grants: LabelledExpiredTempGrant[];
  staleSites: StaleSyncSite[];
  link: string;
};

/** Both conditions, minus the CTA the subject has no use for. */
export type SyncReminderConditions = Omit<SyncReminderEmailOpts, 'link'>;

export function buildSyncReminderSubject(o: SyncReminderConditions): string {
  return `[Stake Building Access] ${syncReminderLead(o)}`;
}

export function buildSyncReminderTextBody(o: SyncReminderEmailOpts): string {
  const lines: string[] = [`${syncReminderLead(o)}.`];
  if (o.grants.length > 0) {
    lines.push('', SYNC_REMINDER_ACTION, '');
    for (const g of o.grants) {
      lines.push(`  ${memberText(g)} — ${g.label}, ended ${g.endDate}`);
    }
  }
  if (o.staleSites.length > 0) {
    lines.push('', SYNC_STALE_ACTION, '');
    for (const s of o.staleSites) {
      lines.push(`  ${s.siteName} — last synced ${s.lastSyncDate} (${daysAgo(s.daysSince)})`);
    }
  }
  lines.push('', `View seats: ${o.link}`);
  return lines.join('\n');
}

export function buildSyncReminderHtmlBody(o: SyncReminderEmailOpts): string {
  const parts: string[] = [
    `<div style="${WRAPPER}">`,
    `<p style="${PARA}">${escapeHtml(`${syncReminderLead(o)}.`)}</p>`,
  ];
  if (o.grants.length > 0) {
    parts.push(
      `<p style="${PARA}">${escapeHtml(SYNC_REMINDER_ACTION)}</p>`,
      `<table role="presentation" style="${TABLE}">`,
      `<tr><th style="${TH}">Member</th><th style="${TH}">Scope</th><th style="${TH}">Ended</th></tr>`,
      ...o.grants.map(
        (g) =>
          `<tr><td style="${TD}">${memberHtml(g)}</td>` +
          `<td style="${TD}">${escapeHtml(g.label)}</td>` +
          `<td style="${TD}"><span style="${FLAG}">${escapeHtml(g.endDate)}</span></td></tr>`,
      ),
      `</table>`,
    );
  }
  if (o.staleSites.length > 0) {
    parts.push(
      `<p style="${PARA}">${escapeHtml(SYNC_STALE_ACTION)}</p>`,
      `<table role="presentation" style="${TABLE}">`,
      `<tr><th style="${TH}">Kindoo site</th><th style="${TH}">Last synced</th></tr>`,
      ...o.staleSites.map(
        (s) =>
          `<tr><td style="${TD}">${escapeHtml(s.siteName)}</td>` +
          `<td style="${TD}"><span style="${FLAG}">${escapeHtml(s.lastSyncDate)}</span> ` +
          `${escapeHtml(`(${daysAgo(s.daysSince)})`)}</td></tr>`,
      ),
      `</table>`,
    );
  }
  parts.push(
    `<p style="${BUTTON_PARA}"><a href="${escapeHtml(o.link)}" style="${BUTTON}">View seats</a></p>`,
    `</div>`,
  );
  return parts.join('\n');
}

/**
 * What the manager is being asked to do. The CTA can only link a page —
 * Sync itself runs in the extension — so the instruction is spelled out
 * in the body rather than carried by the button.
 */
const SYNC_REMINDER_ACTION =
  'Run Sync in the Stake Building Access extension to clear them. Until then the ward still ' +
  'sees a seat whose access has already ended, and may file a removal request for it.';

/**
 * The stale-site half. Named per site rather than "run Sync" flat,
 * because Sync is scoped to whichever Kindoo site the session is on
 * (spec §15 Phase 4) — a manager who runs it on home has not covered a
 * foreign site listed here.
 */
const SYNC_STALE_ACTION =
  'Open each site listed below in Kindoo and run Sync in the Stake Building Access extension. ' +
  'Until it runs, changes made in Kindoo are invisible in Stake Building Access.';

/**
 * The lead sentence, naming whichever conditions fired. Sentence-cased;
 * subject drops the period, the lead paragraph keeps it.
 *
 * Both clauses appear when both fired, joined — one mail, one trip to
 * the extension, and the manager can see the whole backlog at once.
 */
function syncReminderLead(o: SyncReminderConditions): string {
  const clauses: string[] = [];
  if (o.grants.length > 0) clauses.push(expiredSeatsClause(o.grants.length));
  if (o.staleSites.length > 0) {
    clauses.push(staleSitesClause(o.staleSites.length, clauses.length === 0));
  }
  // Never empty in practice — the service does not send with neither
  // condition — but a lead is a sentence, so it gets a fallback rather
  // than an empty string.
  return clauses.join(', and ') || 'Sync has not run recently';
}

function expiredSeatsClause(count: number): string {
  if (count === 1) return 'One temporary seat has expired but is still on the roster';
  return `${COUNT_WORDS[count] ?? String(count)} temporary seats have expired but are still on the roster`;
}

function staleSitesClause(count: number, capitalised: boolean): string {
  const word = COUNT_WORDS[count] ?? String(count);
  const lead = capitalised ? word : word.toLowerCase();
  return count === 1
    ? `${lead} Kindoo site has not been synced in over a week`
    : `${lead} Kindoo sites have not been synced in over a week`;
}

function daysAgo(days: number): string {
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function memberText(g: ExpiredTempGrant): string {
  const name = g.memberName?.trim();
  return name ? `${name} (${g.memberEmail})` : g.memberEmail;
}

function memberHtml(g: ExpiredTempGrant): string {
  const name = g.memberName?.trim();
  const address = escapeHtml(g.memberEmail);
  const mailto = `<a href="mailto:${address}" style="${LINK}">${address}</a>`;
  return name ? `${escapeHtml(name)}<br />${mailto}` : mailto;
}

// ---- copy fragments shared by both parts -----------------------------------

// Leads name the person, never the address — the Member row carries that.

function newRequestLead(o: RequesterNamedEmailOpts): string {
  return `${o.requesterLabel} ${TYPE_LEAD_VERB[o.req.type]} ${personName(o.req)}.`;
}

function cancelledLead(o: RequesterNamedEmailOpts): string {
  return `${o.requesterLabel} cancelled their ${typeNoun(o.req.type)} request for ${personName(o.req)}.`;
}

/** Stem the completed and rejected leads share, minus the closing verb. */
function requestLeadStem(req: AccessRequest): string {
  return `Your ${typeNoun(req.type)} request for ${personName(req)}`;
}

/** `TYPE_LABEL` mid-sentence, so lead and detail row can't drift. */
function typeNoun(type: RequestType): string {
  return TYPE_LABEL[type].toLowerCase();
}

/** Sentence-cased; subject drops the period, the lead paragraph keeps it. */
function overCapLead(count: number): string {
  if (count === 1) return 'One seat pool is over its cap';
  return `${COUNT_WORDS[count] ?? String(count)} seat pools are over their cap`;
}

/**
 * `Scope` for the stake pool; otherwise the unit's own kind, which the
 * resolved name is the only discriminator for — a stake with a branch
 * must not read `Ward: Peterson Branch`.
 */
function scopeRowLabel(scope: string, scopeName: string): string {
  if (scope === 'stake') return 'Scope';
  return unitType(scopeName) === 'branch' ? 'Branch' : 'Ward';
}

/** Display name where there is one; the address is always the fallback. */
function personName(req: AccessRequest): string {
  return req.member_name?.trim() || req.member_email;
}

/** Member cell: name on its own line, address beneath it. */
function memberLines(req: AccessRequest): string[] {
  const name = req.member_name?.trim();
  return name ? [name, req.member_email] : [req.member_email];
}

function memberCell(req: AccessRequest): string {
  const name = req.member_name?.trim();
  const address = escapeHtml(req.member_email);
  const mailto = `<a href="mailto:${address}" style="${LINK}">${address}</a>`;
  return name ? `${escapeHtml(name)}<br />${mailto}` : mailto;
}

/** A rejection with no reason still says so — silence reads as a bug. */
function rejectionReason(req: AccessRequest): string {
  return req.rejection_reason?.trim() || '(not provided)';
}

function hasDates(req: AccessRequest): boolean {
  return req.type === 'add_temp' && !!req.start_date && !!req.end_date;
}

function dateRange(req: AccessRequest): string {
  return `${req.start_date} to ${req.end_date}`;
}

// ---------------------------------------------------------------------------
// Welcome email (first app-access grant). Prose rather than detail rows —
// it goes to a member who may never have seen the app — so it builds its
// own body instead of going through `htmlDocument`.
// ---------------------------------------------------------------------------

export type WelcomeEmailOpts = {
  stakeName: string;
  memberName?: string;
  memberEmail: string;
  /** Pre-formatted by `formatScopeList`. */
  scopeList: string;
  appLink: string;
  guideLink: string;
  isGmail: boolean;
  /** D25 effective tier — see `isLimitedTier`. Narrows the copy. */
  isLimited: boolean;
};

/**
 * Join resolved scope labels into the fragment the welcome copy reads:
 * `A` / `A and B` / `A, B, and C`. `'Stake'` becomes `'the Stake'`;
 * ward names pass through. Callers order Stake first, then wards.
 */
export function formatScopeList(labels: string[]): string {
  const parts = labels.map((l) => (l === SCOPE_LABEL_STAKE ? 'the Stake' : l));
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

export function buildWelcomeSubject(scopeList: string, isLimited: boolean): string {
  const what = isLimited ? 'temporary building access' : 'building access';
  return `[Stake Building Access] You can now request ${what} for ${scopeList}`;
}

export function buildWelcomeTextBody(opts: WelcomeEmailOpts): string {
  return [
    welcomeGreeting(opts.memberName),
    '',
    `You've been given access to Stake Building Access, the app ${opts.stakeName} uses to manage access to its buildings. You can now sign in and request ${accessNoun(opts.isLimited)} for ${opts.scopeList}.`,
    '',
    `Open the app: ${opts.appLink}`,
    '',
    `Signing in: ${welcomeSignInSentence(opts.memberEmail, opts.isGmail)}`,
    '',
    `For more details read the full documentation here: ${opts.guideLink}`,
  ].join('\n');
}

export function buildWelcomeHtmlBody(opts: WelcomeEmailOpts): string {
  return [
    `<div style="${WRAPPER}">`,
    `<p style="${PARA}">${escapeHtml(welcomeGreeting(opts.memberName))}</p>`,
    `<p style="${PARA}">You&#39;ve been given access to Stake Building Access, the app ${escapeHtml(opts.stakeName)} uses to manage access to its buildings. You can now sign in and request ${accessNoun(opts.isLimited)} for <strong>${escapeHtml(opts.scopeList)}</strong>.</p>`,
    `<p style="margin:0 0 24px;text-align:center"><a href="${escapeHtml(opts.appLink)}" style="${BUTTON}">Open Stake Building Access</a></p>`,
    `<p style="${PARA}"><strong>Signing in:</strong> ${escapeHtml(welcomeSignInSentence(opts.memberEmail, opts.isGmail))}</p>`,
    `<p style="margin:0">For more details read the <a href="${escapeHtml(opts.guideLink)}" style="${LINK}">full documentation</a>.</p>`,
    `</div>`,
  ].join('\n');
}

/** What the recipient may request — the one word the tier changes. */
function accessNoun(isLimited: boolean): string {
  return isLimited ? 'temporary building access' : 'building access';
}

function welcomeGreeting(memberName?: string): string {
  const name = memberName?.trim();
  return name ? `Hi ${name},` : 'Hello,';
}

/** Sign-in instructions minus the `Signing in:` lead, shared by both parts. */
function welcomeSignInSentence(memberEmail: string, isGmail: boolean): string {
  return isGmail
    ? `this is a Gmail address, so on the sign-in page just click "Continue with Google" and choose this account (${memberEmail}). No password needed.`
    : `on the sign-in page, enter this email address (${memberEmail}) and click "Send me a sign-in link". You'll receive an email with a link that signs you in — no password needed.`;
}

// ---------------------------------------------------------------------------
// Service-level functions — wired by triggers.
// ---------------------------------------------------------------------------

type BaseDeps = {
  db: Firestore;
  stakeId: string;
  stake: Stake;
};

/** Manager-bound: new pending request submitted. */
export async function notifyManagersNewRequest(
  deps: BaseDeps & { req: AccessRequest; managerEmails: string[] },
): Promise<void> {
  const { db, stakeId, stake, req, managerEmails } = deps;
  if (!emailsEnabled(stake, stakeId, 'newRequest')) return;
  if (managerEmails.length === 0) {
    logger.info('email skipped — no active managers', {
      stakeId,
      type: 'newRequest',
    });
    return;
  }
  const link = safeBuildLink(deps, '/manager/queue');
  if (link === undefined) return;
  // Both reads sit on the send path; issue them together.
  const [requesterLabel, labelScope] = await Promise.all([
    resolveRequesterLabel(db, stakeId, req),
    loadScopeLabeller(db, stakeId),
  ]);
  const opts: RequesterNamedEmailOpts = { req, scope: labelScope(req.scope), link, requesterLabel };
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildNewRequestSubject(opts),
      text: buildNewRequestTextBody(opts),
      html: buildNewRequestHtmlBody(opts),
    }),
    context: { type: 'newRequest', requestId: req.request_id },
  });
}

/** Requester-bound: pending request flipped to complete. */
export async function notifyRequesterCompleted(
  deps: BaseDeps & { req: AccessRequest },
): Promise<void> {
  const { db, stake, req } = deps;
  if (!emailsEnabled(stake, deps.stakeId, 'completed')) return;
  const link = safeBuildLink(deps, '/my-requests');
  if (link === undefined) return;
  const labelScope = await loadScopeLabeller(db, deps.stakeId);
  const opts: RequestEmailOpts = { req, scope: labelScope(req.scope), link };
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: [req.requester_email],
      subject: buildCompletedSubject(opts),
      text: buildCompletedTextBody(opts),
      html: buildCompletedHtmlBody(opts),
    }),
    context: { type: 'completed', requestId: req.request_id },
  });
}

/** Requester-bound: pending request flipped to rejected. */
export async function notifyRequesterRejected(
  deps: BaseDeps & { req: AccessRequest },
): Promise<void> {
  const { db, stake, req } = deps;
  if (!emailsEnabled(stake, deps.stakeId, 'rejected')) return;
  const link = safeBuildLink(deps, '/my-requests');
  if (link === undefined) return;
  const labelScope = await loadScopeLabeller(db, deps.stakeId);
  const opts: RequestEmailOpts = { req, scope: labelScope(req.scope), link };
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: [req.requester_email],
      subject: buildRejectedSubject(opts),
      text: buildRejectedTextBody(opts),
      html: buildRejectedHtmlBody(opts),
    }),
    context: { type: 'rejected', requestId: req.request_id },
  });
}

/** Manager-bound: pending request flipped to cancelled by its requester. */
export async function notifyManagersCancelled(
  deps: BaseDeps & { req: AccessRequest; managerEmails: string[] },
): Promise<void> {
  const { db, stakeId, stake, req, managerEmails } = deps;
  if (!emailsEnabled(stake, stakeId, 'cancelled')) return;
  if (managerEmails.length === 0) {
    logger.info('email skipped — no active managers', { stakeId, type: 'cancelled' });
    return;
  }
  const link = safeBuildLink(deps, '/manager/queue');
  if (link === undefined) return;
  const [requesterLabel, labelScope] = await Promise.all([
    resolveRequesterLabel(db, stakeId, req),
    loadScopeLabeller(db, stakeId),
  ]);
  const opts: RequesterNamedEmailOpts = { req, scope: labelScope(req.scope), link, requesterLabel };
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildCancelledSubject(opts),
      text: buildCancelledTextBody(opts),
      html: buildCancelledHtmlBody(opts),
    }),
    context: { type: 'cancelled', requestId: req.request_id },
  });
}

/** Manager-bound: an over-cap recompute flagged at least one pool over cap. */
export async function notifyManagersOverCap(
  deps: BaseDeps & {
    pools: OverCapEntry[];
    managerEmails: string[];
  },
): Promise<void> {
  const { db, stake, pools, managerEmails } = deps;
  if (!emailsEnabled(stake, deps.stakeId, 'overCap')) return;
  if (managerEmails.length === 0) {
    logger.info('email skipped — no active managers', { stakeId: deps.stakeId, type: 'overCap' });
    return;
  }
  const link = safeBuildLink(deps, '/manager/seats');
  if (link === undefined) return;
  // One wards read labels every pool.
  const labelScope = await loadScopeLabeller(db, deps.stakeId);
  const opts: OverCapEmailOpts = {
    pools: pools.map((p) => ({ ...p, label: labelScope(p.pool) })),
    link,
  };
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildOverCapSubject(opts.pools),
      text: buildOverCapTextBody(opts),
      html: buildOverCapHtmlBody(opts),
    }),
    context: { type: 'overCap' },
  });
}

/**
 * Manager-bound: temp seats expired more than a day ago and are still
 * in SBA, waiting on a Sync.
 *
 * The stake-level kill-switch is the only gate — there is no per-user
 * email preference, so an active manager who never enabled push still
 * gets this. Push (`notificationPrefs.push.syncReminder`) is a separate
 * accelerant, not a condition on the email.
 */
export async function notifyManagersSyncReminder(
  deps: BaseDeps & {
    grants: ExpiredTempGrant[];
    staleSites: StaleSyncSite[];
    managerEmails: string[];
  },
): Promise<void> {
  const { db, stakeId, stake, grants, staleSites, managerEmails } = deps;
  if (!emailsEnabled(stake, stakeId, 'syncReminder')) return;
  if (managerEmails.length === 0) {
    logger.info('email skipped — no active managers', { stakeId, type: 'syncReminder' });
    return;
  }
  if (grants.length === 0 && staleSites.length === 0) return;
  const link = safeBuildLink(deps, '/manager/seats');
  if (link === undefined) return;
  // One wards read labels every grant. Skipped when the stale-sync half
  // is the only condition — site names come off the stake and its
  // `kindooSites`, so there is nothing to label.
  const labelScope = grants.length > 0 ? await loadScopeLabeller(db, stakeId) : () => '';
  const opts: SyncReminderEmailOpts = {
    grants: grants.map((g) => ({ ...g, label: labelScope(g.scope) })),
    staleSites,
    link,
  };
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildSyncReminderSubject(opts),
      text: buildSyncReminderTextBody(opts),
      html: buildSyncReminderHtmlBody(opts),
    }),
    // The reminder has no request id to key the `email_send_failed`
    // audit suffix on. The oldest expired grant's end date names what
    // the run was about; with no expired seats the oldest stale site's
    // last-sync date plays the same role.
    context: {
      type: 'syncReminder',
      source: grants[0]?.endDate ?? staleSites[0]?.lastSyncDate ?? 'unknown',
    },
  });
}

/** Member-bound: their access doc just gained its first scope. */
export async function notifyMemberAccessGranted(
  deps: BaseDeps & {
    memberCanonical: string;
    memberEmail: string;
    memberName?: string;
    grantedScopes: { hasStake: boolean; wards: string[] };
    /** D25 effective tier, resolved by the caller via `isLimitedTier`. */
    isLimited: boolean;
  },
): Promise<void> {
  const { db, stakeId, stake, memberCanonical, memberEmail, memberName, grantedScopes, isLimited } =
    deps;
  if (!emailsEnabled(stake, stakeId, 'accessGranted')) return;

  const labelScope = await loadScopeLabeller(db, stakeId);
  const wardLabels = grantedScopes.wards.map(labelScope);
  const scopeList = formatScopeList([
    ...(grantedScopes.hasStake ? [SCOPE_LABEL_STAKE] : []),
    ...wardLabels,
  ]);

  const appLink = safeBuildLink(deps, '/');
  if (appLink === undefined) return;
  // Same guide for both tiers.
  const guideLink = safeBuildLink(deps, REQUESTER_GUIDE_PATH);
  if (guideLink === undefined) return;

  const name = memberName?.trim();
  const opts: WelcomeEmailOpts = {
    stakeName: stake.stake_name?.trim() || 'your stake',
    ...(name ? { memberName: name } : {}),
    memberEmail,
    scopeList,
    appLink,
    guideLink,
    isGmail: isGmailAddress(memberEmail),
    isLimited,
  };

  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: [memberEmail],
      subject: buildWelcomeSubject(scopeList, isLimited),
      text: buildWelcomeTextBody(opts),
      html: buildWelcomeHtmlBody(opts),
    }),
    // `source` keys the deterministic `email_send_failed` audit id so
    // retries collapse to one row.
    context: { type: 'accessGranted', source: memberCanonical },
  });
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * One wards-collection read per invocation, returned as a resolver so a
 * caller can label any number of scopes from it (over-cap labels every
 * flagged pool). Unresolved codes fall back to the raw code.
 */
async function loadScopeLabeller(
  db: Firestore,
  stakeId: string,
): Promise<(scope: string) => string> {
  const snap = await db.collection(`stakes/${stakeId}/wards`).get();
  const wards = snap.docs.map((d) => d.data() as Ward);
  return (scope) => scopeLabel(scope, wards);
}

function emailsEnabled(stake: Stake, stakeId: string, type: string): boolean {
  if (stake.notifications_enabled === false) {
    logger.info('email skipped — notifications_enabled=false', { stakeId, type });
    return false;
  }
  return true;
}

function buildPayload(opts: {
  stake: Stake;
  to: string[];
  subject: string;
  text: string;
  html?: string;
}): EmailPayload {
  const payload: EmailPayload = {
    from: buildFromAddress(opts.stake),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  };
  if (opts.html) payload.html = opts.html;
  if (opts.stake.notifications_reply_to && opts.stake.notifications_reply_to.trim().length > 0) {
    payload.replyTo = opts.stake.notifications_reply_to.trim();
  }
  return payload;
}

/**
 * Read `WEB_BASE_URL.value()` defensively for diagnostic logging. Never
 * throws; returns `null` if even the param read errors. The
 * `safeBuildLink` log entry uses this to surface what the param
 * actually resolved to, separate from the buildLink() throw message.
 */
function tryReadWebBaseUrl(): string | null {
  try {
    return WEB_BASE_URL.value();
  } catch {
    return null;
  }
}

/** Wrap `buildLink` so a missing env var lands as an audit row, not a throw. */
function safeBuildLink(
  deps: { db: Firestore; stakeId: string; stake?: Pick<Stake, 'web_base_url_override'> },
  route: string,
): string | undefined {
  try {
    return buildLink(route, deps.stake);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const webBaseUrlValue = tryReadWebBaseUrl();
    logger.error('email skipped — link build failed', {
      stakeId: deps.stakeId,
      route,
      errorMessage: message,
      errorStack: stack,
      webBaseUrlValue,
      webBaseUrlType: typeof webBaseUrlValue,
      processEnvWebBaseUrl: process.env['WEB_BASE_URL'] ?? null,
    });
    void writeEmailFailedAudit(deps.db, deps.stakeId, {
      type: 'config',
      error: { message },
    });
    return undefined;
  }
}

async function sendOne(
  deps: { db: Firestore; stakeId: string },
  opts: {
    payload: EmailPayload;
    context: { type: string; requestId?: string; source?: string };
  },
): Promise<void> {
  const result = await getResendSender().send(opts.payload);
  if (result.ok) {
    logger.info('email sent', {
      stakeId: deps.stakeId,
      type: opts.context.type,
      to: opts.payload.to,
      messageId: result.id,
    });
    return;
  }
  logger.warn('email send failed', {
    stakeId: deps.stakeId,
    type: opts.context.type,
    to: opts.payload.to,
    error: result.error,
  });
  const audit: {
    type: string;
    error: { message: string; code?: string };
    payload?: EmailPayload;
    requestId?: string;
    source?: string;
  } = {
    type: opts.context.type,
    error: result.error,
    payload: opts.payload,
  };
  if (opts.context.requestId) audit.requestId = opts.context.requestId;
  if (opts.context.source) audit.source = opts.context.source;
  await writeEmailFailedAudit(deps.db, deps.stakeId, audit);
}

async function writeEmailFailedAudit(
  db: Firestore,
  stakeId: string,
  details: {
    type: string;
    error: { message: string; code?: string };
    payload?: EmailPayload;
    requestId?: string;
    source?: string;
  },
): Promise<void> {
  const writeTime = new Date();
  const ttl = Timestamp.fromMillis(writeTime.getTime() + AUDIT_TTL_MS);
  // Deterministic suffix so retries collapse to the same row.
  const requestKey = details.requestId ?? details.source ?? 'unknown';
  const suffix = `system_email_send_failed_${details.type}_${requestKey}`;
  const docId = auditId(writeTime, suffix);
  const row: AuditLog = {
    audit_id: docId,
    timestamp: Timestamp.fromDate(writeTime),
    actor_email: 'EmailService',
    actor_canonical: 'EmailService',
    action: 'email_send_failed',
    entity_type: 'system',
    entity_id: `email:${details.type}`,
    before: null,
    after: {
      type: details.type,
      error_message: details.error.message,
      error_code: details.error.code ?? null,
      recipients: details.payload?.to ?? [],
      subject: details.payload?.subject ?? '',
      ...(details.requestId ? { request_id: details.requestId } : {}),
      ...(details.source ? { source: details.source } : {}),
    },
    ttl,
  };
  try {
    await db.doc(`stakes/${stakeId}/auditLog/${docId}`).set(row);
  } catch (err) {
    // Defensive: the audit write itself failing should never poison
    // the trigger's calling context.
    logger.error('email_send_failed audit row could not be written', {
      stakeId,
      docId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve the requester's `{Name} ({Calling})` label live from their
 * `access` doc for the request's scope, matching the manager Queue card.
 * A Kindoo Manager may submit in any scope without an `access` row, so
 * their `kindooManagers` doc is read alongside and backstops the name +
 * calling (`{Name} (Kindoo Manager)`). Falls back to the raw
 * `requester_email` when neither yields a name (per
 * `formatRequesterLabel`).
 *
 * The two reads are issued concurrently — this sits on the manager-
 * notification send path.
 */
async function resolveRequesterLabel(
  db: Firestore,
  stakeId: string,
  req: AccessRequest,
): Promise<string> {
  const [accessSnap, managerSnap] = await Promise.all([
    db.doc(`stakes/${stakeId}/access/${req.requester_canonical}`).get(),
    db.doc(`stakes/${stakeId}/kindooManagers/${req.requester_canonical}`).get(),
  ]);
  const access = accessSnap.exists ? (accessSnap.data() as Access) : null;
  const manager = managerSnap.exists ? (managerSnap.data() as KindooManager) : null;
  return formatRequesterLabel(
    deriveRequesterDisplay(access, req.scope, manager),
    req.requester_email,
  );
}
