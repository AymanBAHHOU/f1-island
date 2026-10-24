const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendEntry, formatEntry } = require('../src/statuslog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'f1-statuslog-'));

test('a line is JSON with the time first', () => {
  const line = formatEntry({ event: 'status', status: 'Started' }, new Date('2026-10-24T21:00:00Z'));
  assert.deepEqual(JSON.parse(line), { t: '2026-10-24T21:00:00.000Z', event: 'status', status: 'Started' });
  assert.ok(line.startsWith('{"t":'));
});

test('lines are appended in order', () => {
  const file = path.join(tmp(), 'live-status.log');
  appendEntry(file, { event: 'connect' });
  appendEntry(file, { event: 'status', status: 'Started' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['connect', 'status']);
  assert.equal(lines[1].status, 'Started');
});

test('a big file is kept as .old and restarted', () => {
  const file = path.join(tmp(), 'live-status.log');
  appendEntry(file, { event: 'a', pad: 'x'.repeat(200) }, { maxBytes: 100 });
  appendEntry(file, { event: 'b' }, { maxBytes: 100 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).event, 'b');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.old`, 'utf8')).event, 'a');
});

test('never throws, even when the folder does not exist', () => {
  assert.doesNotThrow(() => appendEntry(path.join(tmp(), 'missing', 'x.log'), { event: 'x' }));
});
