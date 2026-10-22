const test = require('node:test');
const assert = require('node:assert/strict');
const { interpolate, surfacePath, create } = require('../renderer/notch-motion');

const closed = { width: 181, height: 31, radius: 10, shoulder: 0 };
const open = { width: 440, height: 520, radius: 28, shoulder: 20 };

test('notch geometry interpolates monotonically without overshooting any edge', () => {
  let state = closed;
  for (let i = 0; i < 120; i++) {
    const next = interpolate(state, open, 1 / 120);
    for (const key of Object.keys(open)) assert.ok(next[key] >= state[key] && next[key] <= open[key]);
    state = next;
  }
  assert.ok(Math.abs(state.height - open.height) < 0.001);
});

test('interpolation is independent of refresh rate', () => {
  function advance(fps) {
    let state = closed;
    for (let i = 0; i < fps / 2; i++) state = interpolate(state, open, 1 / fps);
    return state;
  }
  for (const fps of [30, 60, 120, 144]) {
    const state = advance(fps);
    for (const key of Object.keys(open)) assert.ok(Math.abs(state[key] - advance(60)[key]) < 1e-8);
  }
});

test('reversing a partial reveal continues from its current geometry', () => {
  const partial = interpolate(closed, open, 0.08);
  const reversed = interpolate(partial, closed, 1 / 120);
  for (const key of Object.keys(open)) assert.ok(reversed[key] <= partial[key] && reversed[key] >= closed[key]);
  assert.deepEqual(interpolate(partial, closed, 0), partial);
});

test('one vector outline includes tangent cubic shoulders and rounded bottom corners', () => {
  const path = surfacePath(open);
  assert.equal((path.match(/C /g) || []).length, 4);
  assert.ok(path.startsWith('M 12 0 H 492'));
  assert.ok(path.endsWith('0 Z'));
  for (const geometry of [closed, open, { width: 20, height: 10, radius: 28, shoulder: 0 }]) {
    assert.doesNotMatch(surfacePath(geometry), /NaN|Infinity/);
  }
});

test('reduced motion snaps to the exact shape without starting an animation loop', () => {
  const oldCancel = global.cancelAnimationFrame;
  global.cancelAnimationFrame = () => {};
  try {
    const element = { style: {} };
    const surface = { setAttribute() {}, firstElementChild: { setAttribute() {} } };
    const motion = create(element, surface, closed, true);
    motion.move(open);
    assert.equal(element.style.width, '440px');
    assert.equal(element.style.height, '520px');
    motion.stop();
    assert.equal(element.style.width, '');
  } finally {
    if (oldCancel) global.cancelAnimationFrame = oldCancel;
    else delete global.cancelAnimationFrame;
  }
});
