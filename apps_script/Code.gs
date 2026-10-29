/**
 * MPS Design Registry + Inventory Datasheet - backend (Google Apps Script, bound to the Google Sheet).
 *
 * Files in this project: Code.gs (this file) + Core.gs (shared logic, generated from js/core.js).
 * Setup: run setup() once (it prints the first admin login), then Deploy > New deployment > Web app
 *        (Execute as: Me, Who has access: Anyone). Copy the /exec URL into js/config.js.
 *
 * Roles:  admin    - masters (suppliers, brands, products, lists, sizes), users, settings, reports, everything
 *         entry    - creates/opens bundles, enters datasheet lines, finds designs
 *         purchase - invoice check (enters invoice quantities, sees excess/shortage, confirms)
 *
 * Every request is a POST with a JSON body {action, token, ...}. Everyone except "ping" and "login" needs a token.
 */

var SHEETS = {
  Users:       ['user_id', 'name', 'role', 'salt', 'pin_hash', 'active', 'created_at', 'last_login'],
  Suppliers:   ['supplier_id', 'name', 'city', 'agent', 'brand', 'photo_required', 'active', 'created_at'],
  Brands:      ['brand_id', 'name', 'active'],
  Products:    ['product_id', 'name', 'size_set', 'active'],
  Lists:       ['list_id', 'list', 'value', 'extra', 'active'],
  SizeSets:    ['set_id', 'name', 'sizes'],
  Designs:     ['design_id', 'design_no', 'supplier_id', 'supplier', 'supplier_code', 'fingerprint', 'photo_id', 'created_at', 'created_by', 'source', 'attrs'],
  Signatures:  ['design_id', 'supplier_id', 'signature'],
  Sightings:   ['sighting_id', 'design_id', 'design_no', 'supplier', 'type', 'timestamp', 'staff', 'photo_id', 'request_id', 'similarity', 'bundle_id'],
  Bundles:     ['bundle_id', 'supplier_id', 'supplier', 'city', 'agent', 'opened_by', 'opened_date', 'invoice_no', 'invoice_date', 'status', 'created_by', 'created_at', 'checked_by', 'checked_at', 'note'],
  Lines:       ['line_id', 'bundle_id', 'design_id', 'design_no', 'supplier_id', 'colour_names', 'colour_hex', 'size_set', 'sizes', 'total_qty', 'qc_pass', 'attrs', 'photo_id', 'entered_by', 'entered_at', 'updated_at', 'request_id', 'deleted'],
  InvoiceRows: ['bundle_id', 'design_id', 'design_no', 'invoice_qty', 'entered_by', 'entered_at'],
  Audit:       ['ts', 'user', 'action', 'entity', 'entity_id', 'detail'],
  Settings:    ['key', 'value']
};
var PHOTO_FOLDER_NAME = 'MPS Design Photos';
var GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';   // override with Script property GEMINI_MODEL
var GEMINI_MAX_CANDIDATES = 5;
var TOKEN_TTL_SEC = 21600;                       // 6 hours (the maximum Apps Script cache allows)
var MAX_PIN_FAILS = 5;
var LIST_NAMES = ['pattern', 'style', 'fit', 'sleeve', 'type', 'material', 'colour'];
var ATTR_KEYS = ['product', 'brand', 'pattern', 'style', 'fit', 'sleeve', 'type', 'material'];
var ATTR_REQUIRED = ['product', 'pattern', 'material'];

