// Weekly importer. Reads the LCR callings sheet via the function's
// service account, parses tabs into rows, diffs against existing
// access + seat docs, and applies the writes via Admin SDK.
//
// Per `docs/spec.md` §8 + `docs/firebase-schema.md` §4.5/§4.6:
//
//   - `importer_callings[scope]` is replaced wholesale per scope per
//     run; manual_grants is left alone (split-ownership).
//   - One Seat doc per (canonical_email) per stake; multi-calling
//     people collapse to one doc with `callings[]`.
//   - Primary scope priority: stake > ward (alphabetical ward_code).
//   - Cross-scope auto findings go to `duplicate_grants[]`.
//   - Per-row audits are emitted by the parameterized `auditTrigger`
//     (Importer stamps `lastActor='Importer'` on each write so the
//     trigger picks up the actor correctly).
//   - `import_start` / `import_end` / `over_cap_warning` audit rows
//     are written directly by this service (no entity write to fan
//     from).
//
// PARITY: the Sync Phase 2 fix callable
// `functions/src/callable/syncApplyFix.ts` mirrors the seat-upsert /
// access-upsert / access-delete bookkeeping in `applyPlan` below (and
// the `sort_order` derivation in `functions/src/lib/diff.ts`). When you
// change one side's logic — sort_order stamping, access-doc
// creation/deletion driven by `give_app_access` templates, or the
// wholesale-per-scope replacement semantics — update the other side in
// the same PR. Drift here is invisible to type-check but breaks roster
// sort + app-access grants for sync-created auto seats.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { auditId, canonicalEmail } from '@kindoo/shared';
import type {
  Access,
  AuditLog,
  Building,
  CallingTemplate,
  ImportSummary,
  OverCapEntry,
  Seat,
  Stake,
  Ward,
} from '@kindoo/shared';
import { getDb } from '../lib/admin.js';
import {
  buildTemplateIndex,
  parseTab,
  resolveTabScope,
  type ParsedRow,
  type TemplateRow,
} from '../lib/parser.js';
import {
  planDiff,
  type AccessUpsert,
  type CurrentState,
  type DiffPlan,
  type SeatWrite,
} from '../lib/diff.js';
import { computeOverCaps } from '../lib/overCaps.js';
import { getSheetFetcher, type SheetTab } from '../lib/sheets.js';
import { IMPORTER_ACTOR } from '../lib/systemActors.js';

const TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Run one importer cycle for a single stake. Caller (scheduled job /
 * callable) is responsible for selecting which stakes to run.
 *
 * `triggeredBy` is recorded only on the `import_start`/`import_end`
 * audit rows; the per-row audit `actor_canonical` is always
 * `'Importer'`.
 */
