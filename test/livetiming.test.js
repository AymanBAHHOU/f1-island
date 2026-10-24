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

test('last lap and sectors keep the purple / green flags; unfinished sectors fall back to the previous lap', () => {
  const { lt } = client();
  const snap = structuredClone(snapshot);
  snap.result.SessionInfo.Type = 'Practice';
  snap.result.TimingData = {
    Lines: {
      3: {
        Position: '1',
        LastLapTime: { Value: '1:35.291', PersonalFastest: true, OverallFastest: true },
        Sectors: [
          { Value: '25.101', PersonalFastest: true, OverallFastest: false, PreviousValue: '25.300' },
          { Value: '', PreviousValue: '36.400' },
          { Value: '', PreviousValue: '' },
        ],
      },
    },
  };
  snap.result.ExtrapolatedClock = { Utc: '2026-10-23T21:56:56Z', Remaining: '00:03:03', Extrapolating: true };
  lt.handle(snap);
  const s = lt.summary();
  clearTimeout(lt.stateTimer);
  const [r] = s.order;
  assert.deepEqual(r.lastLap, { value: '1:35.291', pb: true, overall: true });
  assert.deepEqual(r.sectors[0], { value: '25.101', pb: true, overall: false });
  assert.deepEqual(r.sectors[1], { value: '36.400', pb: false, overall: false, previous: true });
  assert.deepEqual(r.sectors[2], { value: null, pb: false, overall: false, previous: false });
  assert.deepEqual(s.clock, { remaining: '00:03:03', utc: '2026-10-23T21:56:56Z', running: true });
});

// ---- qualifying: best lap and gaps per segment ----

const qualiFeed = (part, lines) => ({
  type: 3,
  invocationId: 'sub',
  result: {
    SessionInfo: { Name: 'Qualifying', Type: 'Qualifying' },
    SessionStatus: { Status: 'Started' },
    DriverList: { 12: { Tla: 'ANT' }, 16: { Tla: 'LEC' }, 30: { Tla: 'LAW' }, 10: { Tla: 'GAS' } },
    TimingData: { SessionPart: part, Lines: lines },
  },
});
const seg = (best, gap, ahead) => ({ best, stat: { TimeDiffToFastest: gap, TimeDifftoPositionAhead: ahead } });
const qline = (pos, segs, extra = {}) => ({
  Position: String(pos),
  BestLapTime: { Value: segs.map((s) => s?.best).filter(Boolean).sort()[0] },
  BestLapTimes: segs.map((s) => ({ Value: s?.best || '' })),
  Stats: segs.map((s) => s?.stat || { TimeDiffToFastest: '', TimeDifftoPositionAhead: '' }),
  ...extra,
});

test('qualifying: Q3 shows each driver the Q3 best lap and Q3 gaps (the feed spells it TimeDifftoPositionAhead)', () => {
  const lt = new LiveTiming();
  lt.handle(
    qualiFeed(3, {
      12: qline(1, [seg('1:35.390', '+0.361', '+0.361'), seg('1:34.278', '+0.080', '+0.080'), seg('1:34.035', '', '')]),
      16: qline(2, [seg('1:35.200', '+0.171', '+0.171'), seg('1:34.198', '', ''), seg('1:34.267', '+0.232', '+0.232')]),
    })
  );
  const [ant, lec] = lt.order();
  assert.deepEqual([ant.code, ant.best, ant.gap, ant.interval], ['ANT', '1:34.035', null, null]);
  assert.deepEqual([lec.code, lec.best, lec.gap, lec.interval], ['LEC', '1:34.267', '+0.232', '+0.232']);
  assert.equal(lt.summary().part, 3);
});

test('qualifying: a driver with no time in the segment shows none; an eliminated driver keeps the segment they went out in', () => {
  const lt = new LiveTiming();
  lt.handle(
    qualiFeed(3, {
      12: qline(1, [seg('1:35.390', '+0.361', '+0.361'), seg('1:34.278', '+0.080', '+0.080'), seg('1:34.035', '', '')]),
      30: qline(10, [seg('1:35.662', '+0.633', '+0.050'), seg('1:35.058', '+0.860', '+0.100'), null]), // through to Q3, no time there
      10: qline(11, [seg('1:35.969', '+0.940', '+0.100'), seg('1:35.080', '+0.882', '+0.020'), null], { KnockedOut: true }),
    })
  );
  const byCode = Object.fromEntries(lt.order().map((r) => [r.code, r]));
  assert.deepEqual([byCode.LAW.best, byCode.LAW.gap, byCode.LAW.interval], [null, null, null]);
  assert.deepEqual([byCode.GAS.best, byCode.GAS.gap, byCode.GAS.interval], ['1:35.080', '+0.882', '+0.020']); // out in Q2
  assert.equal(byCode.GAS.knockedOut, true);
});

test('qualifying: at the start of Q2 nobody has a time yet, but Q1 drop-outs keep their Q1 values', () => {
  const lt = new LiveTiming();
  lt.handle(
    qualiFeed(2, {
      12: qline(1, [seg('1:35.390', '+0.361', '+0.361'), null]),
      10: qline(19, [seg('1:36.770', '+1.741', '+0.100'), null], { KnockedOut: true }),
    })
  );
  const byCode = Object.fromEntries(lt.order().map((r) => [r.code, r]));
  assert.equal(byCode.ANT.best, null);
  assert.equal(byCode.ANT.gap, null);
  assert.deepEqual([byCode.GAS.best, byCode.GAS.gap], ['1:36.770', '+1.741']);
});

test('practice is unchanged: best lap and top-level gaps', () => {
  const lt = new LiveTiming();
  lt.handle({
    type: 3,
    invocationId: 'sub',
    result: {
      SessionInfo: { Name: 'Practice 3', Type: 'Practice' },
      DriverList: { 44: { Tla: 'HAM' } },
      TimingData: { Lines: { 44: { Position: '1', BestLapTime: { Value: '1:34.893' }, TimeDiffToFastest: '+0.100', TimeDiffToPositionAhead: '+0.100' } } },
    },
  });
  const [r] = lt.order();
  assert.deepEqual([r.best, r.gap, r.interval], ['1:34.893', '+0.100', '+0.100']);
});