// ======================================================================================
// setup
// ======================================================================================
/** Run once from the editor. Safe to run again: it never deletes your data. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var headers = SHEETS[name], sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() >= 1) {                         // sheet from an older version with different columns: keep it, start a fresh one
      var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0];
      if (cur.join('|') !== headers.join('|')) {
        sh.setName(name + '_old_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + Math.floor(Math.random() * 1000));
        sh = null;
      }
    }
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');   // plain text: no surprise dates/numbers/formulas
    sh.setFrozenRows(1);
  });
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PEPPER')) props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());

  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    if (readAll_('Users').length === 0) {
      var pin = String(Math.floor(100000 + Math.random() * 900000));
      createUser_('Admin', 'admin', pin);
      Logger.log('FIRST LOGIN  ->  name: Admin   PIN: ' + pin + '   (you can add people and change PINs inside the app)');
    }
    if (readAll_('SizeSets').length === 0) {
      [['S - XXL', ['S', 'M', 'L', 'XL', 'XXL']], ['28 - 40 (waist)', ['28', '30', '32', '34', '36', '38', '40']], ['Free size', ['FREE']]].forEach(function (s) {
        append_('SizeSets', { set_id: nextId_('SZ', 'seq_sizeset', 3), name: s[0], sizes: s[1].join(',') });
      });
    }
    if (readAll_('Lists').length === 0) {
      var seed = {
        pattern: ['Solid', 'Stripes', 'Checks', 'Printed', 'Self design'], style: ['Casual', 'Formal', 'Party'], fit: ['Regular', 'Slim', 'Relaxed'],
        sleeve: ['FS', 'HS'], type: ['Shirt', 'T-Shirt', 'Trouser', 'Kurta'], material: ['Cotton', 'Linen', 'Polyester', 'Silk', 'Blend']
      };
      Object.keys(seed).forEach(function (l) { seed[l].forEach(function (v) { append_('Lists', { list_id: nextId_('L', 'seq_list', 4), list: l, value: v, extra: '', active: 'Y' }); }); });
      MPSCore.DEFAULT_COLOURS.forEach(function (c) { append_('Lists', { list_id: nextId_('L', 'seq_list', 4), list: 'colour', value: c[0], extra: c[1], active: 'Y' }); });
    }
    var have = {}; readAll_('Settings').forEach(function (r) { have[r.key] = true; });
    [['inactive_days', String(MPSCore.DEFAULTS.inactiveDays)], ['photo_mode', 'all'], ['sheet_title', 'MPS SILKS - KGF - Inventory Datasheet - (Readymade Product)']].forEach(function (kv) {
      if (!have[kv[0]]) append_('Settings', { key: kv[0], value: kv[1] });
    });
  } finally { lock.releaseLock(); }
  getPhotoFolder_();
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
}

// ======================================================================================
// HTTP entry points
// ======================================================================================
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'ping') return json_({ ok: true, service: 'mps-design-registry', version: 3 });
  return json_({ ok: false, code: 'BAD_ACTION', error: 'Use POST.' });
}

// action -> { roles: [...] or '*', fn }.  'public' actions need no token.
var ACTIONS = {
  ping:               { pub: true,  fn: function () { return { ok: true, service: 'mps-design-registry', version: 3 }; } },
  login:              { pub: true,  fn: function (b) { return login_(b); } },
  logout:             { roles: '*', fn: function (b) { CacheService.getScriptCache().remove('tok_' + b.token); return { ok: true }; } },
  me:                 { roles: '*', fn: function (b, u) { return { ok: true, user: publicUser_(u) }; } },
  'masters.get':      { roles: '*', fn: function (b, u) { return mastersGet_(b, u); } },
  'masters.save':     { roles: ['admin'], fn: function (b, u) { return mastersSave_(b, u); } },
  'users.list':       { roles: ['admin'], fn: function () { return usersList_(); } },
  'users.save':       { roles: ['admin'], fn: function (b, u) { return usersSave_(b, u); } },
  'designs.list':     { roles: '*', fn: function (b) { return designsList_(b); } },
  'designs.signatures': { roles: '*', fn: function (b) { return designsSignatures_(b); } },
  'designs.verify':   { roles: ['admin', 'entry'], fn: function (b) { return verify_(b); } },
  'designs.suggest':  { roles: ['admin', 'entry'], fn: function (b) { return suggest_(b); } },
  'designs.update':   { roles: ['admin'], fn: function (b, u) { return designUpdate_(b, u); } },
  register:           { roles: ['admin', 'entry'], fn: function (b, u) { return register_(b, u); } },
  'bundles.list':     { roles: '*', fn: function (b) { return bundlesList_(b); } },
  'bundles.create':   { roles: ['admin', 'entry'], fn: function (b, u) { return bundleCreate_(b, u); } },
  'bundles.get':      { roles: '*', fn: function (b, u) { return bundleGet_(b, u); } },
  'bundles.update':   { roles: ['admin', 'entry'], fn: function (b, u) { return bundleUpdate_(b, u); } },
  'photos.get':       { roles: '*', fn: function (b) { return photosGet_(b); } },
  'bundles.reopen':   { roles: ['admin'], fn: function (b, u) { return bundleReopen_(b, u); } },
  'line.save':        { roles: ['admin', 'entry'], fn: function (b, u) { return lineSave_(b, u); } },
  'line.delete':      { roles: ['admin', 'entry'], fn: function (b, u) { return lineDelete_(b, u); } },
  'invoice.get':      { roles: ['admin', 'purchase'], fn: function (b) { return invoiceGet_(b); } },
  'invoice.save':     { roles: ['admin', 'purchase'], fn: function (b, u) { return invoiceSave_(b, u); } },
  'invoice.confirm':  { roles: ['admin', 'purchase'], fn: function (b, u) { return invoiceConfirm_(b, u); } },
  'reports.get':      { roles: ['admin'], fn: function () { return reportsGet_(); } }
};

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);               // sent as text/plain to avoid a CORS preflight
    var def = ACTIONS[body.action];
    if (!def) return json_({ ok: false, code: 'BAD_ACTION', error: 'Unknown action.' });
    var user = null;
    if (!def.pub) {
      user = userFromToken_(body.token);
      if (!user) return json_({ ok: false, code: 'AUTH', error: 'Please sign in again.' });
      if (def.roles !== '*' && def.roles.indexOf(user.role) < 0) return json_({ ok: false, code: 'FORBIDDEN', error: 'Your login is not allowed to do this.' });
    }
    return json_(def.fn(body, user));
  } catch (err) {
    return json_(errorBody_(err));
  }
}

// ======================================================================================
// login, users
// ======================================================================================
function hashPin_(salt, pin) {
  var pepper = PropertiesService.getScriptProperties().getProperty('PEPPER') || '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin + ':' + pepper);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b) + 256).toString(16).slice(1); }).join('');
}
function publicUser_(u) { return { user_id: u.user_id, name: u.name, role: u.role }; }
function createUser_(name, role, pin) {
  var salt = Utilities.getUuid();
  var id = nextId_('U', 'seq_user', 3);
  append_('Users', { user_id: id, name: name, role: role, salt: salt, pin_hash: hashPin_(salt, pin), active: 'Y', created_at: new Date().toISOString(), last_login: '' });
  return id;
}
function login_(b) {
  var name = String(b.name || '').trim(), pin = String(b.pin || '').trim();
  if (!name || !pin) throw fail_('VALIDATION', ['Enter your name and PIN.']);
  var cache = CacheService.getScriptCache(), failKey = 'fail_' + name.toLowerCase();
  if (Number(cache.get(failKey) || 0) >= MAX_PIN_FAILS) throw fail_('LOCKED', ['Too many wrong PINs. Try again in 10 minutes.']);
  var user = null;
  readAll_('Users', true).forEach(function (u) { if (u.name.toLowerCase() === name.toLowerCase() && u.active === 'Y') user = u; });
  if (!user || hashPin_(user.salt, pin) !== user.pin_hash) {
    cache.put(failKey, String(Number(cache.get(failKey) || 0) + 1), 600);
    throw fail_('AUTH', ['Wrong name or PIN.']);
  }
  cache.remove(failKey);
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('tok_' + token, JSON.stringify(publicUser_(user)), TOKEN_TTL_SEC);
  updateRow_('Users', user._row, { last_login: new Date().toISOString() });
  return { ok: true, token: token, expiresInSec: TOKEN_TTL_SEC, user: publicUser_(user) };
}
function userFromToken_(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get('tok_' + token);
  if (!raw) return null;
  var u = JSON.parse(raw), cur = null;
  readAll_('Users').forEach(function (x) { if (x.user_id === u.user_id) cur = x; });     // role/active changes apply immediately
  if (!cur || cur.active !== 'Y') return null;
  return publicUser_(cur);
}
function usersList_() {
  return { ok: true, users: readAll_('Users').map(function (u) { return { user_id: u.user_id, name: u.name, role: u.role, active: u.active, created_at: u.created_at, last_login: u.last_login }; }) };
}
function usersSave_(b, admin) {
  var errors = [], name = String(b.name || '').trim(), role = b.role, pin = b.pin == null ? '' : String(b.pin).trim();
  if (name.length < 2 || name.length > 40) errors.push('Name must be 2 to 40 characters.');
  if (['admin', 'entry', 'purchase'].indexOf(role) < 0) errors.push('Choose a role.');
  if (pin && !/^\d{4,8}$/.test(pin)) errors.push('PIN must be 4 to 8 digits.');
  if (!b.user_id && !pin) errors.push('Set a PIN for the new person.');
  if (errors.length) throw fail_('VALIDATION', errors);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var all = readAll_('Users', true), me = null;
    all.forEach(function (u) { if (u.user_id === b.user_id) me = u; });
    all.forEach(function (u) { if (u.name.toLowerCase() === name.toLowerCase() && u.user_id !== b.user_id) throw fail_('VALIDATION', ['Someone with this name already exists.']); });
    var active = b.active === false || b.active === 'N' ? 'N' : 'Y';
    if (me) {
      var admins = all.filter(function (u) { return u.role === 'admin' && u.active === 'Y' && u.user_id !== me.user_id; }).length;
      if (admins === 0 && (role !== 'admin' || active !== 'Y')) throw fail_('VALIDATION', ['There must always be at least one active admin.']);
      var patch = { name: name, role: role, active: active };
      if (pin) { var salt = Utilities.getUuid(); patch.salt = salt; patch.pin_hash = hashPin_(salt, pin); }
      updateRow_('Users', me._row, patch);
      audit_(admin, 'user.update', 'user', me.user_id, name + ' (' + role + ')' + (pin ? ' PIN changed' : ''));
      return { ok: true, user_id: me.user_id };
    }
    var id = createUser_(name, role, pin);
    audit_(admin, 'user.create', 'user', id, name + ' (' + role + ')');
    return { ok: true, user_id: id };
  } finally { lock.releaseLock(); }
}

// ======================================================================================
// masters
// ======================================================================================
function mastersGet_(b, u) {
  var all = u.role === 'admin' && b.all === true, keep = function (r) { return all || r.active === 'Y'; };
  var lists = {}; LIST_NAMES.forEach(function (n) { lists[n] = []; });
  readAll_('Lists').forEach(function (r) { if (keep(r) && lists[r.list]) lists[r.list].push({ list_id: r.list_id, value: r.value, extra: r.extra, active: r.active }); });
  var settings = readSettings_();
  return {
    ok: true,
    suppliers: readAll_('Suppliers').filter(keep).map(function (r) { return { supplier_id: r.supplier_id, name: r.name, city: r.city, agent: r.agent, brand: r.brand, photo_required: r.photo_required, active: r.active }; }),
    brands: readAll_('Brands').filter(keep).map(function (r) { return { brand_id: r.brand_id, name: r.name, active: r.active }; }),
    products: readAll_('Products').filter(keep).map(function (r) { return { product_id: r.product_id, name: r.name, size_set: r.size_set, active: r.active }; }),
    lists: lists,
    sizeSets: readAll_('SizeSets').map(function (r) { return { set_id: r.set_id, name: r.name, sizes: String(r.sizes).split(',').filter(Boolean) }; }),
    settings: { photo_mode: settings.photo_mode || 'all', inactive_days: settings.inactive_days || '90', sheet_title: settings.sheet_title || '' }
  };
}
function boolYN_(v) { return v === true || v === 'Y' || v === 'y' ? 'Y' : 'N'; }
function mastersSave_(b, admin) {
  var item = b.item || {}, kind = b.kind, errors = [];
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var name = String(item.name == null ? '' : item.name).replace(/\s+/g, ' ').trim();
    function needName() { if (name.length < 1 || name.length > 80) errors.push('Name is required (max 80 characters).'); }
    function unique(sheet, idCol) { readAll_(sheet).forEach(function (r) { if (r.name.toLowerCase() === name.toLowerCase() && r[idCol] !== item[idCol]) errors.push('"' + name + '" already exists.'); }); }
    function done(sheet, idCol, prefix, seq, pad, fields) {
      if (errors.length) throw fail_('VALIDATION', errors);
      var existing = null; readAll_(sheet, true).forEach(function (r) { if (item[idCol] && r[idCol] === item[idCol]) existing = r; });
      if (item[idCol] && !existing) throw fail_('NOT_FOUND', ['Not found.']);
      if (existing) { updateRow_(sheet, existing._row, fields); audit_(admin, 'master.update', sheet, existing[idCol], JSON.stringify(fields)); return { ok: true, id: existing[idCol] }; }
      var id = nextId_(prefix, seq, pad), row = {}; row[idCol] = id; Object.keys(fields).forEach(function (k) { row[k] = fields[k]; });
      append_(sheet, row); audit_(admin, 'master.create', sheet, id, JSON.stringify(fields)); return { ok: true, id: id };
    }
    if (kind === 'supplier') {
      needName(); unique('Suppliers', 'supplier_id');
      var f = { name: name, city: String(item.city || '').trim().slice(0, 60), agent: String(item.agent || '').trim().slice(0, 60), brand: String(item.brand || '').trim().slice(0, 80),
                photo_required: boolYN_(item.photo_required), active: item.active === false || item.active === 'N' ? 'N' : 'Y' };
      if (!item.supplier_id) f.created_at = new Date().toISOString();
      return done('Suppliers', 'supplier_id', 'S', 'seq_supplier', 4, f);
    }
    if (kind === 'brand') { needName(); unique('Brands', 'brand_id'); return done('Brands', 'brand_id', 'BR', 'seq_brand', 4, { name: name, active: item.active === false || item.active === 'N' ? 'N' : 'Y' }); }
    if (kind === 'product') {
      needName(); unique('Products', 'product_id');
      var setOk = false; readAll_('SizeSets').forEach(function (s) { if (s.set_id === item.size_set) setOk = true; });
      if (!setOk) errors.push('Choose a size set for this product.');
      return done('Products', 'product_id', 'P', 'seq_product', 4, { name: name, size_set: item.size_set, active: item.active === false || item.active === 'N' ? 'N' : 'Y' });
    }
    if (kind === 'list') {
      var ln = item.list, value = String(item.value == null ? '' : item.value).replace(/\s+/g, ' ').trim(), extra = String(item.extra || '').trim();
      if (LIST_NAMES.indexOf(ln) < 0) errors.push('Unknown list.');
      if (value.length < 1 || value.length > 40) errors.push('Value is required (max 40 characters).');
      if (ln === 'colour' && !/^#[0-9a-fA-F]{6}$/.test(extra)) errors.push('A colour needs a hex code like #c9a01f.');
      readAll_('Lists').forEach(function (r) { if (r.list === ln && r.value.toLowerCase() === value.toLowerCase() && r.list_id !== item.list_id) errors.push('"' + value + '" is already in this list.'); });
      return done('Lists', 'list_id', 'L', 'seq_list', 4, { list: ln, value: value, extra: ln === 'colour' ? extra.toLowerCase() : '', active: item.active === false || item.active === 'N' ? 'N' : 'Y' });
    }
    if (kind === 'sizeset') {
      needName(); unique('SizeSets', 'set_id');
      var sizes = (item.sizes || []).map(function (s) { return String(s).trim(); }).filter(Boolean), seen = {};
      if (!sizes.length || sizes.length > 20) errors.push('A size set needs 1 to 20 sizes.');
      sizes.forEach(function (s) { if (s.length > 10 || s.indexOf(',') > -1) errors.push('Size "' + s + '" is not valid.'); if (seen[s]) errors.push('Size "' + s + '" is repeated.'); seen[s] = 1; });
      return done('SizeSets', 'set_id', 'SZ', 'seq_sizeset', 3, { name: name, sizes: sizes.join(',') });
    }
    if (kind === 'settings') {
      var days = parseInt(item.inactive_days, 10);
      if (item.photo_mode !== 'all' && item.photo_mode !== 'selected') errors.push('Photo setting must be "all" or "selected".');
      if (isNaN(days) || days < 1 || days > 1000) errors.push('Inactive days must be between 1 and 1000.');
      var title = String(item.sheet_title || '').trim().slice(0, 120);
      if (errors.length) throw fail_('VALIDATION', errors);
      setSetting_('photo_mode', item.photo_mode); setSetting_('inactive_days', String(days)); setSetting_('sheet_title', title);
      audit_(admin, 'settings.update', 'settings', '', 'photo_mode=' + item.photo_mode + ', inactive_days=' + days);
      return { ok: true };
    }
    throw fail_('VALIDATION', ['Unknown kind.']);
  } finally { lock.releaseLock(); }
}

// ======================================================================================
// designs
// ======================================================================================
function parseAttrs_(s) { var o = MPSCore.safeJson(s); ATTR_KEYS.forEach(function (k) { if (o[k] == null) o[k] = ''; }); return o; }
function designOut_(d) {
  return { design_id: d.design_id, design_no: d.design_no, supplier_id: d.supplier_id, supplier: d.supplier, fingerprint: d.fingerprint, photo_id: d.photo_id,
           created_at: d.created_at, created_by: d.created_by, source: d.source, attrs: parseAttrs_(d.attrs) };
}
function designsList_(b) {
  var out = readAll_('Designs').filter(function (d) { return !b.supplier_id || d.supplier_id === b.supplier_id; }).map(designOut_);
  return { ok: true, designs: out };
}
function designsSignatures_(b) {
  var out = {}; readAll_('Signatures').forEach(function (r) { if (r.supplier_id === b.supplier_id) out[r.design_id] = r.signature; });
  return { ok: true, signatures: out };
}
function findDesign_(designId) { var d = null; readWhere_('Designs', 'design_id', designId).forEach(function (r) { d = r; }); return d; }
function designUpdate_(b, admin) {
  var d = findDesign_(b.design_id); if (!d) throw fail_('NOT_FOUND', ['Design not found.']);
  var attrs = validateAttrs_(b.attrs || {}, getSupplier_(d.supplier_id), false);
  updateRow_('Designs', d._row, { attrs: JSON.stringify(attrs) });
  audit_(admin, 'design.update', 'design', d.design_id, JSON.stringify(attrs));
  return { ok: true };
}
// Checks pattern/material/etc. against the admin's lists. `requireAll` = enforce the required fields.
function validateAttrs_(attrs, supplier, requireAll) {
  var errors = [], out = {}, lists = {}, products = {}, brands = {};
  readAll_('Lists').forEach(function (r) { if (r.active === 'Y') (lists[r.list] = lists[r.list] || {})[r.value.toLowerCase()] = r.value; });
  readAll_('Products').forEach(function (r) { if (r.active === 'Y') products[r.name.toLowerCase()] = r.name; });
  readAll_('Brands').forEach(function (r) { if (r.active === 'Y') brands[r.name.toLowerCase()] = r.name; });
  ATTR_KEYS.forEach(function (k) {
    var v = String(attrs[k] == null ? '' : attrs[k]).replace(/\s+/g, ' ').trim();
    if (k === 'brand') {
      if (!v) v = supplier.brand || supplier.name;                      // no brand: the supplier's name is used
      else if (brands[v.toLowerCase()]) v = brands[v.toLowerCase()];
      else if (v.toLowerCase() === String(supplier.brand || '').toLowerCase() || v.toLowerCase() === supplier.name.toLowerCase()) { /* ok */ }
      else errors.push('Brand "' + v + '" is not in the list.');
    } else if (k === 'product') {
      if (v && !products[v.toLowerCase()]) errors.push('Product "' + v + '" is not in the list.'); else if (v) v = products[v.toLowerCase()];
    } else if (v) {
      var set = lists[k] || {};
      if (!set[v.toLowerCase()]) errors.push('Choose ' + k + ' from the list.'); else v = set[v.toLowerCase()];
    }
    if (requireAll && ATTR_REQUIRED.indexOf(k) > -1 && !v) errors.push('Choose the ' + k + '.');
    out[k] = v;
  });
  if (errors.length) throw fail_('VALIDATION', errors);
  return out;
}
function nextGeneratedNo_(supplier) {
  return MPSCore.nextDesignNo(supplier.name, readAll_('Designs').map(function (d) { return { design_no: d.design_no }; }));
}
function createDesign_(f) {
  append_('Designs', { design_id: f.design_id, design_no: f.design_no, supplier_id: f.supplier.supplier_id, supplier: f.supplier.name, supplier_code: MPSCore.supplierCode(f.supplier.name),
                       fingerprint: f.fingerprint || '', photo_id: f.photo_id || '', created_at: f.now, created_by: f.user.name, source: f.source, attrs: JSON.stringify(f.attrs || {}) });
  if (f.signature && /^S1:\d+:/.test(String(f.signature)) && String(f.signature).length < 49000) {
    append_('Signatures', { design_id: f.design_id, supplier_id: f.supplier.supplier_id, signature: f.signature });
  }
}

