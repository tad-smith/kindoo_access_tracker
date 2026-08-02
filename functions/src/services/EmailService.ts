// Typed wrappers for the notification emails the system ships per
// `docs/spec.md` §9. Each wrapper:
//
//   1. Short-circuits if `stake.notifications_enabled === false` (the
//      operator kill-switch). This kill-switch is email-only; push has
//      its own per-user prefs.
//   2. Builds a typed payload (subject + plain-text body + from-address
//      + optional reply-to).
//   3. Hands it to the Resend wrapper (`lib/resend.ts`).
//   4. On Resend error or thrown exception, writes one
//      `email_send_failed` audit row directly via Admin SDK and logs;
//      never re-throws (best-effort delivery).
//
// Body templates are pure functions exported for unit-testing without
// any Firestore dependency. Trigger code feeds them stake + request +
// link data; service-level functions wire the I/O.

import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  REQUESTER_GUIDE_PATH,
  auditId,
  deriveRequesterDisplay,
  formatRequesterLabel,
  isGmailAddress,
  // Resolves a ward_code to its display `ward_name`. Aliased so it can't
  // be confused with the local `scopeLabel` below, which uppercases the
  // raw code for the five request-lifecycle emails.
  scopeLabel as wardScopeLabel,
} from '@kindoo/shared';
import type {
  Access,
  AccessRequest,
  AuditLog,
  OverCapEntry,
  RequestType,
  Stake,
  Ward,
} from '@kindoo/shared';
import { WEB_BASE_URL } from '../lib/params.js';
import { getResendSender, type EmailPayload } from '../lib/resend.js';

// 365 days in ms — same TTL the audit trigger writes.
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Verified envelope per T-04. Display-name is interpolated per stake. */
const ENVELOPE = 'noreply@mail.stakebuildingaccess.org';

const SCOPE_LABEL_STAKE = 'Stake';

const TYPE_LEAD_VERB: Record<RequestType, string> = {
  add_manual: 'submitted a new manual-add request',
  add_temp: 'requested temp access for',
  remove: 'requested removal of',
  edit_auto: 'requested an edit to the auto seat for',
  edit_manual: 'requested an edit to the manual seat for',
  edit_temp: 'requested an edit to the temp seat for',
};

const TYPE_NOUN: Record<RequestType, string> = {
  add_manual: 'manual access',
  add_temp: 'temp access',
  remove: 'removal',
  edit_auto: 'auto-seat edit',
  edit_manual: 'manual-seat edit',
  edit_temp: 'temp-seat edit',
};

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

/** Pretty scope label for subject lines. */
export function scopeLabel(scope: string): string {
  return scope === 'stake' ? SCOPE_LABEL_STAKE : scope.toUpperCase();
}

// ---------------------------------------------------------------------------
// Subject + body builders. Pure; unit-tested independently of I/O.
// ---------------------------------------------------------------------------

export function buildNewRequestSubject(req: AccessRequest, requesterLabel: string): string {
  return `[Stake Building Access] New request from ${requesterLabel} (${scopeLabel(req.scope)})`;
}

export function buildNewRequestBody(
  req: AccessRequest,
  link: string,
  requesterLabel: string,
): string {
  const lead = TYPE_LEAD_VERB[req.type];
  const subject = displayPerson(req);
  const lines: string[] = [
    `${requesterLabel} ${lead} ${subject}.`,
    '',
    `Type:      ${req.type}`,
    `Scope:     ${scopeLabel(req.scope)}`,
    `Member:    ${req.member_email}${req.member_name ? ` (${req.member_name})` : ''}`,
  ];
  if (req.reason) lines.push(`Reason:    ${req.reason}`);
  if (req.type === 'add_temp' && req.start_date && req.end_date) {
    lines.push(`Dates:     ${req.start_date} to ${req.end_date}`);
  }
  if (req.comment) lines.push(`Comment:   ${req.comment}`);
  if (req.urgent === true) lines.push(`Emergency: yes`);
  lines.push('');
  lines.push(`Review the queue: ${link}`);
  return lines.join('\n');
}

export function buildCompletedSubject(req: AccessRequest): string {
  return `[Stake Building Access] Your request for ${req.member_email} has been completed`;
}

export function buildCompletedBody(req: AccessRequest, link: string): string {
  const noun = TYPE_NOUN[req.type];
  const lines: string[] = [
    `Your request for ${noun} for ${req.member_email}${req.member_name ? ` (${req.member_name})` : ''} has been completed.`,
    '',
    `Scope:     ${scopeLabel(req.scope)}`,
    `Type:      ${req.type}`,
  ];
  if (req.completion_note) {
    lines.push('');
    lines.push(`Note: ${req.completion_note}`);
  }
  lines.push('');
  lines.push(`View your requests: ${link}`);
  return lines.join('\n');
}

