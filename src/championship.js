// Championship maths: points still available, who can still win, the
// earliest round the leader can clinch, and title chances from a Monte Carlo
// simulation of the remaining races based on recent form.
//
// The chances are an estimate: each driver gets a form score from recent
// results (newer events weigh more), every remaining race is played out with
// a finishing order drawn in proportion to exp(BETA × form) (a Plackett-Luce
// draw) plus a per-driver retirement chance, and points are awarded. Upgrades,
// penalties, weather and team orders are unknown to it.

const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];
const POINTS = { race: RACE_POINTS, sprint: SPRINT_POINTS };

// Most a single driver / a two-car team can score in one event.
const MAX_DRIVER = { race: 25, sprint: 8 };
const MAX_TEAM = { race: 25 + 18, sprint: 8 + 7 };

const FORM_DECAY = 0.8; // each older event counts 20% less
const BETA = 5; // how strongly form separates drivers
// Pace isn't known exactly: each simulated season redraws every driver's form
// with this much spread (tracks, upgrades). Without it the model is
// over-confident in close fights. Backtests: 2021 after R15 (HAM +2) gives
// HAM 55% / VER 45%; 2025 after R17 (PIA +25) gives PIA 71% / NOR 22% / VER 7%.
const FORM_SPREAD = 0.25;
const DNF_PRIOR = { dnfs: 1, starts: 12 }; // shrinks retirement rates towards ~8%

// ---------- exact maths ----------

const available = (events, perEvent) => events.reduce((sum, e) => sum + perEvent[e.type], 0);

// entries: [{ id, points }]; returns them sorted, with gap, best possible
// total and whether they can still win (a tie is still possible on countback).
function contention(entries, events, perEvent) {
  const left = available(events, perEvent);
  const sorted = [...entries].sort((a, b) => b.points - a.points);
  const leader = sorted[0]?.points ?? 0;
  return sorted.map((e) => ({
    ...e,
    gap: leader - e.points,
    maxPossible: e.points + left,
    contender: e.points + left >= leader,
  }));
}

// Earliest event after which the leader can be champion (winning everything
// while the runner-up scores nothing). Returns { decided: true } if it's
// already over, { event, index, lead } (lead the leader needs after that
// event) or null if there are no events left.
function earliestClinch(leaderPoints, secondPoints, events, perEvent = MAX_DRIVER) {
  const total = available(events, perEvent);
  const lead = leaderPoints - secondPoints;
  if (lead > total) return { decided: true };
  let gained = 0;
  for (let i = 0; i < events.length; i++) {
    gained += perEvent[events[i].type];
    const remaining = total - gained;
    if (lead + gained > remaining) return { event: events[i], index: i, lead: remaining };
  }
  return null;
}

// ---------- form ----------

// history: [{ driver, type, round, points, dnf }] for this season, any order.
// Returns Map(driver -> { form, dnfRate, wins }).
function formFromHistory(history, decay = FORM_DECAY) {
  const events = [...new Set(history.map((h) => `${String(h.round).padStart(3, '0')}-${h.type === 'sprint' ? 0 : 1}`))].sort();
  const age = new Map(events.map((e, i) => [e, events.length - 1 - i]));
  const out = new Map();
  for (const h of history) {
    const s = out.get(h.driver) || { sum: 0, weight: 0, dnfs: 0, starts: 0, wins: 0 };
    s.starts++;
    if (h.dnf) s.dnfs++;
    else {
      // Retirements count towards reliability, not pace.
      const w = decay ** age.get(`${String(h.round).padStart(3, '0')}-${h.type === 'sprint' ? 0 : 1}`);
      s.sum += w * Math.min(1, h.points / MAX_DRIVER[h.type]);
      s.weight += w;
    }
    if (h.type === 'race' && h.position === 1) s.wins++;
    out.set(h.driver, s);
  }
  return new Map(
    [...out].map(([d, s]) => [
      d,
      {
        form: s.weight ? s.sum / s.weight : 0,
        dnfRate: (s.dnfs + DNF_PRIOR.dnfs) / (s.starts + DNF_PRIOR.starts),
        wins: s.wins,
      },
    ])
  );
}

// ---------- simulation ----------