// ---- stand-alone "design finder": photo + supplier -> design number (no datasheet line) ----
function register_(b, user) {
  var errors = MPSCore.validateRegistration({ supplier: 'x', fingerprint: b.fingerprint, requestId: b.requestId });
  var supplier = getSupplier_(b.supplier_id);
  if (!supplier) errors.push('Choose a supplier.');
  if (b.mode !== 'new' && b.mode !== 'seen') errors.push('Invalid mode.');
  if (errors.length) throw fail_('VALIDATION', errors);
  var photo = b.mode === 'new' || b.photo ? savePhoto_(b.photo, 'finder') : { id: '' };
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var prior = findSightingByRequest_(b.requestId);
    if (prior) return { ok: true, duplicate_request: true, outcome: prior.type === 'REGISTER' ? 'NEW' : 'SEEN', design_id: prior.design_id, design_no: prior.design_no, supplier: supplier.name };
    var designs = readAll_('Designs'), now = new Date().toISOString();
    if (b.mode === 'seen') {
      var d = null; designs.forEach(function (x) { if (x.design_id === b.designId) d = x; });
      if (!d) throw fail_('NOT_FOUND', ['That design does not exist.']);
      if (d.supplier_id !== supplier.supplier_id) throw fail_('SUPPLIER_MISMATCH', ['That design belongs to a different supplier.']);
      var sim = MPSCore.similarity(b.fingerprint, d.fingerprint);
      append_('Sightings', { sighting_id: Utilities.getUuid(), design_id: d.design_id, design_no: d.design_no, supplier: d.supplier, type: 'SEEN', timestamp: now, staff: user.name, photo_id: photo.id, request_id: b.requestId, similarity: sim.toFixed(3), bundle_id: '' });
      return { ok: true, outcome: 'SEEN', design_id: d.design_id, design_no: d.design_no, supplier: d.supplier, similarity: sim };
    }
    if (!b.force) {
      var strong = MPSCore.findMatches(b.fingerprint, designs.filter(function (x) { return x.supplier_id === supplier.supplier_id; }), { supplier_id: supplier.supplier_id, name: supplier.name }).filter(function (m) { return m.strong; });
      if (strong.length) throw fail_('POSSIBLE_DUPLICATE', ['This looks like an existing design from the same supplier.'], { candidates: strong.slice(0, 3).map(function (m) { return { design_id: m.design_id, design_no: m.design_no, score: m.score }; }) });
    }
    var no = nextGeneratedNo_(supplier);
    createDesign_({ design_id: no, design_no: no, supplier: supplier, fingerprint: b.fingerprint, signature: b.signature, photo_id: photo.id, now: now, user: user, source: 'MPS', attrs: {} });
    append_('Sightings', { sighting_id: Utilities.getUuid(), design_id: no, design_no: no, supplier: supplier.name, type: 'REGISTER', timestamp: now, staff: user.name, photo_id: photo.id, request_id: b.requestId, similarity: '', bundle_id: '' });
    return { ok: true, outcome: 'NEW', design_id: no, design_no: no, supplier: supplier.name, photo_id: photo.id };
  } finally { lock.releaseLock(); }
}

