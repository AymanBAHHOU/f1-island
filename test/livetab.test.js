const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveTab } = require('../renderer/livetab');

const MIN = 60e3;
const T0 = Date.parse('2026-10-25T20:00:00Z');

test('main before the session starts, while it runs, and for 15 minutes after it', () => {
  const t = new LiveTab();
  t.update({ status: 'Inactive' }, T0 - 10 * MIN);
  assert.equal(t.isMain(true, T0 - 10 * MIN), true);
  t.update({ status: 'Started' }, T0);
  assert.equal(t.isMain(true, T0 + 30 * MIN), true);
  t.update({ status: 'Finished' }, T0 + 60 * MIN);
  assert.equal(t.isMain(true, T0 + 70 * MIN), true);
  assert.equal(t.isMain(true, T0 + 75 * MIN), true); // exactly 15 minutes
  assert.equal(t.isMain(true, T0 + 76 * MIN), false);
});

test('a red flag does not count as finished', () => {
  const t = new LiveTab();
  t.update({ status: 'Started' }, T0);
  t.update({ status: 'Aborted' }, T0 + 20 * MIN);
  assert.equal(t.isMain(true, T0 + 120 * MIN), true);
});

test('Finalised after Finished keeps the first finish time', () => {
  const t = new LiveTab();
  t.update({ status: 'Started' }, T0);
  t.update({ status: 'Finished' }, T0 + 60 * MIN);
  t.update({ status: 'Finalised' }, T0 + 80 * MIN);
  assert.equal(t.isMain(true, T0 + 80 * MIN), false); // 20 minutes after the first
});

test('started after the session ended: uses the scheduled end', () => {
  const late = new LiveTab();
  late.update({ status: 'Finalised' }, T0 + 120 * MIN, T0 + 60 * MIN); // ended an hour ago
  assert.equal(late.isMain(true, T0 + 120 * MIN), false);
  const fresh = new LiveTab();
  fresh.update({ status: 'Finalised' }, T0 + 70 * MIN, T0 + 60 * MIN); // ended 10 minutes ago
  assert.equal(fresh.isMain(true, T0 + 70 * MIN), true);
  const unknown = new LiveTab();
  unknown.update({ status: 'Finalised' }, T0, null); // no schedule: assume long ago
  assert.equal(unknown.isMain(true, T0), false);
});

test('the next session makes it main again; disconnecting resets', () => {
  const t = new LiveTab();
  t.update({ status: 'Started' }, T0);
  t.update({ status: 'Finished' }, T0 + 60 * MIN);
  assert.equal(t.isMain(true, T0 + 90 * MIN), false);
  t.update({ status: 'Inactive' }, T0 + 95 * MIN); // e.g. the Sprint after Sprint Qualifying
  assert.equal(t.isMain(true, T0 + 95 * MIN), true);
  t.update({ status: 'Started' }, T0 + 100 * MIN);
  t.update({ status: 'Finished' }, T0 + 130 * MIN);
  t.update(null, T0 + 200 * MIN);
  assert.equal(t.finishedAt, null);
});

test('not main when there is no live data at all', () => {
  assert.equal(new LiveTab().isMain(false), false);
});
