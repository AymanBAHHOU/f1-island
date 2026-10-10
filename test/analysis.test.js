const test = require('node:test');
const assert = require('node:assert/strict');
const { analyse } = require('../src/analysis');

// A small synthetic practice session: driver 1 does a quali-style run
// (push / cool-down alternating) then a 6-lap long run; driver 2 sets a time.
const start = Date.parse('2026-10-09T08:30:00Z');
let clock = start;
function lap(driver, n, time, extra = {}) {
  const row = {
    driver_number: driver,
    lap_number: n,
    date_start: new Date(clock).toISOString(),
    lap_duration: time,
    duration_sector_1: time && time * 0.3,
    duration_sector_2: time && time * 0.4,
    duration_sector_3: time && time * 0.3,
    is_pit_out_lap: false,
    st_speed: 300 + n,
    ...extra,
  };
  clock += (time || 100) * 1000;
  return row;
}

const laps = [
  // Stint 1 (soft): out-lap, push, cool, push, in-lap.
  lap(1, 1, 120, { is_pit_out_lap: true }),
  lap(1, 2, 92.5),
  lap(1, 3, 140),
  lap(1, 4, 92.3),
  lap(1, 5, 130),
  // Stint 2 (hard): out-lap, six push laps (one in traffic), in-lap.
  lap(1, 6, 125, { is_pit_out_lap: true }),
  lap(1, 7, 96.5),
  lap(1, 8, 96.7),
  lap(1, 9, 99.5), // traffic: >2% off the run median, skipped but doesn't end the run
  lap(1, 10, 96.9),
  lap(1, 11, 97.0),
  lap(1, 12, 97.2),
  lap(1, 13, 120),
  lap(2, 1, 125, { is_pit_out_lap: true }),
  lap(2, 2, 93.1),
  lap(2, 3, 135),
];

const raw = {
  drivers: [
    { driver_number: 1, name_acronym: 'NOR', full_name: 'Lando NORRIS', team_name: 'McLaren', team_colour: 'F47600' },
    { driver_number: 2, name_acronym: 'PIA', full_name: 'Oscar PIASTRI', team_name: 'McLaren', team_colour: 'F47600' },
  ],
  laps,
  stints: [
    { driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 5, compound: 'SOFT', tyre_age_at_start: 0 },
    { driver_number: 1, stint_number: 2, lap_start: 6, lap_end: 13, compound: 'HARD', tyre_age_at_start: 0 },
    { driver_number: 2, stint_number: 1, lap_start: 1, lap_end: 3, compound: 'SOFT', tyre_age_at_start: 2 },
  ],
  results: [],
  weather: [
    { air_temperature: 31.9, track_temperature: 0, humidity: 60, wind_speed: 2, rainfall: 0 }, // 0 °C = sensor dropout
    { air_temperature: 32.5, track_temperature: 53.6, humidity: 64, wind_speed: 3, rainfall: 0 },
  ],
  raceControl: [
    { date: '2026-10-09T08:40:00Z', message: 'CHEQUERED FLAG', flag: 'CHEQUERED', category: 'Flag' },
    { date: '2026-10-09T08:41:00Z', message: 'RED FLAG', flag: 'RED', category: 'Flag' },
    { date: '2026-10-09T08:42:00Z', message: 'CAR 1 (NOR) TIME 1:38.239 DELETED - TRACK LIMITS AT TURN 16', driver_number: null },
    { date: '2026-10-09T08:43:00Z', message: 'CAR 1 (NOR) TIME 1:39.000 DELETED - TRACK LIMITS AT TURN 2', driver_number: null },
  ],
};

const session = { session_key: 1, session_name: 'Practice 1', session_type: 'Practice', date_start: new Date(start).toISOString() };
const a = analyse(session, raw);

test('best laps and classification without official results', () => {
  assert.deepEqual(
    a.classification.map((r) => `${r.position} ${r.driver} ${r.time}`),
    ['1 1 92.3', '2 2 93.1']
  );
  const nor = a.perDriver.find((r) => r.code === 'NOR');
  assert.equal(nor.best.compound, 'SOFT');
  assert.equal(nor.best.tyreAge, 3);
});

test('long run: out/in/cool laps excluded, traffic lap skipped without ending the run', () => {
  const runs = a.longRuns.all.filter((r) => r.code === 'NOR');
  const long = runs.find((r) => r.compound === 'HARD');
  assert.ok(long, 'expected a run on the hard tyre');
  assert.equal(long.pushLaps, 5);
  assert.equal(long.laps.length, 6, 'traffic lap stays in the run but not in the average');
  assert.ok(Math.abs(long.avg - 96.86) < 0.01, `avg ${long.avg}`);
  // The soft stint alternates push / cool-down laps: no 3+ lap run.
  assert.equal(runs.some((r) => r.compound === 'SOFT'), false);
});

test('weather ignores zero-degree sensor dropouts', () => {
  assert.deepEqual(a.weather.track, [53.6, 53.6]);
  assert.equal(a.weather.rain, false);
});

test('race control notes: real red flag kept, "chequeRED FLAG" not mistaken for one', () => {
  assert.deepEqual(
    a.notes.map((n) => n.message),
    ['RED FLAG']
  );
});

test('deleted laps are counted per driver from the message text', () => {
  assert.deepEqual(a.deletedLaps, [{ driver: 1, count: 2 }]);
});