// ======================================================================================
// bundles
// ======================================================================================
function bundleOut_(r) {
  return { bundle_id: r.bundle_id, supplier_id: r.supplier_id, supplier: r.supplier, city: r.city, agent: r.agent, opened_by: r.opened_by, opened_date: r.opened_date,
           invoice_no: r.invoice_no, invoice_date: r.invoice_date, status: r.status, created_by: r.created_by, created_at: r.created_at, checked_by: r.checked_by, checked_at: r.checked_at, note: r.note };
}
function getBundle_(id) { var b = null; readWhere_('Bundles', 'bundle_id', id).forEach(function (r) { b = r; }); return b; }
function getSupplier_(id) { var s = null; readAll_('Suppliers').forEach(function (r) { if (r.supplier_id === id) s = r; }); return s; }
function bundlesList_(b) {
  var counts = {};
  var sh = sheet_('Lines'), n = sh.getLastRow() - 1;
  if (n > 0) {
    var ids = sh.getRange(2, colIndex_('Lines', 'bundle_id'), n, 1).getValues(), qty = sh.getRange(2, colIndex_('Lines', 'total_qty'), n, 1).getValues(), del = sh.getRange(2, colIndex_('Lines', 'deleted'), n, 1).getValues();
    for (var i = 0; i < n; i++) {
      if (del[i][0] === 'Y' || !ids[i][0]) continue;
      var c = counts[ids[i][0]] || (counts[ids[i][0]] = { lines: 0, total: 0 });
      c.lines++; c.total += Number(qty[i][0]) || 0;
    }
  }
  var out = readAll_('Bundles').filter(function (r) { return !b.status || r.status === b.status; }).map(function (r) {
    var o = bundleOut_(r), c = counts[r.bundle_id] || { lines: 0, total: 0 }; o.lines = c.lines; o.total_qty = c.total; return o;
  });
  out.sort(function (a, b2) { return a.created_at < b2.created_at ? 1 : -1; });
  return { ok: true, bundles: out };
}
function bundleCreate_(b, user) {
  var supplier = getSupplier_(b.supplier_id), errors = [];
  if (!supplier || supplier.active !== 'Y') errors.push('Choose a supplier.');
  var agent = String(b.agent == null ? '' : b.agent).replace(/\s+/g, ' ').trim();
  if (!agent) errors.push('Enter the agent name, or choose Nil.');
  var openedBy = String(b.opened_by || user.name).replace(/\s+/g, ' ').trim();
  var date = String(b.opened_date || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('Date is not valid.');
  if (errors.length) throw fail_('VALIDATION', errors);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    if (b.requestId) { var dup = null; readAll_('Bundles').forEach(function (r) { if (r.note === 'req:' + b.requestId) dup = r; }); if (dup) return { ok: true, duplicate_request: true, bundle: bundleOut_(dup) }; }
    var id = nextId_('BND-', 'seq_bundle', 5), now = new Date().toISOString();
    var row = { bundle_id: id, supplier_id: supplier.supplier_id, supplier: supplier.name, city: String(b.city || supplier.city || '').trim().slice(0, 60), agent: agent.slice(0, 60), opened_by: openedBy.slice(0, 40), opened_date: date,
                invoice_no: '', invoice_date: '', status: 'Open', created_by: user.name, created_at: now, checked_by: '', checked_at: '', note: b.requestId ? 'req:' + b.requestId : '' };
    append_('Bundles', row); audit_(user, 'bundle.create', 'bundle', id, supplier.name);
    return { ok: true, bundle: bundleOut_(row) };
  } finally { lock.releaseLock(); }
}
function lineOut_(r) {
  return { line_id: r.line_id, bundle_id: r.bundle_id, design_id: r.design_id, design_no: r.design_no, supplier_id: r.supplier_id, colour_names: r.colour_names, colour_hex: r.colour_hex, size_set: r.size_set,
           sizes: MPSCore.safeJson(r.sizes), total_qty: Number(r.total_qty) || 0, qc_pass: r.qc_pass, attrs: parseAttrs_(r.attrs), photo_id: r.photo_id, entered_by: r.entered_by, entered_at: r.entered_at, updated_at: r.updated_at };
}
// Lines come in pages (a bundle can hold 2000 lines). `mine` = only the signed-in person's lines. `designs` always covers the whole bundle.
function bundleGet_(b, user) {
  var bundle = getBundle_(b.bundle_id); if (!bundle) throw fail_('NOT_FOUND', ['Bundle not found.']);
  var all = readWhere_('Lines', 'bundle_id', b.bundle_id).filter(function (r) { return r.deleted !== 'Y'; });
  all.sort(function (a, c) { return a.entered_at < c.entered_at ? -1 : a.entered_at > c.entered_at ? 1 : 0; });
  var people = {}; all.forEach(function (r) { var p = people[r.entered_by] || (people[r.entered_by] = { name: r.entered_by, lines: 0, total_qty: 0 }); p.lines++; p.total_qty += Number(r.total_qty) || 0; });
  var picked = all.filter(function (r) { return (!b.mine || r.entered_by === user.name) && (!b.designId || r.design_id === b.designId) && (!b.person || r.entered_by === b.person); });
  var offset = Math.max(0, parseInt(b.offset, 10) || 0), limit = Math.min(500, Math.max(1, parseInt(b.limit, 10) || 200));
  var lines = picked.slice(offset, offset + limit).map(lineOut_);
  var inv = readWhere_('InvoiceRows', 'bundle_id', b.bundle_id).map(function (r) { return { design_id: r.design_id, design_no: r.design_no, invoice_qty: Number(r.invoice_qty) }; });
  var designs = b.noDesigns ? [] : MPSCore.countByDesign(all.map(lineOut_)).map(function (d) { return { design_id: d.design_id, design_no: d.design_no, counted: d.counted, lines: d.lines, persons: d.persons }; });
  return { ok: true, bundle: bundleOut_(bundle), lines: lines, total: picked.length, offset: offset, people: Object.keys(people).map(function (k) { return people[k]; }),
           designs: designs, invoiceRows: inv, settings: { sheet_title: readSettings_().sheet_title || '' } };
}
function bundleUpdate_(b, admin) {
  var bundle = getBundle_(b.bundle_id); if (!bundle) throw fail_('NOT_FOUND', ['Bundle not found.']);
  if (admin.role !== 'admin') {
    if (bundle.created_by !== admin.name) throw fail_('FORBIDDEN', ['Only the person who created the bundle (or an admin) can change it.']);
    if (bundle.status !== 'Open') throw fail_('LOCKED', ['This bundle has been checked against the invoice.']);
  }
  var p = b.fields || {}, patch = {};
  ['city', 'agent', 'opened_by', 'note'].forEach(function (k) { if (p[k] != null) patch[k] = String(p[k]).trim().slice(0, 80); });
  if (p.opened_date != null) { if (!/^\d{4}-\d{2}-\d{2}$/.test(p.opened_date)) throw fail_('VALIDATION', ['Date is not valid.']); patch.opened_date = p.opened_date; }
  if (patch.agent === '') throw fail_('VALIDATION', ['Agent cannot be empty (use Nil).']);
  updateRow_('Bundles', bundle._row, patch); audit_(admin, 'bundle.update', 'bundle', bundle.bundle_id, JSON.stringify(patch));
  return { ok: true };
}
function bundleReopen_(b, admin) {
  var bundle = getBundle_(b.bundle_id); if (!bundle) throw fail_('NOT_FOUND', ['Bundle not found.']);
  updateRow_('Bundles', bundle._row, { status: 'Open', checked_by: '', checked_at: '' }); audit_(admin, 'bundle.reopen', 'bundle', bundle.bundle_id, '');
  return { ok: true };
}

