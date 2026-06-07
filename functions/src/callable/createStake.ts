// Superadmin-only callable: provision a new stake. Backs the Create
// Stake form on `/superadmin/stakes` (`docs/spec.md` §5.4). Reverses
// the original Phase 12 plan's CLI-only provisioning constraint (F19).
//
// Auth: gated on `request.auth.token.isPlatformSuperadmin === true`.
// The claim is the source of truth (`platformSuperadmins/{canonical}`
// → `syncSuperadminClaims` trigger → claim). A signed-in non-superadmin
// is rejected with `permission-denied`.
//
// Slug: derived from `stake_name` via the same lowercase-alnum-only
// rule `packages/shared/buildingSlug.ts` uses. Collision is detected
// inside the same transaction that writes the parent doc, so a
// concurrent retry is safe.
//
// `bootstrap_admin_email`: stored lowercased — but ONLY case is
// normalized; dots and `+suffix` are preserved verbatim. The
// `isBootstrapAdmin` rule does a plain string compare against
// `request.auth.token.email` (Firebase Auth always emits the email
// claim lowercased), so case-normalizing on write closes the operator
// typo where the form has `Foo@Bar` but Auth hands the rule
// `foo@bar`. We do NOT call `canonicalEmail()` — that strips Gmail
// dots and `+suffix`, which would silently break the bootstrap-admin
// escape hatch for operators who actually use those address variants.
// See F19 / `firebase-schema.md` §4.1 for the full rationale.
//
// `platformAuditLog`: written directly by this callable in the same
// transaction as the parent doc — this is the one place a callable
// writes an audit row directly, because the `auditTrigger` only fans
// per-stake `auditLog` rows; the cross-stake `platformAuditLog` has no
// trigger writer (`firebase-schema.md` §3.3 "Written by: the
// `createStake` Cloud Function callable").
//
// Failure envelope mirrors `syncApplyFix`:
//   - shape / auth errors → `HttpsError`
//   - domain misses (empty inputs, invalid email, invalid slug,
//     invalid timezone, slug collision) → `{ success: false, error }`
//     so the web form can render a clean inline error.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { buildingSlug, canonicalEmail, auditId } from '@kindoo/shared';
import type { CreateStakeInput, CreateStakeResult } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';

/** 365 days in ms — matches the audit TTL the `auditTrigger` stamps. */
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Default IANA tz when the operator doesn't override (F19). */
const DEFAULT_TIMEZONE = 'America/Denver';

