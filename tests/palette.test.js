// Unit tests for paletteFromRGBA on real silk photos (yellow & blue)
const assert = require('assert');
const C = require('../js/core.js');
const F = require('./fixtures/load.js');

let pass = 0, fail = 0;
const T = (n, f) => {
  try {
    f();
    pass++;
    console.log('  ok  ' + n);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + n + '\n       ' + (e.message || e).split('\n')[0]);
  }
};

console.log('palette extraction on real photos');

const colours = C.DEFAULT_COLOURS.map(c => ({ value: c[0], extra: c[1] }));
const yellow = F.real('yellow');
const blue = F.real('blue');

T('real yellow photo yields gold / warm tones', () => {
  const p = C.paletteFromRGBA(yellow.d, yellow.w, yellow.h, colours, 3);
  assert.ok(Array.isArray(p), 'palette should be an array');
  assert.ok(p.length >= 1, 'should find at least one dominant colour in yellow photo');
  assert.ok(p.some(c => ['Gold', 'Yellow', 'Mustard', 'Cream', 'Beige', 'Brown'].includes(c.name)),
    'expected yellow/gold tone, got: ' + p.map(c => c.name).join(', '));
  assert.ok(p.every(c => c.share > 0 && c.share <= 1), 'shares should be between 0 and 1');
  assert.ok(p.every(c => /^#[0-9a-fA-F]{6}$/.test(c.hex)), 'valid hex code');
});

T('real blue photo yields blue / teal tones', () => {
  const p = C.paletteFromRGBA(blue.d, blue.w, blue.h, colours, 3);
  assert.ok(Array.isArray(p), 'palette should be an array');
  assert.ok(p.length >= 1, 'should find at least one dominant colour in blue photo');
  assert.ok(p.some(c => ['Blue', 'Navy', 'Sky Blue', 'Teal'].includes(c.name)),
    'expected blue tone, got: ' + p.map(c => c.name).join(', '));
  assert.ok(p.every(c => c.share > 0 && c.share <= 1), 'shares should be between 0 and 1');
  assert.ok(p.every(c => /^#[0-9a-fA-F]{6}$/.test(c.hex)), 'valid hex code');
});

T('transparent / empty image returns empty palette', () => {
  const empty = new Uint8ClampedArray(100 * 100 * 4);
  const p = C.paletteFromRGBA(empty, 100, 100, colours);
  assert.deepStrictEqual(p, []);
});

T('palette shares do not exceed 100%', () => {
  const pY = C.paletteFromRGBA(yellow.d, yellow.w, yellow.h, colours, 3);
  const sumY = pY.reduce((a, b) => a + b.share, 0);
  assert.ok(sumY <= 1.05, 'Yellow palette sum share: ' + sumY);

  const pB = C.paletteFromRGBA(blue.d, blue.w, blue.h, colours, 3);
  const sumB = pB.reduce((a, b) => a + b.share, 0);
  assert.ok(sumB <= 1.05, 'Blue palette sum share: ' + sumB);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
