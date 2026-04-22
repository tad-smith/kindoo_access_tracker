// Daily temp-seat expiry (spec §7, architecture.md §9.2).
//
// Shape mirrors the Importer (chunk-3-importer.md "Next"): wide-lock the
// full run, read once, delete matched rows, flush per-row AuditLog entries
// in a single AuditRepo_writeMany at the end. The volumes are much smaller
// than the importer (at target scale maybe 1–5 temp seats expire per week),
// but the shape stays consistent with how Chunk 3 bracketed its writes.
//
// Timezone:
//   Utils_todayIso() returns today's date (YYYY-MM-DD) in the script's
//   timezone (Session.getScriptTimeZone() — wired from appsscript.json
//   "timeZone"). Do NOT call `new Date()` + manual format here — that uses
//   UTC and would fire expiries a few hours early for users east of UTC.
//   Seats.end_date is stored as a tz-agnostic ISO date string, and the
//   daily trigger fires at Config.expiry_hour (default 03:00) in the
//   same script timezone, so the end-of-day boundary is unambiguous.
//
// Expiry rule: strictly end_date < today (lexical string compare on the
// ISO date works because YYYY-MM-DD sorts chronologically). A seat whose
// end_date equals today is still alive on its last day; it disappears on
// the next morning's run.
//
// R-1 race: if a requester submits `remove` for a temp seat and this
// trigger deletes the seat before the manager clicks Complete, Chunk 7's
// RequestsService_completeRemove_ handles it cleanly — it detects the
// absent seat and auto-completes the Request with completion_note, one
// AuditLog row. Nothing for this service to do on that interaction.
//
// Emails: spec §9 does NOT list auto-expire as an email trigger. Don't
// send one here; the `auto_expire` audit row is the trail.
//
// actor_email on every row is the literal string "ExpiryTrigger"
// (spec §3.2, data-model.md §10). Not Session.getEffectiveUser() —
// the trigger runs as the script owner, which is infrastructure, not
// authorship. (AuditRepo requires actor_email explicitly, so there's no
// accidental fallback.)

const EXPIRY_ACTOR_ = 'ExpiryTrigger';

// Public entry. Safe to call manually from the Apps Script editor (the
// `Kindoo Admin → Run expiry now` menu item triggers this) or from the
// time-based trigger installed by TriggersService_install. Returns a
// summary object so `ApiManager_reinstallTriggers` etc. callers can
// surface what happened.
function Expiry_runExpiry() {
  var started = Date.now();
  var today = Utils_todayIso();
  Logger.log('[Expiry] run start — today=' + today);

  var summary = Lock_withLock(function () {
    // Read once, then delete-by-id inside the lock so concurrent writes
    // can't insert a row in between our scan and our deletes. At target
    // scale (12 wards × ~20 seats = ~250 rows, of which a handful are
    // temp) the full scan is trivially cheap.
    var all = Seats_getAll();
    var expiring = [];
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      if (s.type !== 'temp') continue;
      if (!s.end_date) continue; // malformed temp row; skip, don't crash the run
      if (String(s.end_date) < today) expiring.push(s);
    }

    var deletedIds = [];

    if (expiring.length > 0) {
      // Delete one-by-one so we have a clean before-row per audit entry.
      // Collect the audit entries in memory; flush them all at the end in
      // one AuditRepo_writeMany (matches the Importer's batching — same
      // Lock_withLock, same AuditLog write shape).
      var auditEntries = [];
      for (var j = 0; j < expiring.length; j++) {
        var seat = expiring[j];
        var deleted = Seats_deleteById(seat.seat_id);
        if (!deleted) {
          // Defensive — the lock held since the read, so nothing else should
          // have removed the row. Log and continue rather than abort the run
          // (don't punish the remaining expiries for one odd case).
          Logger.log('[Expiry] seat_id=' + seat.seat_id +
            ' disappeared between scan and delete (unexpected under lock).');
          continue;
        }
        auditEntries.push({
          actor_email: EXPIRY_ACTOR_,
          action:      'auto_expire',
          entity_type: 'Seat',
          entity_id:   deleted.seat_id,
          before:      deleted,
          after:       null
        });
        deletedIds.push(deleted.seat_id);
      }

      if (auditEntries.length > 0) {
        AuditRepo_writeMany(auditEntries);
      }
    }

    // Write the last-run stamps on EVERY run (including runs that expire
    // zero rows), so the Dashboard's "last expiry" card always reflects
    // when the trigger most recently fired. Symmetric with the Importer's
    // Config.last_import_at / last_import_summary. Failing to write these
    // does not unwind the audit rows above — the audit trail is the
    // source of truth; Config is a convenience cache.
    var elapsedMs = Date.now() - started;
    var summary = deletedIds.length + ' row' +
      (deletedIds.length === 1 ? '' : 's') + ' expired in ' +
      elapsedMs + 'ms';
    try { Config_update('last_expiry_at', new Date()); } catch (e1) {
      Logger.log('[Expiry] last_expiry_at write failed: ' + e1);
    }
    try { Config_update('last_expiry_summary', summary); } catch (e2) {
      Logger.log('[Expiry] last_expiry_summary write failed: ' + e2);
    }

    return {
      expired:    deletedIds.length,
      ids:        deletedIds,
      elapsed_ms: elapsedMs,
      summary:    summary
    };
  }, { timeoutMs: 30000 });

  Logger.log('[Expiry] completed in ' + summary.elapsed_ms + 'ms — ' +
    summary.expired + ' row' + (summary.expired === 1 ? '' : 's') + ' expired');
  return summary;
}