// ======================================================================================
// datasheet lines
// ======================================================================================
function photoRequired_(supplier, settings) {
  var mode = settings.photo_mode || 'all';
  return mode === 'all' ? true : supplier.photo_required === 'Y';
}
function findLineByRequest_(requestId) { var l = null; if (requestId) readWhere_('Lines', 'request_id', requestId).forEach(function (r) { l = r; }); return l; }
function findSightingByRequest_(requestId) { var s = null; if (requestId) readWhere_('Sightings', 'request_id', requestId).forEach(function (r) { s = r; }); return s; }

function lineSave_(b, user) {
  var bundle = getBundle_(b.bundleId);
  if (!bundle) throw fail_('NOT_FOUND', ['Bundle not found.']);
  if (bundle.status !== 'Open') throw fail_('LOCKED', ['This bundle has been checked against the invoice. Ask the admin to reopen it.']);
  var supplier = getSupplier_(bundle.supplier_id), settings = readSettings_(), errors = [];
  if (!supplier) throw fail_('NOT_FOUND', ['Supplier not found.']);
  var existingLine = null;
  if (b.lineId) {
    readWhere_('Lines', 'line_id', b.lineId).forEach(function (r) { existingLine = r; });
    if (!existingLine || existingLine.bundle_id !== bundle.bundle_id || existingLine.deleted === 'Y') throw fail_('NOT_FOUND', ['Line not found.']);
    if (user.role !== 'admin' && existingLine.entered_by !== user.name) throw fail_('FORBIDDEN', ['You can only change your own lines.']);
  } else {
    if (!b.requestId) errors.push('Missing request id.');
    var dup = findLineByRequest_(b.requestId);
    if (dup) return { ok: true, duplicate_request: true, line: lineOut_(dup), design_no: dup.design_no };
  }
  // sizes / qc / colours
  var sizeSet = null; readAll_('SizeSets').forEach(function (s) { if (s.set_id === b.sizeSet) sizeSet = s; });
  if (!sizeSet) errors.push('Choose a size set.');
  var sizes = {}; if (sizeSet) {
    var allowed = String(sizeSet.sizes).split(','), raw = b.sizes || {};
    errors = errors.concat(MPSCore.validateSizes(raw, allowed));
    Object.keys(raw).forEach(function (k) { var n = Number(raw[k]); if (raw[k] !== '' && raw[k] != null && n > 0) sizes[k] = n; });
  }
  var colours = (b.colourNames || []).map(function (c) { return String(c).trim(); }).filter(Boolean).slice(0, 3);
  if (!colours.length) errors.push('Choose at least one colour.');
  var colourList = {}; readAll_('Lists').forEach(function (r) { if (r.list === 'colour' && r.active === 'Y') colourList[r.value.toLowerCase()] = r.value; });
  colours = colours.map(function (c) { if (!colourList[c.toLowerCase()]) errors.push('Colour "' + c + '" is not in the list.'); return colourList[c.toLowerCase()] || c; });
  var hex = (b.colourHex || []).map(String).filter(function (h) { return /^#[0-9a-fA-F]{6}$/.test(h); }).slice(0, 3);
  // design identity
  var mode = b.designMode;
  if (['typed', 'existing', 'generate'].indexOf(mode) < 0) errors.push('Choose how the design number is given.');
  if (mode === 'typed' && !MPSCore.validDesignNo(b.designNo)) errors.push('Design number may only contain letters, numbers, space and - / . _ (max 40).');
  if (mode === 'existing' && !b.designId) errors.push('Choose the existing design.');
  // photo
  var needPhoto = photoRequired_(supplier, settings), haveOld = existingLine && existingLine.photo_id;
  if (needPhoto && !b.photo && !haveOld) errors.push('A photo is required for this supplier.');
  var attrs = null;
  if (!errors.length) { try { attrs = validateAttrs_(b.attrs || {}, supplier, true); } catch (e) { if (e && e.isFail) errors = errors.concat(e.errors); else throw e; } }
  if (errors.length) throw fail_('VALIDATION', errors);

  var photo = b.photo ? savePhoto_(b.photo, bundle.bundle_id + '_line') : { id: haveOld ? existingLine.photo_id : '' };   // upload before taking the lock
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    if (!existingLine) { var dup2 = findLineByRequest_(b.requestId); if (dup2) return { ok: true, duplicate_request: true, line: lineOut_(dup2), design_no: dup2.design_no }; }
    var now = new Date().toISOString(), design = null, isNew = false;
    if (mode === 'existing') {
      design = findDesign_(b.designId);
      if (!design || design.supplier_id !== supplier.supplier_id) throw fail_('VALIDATION', ['That design does not belong to this supplier.']);
    } else if (mode === 'typed') {
      var id = MPSCore.designIdFor(supplier.supplier_id, b.designNo);
      design = findDesign_(id);
      if (!design) {
        isNew = true;
        createDesign_({ design_id: id, design_no: MPSCore.normalizeDesignNo(b.designNo), supplier: supplier, fingerprint: b.fingerprint, signature: b.signature, photo_id: photo.id, now: now, user: user, source: 'SUPPLIER', attrs: attrs });
        design = { design_id: id, design_no: MPSCore.normalizeDesignNo(b.designNo), attrs: JSON.stringify(attrs), supplier: supplier.name };
      }
    } else {
      var no = nextGeneratedNo_(supplier); isNew = true;
      createDesign_({ design_id: no, design_no: no, supplier: supplier, fingerprint: b.fingerprint, signature: b.signature, photo_id: photo.id, now: now, user: user, source: 'MPS', attrs: attrs });
      design = { design_id: no, design_no: no, attrs: JSON.stringify(attrs), supplier: supplier.name };
    }
    // the design's saved details win; blanks get filled from this entry
    var master = parseAttrs_(design.attrs), merged = {}, changed = false;
    ATTR_KEYS.forEach(function (k) { merged[k] = master[k] || attrs[k]; if (merged[k] !== master[k]) changed = true; });
    if (!isNew && changed && design._row) updateRow_('Designs', design._row, { attrs: JSON.stringify(merged) });
    var fields = { bundle_id: bundle.bundle_id, design_id: design.design_id, design_no: design.design_no, supplier_id: supplier.supplier_id, colour_names: colours.join(', '), colour_hex: hex.join(','),
                   size_set: sizeSet.set_id, sizes: JSON.stringify(sizes), total_qty: String(MPSCore.sizesTotal(sizes)), qc_pass: b.qc ? 'Y' : 'N', attrs: JSON.stringify(merged), photo_id: photo.id, updated_at: now };
    var lineId;
    if (existingLine) {
      updateRow_('Lines', existingLine._row, fields); lineId = existingLine.line_id; audit_(user, 'line.update', 'line', lineId, design.design_no + ' qty ' + fields.total_qty);
    } else {
      lineId = Utilities.getUuid(); fields.line_id = lineId; fields.entered_by = user.name; fields.entered_at = now; fields.request_id = b.requestId; fields.deleted = 'N';
      append_('Lines', fields);
      append_('Sightings', { sighting_id: Utilities.getUuid(), design_id: design.design_id, design_no: design.design_no, supplier: supplier.name, type: isNew ? 'REGISTER' : 'SEEN', timestamp: now, staff: user.name, photo_id: photo.id, request_id: 'line:' + lineId, similarity: '', bundle_id: bundle.bundle_id });
      audit_(user, 'line.create', 'line', lineId, design.design_no + ' qty ' + fields.total_qty);
    }
    var out = lineOut_(Object.assign({ line_id: lineId, entered_by: existingLine ? existingLine.entered_by : user.name, entered_at: existingLine ? existingLine.entered_at : now }, fields));
    return { ok: true, line: out, design_no: design.design_no, new_design: isNew };
  } finally { lock.releaseLock(); }
}
function lineDelete_(b, user) {
  var line = null; readWhere_('Lines', 'line_id', b.lineId).forEach(function (r) { line = r; });
  if (!line || line.deleted === 'Y') throw fail_('NOT_FOUND', ['Line not found.']);
  var bundle = getBundle_(line.bundle_id);
  if (bundle.status !== 'Open') throw fail_('LOCKED', ['This bundle has been checked against the invoice. Ask the admin to reopen it.']);
  if (user.role !== 'admin' && line.entered_by !== user.name) throw fail_('FORBIDDEN', ['You can only delete your own lines.']);
  updateRow_('Lines', line._row, { deleted: 'Y', updated_at: new Date().toISOString() });
  audit_(user, 'line.delete', 'line', line.line_id, line.design_no + ' qty ' + line.total_qty);
  return { ok: true };
}

// ======================================================================================
// invoice check (purchase entry)
// ======================================================================================
function invoiceView_(bundleId) {
  var bundle = getBundle_(bundleId); if (!bundle) throw fail_('NOT_FOUND', ['Bundle not found.']);
  var lines = readWhere_('Lines', 'bundle_id', bundleId).filter(function (r) { return r.deleted !== 'Y'; }).map(lineOut_);
  var counted = MPSCore.countByDesign(lines);
  var rows = readWhere_('InvoiceRows', 'bundle_id', bundleId).map(function (r) { return { design_id: r.design_id, design_no: r.design_no, invoice_qty: Number(r.invoice_qty) }; });
  return { bundle: bundle, counted: counted, rows: rows };
}
function invoiceGet_(b) {
  var v = invoiceView_(b.bundle_id), check = MPSCore.invoiceCheck(v.counted, v.rows);
  check.rows.forEach(function (r) { delete r.source; });
  return { ok: true, bundle: bundleOut_(v.bundle), designs: v.counted, invoiceRows: v.rows, check: check };
}
function invoiceSave_(b, user) {
  var v = invoiceView_(b.bundle_id), errors = [];
  if (v.bundle.status !== 'Open') throw fail_('LOCKED', ['This bundle is already confirmed. Ask the admin to reopen it.']);
  var no = String(b.invoiceNo == null ? '' : b.invoiceNo).replace(/\s+/g, ' ').trim(), date = String(b.invoiceDate || '');
  if (no && no.length > 40) errors.push('Invoice number is too long.');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('Invoice date is not valid.');
  var rows = [], seen = {};
  (b.rows || []).forEach(function (r) {
    var q = r.invoiceQty === '' || r.invoiceQty == null ? null : Number(r.invoiceQty);
    if (q === null) return;                                                      // left empty: still pending
    if (isNaN(q) || Math.floor(q) !== q || q < 0 || q > 9999999) { errors.push('Invoice quantity for ' + (r.designNo || r.designId) + ' must be a whole number.'); return; }
    var id = r.designId, dn = r.designNo || '';
    if (!id) { if (!MPSCore.validDesignNo(dn)) { errors.push('Design number "' + dn + '" is not valid.'); return; } id = MPSCore.designIdFor(v.bundle.supplier_id, dn); dn = MPSCore.normalizeDesignNo(dn); }
    if (!dn) { var c = null; v.counted.forEach(function (x) { if (x.design_id === id) c = x; }); dn = c ? c.design_no : id; }
    if (seen[id]) { errors.push('Design ' + dn + ' appears twice.'); return; } seen[id] = 1;
    rows.push({ design_id: id, design_no: dn, invoice_qty: q });
  });
  if (errors.length) throw fail_('VALIDATION', errors);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var now = new Date().toISOString(), existing = readWhere_('InvoiceRows', 'bundle_id', b.bundle_id);
    var byId = {}; existing.forEach(function (r) { byId[r.design_id] = r; });
    rows.forEach(function (r) {
      var o = byId[r.design_id];
      if (o) updateRow_('InvoiceRows', o._row, { invoice_qty: String(r.invoice_qty), design_no: r.design_no, entered_by: user.name, entered_at: now });
      else append_('InvoiceRows', { bundle_id: b.bundle_id, design_id: r.design_id, design_no: r.design_no, invoice_qty: String(r.invoice_qty), entered_by: user.name, entered_at: now });
    });
    var patch = {}; if (b.invoiceNo != null) patch.invoice_no = no; if (b.invoiceDate != null) patch.invoice_date = date;
    if (Object.keys(patch).length) updateRow_('Bundles', v.bundle._row, patch);
    audit_(user, 'invoice.save', 'bundle', b.bundle_id, rows.length + ' rows');
  } finally { lock.releaseLock(); }
  return invoiceGet_(b);
}
function invoiceConfirm_(b, user) {
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var v = invoiceView_(b.bundle_id), check = MPSCore.invoiceCheck(v.counted, v.rows);
    if (v.bundle.status !== 'Open') throw fail_('LOCKED', ['Already confirmed.']);
    var errors = [];
    if (!v.bundle.invoice_no) errors.push('Enter the invoice number.');
    if (!v.bundle.invoice_date) errors.push('Enter the invoice date.');
    if (!check.complete) errors.push(check.pending + ' design(s) still have no invoice quantity.');
    if (!v.counted.length) errors.push('There are no datasheet lines in this bundle.');
    if (errors.length) throw fail_('VALIDATION', errors);
    updateRow_('Bundles', v.bundle._row, { status: 'Checked', checked_by: user.name, checked_at: new Date().toISOString() });
    audit_(user, 'invoice.confirm', 'bundle', b.bundle_id, 'counted ' + check.totalCounted + ', invoice ' + check.totalInvoice + ', diff ' + check.diff);
    return { ok: true, totals: { counted: check.totalCounted, invoice: check.totalInvoice, diff: check.diff } };
  } finally { lock.releaseLock(); }
}

