const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveTiming, merge } = require('../src/livetiming');

test('merge patches nested objects and array items addressed by index', () => {
  const state = { Lines: { 1: { Sectors: [{ Value: '27.1' }, { Value: '39.0' }], Position: '1' } } };
  merge(state, { Lines: { 1: { Sectors: { 1: { Value: '38.9' } } } } });
  assert.deepEqual(state.Lines[1].Sectors, [{ Value: '27.1' }, { Value: '38.9' }]);
  assert.equal(state.Lines[1].Position, '1');
});

test('merge ignores feed bookkeeping keys', () => {
  const out = merge({}, { Status: '1', _kf: true });
  assert.deepEqual(out, { Status: '1' });
});

// Drive the client with feed messages directly (no network).
function client() {
  const lt = new LiveTiming();
  const events = { rc: [], track: [], status: [] };
  lt.on('rc', (m) => events.rc.push(m.Message));
  lt.on('track', (t) => events.track.push(`${t.prev}->${t.status}`));
  lt.on('status', (s) => events.status.push(s));
  return { lt, events };
}

const snapshot = {
  type: 3,
  invocationId: 'sub',
  result: {
    SessionInfo: { Name: 'Sprint', GmtOffset: '08:00:00', Meeting: { Name: 'Singapore Grand Prix' } },
    SessionStatus: { Status: 'Inactive' },
    TrackStatus: { Status: '2', Message: 'Yellow' },
    RaceControlMessages: { Messages: [{ Utc: '2026-10-10T08:52:43', Category: 'Other', Message: 'DELAYED START' }] },
    LapCount: { CurrentLap: 1, TotalLaps: 20 },
    DriverList: { 3: { Tla: 'VER', TeamColour: '4781D7' }, 44: { Tla: 'HAM', TeamColour: 'ED1131' } },
    TimingData: { Lines: { 3: { Position: '1' }, 44: { Position: '2' } } },
  },
};
const feed = (topic, data) => ({ type: 1, target: 'feed', arguments: [topic, data, '2026-10-10T09:30:00Z'] });

test('snapshot messages are history, not alerts', () => {
  const { lt, events } = client();
  lt.handle(snapshot);
  assert.deepEqual(events.rc, []);
});

test('new race control messages, track and session changes are emitted once', () => {
  const { lt, events } = client();
  lt.handle(structuredClone(snapshot));
  lt.handle(feed('RaceControlMessages', { Messages: { 1: { Utc: '2026-10-10T09:17:00', Message: 'FORMATION LAP WILL START AT 17:30' } } }));
  // The same message again (e.g. after a re-send) is not repeated.
  lt.handle(feed('RaceControlMessages', { Messages: { 1: { Utc: '2026-10-10T09:17:00', Message: 'FORMATION LAP WILL START AT 17:30' } } }));
  lt.handle(feed('SessionStatus', { Status: 'Started' }));
  lt.handle(feed('TrackStatus', { Status: '4', Message: 'SCDeployed' }));
  assert.deepEqual(events.rc, ['FORMATION LAP WILL START AT 17:30']);
  assert.deepEqual(events.status, ['Started']);
  assert.deepEqual(events.track, ['2->4']);
});

test('summary: session, flag, lap, running order, messages newest first', () => {
  const { lt } = client();
  lt.handle(structuredClone(snapshot));
  lt.handle(feed('LapCount', { CurrentLap: 12 }));
  lt.handle(feed('TimingData', { Lines: { 3: { Position: '2' }, 44: { Position: '1' } } }));
  const s = lt.summary();
  clearTimeout(lt.stateTimer);
  assert.equal(s.session, 'Sprint');
  assert.equal(s.status, 'Inactive');
  assert.deepEqual(s.track, { status: '2', message: 'Yellow' });
  assert.equal(s.lap, 12);
  assert.equal(s.totalLaps, 20);
  assert.equal(s.gmtOffset, '08:00:00');
  assert.deepEqual(
    s.top.map((t) => `${t.pos} ${t.code} ${t.color}`),
    ['1 HAM #ED1131', '2 VER #4781D7']
  );
  assert.equal(s.messages[0].message, 'DELAYED START');
  assert.equal(s.messages[0].utc, '2026-10-10T08:52:43Z');
});
