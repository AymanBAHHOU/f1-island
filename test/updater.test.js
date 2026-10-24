const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updater, updateMode, parseVersion, isNewer, releaseInfo, RELEASES_URL } = require('../src/updater');

test('how an install updates itself', () => {
  assert.equal(updateMode({ packaged: false, platform: 'win32', portable: false }), 'off');
  assert.equal(updateMode({ packaged: true, platform: 'win32', portable: false }), 'auto'); // installer
  assert.equal(updateMode({ packaged: true, platform: 'win32', portable: true }), 'notify'); // portable exe
  assert.equal(updateMode({ packaged: true, platform: 'darwin', portable: false }), 'notify'); // unsigned Mac
  assert.equal(updateMode({ packaged: true, platform: 'linux', portable: false }), 'notify');
});

test('versions compare by number, not text', () => {
  assert.deepEqual(parseVersion('v0.1.10'), [0, 1, 10]);
  assert.equal(parseVersion('nightly'), null);
  assert.equal(isNewer('0.1.10', '0.1.9'), true); // text order would say no
  assert.equal(isNewer('v0.2.0', '0.1.99'), true);
  assert.equal(isNewer('0.1.1', '0.1.1'), false);
  assert.equal(isNewer('0.1.0', '0.1.1'), false);
  assert.equal(isNewer('1.0.0-beta.1', '0.9.9'), true);
  assert.equal(isNewer('garbage', '0.1.0'), false);
});

test('only published, final releases count', () => {
  assert.deepEqual(releaseInfo({ tag_name: 'v0.1.1', html_url: 'https://github.com/x/y/releases/tag/v0.1.1' }), {
    version: '0.1.1',
    url: 'https://github.com/x/y/releases/tag/v0.1.1',
  });
  assert.equal(releaseInfo({ tag_name: 'v0.2.0', draft: true }), null);
  assert.equal(releaseInfo({ tag_name: 'v0.2.0', prerelease: true }), null);
  assert.equal(releaseInfo({ tag_name: 'weekly' }), null);
  assert.equal(releaseInfo(null), null);
});

test('a link that is not on github.com falls back to the releases page', () => {
  assert.equal(releaseInfo({ tag_name: 'v0.1.1', html_url: 'https://evil.example/x' }).url, RELEASES_URL);
  assert.equal(releaseInfo({ tag_name: 'v0.1.1' }).url, RELEASES_URL);
});

const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Error', json: async () => body });

test('notify: announces a newer release and opens its page when chosen', async () => {
  const opened = [];
  const u = new Updater({
    version: '0.1.0',
    mode: 'notify',
    fetch: async () => json({ tag_name: 'v0.1.1', html_url: 'https://github.com/a/b/releases/tag/v0.1.1' }),
    shell: { openExternal: (url) => opened.push(url) },
  });
  const states = [];
  u.on('state', (s) => states.push(s.status));
  await u.check();
  assert.equal(u.state.status, 'available');
  assert.equal(u.state.version, '0.1.1');
  u.act();
  assert.deepEqual(opened, ['https://github.com/a/b/releases/tag/v0.1.1']);
  assert.deepEqual(states, ['available']);
});

test('notify: stays quiet when up to date, and when the check fails', async () => {
  const quiet = new Updater({ version: '0.1.1', mode: 'notify', fetch: async () => json({ tag_name: 'v0.1.1' }), shell: {} });
  await quiet.check();
  assert.equal(quiet.state.status, 'idle');
  assert.ok(quiet.state.checkedAt > 0);

  const logged = [];
  const broken = new Updater({ version: '0.1.0', mode: 'notify', fetch: async () => json({}, false), shell: {}, log: (m) => logged.push(m) });
  await broken.check();
  assert.equal(broken.state.status, 'idle');
  assert.equal(logged.length, 1);
});

test('off: never checks', async () => {
  let called = false;
  const u = new Updater({ version: '0.1.0', mode: 'off', fetch: async () => { called = true; return json({}); }, shell: {} });
  await u.check();
  assert.equal(called, false);
});

test('auto: follows electron-updater and restarts on request', async () => {
  const au = new EventEmitter();
  au.checkForUpdates = async () => {
    au.emit('update-available', { version: '0.1.1' });
    au.emit('update-downloaded', { version: '0.1.1' });
  };
  au.quitAndInstall = (...args) => (au.installed = args);
  const u = new Updater({ version: '0.1.0', mode: 'auto', loadAutoUpdater: () => au, shell: {} });
  const seen = [];
  u.on('state', (s) => seen.push(s.status));
  await u.check();
  assert.deepEqual(seen, ['downloading', 'ready']);
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  u.act();
  assert.deepEqual(au.installed, [true, true]); // silent, then relaunch
});

test('auto: an error while downloading goes back to idle; no re-check while busy', async () => {
  const au = new EventEmitter();
  let checks = 0;
  au.checkForUpdates = async () => {
    checks++;
    au.emit('update-available', { version: '0.1.1' });
  };
  const u = new Updater({ version: '0.1.0', mode: 'auto', loadAutoUpdater: () => au, shell: {} });
  await u.check();
  assert.equal(u.state.status, 'downloading');
  await u.check(); // busy: skipped
  assert.equal(checks, 1);
  au.emit('error', new Error('network down'));
  assert.equal(u.state.status, 'idle');
});
