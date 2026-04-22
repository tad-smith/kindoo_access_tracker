// Time-based trigger management (architecture.md §9.3).
//
// Chunk 8 makes the daily expiry trigger real. Chunk 9 will extend this
// file with the weekly importer trigger; the shape here is designed to
// accept more handlers cleanly — the per-handler descriptor lives in
// TRIGGERS_INSTALL_PLAN_ and the install/uninstall loop is generic.
//
// Idempotency: TriggersService_install removes every existing project
// trigger that matches a planned handlerFunction BEFORE installing fresh
// ones. That covers three cases cleanly:
//   (a) first run — nothing to remove, install creates new triggers;
//   (b) re-run with same Config — old triggers removed, new ones created
//       (simpler than inspecting atHour() on each existing trigger and
//       deciding whether it matches; at 1–2 installs over the life of the
//       deployment the waste is negligible);
//   (c) Config.expiry_hour changed — re-running picks up the new hour.
//
// Manager-facing surface (ApiManager_reinstallTriggers, Configuration
// page's "Reinstall triggers" button) calls TriggersService_install too —
// same code path, same idempotency guarantee.
//
// Return shape is `{installed: [...], removed: [...], message: '...'}`
// so the bootstrap wizard's setup_complete audit row carries a meaningful
// after_json.triggers_install string and the manager UI can render a
// status chip.

// Descriptor list — add Chunk-9's weekly import here.
// - handler: function name (must exist at global scope — Apps Script
//   concatenates .gs files so 'Expiry_runExpiry' resolves even though
//   it's defined in services/Expiry.gs).
// - buildSpec: returns a TriggerBuilder-ish spec the installer can
//   translate into ScriptApp.newTrigger calls. Kept as a closure so the
//   plan can read Config at install time (expiry_hour, etc.).
function Triggers_plan_() {
  return [
    {
      handler: 'Expiry_runExpiry',
      buildSpec: function () {
        var hour = Config_get('expiry_hour');
        if (hour == null || isNaN(Number(hour))) hour = 3;
        hour = Number(hour);
        if (hour < 0 || hour > 23) {
          throw new Error('Config.expiry_hour must be 0–23, got ' + hour);
        }
        return { kind: 'daily', atHour: hour };
      }
    }
    // Chunk 9: weekly import trigger lands here.
  ];
}

function TriggersService_install() {
  var plan = Triggers_plan_();
  var plannedHandlers = {};
  for (var p = 0; p < plan.length; p++) plannedHandlers[plan[p].handler] = true;

  // Remove any existing triggers whose handlerFunction matches a planned
  // handler. We do NOT touch triggers for unknown handlers — that lets an
  // operator install a manual ad-hoc trigger (e.g. an onOpen) via the
  // Apps Script editor without TriggersService_install stomping it.
  var existing = ScriptApp.getProjectTriggers();
  var removed = [];
  for (var e = 0; e < existing.length; e++) {
    var t = existing[e];
    var fn = t.getHandlerFunction();
    if (plannedHandlers[fn]) {
      ScriptApp.deleteTrigger(t);
      removed.push(fn);
    }
  }

  var installed = [];
  var notes = [];
  for (var i = 0; i < plan.length; i++) {
    var item = plan[i];
    var spec = item.buildSpec();
    if (spec.kind === 'daily') {
      ScriptApp.newTrigger(item.handler)
        .timeBased()
        .atHour(spec.atHour)
        .everyDays(1)
        .create();
      installed.push(item.handler);
      notes.push(item.handler + ' @ ' + spec.atHour + ':00 daily');
    } else {
      throw new Error('TriggersService_install: unknown spec kind "' + spec.kind +
        '" for handler ' + item.handler);
    }
  }

  var message = '[TriggersService] installed ' + installed.length +
    ' trigger(s): ' + (notes.join('; ') || '(none)') +
    (removed.length > 0 ? ' (removed ' + removed.length + ' prior)' : '');
  Logger.log(message);
  return {
    installed: installed,
    removed:   removed,
    message:   message
  };
}

// Read-only list of the current project triggers, in a shape safe to
// return over google.script.run. Used by the Configuration page to show
// "what's installed" without the manager having to open the Apps Script
// editor.
function TriggersService_list() {
  var triggers = ScriptApp.getProjectTriggers();
  var out = [];
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    var entry = {
      handler:     t.getHandlerFunction(),
      event_type:  String(t.getEventType()),
      unique_id:   t.getUniqueId()
    };
    out.push(entry);
  }
  return out;
}
