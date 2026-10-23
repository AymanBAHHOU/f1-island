// Explicitly labelled synthetic data, used by previews and offline tests only.
const MODES = ['next', 'race', 'safety-car', 'red-flag', 'penalty'];

// A plausible running order for the timing tower: [code, team colour].
const FIELD = [
  ['VER', '#3671C6'], ['NOR', '#FF8000'], ['LEC', '#E8002D'], ['ANT', '#27F4D2'], ['RUS', '#27F4D2'],
  ['HAM', '#E8002D'], ['PIA', '#FF8000'], ['HAD', '#3671C6'], ['ALO', '#229971'], ['GAS', '#00A1E8'],
  ['LAW', '#6692FF'], ['SAI', '#64C4FF'], ['ALB', '#64C4FF'], ['HUL', '#F50537'], ['OCO', '#B6BABD'],
  ['BEA', '#B6BABD'], ['STR', '#229971'], ['LIN', '#6692FF'], ['BOR', '#F50537'], ['COL', '#00A1E8'],
];

function demoOrder() {
  let gap = 0;
  return FIELD.map(([code, color], i) => {
    const interval = i ? 0.4 + ((i * 37) % 23) / 10 : 0;
    gap += interval;
    return {
      pos: i + 1,
      num: String(i + 1),
      code,
      color,
      gap: i ? `+${gap.toFixed(3)}` : 'LAP 24',
      interval: i ? `+${interval.toFixed(3)}` : 'LAP 24',
      best: null,
      last: null,
      laps: 24,
      pits: i % 3 === 0 ? 2 : 1,
      inPit: code === 'SAI',
      pitOut: code === 'LAW',
      out: code === 'COL',
      knockedOut: false,
      tyre: { compound: i % 4 === 0 ? 'MEDIUM' : i % 5 === 0 ? 'SOFT' : 'HARD', laps: 4 + ((i * 7) % 15), fresh: i % 2 === 0 },
    };
  });
}

function createDemo(mode = 'next', now = Date.now()) {
  if (!MODES.includes(mode)) throw new Error(`Unknown demo: ${mode}`);
  const racing = mode !== 'next';
  const start = now + (racing ? -35 * 60e3 : 3 * 3600e3 + 12 * 60e3 + 8e3);
  const session = { name: racing ? 'Race' : 'Qualifying', short: racing ? 'RACE' : 'Q',
    start: new Date(start).toISOString(), end: new Date(start + 2 * 3600e3).toISOString() };
  const message = mode === 'safety-car' ? 'SAFETY CAR DEPLOYED — debris at Turn 4'
    : mode === 'red-flag' ? 'RED FLAG — session suspended, barrier repairs at Turn 9'
    : mode === 'penalty' ? 'CAR 16 (LEC) — 5 SECOND TIME PENALTY — track limits'
    : 'OVERTAKE — NOR passes LEC for P2 at Turn 6';
  const flag = mode === 'red-flag' ? 'RED' : mode === 'safety-car' ? 'YELLOW' : '';
  return {
    mode,
    snapshot: { demo: true, weekend: { name: 'DEMO · British Grand Prix', round: '12', season: String(new Date(now).getFullYear()),
      circuit: 'Silverstone', country: 'United Kingdom', sessions: [session] },
      standings: [], constructors: [], lastRace: null },
    live: racing ? { session: 'Race', kind: 'race', order: demoOrder(), status: mode === 'red-flag' ? 'Aborted' : 'Started',
      track: { status: mode === 'safety-car' ? '4' : mode === 'red-flag' ? '5' : '1' },
      lap: 24, totalLaps: 52, top: [{ pos: 1, code: 'VER', color: '#3671C6' },
        { pos: 2, code: 'NOR', color: '#FF8000' }, { pos: 3, code: 'LEC', color: '#E8002D' }],
      messages: [{ utc: new Date(now).toISOString(), flag, category: mode === 'safety-car' ? 'SafetyCar' : 'Other', message },
        { utc: new Date(now - 45e3).toISOString(), flag: '', category: 'Other', message: 'PIT STOP — RUS switches to medium tyres' }],
    } : null,
  };
}

module.exports = { createDemo, MODES };
