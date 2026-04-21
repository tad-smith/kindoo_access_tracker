// Read-only access to the Access tab. The importer (Chunk 3) owns writes;
// no manual editing path will exist.
//
// Emails are stored as typed (preserve case + dots + +suffix); equality
// is via Utils_emailsEqual (architecture.md D4).

const ACCESS_HEADERS_ = ['email', 'scope', 'calling'];

function Access_getAll() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Access');
  if (!sheet) throw new Error('Access tab missing — run setupSheet().');
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  var headers = data[0];
  for (var h = 0; h < ACCESS_HEADERS_.length; h++) {
    if (String(headers[h]) !== ACCESS_HEADERS_[h]) {
      throw new Error('Access header drift at column ' + (h + 1) +
        ': expected "' + ACCESS_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var rawEmail = data[i][0];
    if (rawEmail === '' || rawEmail == null) continue;
    out.push({
      email:   Utils_cleanEmail(String(rawEmail)),
      scope:   String(data[i][1] == null ? '' : data[i][1]),
      calling: String(data[i][2] == null ? '' : data[i][2])
    });
  }
  return out;
}

function Access_getByEmail(email) {
  if (!email) return [];
  var all = Access_getAll();
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (Utils_emailsEqual(all[i].email, email)) out.push(all[i]);
  }
  return out;
}
