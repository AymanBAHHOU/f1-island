// Session analysis from OpenF1: classification, short-run (one-lap) pace,
// long-run pace, tyre usage, speed traps, weather and key race-control notes.
// No Electron dependency, so it can be exercised from plain Node.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OPENF1 = 'https://api.openf1.org/v1';

// Lap classification, relative to the driver's best lap in the session.
const PUSH_FACTOR = 1.08; // within 8%: a representative lap
const COOL_FACTOR = 1.15; // slower than 15%: cool-down / in-lap, ends a run
const MIN_RUN = 3; // shortest run returned; the view lets the user raise the minimum
const RACE_PACE_MIN = 5; // clean laps needed for a race-pace figure
const RUN_OUTLIER = 1.02; // within a run, laps 2% slower than its median count as traffic

const RACE_TYPES = new Set(['Race', 'Sprint']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- disk cache ----------
// While any F1 session is live, OpenF1 refuses free requests (even for past
// sessions). Responses are kept on disk so sessions already opened keep
// working then. Replay chunks (all cars' positions) are too big to keep.

let cacheDir = null;

function setCacheDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    cacheDir = dir;
  } catch {
    cacheDir = null;
  }
}

const cacheFile = (query) => cacheDir && path.join(cacheDir, `${crypto.createHash('sha1').update(query).digest('hex')}.json`);
const keepOnDisk = (query) => !(query.startsWith('location?') && !query.includes('driver_number'));

function readCache(query) {
  const file = cacheFile(query);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(query, data) {
  const file = cacheFile(query);
  if (!file || !keepOnDisk(query)) return;
  fs.writeFile(file, JSON.stringify(data), () => {});
}

const LIVE_LOCK_MESSAGE =
  "Session analysis pauses while a session is live: the free timing data is members-only until it ends. Sessions you've opened before still work; the rest comes back after the session.";

// OpenF1 allows ~3 requests/s, so requests are serialised with a gap.
let chain = Promise.resolve();
function openf1(query) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${OPENF1}/${query}`, { signal: AbortSignal.timeout(20000) });
      } catch (err) {
        // Offline: fall back to what we have.
        const cached = readCache(query);
        if (cached) return cached;
        throw err;
      }
      await sleep(350);
      if (res.status === 429 && attempt < 5) {
        // Rate limited (OpenF1 also caps requests per minute): wait it out.
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      if (res.status === 404) return []; // OpenF1's "no rows"
      if (!res.ok) {
        const cached = readCache(query);
        if (cached) return cached;
        const body = await res.text().catch(() => '');
        if (res.status === 401 && /live f1 session/i.test(body)) throw new Error(LIVE_LOCK_MESSAGE);
        throw new Error(`Timing data unavailable right now (error ${res.status}). Try again in a minute.`);
      }
      const data = await res.json();
      writeCache(query, data);
      return data;
    }
  };
  const p = chain.then(run);
  chain = p.catch(() => {});
  return p;
}

// ---------- session list ----------

let sessionsCache = null;

async function listSessions() {
  if (sessionsCache && Date.now() - sessionsCache.at < 10 * 60e3) return sessionsCache.data;
  const year = new Date().getUTCFullYear();
  const [sessions, meetings] = await Promise.all([
    openf1(`sessions?year=${year}`),
    openf1(`meetings?year=${year}`),
  ]);
  const meetingName = new Map(meetings.map((m) => [m.meeting_key, m.meeting_name]));
  const now = Date.now();
  const data = sessions
    .filter((s) => !s.is_cancelled && Date.parse(s.date_end) < now)
    .sort((a, b) => b.date_start.localeCompare(a.date_start))
    .map((s) => ({
      key: s.session_key,
      name: s.session_name,
      type: s.session_type,
      start: s.date_start,
      end: s.date_end,
      meeting: meetingName.get(s.meeting_key) || s.country_name,
      location: s.location,
    }));
  sessionsCache = { at: Date.now(), data };
  return data;
}

// ---------- maths helpers ----------

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Least-squares slope of y over x (seconds per lap).
function slope(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}
const minOf = (xs) => (xs.length ? Math.min(...xs) : null);
const maxOf = (xs) => (xs.length ? Math.max(...xs) : null);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- analysis ----------

function driverInfo(drivers) {
  return new Map(
    drivers.map((d) => [
      d.driver_number,
      {
        number: d.driver_number,
        code: d.name_acronym || `#${d.driver_number}`,
        name: d.full_name || d.broadcast_name || d.name_acronym,
        team: d.team_name || 'Unknown',
        color: d.team_colour ? `#${d.team_colour}` : '#888888',
      },
    ])
  );
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// Split a driver's laps into runs: blocks of consecutive laps with no
// cool-down lap, pit stop or missing time in between.
function findRuns(laps, stints, best, isRace) {
  const runs = [];
  const lastStint = stints.at(-1);
  const segments = stints.length
    ? stints.map((s) => ({ stint: s, laps: laps.filter((l) => l.lap_number >= s.lap_start && l.lap_number <= s.lap_end) }))
    : [{ stint: null, laps }];

  for (const { stint, laps: segLaps } of segments) {
    // The final lap of a stint is an in-lap, except at the end of a race.
    const keepLast = isRace && stint === lastStint;
    const usable = keepLast ? segLaps : segLaps.slice(0, -1);

    let block = [];
    const close = () => {
      // Second pass: drop laps well off the run's own median (traffic, mistakes).
      const pushed = block.filter((l) => l.push);
      if (pushed.length >= 3) {
        const m = median(pushed.map((l) => l.time));
        for (const l of block) if (l.push && l.time > m * RUN_OUTLIER) l.push = false;
      }
      const push = block.filter((l) => l.push);
      if (push.length) runs.push({ stint, laps: block, push });
      block = [];
    };

    for (const l of usable) {
      const t = l.lap_duration;
      if (l.is_pit_out_lap || !isNum(t) || t > best * COOL_FACTOR) {
        close();
        continue;
      }
      block.push({
        lap: l.lap_number,
        time: t,
        push: t <= best * PUSH_FACTOR,
        tyreAge: stint ? stint.tyre_age_at_start + (l.lap_number - stint.lap_start) : null,
      });
    }
    close();
  }
  return runs;
}

