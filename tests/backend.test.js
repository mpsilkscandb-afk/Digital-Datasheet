// Backend tests: run the REAL apps_script/Code.gs against the in-memory Google mock.
const assert = require('assert'), { createGas } = require('../tools/gas-mock.js');
let pass = 0, fail = 0; const T = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + (e.message || e).split('\n')[0]); } };
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64');

const gas = createGas(); gas.setup();
const pin = (gas.logs.join('\n').match(/PIN:\s*(\d+)/) || [])[1];
const admin = gas.withToken(gas.login('Admin', pin));
const must = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r; };

// ---- admin creates people and masters
must(admin('users.save', { name: 'Ravi', role: 'entry', pin: '1111' }));
must(admin('users.save', { name: 'Sita', role: 'entry', pin: '2222' }));
must(admin('users.save', { name: 'Purchase', role: 'purchase', pin: '3333' }));
const ravi = gas.withToken(gas.login('Ravi', '1111')), sita = gas.withToken(gas.login('Sita', '2222')), pur = gas.withToken(gas.login('Purchase', '3333'));
const m0 = must(admin('masters.get'));
const set = m0.sizeSets[0].set_id;
const sup = must(admin('masters.save', { kind: 'supplier', item: { name: 'Raj Textiles', city: 'Surat', photo_required: true } })).id;
const sup2 = must(admin('masters.save', { kind: 'supplier', item: { name: 'Nil Photo Co', city: 'Erode', photo_required: false } })).id;
must(admin('masters.save', { kind: 'product', item: { name: 'Shirt', size_set: set } }));
must(admin('masters.save', { kind: 'list', item: { list: 'pattern', value: 'Check' } }));
const L = m0.lists, first = (k) => (L[k][0] || {}).value;
const attrs = (extra) => Object.assign({ product: 'Shirt', pattern: 'Check', style: first('style'), fit: first('fit'), sleeve: first('sleeve'), type: first('type'), material: first('material') }, extra);
const colour = first('colour'), sz = m0.sizeSets[0].sizes;
const line = (who, b, o) => who('line.save', Object.assign({ bundleId: b, requestId: 'r' + Math.random(), designMode: 'typed', designNo: 'A-100', sizeSet: set, sizes: { [sz[0]]: 5, [sz[1]]: 3 }, colourNames: [colour], attrs: attrs(), qc: true, photo: PHOTO }, o || {}));

console.log('roles & login');
T('entry cannot save masters', () => assert.strictEqual(ravi('masters.save', { kind: 'brand', item: { name: 'X' } }).code, 'FORBIDDEN'));
T('entry cannot list users', () => assert.strictEqual(ravi('users.list').code, 'FORBIDDEN'));
T('no token -> AUTH', () => assert.strictEqual(gas.call({ action: 'masters.get' }).code, 'AUTH'));
T('lockout after 5 wrong PINs', () => { for (let i = 0; i < 5; i++) gas.login('Sita', '9999'); assert.strictEqual(gas.call({ action: 'login', name: 'Sita', pin: '2222' }).code, 'LOCKED'); });
T('duplicate supplier name refused (case-insensitive)', () => assert.strictEqual(admin('masters.save', { kind: 'supplier', item: { name: 'raj textiles' } }).code, 'VALIDATION'));
T('last admin cannot be demoted', () => { const u = must(admin('users.list')).users.find(x => x.name === 'Admin'); assert.strictEqual(admin('users.save', { user_id: u.user_id, name: 'Admin', role: 'entry' }).code, 'VALIDATION'); });