// ======================================================================================
// reports
// ======================================================================================
function reportsGet_() {
  return { ok: true, designs: readAll_('Designs').map(designOut_), sightings: readAll_('Sightings').map(function (s) { return { design_id: s.design_id, design_no: s.design_no, supplier: s.supplier, type: s.type, timestamp: s.timestamp, staff: s.staff, bundle_id: s.bundle_id }; }), settings: readSettings_(), serverTime: new Date().toISOString() };
}

// ======================================================================================
// sheet helpers
// ======================================================================================
function fail_(code, errors, extra) { var e = new Error(errors.join(' ')); e.code = code; e.isFail = true; e.errors = errors; e.extra = extra || null; return e; }
function errorBody_(err) {
  if (err && err.isFail) return Object.assign({ ok: false, code: err.code, errors: err.errors, error: err.errors.join(' ') }, err.extra || {});
  return { ok: false, code: 'SERVER_ERROR', error: 'Server error: ' + (err && err.message) };
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function sheet_(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
function colIndex_(name, col) { return SHEETS[name].indexOf(col) + 1; }
function toStr_(v) { return v instanceof Date ? v.toISOString() : String(v == null ? '' : v); }
// Text typed by staff must never be read by Sheets as a formula: quote it when it starts with = + - @
function sheetSafe_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; }
function sheetUnquote_(v) { return typeof v === 'string' && /^'[=+\-@]/.test(v) ? v.slice(1) : v; }
function rowToObj_(name, values, rowNo) {
  var o = {}; SHEETS[name].forEach(function (h, i) { o[h] = sheetUnquote_(toStr_(values[i])); });
  if (rowNo) o._row = rowNo; return o;
}
function readAll_(name, withRow) {
  var sh = sheet_(name); if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS[name].length).getValues(), out = [];
  for (var i = 0; i < values.length; i++) if (values[i][0] !== '') out.push(rowToObj_(name, values[i], i + 2));
  return out;
}
// Reads only the rows whose `col` equals `value` (scans one column, then fetches just those rows).
function readWhere_(name, col, value) {
  var sh = sheet_(name), n = sh ? sh.getLastRow() - 1 : 0; if (n < 1) return [];
  var keys = sh.getRange(2, colIndex_(name, col), n, 1).getValues(), rows = [], i;
  for (i = 0; i < n; i++) if (sheetUnquote_(toStr_(keys[i][0])) === value) rows.push(i + 2);
  var out = [], w = SHEETS[name].length, start = 0;
  while (start < rows.length) {                                              // fetch contiguous runs in one call
    var end = start; while (end + 1 < rows.length && rows[end + 1] === rows[end] + 1) end++;
    var vals = sh.getRange(rows[start], 1, rows[end] - rows[start] + 1, w).getValues();
    for (i = 0; i < vals.length; i++) out.push(rowToObj_(name, vals[i], rows[start] + i));
    start = end + 1;
  }
  return out;
}
function append_(name, obj) {
  var sh = sheet_(name), row = SHEETS[name].map(function (h) { return obj[h] == null ? '' : sheetSafe_(obj[h]); });
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}
function updateRow_(name, rowNo, patch) {
  var sh = sheet_(name), w = SHEETS[name].length, cur = sh.getRange(rowNo, 1, 1, w).getValues()[0];
  var row = SHEETS[name].map(function (h, i) { return patch[h] != null ? sheetSafe_(String(patch[h])) : cur[i]; });
  sh.getRange(rowNo, 1, 1, w).setNumberFormat('@').setValues([row]);
}
function readSettings_() { var out = {}; readAll_('Settings').forEach(function (r) { out[r.key] = r.value; }); return out; }
function setSetting_(key, value) {
  var found = false; readAll_('Settings', true).forEach(function (r) { if (r.key === key) { updateRow_('Settings', r._row, { value: value }); found = true; } });
  if (!found) append_('Settings', { key: key, value: value });
}
// Counters live in Settings. Call while holding the script lock.
function nextId_(prefix, key, pad) {
  var cur = Number(readSettings_()[key] || 0) + 1; setSetting_(key, String(cur));
  return prefix + String(cur).padStart(pad, '0');
}
function audit_(user, action, entity, id, detail) {
  append_('Audit', { ts: new Date().toISOString(), user: user ? user.name : '', action: action, entity: entity, entity_id: id, detail: String(detail || '').slice(0, 500) });
}
function getPhotoFolder_() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
}
// Fallback for when Drive's picture links do not load in a browser: returns small data-URLs. Only files this app saved can be read.
function photosGet_(b) {
  var ids = (b.ids || []).map(String).filter(function (x) { return /^[\w-]{5,80}$/.test(x); }).slice(0, 20), ok = {};
  if (!ids.length) return { ok: true, photos: {} };
  ['Designs', 'Lines'].forEach(function (n) {
    var sh = sheet_(n), c = colIndex_(n, 'photo_id'), cnt = sh ? sh.getLastRow() - 1 : 0; if (cnt < 1) return;
    sh.getRange(2, c, cnt, 1).getValues().forEach(function (r) { ok[String(r[0])] = 1; });
  });
  var out = {};
  ids.forEach(function (id) {
    if (!ok[id]) return;
    try { out[id] = 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes()); } catch (e) { /* missing in Drive */ }
  });
  return { ok: true, photos: out };
}
function savePhoto_(dataUrlOrBase64, name) {
  if (!dataUrlOrBase64) return { id: '' };
  var b64 = String(dataUrlOrBase64).replace(/^data:image\/\w+;base64,/, '');
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', name + '_' + Date.now() + '.jpg');
  var file = getPhotoFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: file.getId() };
}