function summariseRun(run, driver) {
  const times = run.push.map((l) => l.time);
  return {
    driver: driver.number,
    compound: run.stint?.compound || 'UNKNOWN',
    tyreAgeStart: run.push[0].tyreAge,
    laps: run.laps.map((l) => ({ lap: l.lap, time: l.time, push: l.push })),
    pushLaps: times.length,
    avg: mean(times),
    median: median(times),
    best: Math.min(...times),
    // Raw trend: tyre wear makes it positive, fuel burn pulls it down.
    trend: slope(
      run.push.map((l) => l.lap),
      times
    ),
  };
}

function classify(results, drivers, bestByDriver) {
  if (results.length) {
    return results
      .slice()
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
      .map((r) => {
        // Qualifying returns per-phase arrays; use the last phase reached.
        const durations = Array.isArray(r.duration) ? r.duration : [r.duration];
        const gaps = Array.isArray(r.gap_to_leader) ? r.gap_to_leader : [r.gap_to_leader];
        let phase = durations.length - 1;
        while (phase > 0 && durations[phase] == null) phase--;
        return {
          position: r.position,
          driver: r.driver_number,
          time: durations[phase] ?? null,
          gap: gaps[phase] ?? null,
          phase: durations.length > 1 ? phase + 1 : null,
          laps: r.number_of_laps,
          status: r.dsq ? 'DSQ' : r.dns ? 'DNS' : r.dnf ? 'DNF' : null,
        };
      });
  }
  // No official classification yet: order by best lap.
  const ordered = [...bestByDriver].filter(([, b]) => b).sort((a, b) => a[1].time - b[1].time);
  const top = ordered[0]?.[1].time;
  return ordered.map(([num, b], i) => ({
    position: i + 1,
    driver: num,
    time: b.time,
    gap: i ? b.time - top : 0,
    phase: null,
    laps: b.laps,
    status: null,
  }));
}

function teamRanking(entries, valueOf) {
  // entries: [{ driver, ... }]; keep each team's best (lowest) value.
  const byTeam = new Map();
  for (const e of entries) {
    const v = valueOf(e);
    if (!isNum(v)) continue;
    const cur = byTeam.get(e.team);
    if (!cur || v < cur.value) byTeam.set(e.team, { team: e.team, color: e.color, driver: e.driver, value: v, entry: e });
  }
  const list = [...byTeam.values()].sort((a, b) => a.value - b.value);
  const top = list[0]?.value;
  return list.map((t) => ({ ...t, gap: t.value - top }));
}

