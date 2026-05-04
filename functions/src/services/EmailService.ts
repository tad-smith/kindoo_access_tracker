// Five typed wrappers for the notification emails Phase 9 ships per
// `docs/spec.md` §9 + `docs/firebase-migration.md` Phase 9. Each
// wrapper:
//
//   1. Short-circuits if `stake.notifications_enabled === false` (the
//      operator kill-switch). Per the Phase 9 plan this is email-only;
//      push has its own per-user prefs.
//   2. Builds a typed payload (subject + plain-text body + from-address
//      + optional reply-to).
//   3. Hands it to the Resend wrapper (`lib/resend.ts`).
//   4. On Resend error or thrown exception, writes one
//      `email_send_failed` audit row directly via Admin SDK and logs;
//      never re-throws (best-effort discipline matches the Apps Script
//      behaviour).
//
// Body templates are pure functions exported for unit-testing without
// any Firestore dependency. Trigger code feeds them stake + request +
// link data; service-level functions wire the I/O.

import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { auditId } from '@kindoo/shared';
import type { AccessRequest, AuditLog, OverCapEntry, RequestType, Stake } from '@kindoo/shared';
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
};

const TYPE_NOUN: Record<RequestType, string> = {
  add_manual: 'manual access',
  add_temp: 'temp access',
  remove: 'removal',
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
 * Read `WEB_BASE_URL` (Firebase Functions param) and append a route.
 * Throws if unset — the trigger surface catches and writes an
 * `email_send_failed` audit row, so deploy-time misconfiguration is
 * visible-but-not-silent.
 *
 * Firebase params do NOT populate `process.env` automatically; their
 * values are reached via `.value()` at runtime. `StringParam.value()`
 * returns `''` for unset params, so the empty-check below catches both
 * "missing" and "empty string" the same way.
 */
export function buildLink(route: string): string {
  const base = WEB_BASE_URL.value();
  if (!base) {
    throw new Error('WEB_BASE_URL is not set on the function. Set it at deploy time.');
  }
  const trimmed = base.replace(/\/+$/, '');
  const path = route.startsWith('/') ? route : `/${route}`;
  return `${trimmed}${path}`;
}

/** Pretty scope label for subject lines. */
export function scopeLabel(scope: string): string {
  return scope === 'stake' ? SCOPE_LABEL_STAKE : scope.toUpperCase();
}

// ---------------------------------------------------------------------------
// Subject + body builders. Pure; unit-tested independently of I/O.
// ---------------------------------------------------------------------------

export function buildNewRequestSubject(req: AccessRequest): string {
  return `[Stake Building Access] New request from ${req.requester_email} (${scopeLabel(req.scope)})`;
}

export function buildNewRequestBody(req: AccessRequest, link: string): string {
  const lead = TYPE_LEAD_VERB[req.type];
  const subject = displayPerson(req);
  const lines: string[] = [
    `${req.requester_email} ${lead} ${subject}.`,
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
  if (req.urgent === true) lines.push(`Urgent:    yes`);
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

export function buildCancelledSubject(req: AccessRequest): string {
  return `[Stake Building Access] Request cancelled by ${req.requester_email}`;
}

export function buildCancelledBody(req: AccessRequest, link: string): string {
  const noun = TYPE_NOUN[req.type];
  const lines: string[] = [
    `${req.requester_email} cancelled their request for ${noun} for ${req.member_email}${req.member_name ? ` (${req.member_name})` : ''}.`,
    '',
    `Scope:     ${scopeLabel(req.scope)}`,
    `Type:      ${req.type}`,
    '',
    `Open the queue: ${link}`,
  ];
  return lines.join('\n');
}

export function buildOverCapSubject(source: 'manual' | 'weekly'): string {
  return `[Stake Building Access] Over-cap warning after ${source} import`;
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
  const { stake, req, managerEmails } = deps;
  if (!emailsEnabled(stake, deps.stakeId, 'newRequest')) return;
  if (managerEmails.length === 0) {
    logger.info('email skipped — no active managers', {
      stakeId: deps.stakeId,
      type: 'newRequest',
    });
    return;
  }
  const link = safeBuildLink(deps, '/manager/queue');
  if (link === undefined) return;
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildNewRequestSubject(req),
      text: buildNewRequestBody(req, link),
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
  const { stake, req, managerEmails } = deps;
  if (!emailsEnabled(stake, deps.stakeId, 'cancelled')) return;
  if (managerEmails.length === 0) {
    logger.info('email skipped — no active managers', { stakeId: deps.stakeId, type: 'cancelled' });
    return;
  }
  const link = safeBuildLink(deps, '/manager/queue');
  if (link === undefined) return;
  await sendOne(deps, {
    payload: buildPayload({
      stake,
      to: managerEmails,
      subject: buildCancelledSubject(req),
      text: buildCancelledBody(req, link),
    }),
    context: { type: 'cancelled', requestId: req.request_id },
  });
}

/** Manager-bound: importer flagged at least one pool as over cap. */
export async function notifyManagersOverCap(
  deps: BaseDeps & {
    pools: OverCapEntry[];
    source: 'manual' | 'weekly';
    managerEmails: string[];
  },
): Promise<void> {
  const { stake, pools, source, managerEmails } = deps;
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
      subject: buildOverCapSubject(source),
      text: buildOverCapBody(pools, link),
    }),
    context: { type: 'overCap', source },
  });
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

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
}): EmailPayload {
  const payload: EmailPayload = {
    from: buildFromAddress(opts.stake),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  };
  if (opts.stake.notifications_reply_to && opts.stake.notifications_reply_to.trim().length > 0) {
    payload.replyTo = opts.stake.notifications_reply_to.trim();
  }
  return payload;
}

/** Wrap `buildLink` so a missing env var lands as an audit row, not a throw. */
function safeBuildLink(
  deps: { db: Firestore; stakeId: string },
  route: string,
): string | undefined {
  try {
    return buildLink(route);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('email skipped — link build failed', {
      stakeId: deps.stakeId,
      route,
      message,
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