// ======================================================================================
// Gemini (optional). Needs a free API key from Google AI Studio saved as Script property GEMINI_API_KEY.
// Photos are sent to Google for these calls (see README: privacy). Without a key both actions return available:false.
// ======================================================================================
function callGemini_(parts) {
  var props = PropertiesService.getScriptProperties(), apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) return { available: false };
  var model = props.getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } })
  });
  var code = res.getResponseCode();
  if (code !== 200) return { available: true, error: code === 429 ? 'Gemini free limit reached for now. Using the built-in check only.' : 'Gemini returned error ' + code + '. Using the built-in check only.' };
  try {
    var data = JSON.parse(res.getContentText()), text = String(data.candidates[0].content.parts[0].text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return { available: true, json: JSON.parse(text), model: model };
  } catch (e) { return { available: true, error: 'Could not read Gemini\'s answer. Using the built-in check only.' }; }
}
function imgPart_(b64) { return { inline_data: { mime_type: 'image/jpeg', data: String(b64).replace(/^data:image\/\w+;base64,/, '') } }; }

function verify_(b) {
  if (!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')) return { ok: true, available: false };
  if (!b.photo) throw fail_('VALIDATION', ['Photo is required.']);
  var wanted = (b.candidates || []).slice(0, GEMINI_MAX_CANDIDATES), cands = [];
  readAll_('Designs').forEach(function (d) { if (d.supplier_id === b.supplier_id && wanted.indexOf(d.design_id) > -1 && d.photo_id) cands.push(d); });
  if (!cands.length) return { ok: true, available: true, results: [] };
  var parts = [{ text: 'You compare photos of garments / woven textile products for a business. The FIRST image is the NEW product. It is followed by CANDIDATE products, each introduced by a text label with its design number.\n' +
    'For every candidate decide whether it is the SAME DESIGN as the new product. Same design means the same motifs, the same arrangement of border / body / pallu and the same weave or print pattern. ' +
    'IGNORE colour (the same design is often made in several colours), lighting, folding, camera angle, zoom and background. Different motif shapes or layout means a DIFFERENT design even when the colours match.\n' +
    'Answer ONLY with JSON: {"results":[{"design_id":"...","same_design":true,"confidence":0.0,"reason":"max 15 words"}]} with one entry per candidate. confidence is 0 to 1. If unsure use a low confidence; do not guess.' },
    { text: 'NEW product photo:' }, imgPart_(b.photo)];
  cands.forEach(function (d) {
    try { var blob = DriveApp.getFileById(d.photo_id).getBlob(); parts.push({ text: 'CANDIDATE design_id ' + d.design_id + ' (design no ' + d.design_no + '):' }); parts.push({ inline_data: { mime_type: 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) } }); } catch (e) { /* photo missing in Drive: skip */ }
  });
  var r = callGemini_(parts);
  if (!r.available) return { ok: true, available: false };
  if (r.error) return { ok: true, available: true, error: r.error };
  var known = {}; cands.forEach(function (d) { known[d.design_id] = d.design_no; });
  var results = ((r.json && r.json.results) || []).filter(function (x) { return known[x.design_id]; }).map(function (x) {
    return { design_id: x.design_id, design_no: known[x.design_id], same_design: x.same_design === true, confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0)), reason: String(x.reason || '').slice(0, 120) };
  });
  return { ok: true, available: true, results: results, model: r.model };
}

