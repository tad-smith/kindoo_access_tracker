// Read-only access to the KindooManagers tab. Writes (insert/update/delete)
// land in Chunk 2 along with Lock.gs and AuditRepo.

const KINDOO_MGR_HEADERS_ = ['email', 'name', 'active'];

function KindooManagers_getAll() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('KindooManagers');
  if (!sheet) throw new Error('KindooManagers tab missing — run setupSheet().');
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  var headers = data[0];
  for (var h = 0; h < KINDOO_MGR_HEADERS_.length; h++) {
    if (String(headers[h]) !== KINDOO_MGR_HEADERS_[h]) {
      throw new Error('KindooManagers header drift at column ' + (h + 1) +
        ': expected "' + KINDOO_MGR_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var rawEmail = data[i][0];
    if (rawEmail === '' || rawEmail == null) continue;
    out.push({
      email:  Utils_normaliseEmail(String(rawEmail)),
      name:   String(data[i][1] == null ? '' : data[i][1]),
      active: data[i][2] === true ||
              String(data[i][2]).trim().toLowerCase() === 'true'
    });
  }
  return out;
}

function KindooManagers_isActiveByEmail(canonEmail) {
  var rows = KindooManagers_getAll();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].email === canonEmail && rows[i].active) return true;
  }
  return false;
}

function KindooManagers_getActiveEmails() {
  var rows = KindooManagers_getAll();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].active) out.push(rows[i].email);
  }
  return out;
}
