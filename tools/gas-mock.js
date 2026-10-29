/*
 * An in-memory stand-in for the few Google services the backend uses (Sheets, Drive, Cache, Properties, Lock,
 * UrlFetch). It runs the REAL apps_script/Core.gs + Code.gs in a Node VM. Used by the tests and by the local
 * dev server (tools/dev-server.js). It is not Google: real quotas, speed and permission prompts are not simulated.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

function createGas(opts = {}) {
  const root = opts.root || path.join(__dirname, '..');
  const state = opts.state || { sheets: {}, files: {}, folders: {}, props: {}, seq: 0 };
  const logs = [], fetches = [], gemini = { status: 200, body: null }, cache = new Map();
  let lockHeld = false, onChange = opts.onChange || (() => {});

  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    setValues(v) {
      v.forEach((row, i) => row.forEach((x, j) => { (this.sh.data[this.r - 1 + i] ||= [])[this.c - 1 + j] = x; }));
      onChange(); return this;
    }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(((this.sh.data[this.r - 1 + i] || [])[this.c - 1 + j]) ?? ''); out.push(row); }
      return out;
    }
    setValue(x) { return this.setValues([[x]]); }
    setFontWeight() { return this; } setNumberFormat() { return this; }
  }
  class Sheet {
    constructor(name, data) { this.name = name; this.data = data || []; }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    getLastRow() { let last = 0; this.data.forEach((row, i) => { if (row && row.some(v => v !== '' && v != null)) last = i + 1; }); return last; }
    getMaxRows() { return 1000; } setFrozenRows() {}
    setName(n) { delete state.sheets[this.name]; this.name = n; state.sheets[n] = this.data; sheets[n] = this; }
  }
  const sheets = {};
  Object.keys(state.sheets).forEach(n => { sheets[n] = new Sheet(n, state.sheets[n]); });
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => { state.sheets[n] = []; return (sheets[n] = new Sheet(n, state.sheets[n])); },
    getSheets: () => Object.values(sheets),
    deleteSheet: sh => { delete sheets[sh.name]; delete state.sheets[sh.name]; }
  };
  const mkFile = (blob) => {
    const id = 'file' + (++state.seq);
    state.files[id] = { name: blob.n, bytes: Buffer.from(blob.b).toString('base64'), type: blob.t }; onChange();
    return { getId: () => id, setSharing() {}, getBlob: () => ({ getBytes: () => Array.from(Buffer.from(state.files[id].bytes, 'base64')) }) };
  };
  const folder = { createFile: mkFile };
  const ctx = {
    console, Date, Math, JSON, Object, Array, String, Number, parseInt, parseFloat, isNaN, Error, RegExp,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => state.props[k] ?? null, setProperty: (k, v) => { state.props[k] = String(v); onChange(); }, deleteProperty: k => { delete state.props[k]; onChange(); } }) },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache.get(k); if (!e) return null; if (e.exp < Date.now()) { cache.delete(k); return null; } return e.v; },
      put: (k, v, sec) => { cache.set(k, { v: String(v), exp: Date.now() + (sec || 600) * 1000 }); },
      remove: k => { cache.delete(k); } }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (lockHeld) throw new Error('lock contention'); lockHeld = true; }, releaseLock() { lockHeld = false; } }) },
    Logger: { log: m => logs.push(String(m)) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Decode: s => Buffer.from(s, 'base64'), base64Encode: b => Buffer.from(b).toString('base64'),
      newBlob: (b, t, n) => ({ b, t, n }),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map(x => (x > 127 ? x - 256 : x))   // Java-style signed bytes
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 1 }, Permission: { VIEW: 1 },
      getFoldersByName: () => ({ hasNext: () => true, next: () => folder }),
      createFolder: () => folder,
      getFileById: id => { if (!state.files[id]) throw new Error('File not found: ' + id); return { getBlob: () => ({ getBytes: () => Array.from(Buffer.from(state.files[id].bytes, 'base64')) }) }; }
    },
    UrlFetchApp: { fetch: (url, opt) => { fetches.push({ url, opt }); return { getResponseCode: () => gemini.status, getContentText: () => typeof gemini.body === 'string' ? gemini.body : JSON.stringify(gemini.body) }; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) }
  };
  vm.createContext(ctx);
  ['Core.gs', 'Code.gs'].forEach(f => vm.runInContext(fs.readFileSync(path.join(root, 'apps_script', f), 'utf8'), ctx, { filename: f }));

  const run = (name, ...a) => vm.runInContext(name, ctx)(...a);
  const gas = {
    ctx, state, logs, fetches, gemini, cache, sheets,
    setup() { run('setup'); const m = logs.map(l => /name: Admin\s+PIN: (\d+)/.exec(l)).filter(Boolean).pop(); gas.adminPin = m ? m[1] : gas.adminPin; return gas; },
    call(body) { return JSON.parse(run('doPost', { postData: { contents: JSON.stringify(body) } }).getContent()); },
    get(params) { return JSON.parse(run('doGet', { parameter: params }).getContent()); },
    login(name, pin) { const r = gas.call({ action: 'login', name, pin }); return r.ok ? r.token : null; },
    withToken(token) { return (action, body = {}) => gas.call(Object.assign({ action, token }, body)); },
    rows(name) { const d = state.sheets[name] || []; return d.slice(1).filter(r => r && r[0] !== '' && r[0] != null); },
    expireTokens() { cache.clear(); }
  };
  return gas;
}
module.exports = { createGas };
