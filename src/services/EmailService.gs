// Typed wrappers over MailApp.sendEmail for the four request-lifecycle
// notifications (spec §9). Plain-text bodies — simpler to maintain and
// more robust across the odd mail client that mangles HTML.
//
// From-address is the deployer (Main runs `executeAs: USER_DEPLOYING`, so
// MailApp sends as the deployer; open-questions.md A-2 accepts that).
// Display-name uses stake_name from Config.
//
// Every function READS active KindooManagers / stake_name once per call,
// not once per recipient (see architecture.md §9 "no N+1 reads").
//
// IMPORTANT: every call site in RequestsService invokes these OUTSIDE the
// Lock_withLock closure. MailApp.sendEmail is ~1-2 s per call; holding
// the script lock for mail I/O would starve concurrent writers. The
// pattern is:
//
//     var result = Lock_withLock(function () {
//       return RequestsService_submit({...});  // atomic write + audit
//     });
//     try {
//       EmailService_notifyManagersNewRequest(result.request, principal);
//     } catch (e) {
//       Logger.log('[EmailService] ... failed: ' + e);
//       result.warning = 'Request saved, but manager notification email failed to send.';
//     }
//
// So a mail failure never unwinds a successful write; the user sees a
// warning toast instead. See also architecture.md "Email send policy"
// section (added for Chunk 6).

// Subject-line convention:
//   - Start with "[Kindoo Access]" for trivial inbox filtering.
//   - Name the actor (requester or nothing) and target where helpful.
//   - Carry the scope so a manager scanning their inbox can triage
//     which ward the change is in without opening.

function EmailService_notifyManagersNewRequest(request, requesterPrincipal) {
  var recipients = EmailService_activeManagerEmails_();
  if (recipients.length === 0) {
    // No managers to notify — NOT an error; Chunk-2 allows a "last
    // active manager deleted" state with a warn toast. Log and return
    // silently; the audit row for the submit is already in place.
    Logger.log('[EmailService] notifyManagersNewRequest: no active managers; nothing sent.');
    return;
  }

  var scopeLabel = EmailService_scopeLabel_(request.scope);
  var requesterLabel = requesterPrincipal && requesterPrincipal.email
    ? requesterPrincipal.email
    : (request.requester_email || 'a requester');
  var targetLabel = EmailService_personLabel_(request.target_name, request.target_email);
  var typeLabel = EmailService_typeLabel_(request.type);

  var subject = '[Kindoo Access] New request from ' + requesterLabel + ' (' + scopeLabel + ')';
  var lines = [
    requesterLabel + ' submitted a new ' + typeLabel + ' request for ' + targetLabel + '.',
    '',
    'Scope: ' + scopeLabel,
    'Type: ' + typeLabel,
    'Target: ' + targetLabel,
    'Reason: ' + (request.reason || '(none)')
  ];
  if (request.comment) lines.push('Comment: ' + request.comment);
  if (request.type === 'add_temp') {
    lines.push('Start: ' + (request.start_date || '(unset)'));
    lines.push('End:   ' + (request.end_date   || '(unset)'));
  }
  lines.push('');
  lines.push('Review in the Requests Queue: ' + EmailService_managerLink_());

  EmailService_send_(recipients, subject, lines.join('\n'));
}

function EmailService_notifyRequesterCompleted(request, managerPrincipal, seat) {
  var recipient = request && request.requester_email;
  if (!recipient) {
    Logger.log('[EmailService] notifyRequesterCompleted: no requester_email on request ' + (request && request.request_id));
    return;
  }

  var scopeLabel = EmailService_scopeLabel_(request.scope);
  var targetLabel = EmailService_personLabel_(request.target_name, request.target_email);
  var typeLabel = EmailService_typeLabel_(request.type);
  var managerLabel = managerPrincipal && managerPrincipal.email ? managerPrincipal.email : 'a Kindoo Manager';

  var subject = '[Kindoo Access] Your request for ' + (request.target_email || 'a user') + ' has been completed';
  var lines = [
    managerLabel + ' marked your ' + typeLabel + ' request for ' + targetLabel + ' as complete.',
    '',
    'Scope: ' + scopeLabel,
    'Target: ' + targetLabel
  ];
  if (request.type === 'add_temp' && seat) {
    lines.push('Start: ' + (seat.start_date || '(unset)'));
    lines.push('End:   ' + (seat.end_date   || '(unset)'));
  }
  if (request.reason) lines.push('Reason: ' + request.reason);
  lines.push('');
  lines.push('See your requests: ' + EmailService_myRequestsLink_());

  EmailService_send_([recipient], subject, lines.join('\n'));
}

function EmailService_notifyRequesterRejected(request, managerPrincipal, reason) {
  var recipient = request && request.requester_email;
  if (!recipient) {
    Logger.log('[EmailService] notifyRequesterRejected: no requester_email on request ' + (request && request.request_id));
    return;
  }

  var scopeLabel = EmailService_scopeLabel_(request.scope);
  var targetLabel = EmailService_personLabel_(request.target_name, request.target_email);
  var typeLabel = EmailService_typeLabel_(request.type);
  var managerLabel = managerPrincipal && managerPrincipal.email ? managerPrincipal.email : 'a Kindoo Manager';

  var subject = '[Kindoo Access] Your request was rejected';
  var lines = [
    managerLabel + ' rejected your ' + typeLabel + ' request for ' + targetLabel + '.',
    '',
    'Scope: ' + scopeLabel,
    'Target: ' + targetLabel,
    'Rejection reason: ' + (reason || '(none provided)'),
    ''
  ];
  if (request.reason) {
    lines.push('Your original reason: ' + request.reason);
    lines.push('');
  }
  lines.push('See your requests: ' + EmailService_myRequestsLink_());

  EmailService_send_([recipient], subject, lines.join('\n'));
}