const KEY_MESSAGE = /PENALTY|INVESTIGATION|REPRIMAND|NO FURTHER ACTION|\bRED FLAG/i;
const DELETED = /\bDELETED\b/i;

function analyse(session, raw) {
  const { drivers, laps, stints, results, weather, raceControl } = raw;
  const isRace = RACE_TYPES.has(session.session_name);
  const info = driverInfo(drivers);
  const lapsByDriver = groupBy(laps, 'driver_number');
  const stintsByDriver = groupBy(stints, 'driver_number');

  const perDriver = [];
  const bestByDriver = new Map();
  const longRuns = [];
  const racePace = [];

  for (const [num, dLaps] of lapsByDriver) {
    const d = info.get(num) || { number: num, code: `#${num}`, name: `#${num}`, team: 'Unknown', color: '#888888' };
    dLaps.sort((a, b) => a.lap_number - b.lap_number);
    const dStints = (stintsByDriver.get(num) || []).sort((a, b) => a.lap_start - b.lap_start);
    const stintAt = (lap) => dStints.find((s) => lap >= s.lap_start && lap <= s.lap_end);

    const timed = dLaps.filter((l) => isNum(l.lap_duration) && !l.is_pit_out_lap);
    const bestLap = timed.reduce((b, l) => (!b || l.lap_duration < b.lap_duration ? l : b), null);
    const sector = (k) => minOf(dLaps.map((l) => l[k]).filter(isNum));
    const s1 = sector('duration_sector_1');
    const s2 = sector('duration_sector_2');
    const s3 = sector('duration_sector_3');

    const bestStint = bestLap && stintAt(bestLap.lap_number);
    const best = bestLap
      ? {
          time: bestLap.lap_duration,
          lap: bestLap.lap_number,
          compound: bestStint?.compound || 'UNKNOWN',
          tyreAge: bestStint ? bestStint.tyre_age_at_start + (bestLap.lap_number - bestStint.lap_start) : null,
          laps: dLaps.length,
        }
      : null;
    bestByDriver.set(num, best);

    const lapList = dLaps
      .filter((l) => isNum(l.lap_duration))
      .map((l) => {
        const st = stintAt(l.lap_number);
        return {
          lap: l.lap_number,
          time: l.lap_duration,
          sectors: [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3].map((x) => (isNum(x) ? x : null)),
          compound: st?.compound || 'UNKNOWN',
          tyreAge: st ? st.tyre_age_at_start + (l.lap_number - st.lap_start) : null,
          pitOut: !!l.is_pit_out_lap,
          speedTrap: isNum(l.st_speed) ? l.st_speed : null,
        };
      });

    const row = {
      driver: num,
      code: d.code,
      lapList,
      team: d.team,
      color: d.color,
      laps: dLaps.length,
      best,
      sectors: [s1, s2, s3],
      ideal: s1 && s2 && s3 ? s1 + s2 + s3 : null,
      speedTrap: maxOf(dLaps.map((l) => l.st_speed).filter(isNum)),
      i1: maxOf(dLaps.map((l) => l.i1_speed).filter(isNum)),
      i2: maxOf(dLaps.map((l) => l.i2_speed).filter(isNum)),
      tyres: {},
    };
    for (const s of dStints) {
      const n = Math.max(0, Math.min(s.lap_end, dLaps.at(-1)?.lap_number ?? s.lap_end) - s.lap_start + 1);
      row.tyres[s.compound] = (row.tyres[s.compound] || 0) + n;
    }
    perDriver.push(row);

    if (!best) continue;
    const runs = findRuns(dLaps, dStints, best.time, isRace);

    // Every run long enough to matter; the view picks per driver by the chosen minimum.
    for (const run of runs) {
      if (run.push.length >= MIN_RUN) longRuns.push({ ...summariseRun(run, d), code: d.code, team: d.team, color: d.color });
    }

    if (isRace) {
      const push = runs.flatMap((r) => r.push.map((l) => l.time));
      if (push.length >= RACE_PACE_MIN) {
        racePace.push({ driver: num, code: d.code, team: d.team, color: d.color, laps: push.length, median: median(push), avg: mean(push) });
      }
    }
  }

  // Overall best sectors, for highlighting.
  const bestSectors = [0, 1, 2].map((i) => minOf(perDriver.map((r) => r.sectors[i]).filter(isNum)));

  // Tyre usage by team.
  const tyresByTeam = new Map();
  for (const r of perDriver) {
    const t = tyresByTeam.get(r.team) || { team: r.team, color: r.color, compounds: {} };
    for (const [c, n] of Object.entries(r.tyres)) t.compounds[c] = (t.compounds[c] || 0) + n;
    tyresByTeam.set(r.team, t);
  }

  const shortRunsTeams = teamRanking(perDriver, (r) => r.best?.time);
  const racePaceTeams = teamRanking(racePace, (r) => r.median);

  // Zero readings are sensor dropouts, not real temperatures.
  const air = weather.map((w) => w.air_temperature).filter((t) => isNum(t) && t > 0);
  const track = weather.map((w) => w.track_temperature).filter((t) => isNum(t) && t > 0);

  return {
    session: {
      key: session.session_key,
      name: session.session_name,
      type: session.session_type,
      isRace,
      start: session.date_start,
      location: session.location,
      country: session.country_name,
    },
    drivers: Object.fromEntries([...info].map(([k, v]) => [k, v])),
    classification: classify(results, drivers, bestByDriver),
    perDriver,
    bestSectors,
    shortRuns: { teams: shortRunsTeams },
    longRuns: {
      all: longRuns,
      settings: { pushFactor: PUSH_FACTOR, coolFactor: COOL_FACTOR, minRun: MIN_RUN },
    },
    racePace: { drivers: racePace.sort((a, b) => a.median - b.median), teams: racePaceTeams },
    tyres: [...tyresByTeam.values()],
    weather: air.length
      ? {
          air: [minOf(air), maxOf(air)],
          track: [minOf(track), maxOf(track)],
          rain: weather.some((w) => w.rainfall > 0),
          humidity: mean(weather.map((w) => w.humidity).filter(isNum)),
          wind: maxOf(weather.map((w) => w.wind_speed).filter(isNum)),
        }
      : null,
    notes: raceControl
      .filter((m) => !DELETED.test(m.message || ''))
      .filter((m) => m.flag === 'RED' || m.category === 'SafetyCar' || KEY_MESSAGE.test(m.message || ''))
      .map((m) => ({ date: m.date, lap: m.lap_number, message: m.message, flag: m.flag, category: m.category })),
    // Lap times deleted (mostly track limits), counted per driver.
    // OpenF1 leaves driver_number empty on these, so read "CAR 18 (STR)" from the text.
    deletedLaps: [
      ...groupBy(
        raceControl
          .filter((m) => DELETED.test(m.message || ''))
          .map((m) => ({ driver_number: m.driver_number ?? Number(/\bCAR (\d+)/i.exec(m.message)?.[1]) }))
          .filter((m) => m.driver_number),
        'driver_number'
      ),
    ]
      .map(([num, msgs]) => ({ driver: num, count: msgs.length }))
      .sort((a, b) => b.count - a.count),
  };
}

