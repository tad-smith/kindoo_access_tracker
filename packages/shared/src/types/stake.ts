// `Stake` — the parent doc for every stake (Config-tab equivalent in
// Apps Script) per `docs/firebase-schema.md` §4.1. Lives at
// `stakes/{stakeId}` with the human-readable slug as the doc ID.
//
// The doc holds three classes of fields:
//
//   1. Identity + setup (`stake_id`, `stake_name`, `created_*`,
//      `bootstrap_admin_email`, `setup_complete`).
//   2. Operator config (`callings_sheet_id`, `stake_seat_cap`,
//      schedule fields, `notifications_enabled`, `timezone`).
//   3. Operational state written by the importer + expiry trigger
//      (`last_*` + `last_over_caps_json`).
//
// Plus the universal `lastActor` integrity-check field every domain
// doc carries.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

/** Full ISO-8601 day-of-week names — match Apps Script `Config` tab values. */
export type ImportDay =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

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

  // ----- Notifications -----
  notifications_enabled: boolean;

  // ----- Operational state (server-written) -----
  /** Pools currently over cap; written by importer at end of run. Empty array == all clear. */
  last_over_caps_json: OverCapEntry[];
  last_import_at?: TimestampLike;
  last_import_summary?: string;
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
