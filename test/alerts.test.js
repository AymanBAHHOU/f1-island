const test = require('node:test');
const assert = require('node:assert/strict');
const { fromTrack, fromMessage, fromSessionStatus } = require('../src/alerts');

const titleOf = (message, extra = {}) => fromMessage({ Message: message, ...extra })?.title ?? null;

test('track status: neutralisations pop up, single yellows do not', () => {
  assert.equal(fromTrack({ status: '4', prev: '1' }).title, 'Safety Car');
  assert.equal(fromTrack({ status: '6', prev: '1' }).title, 'Virtual Safety Car');
  assert.equal(fromTrack({ status: '7', prev: '6' }).title, 'VSC ending');
  assert.equal(fromTrack({ status: '5', prev: '1' }).title, 'Red flag');
  assert.equal(fromTrack({ status: '2', prev: '1' }), null);
});

test('track clear only pops up after a neutralisation', () => {
  assert.equal(fromTrack({ status: '1', prev: '4' }).title, 'Track clear');
  assert.equal(fromTrack({ status: '1', prev: '2' }), null);
});

test('session control messages (Singapore Sprint, delayed start)', () => {
  assert.equal(titleOf('DELAYED START'), 'Start delayed');
  assert.equal(titleOf('SESSION SUSPENDED'), 'Session suspended');
  assert.equal(titleOf('SPRINT WILL RESUME AT 10:20'), 'Restart');
  assert.equal(titleOf('FORMATION LAP WILL START AT 17:30'), 'Start procedure');
  // Not a restart, even though it says "WILL START".
  assert.equal(titleOf('THE RACE WILL START BEHIND THE SAFETY CAR'), 'Start procedure');
});

test('track conditions and overtake mode', () => {
  assert.equal(titleOf('TRACK SURFACE SLIPPERY IN TRACK SECTOR 13'), 'Track conditions');
  assert.equal(titleOf('LOW GRIP CONDITIONS'), 'Track conditions');
  assert.equal(titleOf('CHANGE IN CLIMATIC CONDITIONS'), 'Track conditions');
  assert.equal(titleOf('OVERTAKE DISABLED'), 'Overtake disabled');
  assert.equal(titleOf('OVERTAKE ENABLED'), 'Overtake enabled');
  assert.equal(titleOf('RISK OF RAIN FOR THE F1 SPRINT IS 80%'), 'Weather');
});

test('stewards', () => {
  assert.equal(titleOf('FIA STEWARDS: 10 SECOND TIME PENALTY FOR CAR 5 (BOR) - CAUSING A COLLISION'), 'Penalty');
  assert.equal(titleOf('FIA STEWARDS: TURN 2 INCIDENT INVOLVING CARS 5 (BOR) AND 55 (SAI) UNDER INVESTIGATION'), 'Under investigation');
  assert.equal(titleOf('FIA STEWARDS: SQ1 INCIDENT INVOLVING CARS 11 (PER) NO FURTHER ACTION'), 'Stewards');
});

test('flags from race control', () => {
  assert.equal(titleOf('CHEQUERED FLAG', { Flag: 'CHEQUERED' }), 'Chequered flag');
  assert.equal(titleOf('DOUBLE YELLOW IN TRACK SECTOR 4', { Flag: 'DOUBLE YELLOW' }), 'Double yellow');
  // Red / SC arrive through track status; no duplicate alert.
  assert.equal(titleOf('RED FLAG', { Flag: 'RED' }), null);
  assert.equal(titleOf('SAFETY CAR DEPLOYED', { Category: 'SafetyCar' }), null);
});

test('noise is ignored', () => {
  assert.equal(titleOf('CAR 18 (STR) TIME 1:44.142 DELETED - TRACK LIMITS AT TURN 2 LAP 3 16:33:37'), null);
  assert.equal(titleOf('YELLOW IN TRACK SECTOR 6', { Flag: 'YELLOW' }), null);
  assert.equal(titleOf(''), null);
});

test('session status', () => {
  assert.equal(fromSessionStatus('Started', 'Sprint').title, 'Sprint underway');
  assert.equal(fromSessionStatus('Aborted', 'Sprint').title, 'Session suspended');
  assert.equal(fromSessionStatus('Finished', 'Sprint'), null);
});

test('every alert tile fits (short labels only)', () => {
  const samples = [
    fromTrack({ status: '4', prev: '1' }),
    fromTrack({ status: '6', prev: '1' }),
    fromMessage({ Message: 'DELAYED START' }),
    fromMessage({ Message: 'LOW GRIP CONDITIONS' }),
    fromMessage({ Message: 'OVERTAKE DISABLED' }),
    fromMessage({ Message: 'FORMATION LAP WILL START AT 17:30' }),
    fromMessage({ Message: 'RISK OF RAIN' }),
  ];
  for (const a of samples) assert.ok(a.tile.length <= 4, `tile "${a.tile}" for ${a.title} is too long`);
});
