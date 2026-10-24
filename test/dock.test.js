const test = require('node:test');
const assert = require('node:assert/strict');
const { nearDock } = require('../src/dock');

const home = { x: 700, y: -32 };

test('dropped at the dock spot', () => {
  assert.equal(nearDock({ x: 700, y: -32 }, home, 48), true);
});

test('anywhere along the top edge docks, however far from the centre', () => {
  assert.equal(nearDock({ x: 0, y: -32 }, home, 48), true);
  assert.equal(nearDock({ x: 1400, y: -20 }, home, 48), true);
  assert.equal(nearDock({ x: 100, y: -32 + 40 }, home, 48), true);
});

test('too far down does not dock', () => {
  assert.equal(nearDock({ x: 700, y: -32 + 48 }, home, 48), false);
  assert.equal(nearDock({ x: 700, y: 300 }, home, 48), false);
});

test('above the dock spot counts as near', () => {
  assert.equal(nearDock({ x: 700, y: -200 }, home, 48), true);
});