console.log('bundles & lines');
let b1;
T('create bundle needs agent', () => assert.strictEqual(ravi('bundles.create', { supplier_id: sup }).code, 'VALIDATION'));
T('create bundle (agent Nil)', () => { b1 = must(ravi('bundles.create', { supplier_id: sup, agent: 'Nil', requestId: 'b1' })).bundle.bundle_id; assert.ok(/^BND-/.test(b1)); });
T('bundle create idempotent', () => assert.strictEqual(must(ravi('bundles.create', { supplier_id: sup, agent: 'Nil', requestId: 'b1' })).bundle.bundle_id, b1));
T('typed design saves, new_design true', () => { const r = must(line(ravi, b1, { requestId: 'L1' })); assert.ok(r.new_design); assert.strictEqual(r.design_no, 'A-100'); assert.strictEqual(r.line.total_qty, 8); });
T('same requestId is not duplicated', () => { const r = must(line(ravi, b1, { requestId: 'L1' })); assert.ok(r.duplicate_request); assert.strictEqual(must(ravi('bundles.get', { bundle_id: b1 })).total, 1); });
T('second colour of same design is not new', () => { const r = must(line(sita, b1, { requestId: 'L2', designNo: 'a-100', colourNames: [L.colour[1].value] })); assert.ok(!r.new_design); });
T('photo required for supplier', () => assert.strictEqual(line(ravi, b1, { photo: '' }).code, 'VALIDATION'));
T('photo_mode all (default) forces photo for every supplier', () => { const b = must(ravi('bundles.create', { supplier_id: sup2, agent: 'Nil' })).bundle.bundle_id; assert.strictEqual(line(ravi, b, { photo: '', designNo: 'Z1' }).code, 'VALIDATION'); });
T('photo_mode selected skips unselected', () => {
  must(admin('masters.save', { kind: 'settings', item: { photo_mode: 'selected', inactive_days: 90 } }));
  const b = must(ravi('bundles.create', { supplier_id: sup2, agent: 'X' })).bundle.bundle_id; must(line(ravi, b, { photo: '', designNo: 'Z2' }));
  assert.strictEqual(line(ravi, b1, { photo: '', designNo: 'NEW9' }).code, 'VALIDATION');   // supplier 1 flagged
  must(admin('masters.save', { kind: 'settings', item: { photo_mode: 'all', inactive_days: 90 } }));
});
T('generate makes MPS number and sequence continues', () => { const a = must(line(ravi, b1, { designMode: 'generate', designNo: '' })), c = must(line(ravi, b1, { designMode: 'generate', designNo: '' })); assert.ok(/^MPS-/.test(a.design_no)); assert.notStrictEqual(a.design_no, c.design_no); });
T('invalid size set values rejected', () => assert.strictEqual(line(ravi, b1, { sizes: { NOPE: 2 } }).code, 'VALIDATION'));
T('unknown colour rejected', () => assert.strictEqual(line(ravi, b1, { colourNames: ['Zzz'] }).code, 'VALIDATION'));
T('formula-like design no is rejected', () => assert.strictEqual(line(ravi, b1, { designNo: '=1+1' }).code, 'VALIDATION'));
T('entry cannot edit or delete others lines', () => { const id = must(ravi('bundles.get', { bundle_id: b1 })).lines[0].line_id; assert.strictEqual(sita('line.delete', { lineId: id }).code, 'FORBIDDEN'); });
T('own line delete (soft) removes it from counts', () => { const g = must(ravi('bundles.get', { bundle_id: b1 })), mine = g.lines.find(l => l.entered_by === 'Ravi'); must(ravi('line.delete', { lineId: mine.line_id })); assert.strictEqual(must(ravi('bundles.get', { bundle_id: b1 })).total, g.total - 1); });
T('bundles.get pages and mine filter', () => { const g = must(ravi('bundles.get', { bundle_id: b1, limit: 2 })); assert.strictEqual(g.lines.length, 2); const m = must(sita('bundles.get', { bundle_id: b1, mine: true })); assert.ok(m.lines.every(l => l.entered_by === 'Sita')); assert.ok(g.designs.length > 0 && g.people.length >= 2); });
T('entry can edit own bundle header, not others', () => { must(ravi('bundles.update', { bundle_id: b1, agent: 'Kumar' })); assert.strictEqual(sita('bundles.update', { bundle_id: b1, agent: 'Z' }).code, 'FORBIDDEN'); });

console.log('photos');
T('photos.get returns only app photos', () => { const g = must(ravi('bundles.get', { bundle_id: b1 })), id = g.lines.find(l => l.photo_id).photo_id; const r = must(ravi('photos.get', { ids: [id, 'notmine12345'] })); assert.ok(/^data:image\/jpeg;base64,/.test(r.photos[id])); assert.ok(!r.photos.notmine12345); });

console.log('invoice check');
T('purchase sees counted vs blank invoice', () => { const r = must(pur('invoice.get', { bundle_id: b1 })); assert.ok(r.designs.length >= 2); assert.ok(!r.check.complete); });
T('confirm refused until invoice complete', () => assert.strictEqual(pur('invoice.confirm', { bundle_id: b1 }).code, 'VALIDATION'));
T('save invoice rows, excess/shortage computed', () => {
  const d = must(pur('invoice.get', { bundle_id: b1 })).designs;
  const rows = d.map(x => ({ designId: x.design_id, designNo: x.design_no, invoiceQty: x.counted + (x.design_no === 'A-100' ? 2 : 0) }));
  const r = must(pur('invoice.save', { bundle_id: b1, invoiceNo: 'INV-9', invoiceDate: '2026-10-20', rows }));
  assert.ok(r.check.complete); assert.strictEqual(r.check.diff, -2);
});
T('entry cannot confirm', () => assert.strictEqual(ravi('invoice.confirm', { bundle_id: b1 }).code, 'FORBIDDEN'));
T('confirm locks bundle', () => { must(pur('invoice.confirm', { bundle_id: b1 })); assert.strictEqual(line(ravi, b1, { designNo: 'LATE' }).code, 'LOCKED'); });
T('only admin can reopen', () => { assert.strictEqual(pur('bundles.reopen', { bundle_id: b1 }).code, 'FORBIDDEN'); must(admin('bundles.reopen', { bundle_id: b1 })); must(line(ravi, b1, { designNo: 'LATE' })); });
T('audit trail has entries', () => assert.ok(gas.rows('Audit').length >= 10));
T('no PIN hash leaks via users.list', () => assert.ok(!JSON.stringify(must(admin('users.list'))).match(/pin_hash|salt/)));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
