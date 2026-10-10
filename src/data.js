// Data layer: schedule/results/standings from Jolpica (Ergast successor).
// Runs in the main process. Live timing lives in livetiming.js.

const JOLPICA = 'https://api.jolpi.ca/ergast/f1';

const SESSION_DEFS = [
  { key: 'FirstPractice', name: 'Practice 1', short: 'FP1', mins: 60 },
  { key: 'SecondPractice', name: 'Practice 2', short: 'FP2', mins: 60 },
  { key: 'ThirdPractice', name: 'Practice 3', short: 'FP3', mins: 60 },
  { key: 'SprintQualifying', name: 'Sprint Qualifying', short: 'SQ', mins: 45 },
  { key: 'SprintShootout', name: 'Sprint Shootout', short: 'SQ', mins: 45 },
  { key: 'Sprint', name: 'Sprint', short: 'SPR', mins: 60 },
  { key: 'Qualifying', name: 'Qualifying', short: 'Q', mins: 60 },
];
const RACE_MINS = 120;
// Keep showing a weekend this long after the race's scheduled end.
const WEEKEND_TAIL_MS = 6 * 3600e3;

const HOUR = 3600e3;
const MIN = 60e3;

const cache = new Map();

async function getJson(url, ttlMs) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (hit) return hit.data; // stale data beats no data
    throw err;
  }
}

const toDate = (o) => (o && o.date ? new Date(`${o.date}T${o.time || '00:00:00Z'}`) : null);

function buildSessions(race) {
  const sessions = [];
  const add = (name, short, start, mins) =>
    sessions.push({
      name,
      short,
      start: start.toISOString(),
      end: new Date(start.getTime() + mins * MIN).toISOString(),
    });

  for (const def of SESSION_DEFS) {
    const start = toDate(race[def.key]);
    if (start) add(def.name, def.short, start, def.mins);
  }
  add('Race', 'RACE', toDate(race), RACE_MINS);
  return sessions.sort((a, b) => a.start.localeCompare(b.start));
}

function pickWeekend(races, now = Date.now()) {
  const race = races.find((r) => toDate(r).getTime() + RACE_MINS * MIN + WEEKEND_TAIL_MS > now);
  if (!race) return null;
  return {
    season: race.season,
    round: race.round,
    name: race.raceName,
    circuitId: race.Circuit.circuitId,
    circuit: race.Circuit.circuitName,
    locality: race.Circuit.Location.locality,
    country: race.Circuit.Location.country,
    sessions: buildSessions(race),
  };
}

const driverCode = (d) => d.code || d.familyName.slice(0, 3).toUpperCase();
const byPosition = (a, b) => Number(a.position) - Number(b.position);

// Recent winners at a circuit and a recap of the most recent race there
// before `season` (pole, podium, fastest lap).
async function getCircuitHistory(circuitId, season) {
  const winnersUrl = `${JOLPICA}/circuits/${circuitId}/results/1.json`;
  const head = await getJson(`${winnersUrl}?limit=1`, 12 * HOUR);
  const total = Number(head.MRData.total) || 0;
  const recent = total
    ? (await getJson(`${winnersUrl}?limit=6&offset=${Math.max(0, total - 6)}`, 12 * HOUR)).MRData.RaceTable.Races
    : [];
  const past = recent.filter((r) => Number(r.season) < Number(season));

  const history = {
    winners: past
      .slice(-5)
      .reverse()
      .map((r) => ({ season: r.season, code: driverCode(r.Results[0].Driver), teamId: r.Results[0].Constructor.constructorId })),
    last: null,
  };

  const lastSeason = past.at(-1)?.season;
  if (!lastSeason) return history;

  const [results, quali] = await Promise.all([
    getJson(`${JOLPICA}/${lastSeason}/circuits/${circuitId}/results.json?limit=40`, 24 * HOUR),
    getJson(`${JOLPICA}/${lastSeason}/circuits/${circuitId}/qualifying.json?limit=40`, 24 * HOUR).catch(() => null),
  ]);
  const race = results.MRData.RaceTable.Races[0];
  if (!race) return history;
  const classified = race.Results.slice().sort(byPosition);
  const fastest = classified.find((r) => r.FastestLap?.rank === '1');
  // Rows don't reliably come back in position order, so look for P1 explicitly.
  const pole = quali?.MRData.RaceTable.Races[0]?.QualifyingResults.find((q) => q.position === '1');

  history.last = {
    season: lastSeason,
    name: race.raceName,
    laps: classified[0].laps,
    winnerTime: classified[0].Time?.time ?? null,
    podium: classified.slice(0, 3).map((r) => ({ pos: r.position, code: driverCode(r.Driver), teamId: r.Constructor.constructorId })),
    pole: pole && {
      code: driverCode(pole.Driver),
      teamId: pole.Constructor.constructorId,
      time: pole.Q3 || pole.Q2 || pole.Q1 || null,
    },
    fastestLap: fastest && {
      code: driverCode(fastest.Driver),
      teamId: fastest.Constructor.constructorId,
      time: fastest.FastestLap.Time?.time ?? null,
      lap: fastest.FastestLap.lap,
    },
  };
  return history;
}