// Suggests pattern / material / ... from one photo. Only values from the admin's own lists are ever returned.
function suggest_(b) {
  if (!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')) return { ok: true, available: false };
  if (!b.photo) throw fail_('VALIDATION', ['Photo is required.']);
  var lists = {}; readAll_('Lists').forEach(function (r) { if (r.active === 'Y' && r.list !== 'colour') (lists[r.list] = lists[r.list] || []).push(r.value); });
  var products = readAll_('Products').filter(function (r) { return r.active === 'Y'; }).map(function (r) { return r.name; });
  var menu = 'product: ' + JSON.stringify(products); Object.keys(lists).forEach(function (k) { menu += '\n' + k + ': ' + JSON.stringify(lists[k]); });
  var r = callGemini_([{ text: 'Look at this product photo for a garment business. For each field choose EXACTLY ONE value from the allowed list, or "" if you cannot tell. Never invent values.\nAllowed values:\n' + menu +
    '\nAnswer ONLY with JSON like {"product":"","pattern":"","style":"","fit":"","sleeve":"","type":"","material":""}.' }, imgPart_(b.photo)]);
  if (!r.available) return { ok: true, available: false };
  if (r.error) return { ok: true, available: true, error: r.error };
  var out = {}; ['product', 'pattern', 'style', 'fit', 'sleeve', 'type', 'material'].forEach(function (k) {
    var pool = k === 'product' ? products : (lists[k] || []), v = String((r.json && r.json[k]) || '').trim(), hit = '';
    pool.forEach(function (p) { if (p.toLowerCase() === v.toLowerCase()) hit = p; });
    out[k] = hit;
  });
  return { ok: true, available: true, suggestion: out, model: r.model };
}