const analysisCache = new Map();

async function getAnalysis(sessionKey) {
  const hit = analysisCache.get(sessionKey);
  if (hit && (hit.final || Date.now() - hit.at < 5 * 60e3)) return hit.data;

  const [session] = await openf1(`sessions?session_key=${sessionKey}`);
  if (!session) throw new Error('Session not found');
  const q = `session_key=${sessionKey}`;
  // Sequential on purpose (rate limit); the queue spaces them out.
  const drivers = await openf1(`drivers?${q}`);
  const laps = await openf1(`laps?${q}`);
  const stints = await openf1(`stints?${q}`);
  const results = await openf1(`session_result?${q}`);
  const weather = await openf1(`weather?${q}`);
  const raceControl = await openf1(`race_control?${q}`);

  if (!laps.length) throw new Error('No lap data for this session yet. It usually appears about 30 minutes after the session ends.');

  const data = analyse(session, { drivers, laps, stints, results, weather, raceControl });
  // Data is considered final a couple of hours after the session ends.
  const final = Date.now() - Date.parse(session.date_end) > 2 * 3600e3;
  analysisCache.set(sessionKey, { at: Date.now(), final, data, laps, session, raceControl, drivers });
  return data;
}

// ---------- telemetry ----------

const telemetryCache = new Map();