export const createStake = onCall(
  { serviceAccount: APP_SA },
  async (req): Promise<CreateStakeResult> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    if (req.auth.token.isPlatformSuperadmin !== true) {
      throw new HttpsError('permission-denied', 'caller is not a platform superadmin');
    }

    const typedEmail = req.auth.token.email;
    if (!typedEmail) {
      throw new HttpsError('failed-precondition', 'auth token has no email');
    }
    const callerCanonical = canonicalEmail(typedEmail);
    const callerActor = { email: typedEmail, canonical: callerCanonical };

    const data = (req.data ?? {}) as Partial<CreateStakeInput>;

    // Shape validation: presence/type of the input fields. Empty-after-trim
    // is a soft failure (the form renders an inline error); wrong type is
    // a hard error (no SDK client should ever produce that shape).
    if (data.stake_name !== undefined && typeof data.stake_name !== 'string') {
      throw new HttpsError('invalid-argument', 'stake_name must be a string');
    }
    if (
      data.bootstrap_admin_email !== undefined &&
      typeof data.bootstrap_admin_email !== 'string'
    ) {
      throw new HttpsError('invalid-argument', 'bootstrap_admin_email must be a string');
    }
    if (data.timezone !== undefined && typeof data.timezone !== 'string') {
      throw new HttpsError('invalid-argument', 'timezone must be a string');
    }

    const stakeName = (data.stake_name ?? '').trim();
    if (stakeName.length === 0) {
      return { success: false, error: 'name_required' };
    }
    // Lowercase but do NOT canonicalize: dots and `+suffix` survive,
    // case is normalized so the `isBootstrapAdmin` rule's plain-string
    // compare against Firebase Auth's (always-lowercase) `email` claim
    // can't be defeated by an operator typo like `Foo@Bar` in the form.
    const bootstrapAdminEmail = (data.bootstrap_admin_email ?? '').trim().toLowerCase();
    if (bootstrapAdminEmail.length === 0) {
      return { success: false, error: 'email_required' };
    }
    // Shape check on the typed email — defense in depth alongside the
    // web's zod `.email()` validation. Same simple regex zod's HTML
    // `type=email` parser approximates: a local-part, an `@`, a domain
    // with at least one `.`, and no whitespace anywhere. Catches the
    // "typo missing TLD / missing @" cases that bypass the form (e.g.
    // a direct REST POST or an extension client). Not RFC 5322; we
    // don't need that precision at v1 scale.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapAdminEmail)) {
      return { success: false, error: 'invalid_email' };
    }

    const timezone =
      data.timezone !== undefined && data.timezone.trim().length > 0
        ? data.timezone.trim()
        : DEFAULT_TIMEZONE;

    // Validate the IANA tz before writing. The audit-log date filter and
    // other tz-sensitive paths build an `Intl.DateTimeFormat` from this
    // string; a malformed value (e.g. `'Americ/Denver'`) would throw
    // `RangeError`. Catching it here surfaces the bad input as a clean
    // soft-fail at provisioning time. Applied to BOTH the operator-typed
    // value and the default fallback (defense in depth — `'America/Denver'`
    // should never trip the check, but if it does that's a Node-runtime
    // config bug worth catching).
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return { success: false, error: 'invalid_timezone' };
    }

    const slug = buildingSlug(stakeName);
    if (slug.length === 0) {
      return { success: false, error: 'invalid_slug' };
    }

    const db = getDb();
    const stakeRef = db.doc(`stakes/${slug}`);

    // The audit doc ID is derived from the in-process write time (a
    // serverTimestamp() sentinel cannot be used to address a doc inside
    // the same transaction). We also use this single in-process
    // `Timestamp` as the value for `created_at` / `last_modified_at` on
    // the stake doc, the audit row's `timestamp`, AND the snapshot
    // mirrored to the audit `after` payload — so the audit row's
    // `after` exactly equals the body just written to `stakes/{slug}`.
    // The parameterized `auditTrigger` reads its `after` from the
    // post-write doc snapshot (server-timestamps already resolved by
    // Firestore); we get the same property here by writing concrete
    // `Timestamp` values up front rather than serverTimestamp()
    // sentinels.
    const writeTime = new Date();
    const now = Timestamp.fromDate(writeTime);
    const auditDocId = auditId(writeTime);
    const auditRef = db.doc(`platformAuditLog/${auditDocId}`);
    const auditTtl = Timestamp.fromMillis(writeTime.getTime() + TTL_MS);

    return db.runTransaction<CreateStakeResult>(async (tx) => {
      const existing = await tx.get(stakeRef);
      if (existing.exists) {
        return { success: false, error: 'slug_collision' };
      }

      const stakeBody = {
        // Identity is the doc id (the slug); no stored id field.
        stake_name: stakeName,
        // Setup
        bootstrap_admin_email: bootstrapAdminEmail,
        setup_complete: false,
        // Capacity
        stake_seat_cap: 0,
        // Schedules
        timezone,
        // Notifications
        notifications_enabled: true,
        // Operational state
        last_over_caps_json: [],
        // Bookkeeping
        created_at: now,
        last_modified_at: now,
        created_by: callerCanonical,
        last_modified_by: callerActor,
        lastActor: callerActor,
      };
      tx.set(stakeRef, stakeBody);

      tx.set(auditRef, {
        timestamp: now,
        actor_email: typedEmail,
        actor_canonical: callerCanonical,
        action: 'create_stake',
        entity_type: 'stake',
        entity_id: slug,
        before: null,
        // Full snapshot of the just-written stake doc — mirrors the
        // `auditTrigger`'s convention of stamping the post-write
        // snapshot on `after`.
        after: stakeBody,
        ttl: auditTtl,
      });

      return { success: true, stakeId: slug };
    });
  },
);
