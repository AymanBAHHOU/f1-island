const test = require('node:test');
const assert = require('node:assert/strict');
const { readNotches, notchForDisplay, notchOrigin, containsNotch } = require('../src/notch');

const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } };
const geometry = { id: 1, width: 185, height: 32, centerX: 755.5 };

test('AppKit notch points map to the full screen, not the menu-bar work area', () => {
  const notch = notchForDisplay(display, [geometry]);
  assert.deepEqual(notch, { ...geometry, top: 0 });
  assert.deepEqual(notchOrigin(notch, 520, 32), { x: 496, y: -32 });
});

test('negative and vertically offset monitor origins are preserved', () => {
  const secondary = { ...display, bounds: { ...display.bounds, x: -1512, y: -982 } };
  const notch = notchForDisplay(secondary, [geometry]);
  assert.equal(notch.centerX, -756.5);
  assert.deepEqual(notchOrigin(notch, 520, 32), { x: -1016, y: -1014 });
  assert.equal(containsNotch({ x: -756, y: -970 }, notch), true);
});

test('external monitors, disabled attachment and unsupported platforms fall back', () => {
  assert.equal(notchForDisplay({ ...display, id: 2 }, [geometry]), null);
  assert.equal(notchForDisplay(display, [geometry], false), null);
  assert.equal(notchForDisplay(display, []), null);
  assert.deepEqual(readNotches({}, 'win32'), []);
  assert.deepEqual(readNotches({}, 'linux'), []);
});

test('malformed, missing, or implausible native measurements are rejected', () => {
  assert.equal(notchForDisplay(display, [null, {}]), null);
  for (const patch of [
    { width: NaN }, { width: 0 }, { width: 800 }, { height: -1 }, { height: 101 },
    { centerX: Infinity }, { centerX: 0 }, { centerX: 1512 }, { height: undefined },
  ]) assert.equal(notchForDisplay(display, [{ ...geometry, ...patch }]), null);
});

test('the invisible camera cutout itself is a hover target, with a small margin', () => {
  const notch = notchForDisplay(display, [geometry]);
  assert.equal(containsNotch({ x: 756, y: 0 }, notch), true);
  assert.equal(containsNotch({ x: 756, y: 32 }, notch), true);
  assert.equal(containsNotch({ x: 756, y: 40 }, notch), true);
  assert.equal(containsNotch({ x: 756, y: 41 }, notch), false);
  assert.equal(containsNotch({ x: 500, y: 10 }, notch), false);
  assert.equal(containsNotch({ x: 756, y: -1 }, notch), false);
  assert.equal(containsNotch({ x: 756, y: 1 }, null), false);
});