// Value of `key` at time t, linearly interpolated between samples.
function interpAt(samples, t, key) {
  let i = samples.findIndex((s) => s.t >= t);
  if (i <= 0) return samples[Math.max(0, i)][key];
  const a = samples[i - 1];
  const b = samples[i];
  return a[key] + ((b[key] - a[key]) * (t - a.t)) / (b.t - a.t || 1);
}

// Car telemetry for one lap, with distance (m) from the start line obtained by
// integrating speed. Samples arrive ~3.7 times a second.
async function getTelemetry(sessionKey, driver, lapNumber) {
  const cacheKey = `${sessionKey}/${driver}/${lapNumber}`;
  if (telemetryCache.has(cacheKey)) return telemetryCache.get(cacheKey);

  if (!analysisCache.get(sessionKey)?.laps) await getAnalysis(sessionKey);
  const lap = analysisCache.get(sessionKey).laps.find((l) => l.driver_number === driver && l.lap_number === lapNumber);
  if (!lap?.date_start || !isNum(lap.lap_duration)) throw new Error('No timing for that lap.');

  const start = Date.parse(lap.date_start);
  const lapTime = lap.lap_duration;
  const from = new Date(start - 1500).toISOString();
  const to = new Date(start + lapTime * 1000 + 1500).toISOString();
  const rows = await openf1(
    `car_data?session_key=${sessionKey}&driver_number=${driver}&date>=${encodeURIComponent(from)}&date<=${encodeURIComponent(to)}`
  );
  if (rows.length < 20) throw new Error('No car telemetry for that lap.');

  // Time from the lap start, then distance by trapezoid integration of speed.
  const raw = rows
    .map((r) => ({
      t: (Date.parse(r.date) - start) / 1000,
      speed: r.speed,
      throttle: Math.min(100, Math.max(0, r.throttle)),
      brake: r.brake > 0 ? 100 : 0,
      gear: r.n_gear,
      drs: r.drs >= 10, // 10/12/14 = flap open
    }))
    .sort((a, b) => a.t - b.t);
  raw[0].d = 0;
  for (let i = 1; i < raw.length; i++) {
    raw[i].d = raw[i - 1].d + (((raw[i - 1].speed + raw[i].speed) / 2) * (raw[i].t - raw[i - 1].t)) / 3.6;
  }

  // Re-zero on the start line and clip to the lap.
  const d0 = interpAt(raw, 0, 'd');
  const length = interpAt(raw, lapTime, 'd') - d0;
  const samples = raw
    .filter((r) => r.t >= 0 && r.t <= lapTime)
    .map((r) => ({ ...r, t: Math.round(r.t * 1000) / 1000, d: Math.round((r.d - d0) * 10) / 10 }));
  const edge = (t) => ({
    t,
    d: Math.round((interpAt(raw, t, 'd') - d0) * 10) / 10,
    speed: Math.round(interpAt(raw, t, 'speed')),
    throttle: Math.round(interpAt(raw, t, 'throttle')),
    brake: samples[0]?.brake ?? 0,
    gear: Math.round(interpAt(raw, t, 'gear')),
    drs: false,
  });
  samples.unshift(edge(0));
  samples.push({ ...edge(lapTime), brake: samples.at(-1).brake, drs: samples.at(-1).drs });

  const result = { driver, lap: lapNumber, lapTime, length, samples };
  telemetryCache.set(cacheKey, result);
  return result;
}

// ---------- positions on track: maps & replay ----------

const lapLocationCache = new Map();
const trackMapCache = new Map();

async function ensureAnalysed(sessionKey) {
  if (!analysisCache.get(sessionKey)?.laps) await getAnalysis(sessionKey);
  return analysisCache.get(sessionKey);
}