export function buildRejectedSubject(_req: AccessRequest): string {
  return '[Stake Building Access] Your request was rejected';
}

export function buildRejectedBody(req: AccessRequest, link: string): string {
  const noun = TYPE_NOUN[req.type];
  const lines: string[] = [
    `Your request for ${noun} for ${req.member_email}${req.member_name ? ` (${req.member_name})` : ''} was rejected.`,
    '',
    `Scope:     ${scopeLabel(req.scope)}`,
    `Reason:    ${req.rejection_reason ?? '(not provided)'}`,
    '',
    `View your requests: ${link}`,
  ];
  return lines.join('\n');
}

export function buildCancelledSubject(req: AccessRequest, requesterLabel: string): string {
  return `[Stake Building Access] Request cancelled by ${requesterLabel}`;
}

export function buildCancelledBody(
  req: AccessRequest,
  link: string,
  requesterLabel: string,
): string {
  const noun = TYPE_NOUN[req.type];
  const lines: string[] = [
    `${requesterLabel} cancelled their request for ${noun} for ${req.member_email}${req.member_name ? ` (${req.member_name})` : ''}.`,
    '',
    `Scope:     ${scopeLabel(req.scope)}`,
    `Type:      ${req.type}`,
    '',
    `Open the queue: ${link}`,
  ];
  return lines.join('\n');
}

export function buildOverCapSubject(): string {
  return `[Stake Building Access] Over-cap warning`;
}

export function buildOverCapBody(pools: OverCapEntry[], link: string): string {
  const lines: string[] = ['One or more seat pools are over their cap:', ''];
  for (const p of pools) {
    const label = p.pool === 'stake' ? SCOPE_LABEL_STAKE : p.pool.toUpperCase();
    lines.push(`  ${label}: ${p.count} of ${p.cap} (over by ${p.over_by})`);
  }
  lines.push('');
  lines.push(`View seats: ${link}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Welcome email (first app-access grant). The only email that ships an
// HTML part — it goes to a member who may never have seen the app, so
// the call to action gets a real button. `text` remains the fallback
// part; the other five emails stay plain-text.
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

export function buildWelcomeSubject(scopeList: string): string {
  return `[Stake Building Access] You can now request building access for ${scopeList}`;
}

export function buildWelcomeTextBody(opts: WelcomeEmailOpts): string {
  return [
    welcomeGreeting(opts.memberName),
    '',
    `You've been given access to Stake Building Access, the app ${opts.stakeName} uses to manage access to its buildings. You can now sign in and request building access for ${opts.scopeList}.`,
    '',
    `Open the app: ${opts.appLink}`,
    '',
    `Signing in: ${welcomeSignInSentence(opts.memberEmail, opts.isGmail)}`,
    '',
    `For more details read the full documentation here: ${opts.guideLink}`,
  ].join('\n');
}

export function buildWelcomeHtmlBody(opts: WelcomeEmailOpts): string {
  const wrapper =
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
    'font-size:16px;line-height:1.5;color:#1a202c;max-width:560px;margin:0 auto;padding:24px';
  const para = 'margin:0 0 16px';
  const button =
    'display:inline-block;background-color:#2b6cb0;color:#ffffff;text-decoration:none;' +
    'padding:12px 24px;border-radius:6px;font-weight:600';
  return [
    `<div style="${wrapper}">`,
    `<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px">You can now request building access</h1>`,
    `<p style="${para}">${escapeHtml(welcomeGreeting(opts.memberName))}</p>`,
    `<p style="${para}">You&#39;ve been given access to Stake Building Access, the app ${escapeHtml(opts.stakeName)} uses to manage access to its buildings. You can now sign in and request building access for <strong>${escapeHtml(opts.scopeList)}</strong>.</p>`,
    `<p style="margin:0 0 24px;text-align:center"><a href="${escapeHtml(opts.appLink)}" style="${button}">Open Stake Building Access</a></p>`,
    `<p style="${para}"><strong>Signing in:</strong> ${escapeHtml(welcomeSignInSentence(opts.memberEmail, opts.isGmail))}</p>`,
    `<p style="margin:0">For more details read the <a href="${escapeHtml(opts.guideLink)}" style="color:#2b6cb0">full documentation</a>.</p>`,
    `</div>`,
  ].join('\n');
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

/** Member names, stake names and ward names are user data. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const requesterLabel = await resolveRequesterLabel(db, stakeId, req);
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildNewRequestSubject(req, requesterLabel),
      text: buildNewRequestBody(req, link, requesterLabel),
    }),
    context: { type: 'newRequest', requestId: req.request_id },
  });
}

/** Requester-bound: pending request flipped to complete. */
export async function notifyRequesterCompleted(
  deps: BaseDeps & { req: AccessRequest },
): Promise<void> {
  const { stake, req } = deps;
  if (!emailsEnabled(stake, deps.stakeId, 'completed')) return;
  const link = safeBuildLink(deps, '/my-requests');
  if (link === undefined) return;
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: [req.requester_email],
      subject: buildCompletedSubject(req),
      text: buildCompletedBody(req, link),
    }),
    context: { type: 'completed', requestId: req.request_id },
  });
}

