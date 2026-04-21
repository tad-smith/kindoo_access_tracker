// Time-based trigger management for the Kindoo Access Tracker.
//
// Real trigger installation (daily Expiry_runExpiry, weekly
// Importer_runImport) lands in Chunks 8 and 9 respectively. Chunk 4 (the
// bootstrap wizard) calls TriggersService_install() at the end of setup,
// so this file has to exist and be callable now — but the body is a safe
// no-op until its owning chunks ship.
//
// The Chunk-4 changelog documents that the wizard calls this stub and why
// the real install is deferred. Replacing the stub will not require any
// changes in Bootstrap.gs — the interface (nullary function, returns a
// short report string) is stable.

function TriggersService_install() {
  // No-op in Chunks 1-4. Logged so the wizard's end-of-run audit trail and
  // any operator re-running Kindoo Admin → Install triggers can see it ran.
  // Chunk 8 will replace this with the real ScriptApp.newTrigger() calls
  // for Expiry_runExpiry; Chunk 9 adds Importer_runImport.
  var msg = '[TriggersService] install() is a no-op until Chunks 8 (expiry) ' +
            'and 9 (weekly import) ship. Called from bootstrap wizard or ' +
            'admin menu; nothing to do yet.';
  Logger.log(msg);
  return msg;
}