// x/y positions (decimetres) through one lap, with t = seconds from the lap start.
async function getLapLocation(sessionKey, driver, lapNumber) {
  const cacheKey = `${sessionKey}/${driver}/${lapNumber}`;
  if (lapLocationCache.has(cacheKey)) return lapLocationCache.get(cacheKey);
  const { laps } = await ensureAnalysed(sessionKey);
  const lap = laps.find((l) => l.driver_number === driver && l.lap_number === lapNumber);
  if (!lap?.date_start || !isNum(lap.lap_duration)) throw new Error('No timing for that lap.');
  const start = Date.parse(lap.date_start);
  const from = new Date(start).toISOString();
  const to = new Date(start + lap.lap_duration * 1000).toISOString();
  const rows = await openf1(
    `location?session_key=${sessionKey}&driver_number=${driver}&date>=${encodeURIComponent(from)}&date<=${encodeURIComponent(to)}`
  );
  // (0,0,0) rows are dropouts.
  const points = rows
    .filter((r) => r.x || r.y)
    .map((r) => ({ t: (Date.parse(r.date) - start) / 1000, x: r.x, y: r.y }))
    .sort((a, b) => a.t - b.t);
  if (points.length < 30) throw new Error('No position data for that lap.');
  const result = { driver, lap: lapNumber, points };
  lapLocationCache.set(cacheKey, result);
  return result;
}

// Track outline from the session's fastest clean lap.
async function getTrackMap(sessionKey) {
  if (trackMapCache.has(sessionKey)) return trackMapCache.get(sessionKey);
  const { laps } = await ensureAnalysed(sessionKey);
  const fastest = laps
    .filter((l) => isNum(l.lap_duration) && !l.is_pit_out_lap && l.date_start)
    .sort((a, b) => a.lap_duration - b.lap_duration)[0];
  if (!fastest) throw new Error('No laps to draw the track from.');
  const loc = await getLapLocation(sessionKey, fastest.driver_number, fastest.lap_number);
  const map = { points: loc.points.map(({ x, y }) => ({ x, y })) };
  trackMapCache.set(sessionKey, map);
  return map;
}

// Map for a race weekend: this weekend's latest finished session, otherwise
// last year's race at the same venue.
async function getWeekendTrackMap({ start, end, country, locality }) {
  const sessions = await listSessions();
  const t0 = Date.parse(start) - 6 * 3600e3;
  const t1 = Date.parse(end) + 24 * 3600e3;
  const thisWeekend = sessions.find((s) => Date.parse(s.start) >= t0 && Date.parse(s.start) <= t1);
  if (thisWeekend) return getTrackMap(thisWeekend.key);

  const year = new Date(start).getUTCFullYear() - 1;
  const races = await openf1(`sessions?year=${year}&session_name=Race`);
  const norm = (v) => String(v || '').toLowerCase();
  const sameCountry = races.filter((r) => norm(r.country_name) === norm(country));
  const match =
    sameCountry.find((r) => norm(r.location).includes(norm(locality)) || norm(locality).includes(norm(r.location))) ||
    (sameCountry.length === 1 ? sameCountry[0] : null);
  if (!match) return null;
  return getTrackMap(match.session_key);
}

// ---------- replay ----------

const REPLAY_CHUNK_MS = 60e3;
const chunkCache = new Map(); // LRU-ish: insertion order
const CHUNK_CACHE_MAX = 40;

async function getReplayInfo(sessionKey) {
  const a = await ensureAnalysed(sessionKey);
  const start = Date.parse(a.session.date_start);
  const end = Date.parse(a.session.date_end);
  const rel = (iso) => Date.parse(iso) - start;
  const positions = await openf1(`position?session_key=${sessionKey}`);
  const drivers = Object.fromEntries(
    a.drivers.map((d) => [
      d.driver_number,
      { code: d.name_acronym || `#${d.driver_number}`, color: d.team_colour ? `#${d.team_colour}` : '#888888', team: d.team_name },
    ])
  );
  return {
    sessionKey,
    name: a.session.session_name,
    isRace: RACE_TYPES.has(a.session.session_name),
    duration: end - start,
    chunkMs: REPLAY_CHUNK_MS,
    drivers,
    // [ms from start, driver, position]
    positions: positions.map((p) => [rel(p.date), p.driver_number, p.position]).sort((x, y) => x[0] - y[0]),
    // [ms from start, driver, lap number] for each lap start
    laps: a.laps
      .filter((l) => l.date_start)
      .map((l) => [rel(l.date_start), l.driver_number, l.lap_number])
      .sort((x, y) => x[0] - y[0]),
    messages: a.raceControl
      .filter((m) => m.message)
      .map((m) => ({ t: rel(m.date), message: m.message, flag: m.flag, category: m.category }))
      .sort((x, y) => x.t - y.t),
    track: await getTrackMap(sessionKey).catch(() => null),
  };
}