export async function runImporterForStake(opts: {
  stakeId: string;
  triggeredBy: string;
}): Promise<ImportSummary> {
  const { stakeId, triggeredBy } = opts;
  const runSource: 'manual' | 'weekly' = triggeredBy === 'weekly-trigger' ? 'weekly' : 'manual';
  const db = getDb();
  const startedMs = Date.now();

  await writeSystemAuditRow(db, stakeId, {
    action: 'import_start',
    after: { triggered_by: triggeredBy, scope: 'all' },
  });

  try {
    const result = await runImporterCore(db, stakeId);
    const elapsed = Date.now() - startedMs;
    const overCaps = await computeAndPersistOverCaps(db, stakeId);
    if (overCaps.length > 0) {
      await writeSystemAuditRow(db, stakeId, {
        action: 'over_cap_warning',
        after: { pools: overCaps, triggered_by: triggeredBy },
      });
    }
    const summary: ImportSummary = {
      ok: true,
      ...result,
      over_caps: overCaps,
      elapsed_ms: elapsed,
      triggered_by: triggeredBy,
    };
    await writeStakeImportSummary(db, stakeId, summary, runSource);
    await writeSystemAuditRow(db, stakeId, {
      action: 'import_end',
      after: {
        triggered_by: triggeredBy,
        inserted: summary.inserted,
        deleted: summary.deleted,
        updated: summary.updated,
        access_added: summary.access_added,
        access_removed: summary.access_removed,
        warnings: summary.warnings,
        skipped_tabs: summary.skipped_tabs,
        elapsed_ms: elapsed,
      },
    });
    return summary;
  } catch (err) {
    const elapsed = Date.now() - startedMs;
    const message = err instanceof Error ? err.message : String(err);
    const summary: ImportSummary = {
      ok: false,
      inserted: 0,
      deleted: 0,
      updated: 0,
      access_added: 0,
      access_removed: 0,
      warnings: [],
      skipped_tabs: [],
      over_caps: [],
      elapsed_ms: elapsed,
      triggered_by: triggeredBy,
      error: message,
    };
    await writeStakeImportSummary(db, stakeId, summary, runSource);
    await writeSystemAuditRow(db, stakeId, {
      action: 'import_end',
      after: { triggered_by: triggeredBy, error: message, elapsed_ms: elapsed },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core: parse the LCR sheet, plan the diff, apply the writes.
// ---------------------------------------------------------------------------

type CoreResult = {
  inserted: number;
  deleted: number;
  updated: number;
  access_added: number;
  access_removed: number;
  warnings: string[];
  skipped_tabs: string[];
};

async function runImporterCore(db: Firestore, stakeId: string): Promise<CoreResult> {
  const stake = await loadStake(db, stakeId);
  if (!stake.callings_sheet_id) {
    throw new Error(
      `stake.callings_sheet_id is not set on ${stakeId}. Configure the LCR sheet ID before running the importer.`,
    );
  }

  const tabs = await fetchTabs(stake.callings_sheet_id);
  const wards = await loadWards(db, stakeId);
  const wardCodes = new Set(wards.map((w) => w.ward_code));
  const wardBuildings = new Map<string, string[]>();
  for (const w of wards) {
    wardBuildings.set(w.ward_code, w.building_name ? [w.building_name] : []);
  }
  // T-42: per-scope Kindoo site map. Stake → home (null); wards → their
  // own `kindoo_site_id`. Drives `Seat.kindoo_site_id` derivation in
  // the diff planner.
  const siteByScope = new Map<string, string | null>();
  siteByScope.set('stake', null);
  for (const w of wards) {
    siteByScope.set(w.ward_code, w.kindoo_site_id ?? null);
  }
  const buildings = await loadBuildings(db, stakeId);
  const stakeBuildings = buildings.map((b) => b.building_name);
  // Stake-scope auto seats grant access to home-site buildings only
  // (spec §15 Phase 1 policy). Foreign-site buildings live on a
  // different Kindoo site's pool — the importer must not seed them
  // onto stake-scope seats.
  const stakeHomeBuildings = buildings
    .filter((b) => b.kindoo_site_id == null)
    .map((b) => b.building_name);

  const wardTpls = await loadCallingTemplates(db, stakeId, 'wardCallingTemplates');
  const stakeTpls = await loadCallingTemplates(db, stakeId, 'stakeCallingTemplates');
  const wardIndex = buildTemplateIndex(wardTpls);
  const stakeIndex = buildTemplateIndex(stakeTpls);
  // Scope-keyed template indexes the diff planner uses to resolve
  // `sheet_order` for both this-run-seen and preserved-scope callings.
  // All wards share `wardIndex` (templates are stake-wide); stake gets
  // its own.
  const templateIndexByScope = new Map<string, typeof wardIndex>();
  templateIndexByScope.set('stake', stakeIndex);
  for (const w of wards) templateIndexByScope.set(w.ward_code, wardIndex);

  const allRows: ParsedRow[] = [];
  const warnings: string[] = [];
  const skippedTabs: string[] = [];
  const scopesSeen = new Set<string>();

  for (const tab of tabs) {
    const ts = resolveTabScope(tab.name, wardCodes);
    if (ts.kind === 'skip') {
      skippedTabs.push(tab.name);
      continue;
    }
    const result = parseTab({
      tabName: tab.name,
      values: tab.values,
      scope: ts.scope,
      prefix: ts.prefix,
      templateIndex: ts.kind === 'stake' ? stakeIndex : wardIndex,
    });
    for (const r of result.rows) allRows.push(r);
    for (const w of result.warnings) {
      warnings.push(`tab "${w.tab}" row ${w.row}: ${w.message}`);
    }
    scopesSeen.add(ts.scope);
  }

  for (const w of wards) {
    if (!scopesSeen.has(w.ward_code)) {
      warnings.push(
        `No callings-sheet tab named "${w.ward_code}" — leaving existing auto-seats and access for that ward untouched.`,
      );
    }
  }

  const current = await loadCurrentState(db, stakeId);
  const plan = planDiff({
    parsedRows: allRows,
    scopesSeen,
    current,
    scopeMeta: {
      wardBuildings,
      stakeBuildings,
      stakeHomeBuildings,
      wardCodes,
      siteByScope,
      templateIndexByScope,
    },
  });
  const counters = await applyPlan(db, stakeId, current, plan);

  return {
    ...counters,
    warnings,
    skipped_tabs: skippedTabs,
  };
}

async function loadStake(db: Firestore, stakeId: string): Promise<Stake> {
  const snap = await db.doc(`stakes/${stakeId}`).get();
  if (!snap.exists) throw new Error(`stake ${stakeId} not found`);
  return snap.data() as Stake;
}

async function loadWards(db: Firestore, stakeId: string): Promise<Ward[]> {
  const snap = await db.collection(`stakes/${stakeId}/wards`).get();
  return snap.docs.map((d) => d.data() as Ward);
}

async function loadBuildings(db: Firestore, stakeId: string): Promise<Building[]> {
  const snap = await db.collection(`stakes/${stakeId}/buildings`).get();
  return snap.docs.map((d) => d.data() as Building);
}

async function loadCallingTemplates(
  db: Firestore,
  stakeId: string,
  collection: 'wardCallingTemplates' | 'stakeCallingTemplates',
): Promise<TemplateRow[]> {
  const snap = await db.collection(`stakes/${stakeId}/${collection}`).get();
  return snap.docs.map((d) => {
    const data = d.data() as CallingTemplate;
    return {
      calling_name: data.calling_name,
      give_app_access: data.give_app_access === true,
      auto_kindoo_access: data.auto_kindoo_access === true,
      sheet_order: typeof data.sheet_order === 'number' ? data.sheet_order : 0,
    };
  });
}

async function loadCurrentState(db: Firestore, stakeId: string): Promise<CurrentState> {
  const [accessSnap, seatsSnap] = await Promise.all([
    db.collection(`stakes/${stakeId}/access`).get(),
    db.collection(`stakes/${stakeId}/seats`).get(),
  ]);
  const accessByCanonical = new Map<string, Access>();
  for (const d of accessSnap.docs) accessByCanonical.set(d.id, d.data() as Access);
  const seatsByCanonical = new Map<string, Seat>();
  for (const d of seatsSnap.docs) seatsByCanonical.set(d.id, d.data() as Seat);
  return { accessByCanonical, seatsByCanonical };
}

async function fetchTabs(sheetId: string): Promise<SheetTab[]> {
  return getSheetFetcher()(sheetId);
}

// ---------------------------------------------------------------------------
// Apply the plan. Each batch of writes runs in its own write batch
// (Firestore caps batch size at 500). Idempotent by doc-ID.
// ---------------------------------------------------------------------------

async function applyPlan(
  db: Firestore,
  stakeId: string,
  current: CurrentState,
  plan: DiffPlan,
): Promise<{
  inserted: number;
  deleted: number;
  updated: number;
  access_added: number;
  access_removed: number;
}> {
  let inserted = 0;
  let deleted = 0;
  let updated = 0;
  let accessAdded = 0;
  let accessRemoved = 0;

  const now = FieldValue.serverTimestamp();
  // Per-array timestamps can't use serverTimestamp() (Firestore rejects
  // sentinel values inside arrays). Use a single client-side Timestamp
  // for any detected_at fields nested in duplicate_grants[].
  const nowTs = Timestamp.now();
  const importerActor = { ...IMPORTER_ACTOR };

  // Access upserts.
  for (const u of plan.accessUpserts) {
    const cur = current.accessByCanonical.get(u.canonical);
    const ref = db.doc(`stakes/${stakeId}/access/${u.canonical}`);
    if (cur) {
      // Skip if importer_callings byte-equal to current AND member name/email
      // and sort_order unchanged — avoids a no-op write that fires the
      // audit trigger.
      if (
        objEqualSimple(u.importer_callings, cur.importer_callings) &&
        cur.member_email === u.member_email &&
        cur.member_name === u.member_name &&
        (cur.sort_order ?? null) === u.sort_order
      ) {
        continue;
      }
      await ref.set(
        {
          importer_callings: u.importer_callings,
          member_email: u.member_email,
          member_name: u.member_name,
          sort_order: u.sort_order,
          last_modified_at: now,
          last_modified_by: importerActor,
          lastActor: importerActor,
        },
        { merge: true },
      );
      updated++;
    } else {
      await ref.set(
        {
          member_canonical: u.canonical,
          member_email: u.member_email,
          member_name: u.member_name,
          importer_callings: u.importer_callings,
          manual_grants: {},
          sort_order: u.sort_order,
          created_at: now,
          last_modified_at: now,
          last_modified_by: importerActor,
          lastActor: importerActor,
        },
        { merge: true },
      );
      accessAdded++;
    }
  }

  // Access deletes.
  for (const d of plan.accessDeletes) {
    await db.doc(`stakes/${stakeId}/access/${d.canonical}`).delete();
    accessRemoved++;
  }

  // Seat writes.
  for (const w of plan.seatWrites) {
    if (w.kind === 'auto-upsert') {
      const ref = db.doc(`stakes/${stakeId}/seats/${w.seat.member_canonical}`);
      const cur = current.seatsByCanonical.get(w.seat.member_canonical);
      const dupGrants = w.seat.duplicate_grants.map((g) => ({
        ...g,
        detected_at: cur
          ? (cur.duplicate_grants.find((c) => c.scope === g.scope)?.detected_at ?? nowTs)
          : nowTs,
      }));
      const isNew = !cur;
      await ref.set(
        {
          member_canonical: w.seat.member_canonical,
          member_email: w.seat.member_email,
          member_name: w.seat.member_name,
          scope: w.seat.scope,
          type: 'auto',
          callings: w.seat.callings,
          building_names: w.seat.building_names,
          kindoo_site_id: w.seat.kindoo_site_id,
          duplicate_grants: dupGrants,
          sort_order: w.seat.sort_order,
          ...(isNew ? { created_at: now } : {}),
          last_modified_at: now,
          last_modified_by: importerActor,
          lastActor: importerActor,
        },
        { merge: true },
      );
      if (isNew) inserted++;
      else updated++;
    } else if (w.kind === 'auto-delete') {
      await db.doc(`stakes/${stakeId}/seats/${w.canonical}`).delete();
      deleted++;
    } else if (w.kind === 'duplicates-update') {
      const ref = db.doc(`stakes/${stakeId}/seats/${w.canonical}`);
      const cur = current.seatsByCanonical.get(w.canonical);
      const dupGrants = w.duplicate_grants.map((g) => ({
        ...g,
        detected_at:
          cur?.duplicate_grants.find((c) => c.scope === g.scope && c.type === g.type)
            ?.detected_at ?? nowTs,
      }));
      await ref.set(
        {
          duplicate_grants: dupGrants,
          last_modified_at: now,
          last_modified_by: importerActor,
          lastActor: importerActor,
        },
        { merge: true },
      );
      updated++;
    }
  }

  return {
    inserted,
    deleted,
    updated,
    access_added: accessAdded,
    access_removed: accessRemoved,
  };
}

function objEqualSimple(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b ?? {}).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  for (const k of ka) {
    const av = a[k]!;
    const bv = b[k] ?? [];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Over-cap detection + persistence.
// ---------------------------------------------------------------------------

async function computeAndPersistOverCaps(db: Firestore, stakeId: string): Promise<OverCapEntry[]> {
  const [stake, wards, seatsSnap] = await Promise.all([
    db.doc(`stakes/${stakeId}`).get(),
    db.collection(`stakes/${stakeId}/wards`).get(),
    db.collection(`stakes/${stakeId}/seats`).get(),
  ]);
  const stakeData = stake.data() as Stake;
  const overCaps = computeOverCaps({
    seats: seatsSnap.docs.map((d) => d.data() as Seat),
    wards: wards.docs.map((d) => d.data() as Ward),
    stakeSeatCap: stakeData.stake_seat_cap ?? 0,
  });
  await db.doc(`stakes/${stakeId}`).set(
    {
      last_over_caps_json: overCaps,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: { ...IMPORTER_ACTOR },
      lastActor: { ...IMPORTER_ACTOR },
    },
    { merge: true },
  );
  return overCaps;
}

async function writeStakeImportSummary(
  db: Firestore,
  stakeId: string,
  summary: ImportSummary,
  runSource: 'manual' | 'weekly',
): Promise<void> {
  const summaryStr = formatImportSummary(summary);
  await db.doc(`stakes/${stakeId}`).set(
    {
      last_import_at: FieldValue.serverTimestamp(),
      last_import_summary: summaryStr,
      last_import_triggered_by: runSource,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: { ...IMPORTER_ACTOR },
      lastActor: { ...IMPORTER_ACTOR },
    },
    { merge: true },
  );
}

function formatImportSummary(s: ImportSummary): string {
  if (!s.ok) return `FAILED: ${s.error ?? 'unknown error'} (${(s.elapsed_ms / 1000).toFixed(1)}s)`;
  const parts = [
    `${s.inserted} insert${s.inserted === 1 ? '' : 's'}`,
    `${s.deleted} delete${s.deleted === 1 ? '' : 's'}`,
    `${s.updated} update${s.updated === 1 ? '' : 's'}`,
  ];
  if (s.access_added > 0 || s.access_removed > 0) {
    parts.push(`${s.access_added} access+/${s.access_removed} access-`);
  }
  if (s.warnings.length > 0) {
    parts.push(`${s.warnings.length} warning${s.warnings.length === 1 ? '' : 's'}`);
  }
  return parts.join(', ') + ` (${(s.elapsed_ms / 1000).toFixed(1)}s)`;
}

// ---------------------------------------------------------------------------
// System audit rows. Importer + Expiry write these directly because no
// underlying entity write fans out from a `import_start` /
// `over_cap_warning` event.
// ---------------------------------------------------------------------------

async function writeSystemAuditRow(
  db: Firestore,
  stakeId: string,
  opts: {
    action: 'import_start' | 'import_end' | 'over_cap_warning';
    after: Record<string, unknown>;
  },
): Promise<void> {
  const writeTime = new Date();
  const ttl = Timestamp.fromMillis(writeTime.getTime() + TTL_MS);
  const docId = auditId(writeTime, `system_${opts.action}`);
  const row: AuditLog = {
    audit_id: docId,
    timestamp: Timestamp.fromDate(writeTime),
    actor_email: IMPORTER_ACTOR.email,
    actor_canonical: IMPORTER_ACTOR.canonical,
    action: opts.action,
    entity_type: 'system',
    entity_id: opts.action,
    before: null,
    after: opts.after,
    ttl,
  };
  await db.doc(`stakes/${stakeId}/auditLog/${docId}`).set(row);
}

// Workaround: ensure canonicalEmail is referenced (kept in case future
// tweaks need it; current diff planner does the canonicalisation).
void canonicalEmail;
