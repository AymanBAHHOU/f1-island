const test = require('node:test');
const assert = require('node:assert/strict');
const { podiumOf } = require('../src/analysis');

const drivers = [
  { driver_number: 16, name_acronym: 'LEC', team_colour: 'ED1131' },
  { driver_number: 12, name_acronym: 'ANT', team_colour: '00D7B6' },
  { driver_number: 3, name_acronym: 'VER', team_colour: '4781D7' },
];

test('practice: winner time, then gaps, in position order', () => {
  const results = [
    { position: 3, driver_number: 3, duration: 95.48, gap_to_leader: 0.189 },
    { position: 1, driver_number: 16, duration: 95.291, gap_to_leader: 0 },
    { position: 2, driver_number: 12, duration: 95.333, gap_to_leader: 0.042 },
    { position: 4, driver_number: 99, duration: 95.6, gap_to_leader: 0.3 },
  ];
  assert.deepEqual(podiumOf(results, drivers, 'Practice 2'), [
    { pos: 1, code: 'LEC', color: '#ED1131', time: 95.291, gap: null },
    { pos: 2, code: 'ANT', color: '#00D7B6', time: null, gap: 0.042 },
    { pos: 3, code: 'VER', color: '#4781D7', time: null, gap: 0.189 },
  ]);
});

test('qualifying: uses the last phase reached (Q3)', () => {
  const results = [
    { position: 1, driver_number: 16, duration: [93.1, 92.8, 92.6], gap_to_leader: [0, 0, 0] },
    { position: 2, driver_number: 3, duration: [93.2, 92.9, 92.7], gap_to_leader: [0.1, 0.1, 0.1] },
  ];
  const top = podiumOf(results, drivers, 'Qualifying');
  assert.equal(top[0].time, 92.6);
  assert.equal(top[1].gap, 0.1);
});

test('race: no winner time (it is the whole race); text gaps pass through', () => {
  const results = [
    { position: 1, driver_number: 3, duration: 6120.785, gap_to_leader: 0 },
    { position: 2, driver_number: 16, duration: 6128.12, gap_to_leader: 7.335 },
    { position: 3, driver_number: 12, duration: null, gap_to_leader: '+1 LAP' },
  ];
  const top = podiumOf(results, drivers, 'Race');
  assert.equal(top[0].time, null);
  assert.equal(top[1].gap, 7.335);
  assert.equal(top[2].gap, '+1 LAP');
});

test('unknown driver falls back to the car number', () => {
  const top = podiumOf([{ position: 1, driver_number: 7, duration: 90, gap_to_leader: 0 }], [], 'Practice 1');
  assert.equal(top[0].code, '#7');
});