function EmailService_notifyManagersCancelled(request, requesterPrincipal) {
  var recipients = EmailService_activeManagerEmails_();
  if (recipients.length === 0) {
    Logger.log('[EmailService] notifyManagersCancelled: no active managers; nothing sent.');
    return;
  }

  var scopeLabel = EmailService_scopeLabel_(request.scope);
  var targetLabel = EmailService_personLabel_(request.target_name, request.target_email);
  var typeLabel = EmailService_typeLabel_(request.type);
  var requesterLabel = requesterPrincipal && requesterPrincipal.email
    ? requesterPrincipal.email
    : (request.requester_email || 'a requester');

  var subject = '[Kindoo Access] Request cancelled by ' + requesterLabel;
  var lines = [
    requesterLabel + ' cancelled their pending ' + typeLabel + ' request for ' + targetLabel + '.',
    '',
    'Scope: ' + scopeLabel,
    'Target: ' + targetLabel,
    'Original reason: ' + (request.reason || '(none)'),
    '',
    'No action is needed. Queue: ' + EmailService_managerLink_()
  ];
  EmailService_send_(recipients, subject, lines.join('\n'));
}

// ----------------------------------------------------------------------
// Shared helpers.
// ----------------------------------------------------------------------

// One MailApp.sendEmail call per recipient (rather than a single call with
// a `bcc` list) — keeps From / To natural in each recipient's inbox and
// lets the quota account one-per-recipient, which is what the 100/day
// consumer quota is measured in.
//
// If any one send throws, we log it and continue so the other recipients
// still get notified. If every send fails, rethrow the last error so the
// caller can surface a warning.
function EmailService_send_(recipients, subject, body) {
  // Chunk 6: global kill-switch (Config.notifications_enabled). When
  // disabled we log what WOULD have been sent (subject + recipient
  // count) so an operator can still see activity in Stackdriver, but
  // no MailApp.sendEmail calls happen. Reads the key defensively —
  // an unset / missing cell is treated as "enabled" so a fresh
  // pre-seed install does the spec-compliant thing by default.
  var enabled = true;
  try {
    var v = Config_get('notifications_enabled');
    if (v === false) enabled = false;
  } catch (e) {
    Logger.log('[EmailService] notifications_enabled read failed: ' + e + ' (defaulting to enabled)');
  }
  if (!enabled) {
    Logger.log('[EmailService] notifications disabled via Config.notifications_enabled; ' +
      'would have sent to ' + recipients.length + ' recipient' +
      (recipients.length === 1 ? '' : 's') + ': "' + subject + '"');
    return;
  }

  var stakeName = '';
  try { stakeName = Config_get('stake_name') || ''; } catch (e2) {}
  var fromName = stakeName ? (stakeName + ' — Kindoo Access') : 'Kindoo Access Tracker';

  var lastErr = null;
  var okCount = 0;
  for (var i = 0; i < recipients.length; i++) {
    var to = recipients[i];
    if (!to) continue;
    try {
      MailApp.sendEmail({
        to:      to,
        subject: subject,
        body:    body,
        name:    fromName
      });
      okCount++;
    } catch (e) {
      lastErr = e;
      Logger.log('[EmailService] send failed for ' + to + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  if (okCount === 0 && lastErr) throw lastErr;
}

function EmailService_activeManagerEmails_() {
  var out = [];
  try {
    var managers = KindooManagers_getAll();
    for (var i = 0; i < managers.length; i++) {
      if (managers[i].active && managers[i].email) out.push(managers[i].email);
    }
  } catch (e) {
    Logger.log('[EmailService] activeManagerEmails failed: ' + e);
  }
  return out;
}

function EmailService_managerLink_() {
  var mainUrl = '';
  try { mainUrl = Config_get('main_url') || ''; } catch (e) {}
  if (!mainUrl) return '(main_url not configured)';
  return mainUrl + '?p=mgr/queue';
}

function EmailService_myRequestsLink_() {
  var mainUrl = '';
  try { mainUrl = Config_get('main_url') || ''; } catch (e) {}
  if (!mainUrl) return '(main_url not configured)';
  return mainUrl + '?p=my';
}

function EmailService_scopeLabel_(scope) {
  if (!scope) return '(unknown scope)';
  if (scope === 'stake') return 'Stake Pool';
  // Look up ward_name for a prettier label; fall back to the code if the
  // Wards tab doesn't have it (deleted / never seeded).
  try {
    var ward = Wards_getByCode(scope);
    if (ward) return 'Ward ' + scope + ' (' + ward.ward_name + ')';
  } catch (e) {}
  return 'Ward ' + scope;
}

function EmailService_personLabel_(name, email) {
  var n = name ? String(name).trim() : '';
  var e = email ? String(email).trim() : '';
  if (n && e) return n + ' <' + e + '>';
  return n || e || '(unnamed)';
}

function EmailService_typeLabel_(type) {
  if (type === 'add_manual') return 'manual-add';
  if (type === 'add_temp')   return 'temp-add';
  if (type === 'remove')     return 'remove';
  return String(type || '(unknown)');
}