// Small seeded PRNG so the same inputs always give the same chances.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// drivers: [{ id, team, points, form, dnfRate, wins }]; teams: [{ id, points }].
// Returns { drivers: Map(id -> chance), teams: Map(id -> chance) }.
function simulate({ drivers, teams, events, runs = 20000, seed = 1, beta = BETA, spread = FORM_SPREAD }) {
  const rand = mulberry32(seed);
  const n = drivers.length;
  const driverTitles = new Array(n).fill(0);
  const teamIndex = new Map(teams.map((t, i) => [t.id, i]));
  const teamTitles = new Array(teams.length).fill(0);
  const strength = new Float64Array(n);
  // Standard normal draw (Box-Muller) from the seeded generator.
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const keys = new Float64Array(n);
  const order = new Array(n);
  const total = new Float64Array(n);
  const wins = new Float64Array(n);
  const teamTotal = new Float64Array(teams.length);

  for (let run = 0; run < runs; run++) {
    for (let i = 0; i < n; i++) {
      strength[i] = beta * ((drivers[i].form || 0) + spread * gauss());
      total[i] = drivers[i].points;
      wins[i] = drivers[i].wins || 0;
    }
    for (let t = 0; t < teams.length; t++) teamTotal[t] = teams[t].points;

    for (const ev of events) {
      // Gumbel-max trick: sorting by strength + Gumbel noise is a
      // Plackett-Luce draw. Retirements sink to the back.
      for (let i = 0; i < n; i++) {
        order[i] = i;
        keys[i] = rand() < drivers[i].dnfRate ? -1e9 : strength[i] - Math.log(-Math.log(rand() || 1e-12));
      }
      order.sort((a, b) => keys[b] - keys[a]);
      const table = POINTS[ev.type];
      for (let p = 0; p < table.length && p < n; p++) {
        const i = order[p];
        if (keys[i] <= -1e9) break; // retired: no points
        total[i] += table[p];
        const t = teamIndex.get(drivers[i].team);
        if (t !== undefined) teamTotal[t] += table[p];
      }
      if (ev.type === 'race' && keys[order[0]] > -1e9) wins[order[0]]++;
    }

    // Champion: most points, then most wins (countback, simplified).
    let best = 0;
    for (let i = 1; i < n; i++) {
      if (total[i] > total[best] || (total[i] === total[best] && wins[i] > wins[best])) best = i;
    }
    driverTitles[best]++;
    let bestTeam = 0;
    for (let t = 1; t < teams.length; t++) if (teamTotal[t] > teamTotal[bestTeam]) bestTeam = t;
    if (teams.length) teamTitles[bestTeam]++;
  }

  return {
    drivers: new Map(drivers.map((d, i) => [d.id, driverTitles[i] / runs])),
    teams: new Map(teams.map((t, i) => [t.id, teamTitles[i] / runs])),
  };
}

// ---------- everything for the island ----------

// input: {
//   drivers: [{ code, points, team, color }], teams: [{ name, points, color }],
//   events: [{ type: 'race'|'sprint', name, start }] still to be scored,
//   history: [{ driver, type, round, points, position, dnf }]
// }
function titleFight({ drivers, teams, events, history, runs = 20000, beta = BETA, decay = FORM_DECAY, spread = FORM_SPREAD }) {
  const form = formFromHistory(history, decay);
  const dRows = contention(drivers.map((d) => ({ ...d, id: d.code })), events, MAX_DRIVER);
  const tRows = contention(teams.map((t) => ({ ...t, id: t.name })), events, MAX_TEAM);

  let chances = null;
  if (events.length && dRows.length) {
    chances = simulate({
      drivers: dRows.map((d) => ({ id: d.id, team: d.team, points: d.points, ...(form.get(d.code) || { form: 0, dnfRate: 0.1, wins: 0 }) })),
      teams: tRows.map((t) => ({ id: t.id, points: t.points })),
      events,
      runs,
      beta,
      spread,
    });
  }
  // Out of contention means zero, whatever the simulation's rounding says.
  const chanceOf = (map, row) => (row.contender ? (chances ? map.get(row.id) ?? 0 : row.gap === 0 ? 1 : 0) : 0);

  return {
    races: events.filter((e) => e.type === 'race').length,
    sprints: events.filter((e) => e.type === 'sprint').length,
    pointsLeft: available(events, MAX_DRIVER),
    teamPointsLeft: available(events, MAX_TEAM),
    runs: chances ? runs : 0,
    drivers: dRows.map((d) => ({
      code: d.code,
      color: d.color || null,
      points: d.points,
      gap: d.gap,
      maxPossible: d.maxPossible,
      contender: d.contender,
      chance: chanceOf(chances?.drivers, d),
    })),
    teams: tRows.map((t) => ({
      name: t.name,
      color: t.color || null,
      points: t.points,
      gap: t.gap,
      maxPossible: t.maxPossible,
      contender: t.contender,
      chance: chanceOf(chances?.teams, t),
    })),
    clinch: dRows.length > 1 ? earliestClinch(dRows[0].points, dRows[1].points, events) : null,
    teamClinch: tRows.length > 1 ? earliestClinch(tRows[0].points, tRows[1].points, events, MAX_TEAM) : null,
  };
}

module.exports = { titleFight, contention, earliestClinch, formFromHistory, simulate, MAX_DRIVER, MAX_TEAM };
