const test = require('node:test');
const assert = require('node:assert/strict');
const { model, events, countdown } = require('../renderer/notch-idle');
const { createDemo, MODES } = require('../src/demo');
const { idleModeMenu } = require('../src/platform');

const now = Date.parse('2026-10-22T12:00:00Z');
function view(mode, extra = {}) {
  const demo = createDemo(mode, now);
  return model({ snapshot: demo.snapshot, live: demo.live, now,
    state: { kind: mode === 'next' ? 'next' : 'live', session: demo.snapshot.weekend.sessions[0] }, ...extra });
}

test('idle appearance has exactly two mutually exclusive persistent choices', () => {
  for (const hidden of [false, true]) {
    let value;
    const menu = idleModeMenu(hidden, (next) => { value = next; });
    assert.deepEqual(menu.submenu.map((item) => item.label), ['Notch only', 'Stretched']);
    assert.equal(menu.submenu.filter((item) => item.checked).length, 1);
    menu.submenu[0].click();
    assert.equal(value, true);
    menu.submenu[1].click();
    assert.equal(value, false);
  }
});

test('stretched upcoming session includes GP, session, date and a ticking countdown', () => {
  const next = view('next');
  assert.equal(next.title, 'British GP');
  assert.equal(next.status, 'Q · STARTS IN');
  assert.equal(next.value, '03:12:08');
  assert.match(next.detail, /Qualifying/);
  assert.match(next.kicker, /DEMO/);
  assert.equal(view('next', { now: now + 1000 }).value, '03:12:07');
});

test('a future session never leaks stale race events or flags', () => {
  const stale = createDemo('red-flag', now).live;
  const next = view('next', { live: stale });
  assert.equal(next.eventKey, '');
  assert.equal(next.status, 'Q · STARTS IN');
  assert.doesNotMatch(next.detail, /RED FLAG/);
});

test('live stretched state shows lap progress, leader and race events', () => {
  const race = view('race');
  assert.equal(race.live, true);
  assert.equal(race.title, 'LAP 24 / 52');
  assert.equal(race.value, 'VER · P1');
  assert.match(race.detail, /OVERTAKE/);
  assert.match(view('race', { eventIndex: 1 }).detail, /PIT STOP/);
});

test('Safety Car, red flags and penalties use their own status and palette', () => {
  assert.equal(view('safety-car').tone, 'sc');
  assert.equal(view('safety-car').chip, 'SC');
  assert.equal(view('safety-car').status, 'SAFETY CAR');
  assert.match(view('red-flag').detail, /barrier repairs/);
  assert.equal(view('red-flag').tone, 'red');
  assert.equal(view('penalty').tone, 'info');
  assert.match(view('penalty').detail, /5 SECOND TIME PENALTY/);
});

test('race-control ticker skips noise, supports no data, and limits its rotation', () => {
  assert.deepEqual(events(null), []);
  assert.deepEqual(events({ messages: [{ message: 'CLEAR IN TRACK SECTOR 1' },
    { message: 'LAP TIME DELETED' }, { message: '' }, { message: null }] }), []);
  assert.equal(events({ messages: Array.from({ length: 10 }, (_, n) => ({ message: `Event ${n}` })) }).length, 5);
  const race = createDemo('race', now);
  race.live.messages = [];
  assert.match(view('race', { live: race.live }).detail, /waiting for race control/);
});

test('finished and delayed sessions do not present stale flags as current', () => {
  const race = createDemo('red-flag', now);
  race.live.status = 'Finished';
  const finished = view('race', { live: race.live });
  assert.equal(finished.live, false);
  assert.equal(finished.status, 'CHEQUERED FLAG');
  assert.equal(finished.tone, 'neutral');
  race.live.status = 'Inactive';
  assert.equal(view('race', { live: race.live }).status, 'START DELAYED');
});

test('a scheduled race without a timing feed never claims the track is green', () => {
  const waiting = view('race', { live: null });
  assert.equal(waiting.status, 'CONNECTING');
  assert.equal(waiting.tone, 'neutral');
  assert.match(waiting.detail, /Waiting for the live timing feed/);
});

test('loading, offline, season-break and weekend-complete idle states are explicit', () => {
  assert.equal(model({ state: { kind: 'error' }, now }).chip, 'OFFLINE');
  assert.equal(model({ state: { kind: 'none' }, now }).value, 'Loading…');
  assert.equal(model({ state: { kind: 'none' }, snapshot: {}, now }).title, 'Season break');
  assert.equal(model({ state: { kind: 'finished' }, now }).value, 'Finished');
});

test('countdowns do not become negative and support days / unknown start times', () => {
  assert.equal(countdown(-1000), '00:00:00');
  assert.equal(countdown(90000000), '1d 01h');
  assert.equal(view('next', { state: { kind: 'next', session: { start: 'invalid', short: 'Q' } } }).value, 'TBA');
});

test('all dummy scenarios are labelled, isolated and use relative session times', () => {
  for (const mode of MODES) {
    const demo = createDemo(mode, now);
    assert.equal(demo.snapshot.demo, true);
    assert.match(demo.snapshot.weekend.name, /^DEMO/);
    assert.equal(demo.snapshot.weekend.sessions.length, 1);
    assert.ok(Date.parse(demo.snapshot.weekend.sessions[0].end) > now);
  }
  const first = createDemo('race', now);
  first.live.messages[0].message = 'Modified';
  assert.notEqual(createDemo('race', now).live.messages[0].message, 'Modified');
  assert.throws(() => createDemo('unknown'), /Unknown demo/);
});
