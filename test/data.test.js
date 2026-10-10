const test = require('node:test');
const assert = require('node:assert/strict');
const { standingsAsOf } = require('../src/data');

const races = [
  { round: '16', date: '2026-10-04', time: '07:00:00Z' },
  {
    round: '17',
    date: '2026-10-11',
    time: '12:00:00Z',
    Sprint: { date: '2026-10-10', time: '09:00:00Z' },
  },
];

test('standings that include the race are as of after the race', () => {
  assert.equal(standingsAsOf('17', races, 17), Date.parse('2026-10-11T14:00:00Z'));
});

test('"round 17" standings with only the Sprint published: the race still counts as remaining', () => {
  // Singapore 2026: Jolpica listed round-17 standings after the Sprint while
  // the last race with results was round 16.
  const asOf = standingsAsOf('17', races, 16);
  assert.equal(asOf, Date.parse('2026-10-10T10:00:00Z'));
  assert.ok(asOf < Date.parse('2026-10-11T12:00:00Z'), 'the Singapore race is after the standings');
});

test('unknown round: nothing is assumed', () => {
  assert.equal(standingsAsOf('99', races, 16), 0);
});