// Car positions for one chunk of the session: { cars: { [driver]: [[ms, x, y], ...] } }.
async function getReplayChunk(sessionKey, index) {
  const cacheKey = `${sessionKey}/${index}`;
  if (chunkCache.has(cacheKey)) return chunkCache.get(cacheKey);
  const a = await ensureAnalysed(sessionKey);
  const start = Date.parse(a.session.date_start);
  const from = new Date(start + index * REPLAY_CHUNK_MS).toISOString();
  const to = new Date(start + (index + 1) * REPLAY_CHUNK_MS).toISOString();
  const rows = await openf1(`location?session_key=${sessionKey}&date>=${encodeURIComponent(from)}&date<${encodeURIComponent(to)}`);
  const cars = {};
  for (const r of rows) {
    if (!r.x && !r.y) continue;
    (cars[r.driver_number] ||= []).push([Date.parse(r.date) - start, r.x, r.y]);
  }
  for (const list of Object.values(cars)) list.sort((x, y) => x[0] - y[0]);
  const chunk = { index, cars };
  chunkCache.set(cacheKey, chunk);
  if (chunkCache.size > CHUNK_CACHE_MAX) chunkCache.delete(chunkCache.keys().next().value);
  return chunk;
}

// ---------- weekend results ----------
// The top three of each finished session this weekend, for the Weekend page.
// Only the classification is fetched (not laps), so this stays light.

const weekendResultsCache = new Map(); // session key -> { at, final, entry }

// Qualifying gives per-phase arrays (Q1, Q2, Q3): use the last phase reached.
const lastPhase = (v) => (Array.isArray(v) ? v.filter((x) => x != null).at(-1) ?? null : v ?? null);

// [{ pos, code, color, time, gap }]: the winner's time (not for races, where
// it's the whole race), then gaps; gaps can be text ("+1 LAP").
function podiumOf(results, drivers, sessionName) {
  const info = driverInfo(drivers);
  const isRace = RACE_TYPES.has(sessionName);
  return results
    .filter((r) => r.position >= 1 && r.position <= 3)
    .sort((a, b) => a.position - b.position)
    .map((r) => {
      const d = info.get(r.driver_number);
      const time = lastPhase(r.duration);
      const gap = lastPhase(r.gap_to_leader);
      return {
        pos: r.position,
        code: d?.code || `#${r.driver_number}`,
        color: d?.color || '#888888',
        time: r.position === 1 && !isRace && isNum(time) ? time : null,
        gap: r.position === 1 ? null : gap,
      };
    });
}

async function getWeekendResults({ start, end }) {
  const sessions = await listSessions();
  const t0 = Date.parse(start) - 6 * 3600e3;
  const t1 = Date.parse(end) + 24 * 3600e3;
  const these = sessions
    .filter((s) => Date.parse(s.start) >= t0 && Date.parse(s.start) <= t1)
    .sort((a, b) => a.start.localeCompare(b.start));
  const out = [];
  for (const s of these) {
    const hit = weekendResultsCache.get(s.key);
    if (hit && (hit.final || Date.now() - hit.at < 5 * 60e3)) {
      out.push(hit.entry);
      continue;
    }
    try {
      const results = await openf1(`session_result?session_key=${s.key}&position%3C%3D3`);
      const drivers = results.length ? await openf1(`drivers?session_key=${s.key}`) : [];
      const entry = { key: s.key, name: s.name, start: s.start, top: podiumOf(results, drivers, s.name) };
      // Classifications can still change for a while (penalties): final after 2 hours.
      const final = entry.top.length > 0 && Date.now() - Date.parse(s.end) > 2 * 3600e3;
      weekendResultsCache.set(s.key, { at: Date.now(), final, entry });
      out.push(entry);
    } catch {
      out.push(hit?.entry || { key: s.key, name: s.name, start: s.start, top: [], unavailable: true });
    }
  }
  return out;
}

module.exports = {
  listSessions,
  getAnalysis,
  getTelemetry,
  getLapLocation,
  getTrackMap,
  getWeekendTrackMap,
  getWeekendResults,
  podiumOf,
  getReplayInfo,
  getReplayChunk,
  analyse,
  setCacheDir,
};
