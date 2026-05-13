// `Stake` — the parent doc for every stake per
// `docs/firebase-schema.md` §4.1. Lives at `stakes/{stakeId}` with the
// human-readable slug as the doc ID. Holds identity, operator config,
// importer source, and operational state written by server triggers.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

/** Full ISO-8601 day-of-week names — the schedule field accepts these literally. */
export type ImportDay =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

// Extension v2.1 — Kindoo site identity captured at first-run config.
// Persisted on the stake doc so every manager shares the same mapping;
// new managers don't reconfigure. `site_id` matches Kindoo's `EID`
// (the localStorage.state.sites.ids[0] value); `site_name` is captured
// at config time for drift detection.
export type KindooConfig = {
  /** Kindoo site / environment ID. Matches `EID` in Kindoo's API payloads. */
  site_id: number;
  /** Kindoo's display name for the site, captured at config time for diagnostics and drift detection. */
  site_name: string;
  configured_at: TimestampLike;
  configured_by: ActorRef;
};

/** One entry in `last_over_caps_json` — the importer's flag of a pool over its cap. */
export type OverCapEntry = {
  /** Pool identifier — `'stake'` for the stake-wide pool, otherwise a ward_code. */
  pool: 'stake' | string;
  /** Live count in the pool at the moment the importer ran. */
  count: number;
  /** Cap as configured at the time. */
  cap: number;
  /** Always `count - cap` for clarity (importer writes both rather than letting consumers re-derive). */
  over_by: number;
};

/** `stakes/{stakeId}` parent doc body — see `firebase-schema.md` §4.1. */
export type Stake = {
  // ----- Identity -----
  /** `= doc.id`. The slug (e.g. `'csnorth'`). */
  stake_id: string;
  /** Human-readable display name. */
  stake_name: string;
  /**
   * Overrides the value the extension's v2 Kindoo configuration wizard
   * compares against the Kindoo site name. Absent → comparison uses
   * `stake_name`. Set this when `stake_name` carries a label that
   * isn't part of the Kindoo site name (e.g. a `"STAGING - "` prefix
   * on the staging Firestore stake doc).
   */
  kindoo_expected_site_name?: string;
  created_at: TimestampLike;
  /** Canonical email of the platform superadmin who provisioned the stake. */
  created_by: string;

  // ----- Importer source -----
  /** Google Sheet ID of the LCR callings export. */
  callings_sheet_id: string;
  /** Typed email of the bootstrap admin (auto-added to kindooManagers on setup). */
  bootstrap_admin_email: string;
  /** True iff the bootstrap wizard has completed — gates manager UI access. */
  setup_complete: boolean;

  // ----- Capacity -----
  /** Total Kindoo seat licenses for this stake. */
  stake_seat_cap: number;

  // ----- Schedules -----
  /** Local-time hour (0–23) at which the daily expiry trigger fires for this stake. */
  expiry_hour: number;
  /** Local-time day-of-week the importer fires. */
  import_day: ImportDay;
  /** Local-time hour (0–23) the importer fires. */
  import_hour: number;
  /** IANA tz identifier (e.g. `'America/Denver'`). All schedule fields evaluate in this tz. */
  timezone: string;

  // ----- Extension v2.1 — Kindoo site config -----
  /** Optional; absent until v2.1 first-run config completes. */
  kindoo_config?: KindooConfig;

  // ----- Notifications -----
  notifications_enabled: boolean;
  /**
   * Optional reply-to address used by the email service. When unset,
   * outbound emails ship without a `Reply-To` header (replies bounce
   * off `noreply@…`). Operator-configurable so a stake can route
   * replies to its bishopric / clerk inbox.
   */
  notifications_reply_to?: string;

  // ----- Operational state (server-written) -----
  /** Pools currently over cap; written by importer at end of run. Empty array == all clear. */
  last_over_caps_json: OverCapEntry[];
  last_import_at?: TimestampLike;
  last_import_summary?: string;
  /**
   * How the most recent importer run was triggered. Read by the
   * over-cap email trigger so the subject line attributes the run
   * (`manual` vs `weekly`). Optional — when absent the trigger
   * defaults to `'manual'`.
   */
  last_import_triggered_by?: 'manual' | 'weekly';
  last_expiry_at?: TimestampLike;
  last_expiry_summary?: string;

  // ----- Bookkeeping -----
  last_modified_at: TimestampLike;
  last_modified_by: ActorRef;
  /**
   * The `lastActor` integrity-check field every domain doc carries —
   * rules verify `lastActor.canonical == request.auth.token.canonical`
   * and `lastActor.email == request.auth.token.email` on every client
   * write. Server-side (Admin SDK) writes set this to a synthetic
   * `'Importer'` / `'ExpiryTrigger'` actor.
   */
  lastActor: ActorRef;
};
