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

test('running order: race gaps, intervals, tyres, pits and status', () => {
  const { lt } = client();
  const snap = structuredClone(snapshot);
  snap.result.SessionInfo.Type = 'Race';
  snap.result.DriverList[16] = { Tla: 'LEC', TeamColour: 'ED1131' };
  snap.result.TimingData = {
    Lines: {
      3: { Position: '1', GapToLeader: 'LAP 12', IntervalToPositionAhead: { Value: 'LAP 12' }, NumberOfPitStops: 1, LastLapTime: { Value: '1:36.100' } },
      44: { Position: '2', GapToLeader: '+3.214', IntervalToPositionAhead: { Value: '+3.214', Catching: true }, NumberOfPitStops: 1, InPit: true },
      16: { Position: '3', GapToLeader: '+9.880', IntervalToPositionAhead: { Value: '+6.666' }, NumberOfPitStops: 0, Retired: true },
    },
  };
  snap.result.TimingAppData = {
    Lines: {
      3: { Stints: [{ Compound: 'MEDIUM', TotalLaps: 4, New: 'true' }, { Compound: 'HARD', TotalLaps: 8, New: 'true' }] },
      // Stints built from deltas arrive as index-keyed objects.
      44: { Stints: { 0: { Compound: 'SOFT', TotalLaps: 10, New: 'false' } } },
    },
  };
  lt.handle(snap);
  const order = lt.summary().order;
  clearTimeout(lt.stateTimer);
  assert.deepEqual(order.map((r) => r.code), ['VER', 'HAM', 'LEC']);
  assert.equal(order[1].gap, '+3.214');
  assert.equal(order[1].interval, '+3.214');
  assert.deepEqual(order[0].tyre, { compound: 'HARD', laps: 8, fresh: true });
  assert.deepEqual(order[1].tyre, { compound: 'SOFT', laps: 10, fresh: false });
  assert.equal(order[1].inPit, true);
  assert.equal(order[2].out, true);
  assert.equal(order[2].tyre, null);
  assert.equal(lt.summary().kind, 'race');
  clearTimeout(lt.stateTimer);
});

test('running order: practice uses gap to the fastest lap', () => {
  const { lt } = client();
  const snap = structuredClone(snapshot);
  snap.result.SessionInfo.Type = 'Practice';
  snap.result.TimingData = {
    Lines: {
      3: { Position: '2', TimeDiffToFastest: '+0.213', TimeDiffToPositionAhead: '+0.213', BestLapTime: { Value: '1:35.010' }, NumberOfLaps: 14 },
      44: { Position: '1', TimeDiffToFastest: '', BestLapTime: { Value: '1:34.797' }, NumberOfLaps: 11 },
    },
  };
  lt.handle(snap);
  const s = lt.summary();
  clearTimeout(lt.stateTimer);
  assert.equal(s.kind, 'practice');
  assert.deepEqual(s.order.map((r) => `${r.pos} ${r.code} ${r.best} ${r.gap}`), ['1 HAM 1:34.797 null', '2 VER 1:35.010 +0.213']);
  assert.equal(s.order[0].laps, 11);
});