async function getSnapshot() {
  const [schedule, last, standings, constructors] = await Promise.allSettled([
    getJson(`${JOLPICA}/current.json?limit=100`, 6 * HOUR),
    getJson(`${JOLPICA}/current/last/results.json?limit=3`, 10 * MIN),
    getJson(`${JOLPICA}/current/driverStandings.json?limit=10`, 10 * MIN),
    getJson(`${JOLPICA}/current/constructorStandings.json?limit=11`, 10 * MIN),
  ]);

  const snap = {
    fetchedAt: new Date().toISOString(),
    weekend: null,
    lastRace: null,
    standings: [],
    constructors: [],
    circuit: null,
    error: null,
  };

  if (schedule.status === 'fulfilled') {
    snap.weekend = pickWeekend(schedule.value.MRData.RaceTable.Races);
  } else {
    snap.error = `Schedule unavailable (${schedule.reason.message})`;
  }

  if (last.status === 'fulfilled') {
    const race = last.value.MRData.RaceTable.Races[0];
    if (race) {
      snap.lastRace = {
        round: race.round,
        name: race.raceName,
        podium: race.Results.slice(0, 3).map((r) => ({
          pos: r.position,
          code: driverCode(r.Driver),
          teamId: r.Constructor.constructorId,
        })),
      };
    }
  }

  if (standings.status === 'fulfilled') {
    const list = standings.value.MRData.StandingsTable.StandingsLists[0];
    snap.standings = (list ? list.DriverStandings : []).slice(0, 10).map((s) => ({
      pos: s.position || s.positionText,
      code: driverCode(s.Driver),
      points: s.points,
      teamId: s.Constructors.at(-1)?.constructorId,
    }));
  }

  if (constructors.status === 'fulfilled') {
    const list = constructors.value.MRData.StandingsTable.StandingsLists[0];
    snap.constructors = (list ? list.ConstructorStandings : []).map((s) => ({
      pos: s.position || s.positionText,
      name: s.Constructor.name,
      teamId: s.Constructor.constructorId,
      points: s.points,
    }));
  }

  // Jolpica can lag hours behind a Sprint or race; prefer OpenF1's championship
  // when it reflects a later session.
  if (standings.status === 'fulfilled' && schedule.status === 'fulfilled') {
    const list = standings.value.MRData.StandingsTable.StandingsLists[0];
    const race = schedule.value.MRData.RaceTable.Races.find((r) => r.round === list?.round);
    const jolpicaAsOf = race ? toDate(race).getTime() + RACE_MINS * MIN : 0;
    try {
      const fresher = await getOpenF1Standings(jolpicaAsOf);
      if (fresher) Object.assign(snap, fresher);
    } catch {
      // OpenF1 unavailable (e.g. locked during a live session): keep Jolpica's.
    }
  }

  if (snap.weekend) {
    try {
      snap.circuit = await getCircuitHistory(snap.weekend.circuitId, snap.weekend.season);
    } catch {
      // Optional extra; the Circuit page says it's unavailable.
    }
  }

  return snap;
}

// ---------- fresher standings (OpenF1) ----------

const OPENF1 = 'https://api.openf1.org/v1';
const FINAL_AFTER_MS = 30 * MIN; // OpenF1 publishes results ~30 min after a session

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenF1 allows ~3 requests/s: space requests out and retry when rate limited.
async function openf1Json(url, ttlMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      const fresh = !cache.has(url) || Date.now() - cache.get(url).at >= ttlMs;
      const data = await getJson(url, ttlMs);
      if (fresh) await sleep(400);
      return data;
    } catch (err) {
      if (!/^429/.test(err.message) || attempt >= 3) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// Championship after the latest finished Sprint/race, if it's newer than
// `afterMs`. Returns { standings, constructors, standingsNote } or null.
async function getOpenF1Standings(afterMs) {
  const year = new Date().getUTCFullYear();
  const sessions = await openf1Json(`${OPENF1}/sessions?year=${year}&session_type=Race`, 30 * MIN);
  const now = Date.now();
  const latest = sessions
    .filter((s) => !s.is_cancelled && Date.parse(s.date_end) + FINAL_AFTER_MS < now)
    .sort((a, b) => b.date_start.localeCompare(a.date_start))[0];
  if (!latest || Date.parse(latest.date_start) <= afterMs) return null;

  // Sequential: OpenF1 allows only a few requests per second.
  const q = `session_key=${latest.session_key}`;
  const champ = await openf1Json(`${OPENF1}/championship_drivers?${q}`, 10 * MIN);
  const teams = await openf1Json(`${OPENF1}/championship_teams?${q}`, 10 * MIN);
  const drivers = await openf1Json(`${OPENF1}/drivers?${q}`, 60 * MIN);
  const [meeting] = await openf1Json(`${OPENF1}/meetings?meeting_key=${latest.meeting_key}`, 12 * HOUR);
  if (!champ.length) return null;

  const byNumber = new Map(drivers.map((d) => [d.driver_number, d]));
  const teamColour = new Map(drivers.filter((d) => d.team_colour).map((d) => [d.team_name, `#${d.team_colour}`]));
  const colourOf = (d) => (d?.team_colour ? `#${d.team_colour}` : null);

  return {
    standings: champ
      .slice()
      .sort((a, b) => a.position_current - b.position_current)
      .slice(0, 10)
      .map((c) => {
        const d = byNumber.get(c.driver_number);
        return { pos: String(c.position_current), code: d?.name_acronym || `#${c.driver_number}`, points: String(c.points_current), color: colourOf(d) };
      }),
    constructors: teams
      .slice()
      .sort((a, b) => a.position_current - b.position_current)
      .map((t) => ({ pos: String(t.position_current), name: t.team_name, points: String(t.points_current), color: teamColour.get(t.team_name) || null })),
    standingsNote: `After ${(meeting?.meeting_name || latest.country_name).replace(/Grand Prix/i, 'GP')}${
      latest.session_name === 'Sprint' ? ' Sprint' : ''
    }`,
  };
}

module.exports = { getSnapshot };
