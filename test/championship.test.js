const test = require('node:test');
const assert = require('node:assert/strict');
const { titleFight, contention, earliestClinch, formFromHistory, MAX_DRIVER, MAX_TEAM } = require('../src/championship');

const races = (n) => Array.from({ length: n }, (_, i) => ({ type: 'race', name: `Race ${i + 1}` }));

// 2026 after the Singapore Sprint: 7 races left, no Sprints.
const standings = [
  { id: 'ANT', points: 325 },
  { id: 'RUS', points: 236 },
  { id: 'HAM', points: 221 },
  { id: 'LEC', points: 197 },
  { id: 'VER', points: 196 },
  { id: 'NOR', points: 189 },
  { id: 'PIA', points: 128 },
];

test('contention: 175 points left, PIA is out', () => {
  const rows = contention(standings, races(7), MAX_DRIVER);
  assert.deepEqual(
    rows.filter((r) => r.contender).map((r) => r.id),
    ['ANT', 'RUS', 'HAM', 'LEC', 'VER', 'NOR']
  );
  const pia = rows.find((r) => r.id === 'PIA');
  assert.equal(pia.maxPossible, 303);
  assert.equal(pia.gap, 197);
});

test('contention: a tie on points is still mathematically possible', () => {
  const rows = contention([{ id: 'A', points: 100 }, { id: 'B', points: 75 }], races(1), MAX_DRIVER);
  assert.equal(rows[1].contender, true); // 75 + 25 = 100: level, decided on countback
});

test('Sprints count 8 points per driver, 15 per team', () => {
  const events = [{ type: 'sprint' }, { type: 'race' }];
  assert.equal(contention([{ id: 'A', points: 0 }], events, MAX_DRIVER)[0].maxPossible, 33);
  assert.equal(contention([{ id: 'T', points: 0 }], events, MAX_TEAM)[0].maxPossible, 58);
});

test('earliest clinch: an 89-point lead with 7 races left', () => {
  // After Singapore the lead could be at most 114 with 150 still available:
  // not enough. After Austin: up to 139 with 125 left: possible.
  const c = earliestClinch(325, 236, races(7));
  assert.equal(c.index, 1);
  assert.equal(c.event.name, 'Race 2');
  assert.equal(c.lead, 125);
});

test('earliest clinch: already decided, last-race decider, or nothing left', () => {
  assert.deepEqual(earliestClinch(400, 200, races(3)), { decided: true });
  // 10-point lead, one race left: only the last race can decide it.
  assert.equal(earliestClinch(110, 100, races(1)).index, 0);
  assert.equal(earliestClinch(100, 100, []), null);
});

test('form: newer results weigh more; retirements hurt reliability, not pace', () => {
  const history = [
    { driver: 'A', type: 'race', round: 1, points: 0, position: 15, dnf: false },
    { driver: 'A', type: 'race', round: 2, points: 25, position: 1, dnf: false },
    { driver: 'B', type: 'race', round: 1, points: 25, position: 1, dnf: false },
    { driver: 'B', type: 'race', round: 2, points: 0, position: 20, dnf: true },
  ];
  const form = formFromHistory(history);
  assert.ok(form.get('A').form > 0.5, 'recent win should dominate');
  assert.equal(form.get('B').form, 1, 'the DNF is not counted as slow');
  assert.ok(form.get('B').dnfRate > form.get('A').dnfRate);
  assert.equal(form.get('A').wins, 1);
});

// A season where ANT has been far quicker than everyone.
function season() {
  const codes = ['ANT', 'RUS', 'HAM', 'LEC', 'VER', 'NOR', 'PIA'];
  const history = [];
  for (let round = 1; round <= 10; round++) {
    codes.forEach((driver, i) => history.push({ driver, type: 'race', round, points: [25, 18, 15, 12, 10, 8, 6][i], position: i + 1, dnf: false }));
  }
  return {
    drivers: standings.map((s) => ({ code: s.id, points: s.points, team: ['ANT', 'RUS'].includes(s.id) ? 'Mercedes' : 'Other' })),
    teams: [
      { name: 'Mercedes', points: 561 },
      { name: 'Other', points: 418 },
    ],
    events: races(7),
    history,
    runs: 4000,
  };
}

test('simulation: chances add up, are repeatable, and favour the leader', () => {
  const a = titleFight(season());
  const b = titleFight(season());
  const sum = a.drivers.reduce((s, d) => s + d.chance, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `driver chances sum to ${sum}`);
  assert.deepEqual(
    a.drivers.map((d) => d.chance),
    b.drivers.map((d) => d.chance),
    'same inputs, same numbers (seeded)'
  );
  assert.ok(a.drivers[0].chance > 0.85, `leader ${a.drivers[0].chance}`);
  assert.ok(Math.abs(a.teams.reduce((s, t) => s + t.chance, 0) - 1) < 1e-9);
});

test('simulation: drivers who can no longer win get exactly zero', () => {
  const t = titleFight(season());
  const pia = t.drivers.find((d) => d.code === 'PIA');
  assert.equal(pia.contender, false);
  assert.equal(pia.chance, 0);
});

test('a close fight stays close', () => {
  const s = season();
  s.drivers = [
    { code: 'ANT', points: 300, team: 'Mercedes' },
    { code: 'RUS', points: 298, team: 'Mercedes' },
  ];
  s.history = s.history.filter((h) => ['ANT', 'RUS'].includes(h.driver)).map((h) => ({ ...h, points: 18, position: 2 }));
  const t = titleFight(s);
  for (const d of t.drivers) assert.ok(d.chance > 0.3 && d.chance < 0.7, `${d.code} ${d.chance}`);
});

test('season over: no simulation, leader wins', () => {
  const t = titleFight({ ...season(), events: [] });
  assert.equal(t.runs, 0);
  assert.equal(t.drivers[0].chance, 1);
  assert.equal(t.drivers[1].chance, 0);
  assert.deepEqual(t.clinch, { decided: true });
});
