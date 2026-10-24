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

// ---- deleted lap times ----

const { deletedLapTimes } = require('../src/analysis');

test('deleted lap times are read per car by their time; laps without a time are skipped', () => {
  const m = deletedLapTimes([
    { date: '2026-10-24T18:19:31Z', message: 'CAR 16 (LEC) TIME 1:34.810 DELETED - TRACK LIMITS AT TURN 10 LAP 13 13:17:43' },
    { date: '2026-10-24T18:14:16Z', message: 'CAR 12 (ANT) TIME 1:35.015 DELETED - TRACK LIMITS AT TURN 9 LAP 9 13:11:07' },
    { date: '2026-10-24T18:08:37Z', message: 'CAR 16 (LEC) LAP DELETED - TRACK LIMITS AT TURN 20 (NEXT LAP PIT)' },
    { date: '2026-10-24T18:00:00Z', message: 'CAR 16 (LEC) TIME 59.500 DELETED - TRACK LIMITS AT TURN 1 (NEXT LAP)' },
    { date: '2026-10-24T18:20:00Z', message: 'CHEQUERED FLAG' },
  ]);
  assert.deepEqual(m.get(16).map((t) => Math.round(t * 1000)), [59500, 94810]);
  assert.deepEqual(m.get(12), [95.015]);
  assert.equal(m.has(1), false);
});

test('a reinstated lap gives its time back', () => {
  const m = deletedLapTimes([
    { date: '2026-10-24T18:00:00Z', message: 'CAR 43 (COL) TIME 1:36.100 DELETED - TRACK LIMITS AT TURN 4 LAP 13 12:58:00' },
    { date: '2026-10-24T18:05:00Z', message: 'CAR 43 (COL) LAP 13 WILL BE REINSTATED' },
    { date: '2026-10-24T18:10:00Z', message: 'CAR 43 (COL) TIME 1:36.500 DELETED - TRACK LIMITS AT TURN 4 LAP 15 13:02:00' },
  ]);
  assert.deepEqual(m.get(43), [96.5]);
});

test('a deleted lap is not the best lap, but is still listed and flagged', () => {
  const t0 = Date.parse('2026-10-24T17:30:00Z');
  const row = (n, time, extra = {}) => ({
    driver_number: 1, lap_number: n, date_start: new Date(t0 + n * 100e3).toISOString(), lap_duration: time,
    duration_sector_1: 30, duration_sector_2: 35, duration_sector_3: time - 65, is_pit_out_lap: false, ...extra,
  });
  const r = {
    drivers: [{ driver_number: 1, name_acronym: 'LEC', full_name: 'Charles LECLERC', team_name: 'Ferrari', team_colour: 'ED1131' }],
    laps: [row(1, 120, { is_pit_out_lap: true }), row(2, 95.4), row(3, 94.81), row(4, 95.2)],
    stints: [{ driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 4, compound: 'SOFT', tyre_age_at_start: 0 }],
    results: [],
    weather: [],
    raceControl: [
      { date: '2026-10-24T18:19:31Z', message: 'CAR 1 (LEC) TIME 1:34.810 DELETED - TRACK LIMITS AT TURN 10 LAP 4 13:17:43' },
    ],
  };
  const d = analyse({ session_key: 2, session_name: 'Practice 3', session_type: 'Practice', date_start: new Date(t0).toISOString() }, r);
  const lec = d.perDriver[0];
  assert.equal(lec.best.time, 95.2); // not the deleted 1:34.810
  assert.equal(lec.best.lap, 4);
  assert.deepEqual(lec.lapList.filter((l) => l.deleted).map((l) => l.lap), [3]);
  assert.equal(d.classification[0].time, 95.2); // the fallback ranking agrees
});