/** Requester-bound: pending request flipped to rejected. */
export async function notifyRequesterRejected(
  deps: BaseDeps & { req: AccessRequest },
): Promise<void> {
  const { stake, req } = deps;
  if (!emailsEnabled(stake, deps.stakeId, 'rejected')) return;
  const link = safeBuildLink(deps, '/my-requests');
  if (link === undefined) return;
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: [req.requester_email],
      subject: buildRejectedSubject(req),
      text: buildRejectedBody(req, link),
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
  const requesterLabel = await resolveRequesterLabel(db, stakeId, req);
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildCancelledSubject(req, requesterLabel),
      text: buildCancelledBody(req, link, requesterLabel),
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
  const { stake, pools, managerEmails } = deps;
  if (!emailsEnabled(stake, deps.stakeId, 'overCap')) return;
  if (managerEmails.length === 0) {
    logger.info('email skipped — no active managers', { stakeId: deps.stakeId, type: 'overCap' });
    return;
  }
  const link = safeBuildLink(deps, '/manager/seats');
  if (link === undefined) return;
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildOverCapSubject(),
      text: buildOverCapBody(pools, link),
    }),
    context: { type: 'overCap' },
  });
}

/** Member-bound: their access doc just gained its first scope. */
export async function notifyMemberAccessGranted(
  deps: BaseDeps & {
    memberCanonical: string;
    memberEmail: string;
    memberName?: string;
    grantedScopes: { hasStake: boolean; wards: string[] };
  },
): Promise<void> {
  const { db, stakeId, stake, memberCanonical, memberEmail, memberName, grantedScopes } = deps;
  if (!emailsEnabled(stake, stakeId, 'accessGranted')) return;

  const wardLabels = await resolveWardLabels(db, stakeId, grantedScopes.wards);
  const scopeList = formatScopeList([
    ...(grantedScopes.hasStake ? [SCOPE_LABEL_STAKE] : []),
    ...wardLabels,
  ]);

  const appLink = safeBuildLink(deps, '/');
  if (appLink === undefined) return;
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
  };

  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: [memberEmail],
      subject: buildWelcomeSubject(scopeList),
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

/** One wards-collection read; unresolved codes fall back to the raw code. */
async function resolveWardLabels(
  db: Firestore,
  stakeId: string,
  wards: string[],
): Promise<string[]> {
  if (wards.length === 0) return [];
  const snap = await db.collection(`stakes/${stakeId}/wards`).get();
  const wardDocs = snap.docs.map((d) => d.data() as Ward);
  return wards.map((code) => wardScopeLabel(code, wardDocs));
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
  const ttl = Timestamp.fromMillis(writeTime.getTime() + TTL_MS);
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

/** Display string for the request's subject person used in body verbs. */
function displayPerson(req: AccessRequest): string {
  const name = req.member_name?.trim();
  return name ? `${name} (${req.member_email})` : req.member_email;
}

/**
 * Resolve the requester's `{Name} ({Calling})` label live from their
 * `access` doc for the request's scope, matching the manager Queue card.
 * Falls back to the raw `requester_email` when no access doc / name
 * exists (per `formatRequesterLabel`). One read per manager email send.
 */
async function resolveRequesterLabel(
  db: Firestore,
  stakeId: string,
  req: AccessRequest,
): Promise<string> {
  const snap = await db.doc(`stakes/${stakeId}/access/${req.requester_canonical}`).get();
  const access = snap.exists ? (snap.data() as Access) : null;
  return formatRequesterLabel(deriveRequesterDisplay(access, req.scope), req.requester_email);
}
