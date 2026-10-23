const test = require('node:test');
const assert = require('node:assert/strict');
const { remainingMs, formatClock } = require('../renderer/clock');

const clock = { remaining: '00:03:03', utc: '2026-10-23T21:56:56.000Z', running: true };

test('a running clock counts down from the time it was reported', () => {
  assert.equal(remainingMs(clock, Date.parse('2026-10-23T21:56:56Z')), 183000);
  assert.equal(remainingMs(clock, Date.parse('2026-10-23T21:57:56Z')), 123000);
  assert.equal(formatClock(remainingMs(clock, Date.parse('2026-10-23T21:57:56Z'))), '2:03');
});

test('a stopped clock (red flag, before the start) holds its value', () => {
  const stopped = { ...clock, running: false };
  assert.equal(remainingMs(stopped, Date.parse('2026-10-23T22:30:00Z')), 183000);
});

test('the countdown never goes below zero, and long sessions show hours', () => {
  assert.equal(remainingMs(clock, Date.parse('2026-10-23T23:00:00Z')), 0);
  assert.equal(formatClock(3785000), '1:03:05');
  assert.equal(remainingMs(null), null);
});
