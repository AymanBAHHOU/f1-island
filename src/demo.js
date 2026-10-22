// Explicitly labelled synthetic data, used by previews and offline tests only.
const MODES = ['next', 'race', 'safety-car', 'red-flag', 'penalty'];

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
    live: racing ? { session: 'Race', status: mode === 'red-flag' ? 'Aborted' : 'Started',
      track: { status: mode === 'safety-car' ? '4' : mode === 'red-flag' ? '5' : '1' },
      lap: 24, totalLaps: 52, top: [{ pos: 1, code: 'VER', color: '#3671C6' },
        { pos: 2, code: 'NOR', color: '#FF8000' }, { pos: 3, code: 'LEC', color: '#E8002D' }],
      messages: [{ utc: new Date(now).toISOString(), flag, category: mode === 'safety-car' ? 'SafetyCar' : 'Other', message },
        { utc: new Date(now - 45e3).toISOString(), flag: '', category: 'Other', message: 'PIT STOP — RUS switches to medium tyres' }],
    } : null,
  };
}

module.exports = { createDemo, MODES };
