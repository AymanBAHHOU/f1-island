const test = require('node:test');
const assert = require('node:assert/strict');
const { windowOptions, configureWindow, formatHotkey, loginItemMenu } = require('../src/platform');

test('macOS uses a non-fullscreenable panel above apps, on every Space', () => {
  assert.deepEqual(windowOptions('darwin'), { type: 'panel', fullscreenable: false });
  const calls = [];
  configureWindow({
    setAlwaysOnTop: (...args) => calls.push(['top', ...args]),
    setVisibleOnAllWorkspaces: (...args) => calls.push(['spaces', ...args]),
  }, 'darwin');
  assert.deepEqual(calls, [
    ['top', true, 'floating'],
    ['spaces', true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
  ]);
});

test('Windows keeps its existing window and always-on-top behavior', () => {
  assert.deepEqual(windowOptions('win32'), {});
  const calls = [];
  configureWindow({ setAlwaysOnTop: (...args) => calls.push(args) }, 'win32');
  assert.deepEqual(calls, [[true, 'screen-saver']]);
});

test('shortcuts use platform-appropriate modifier names', () => {
  assert.equal(formatHotkey('CommandOrControl+Alt+F', 'darwin'), 'Cmd+Option+F');
  assert.equal(formatHotkey('CommandOrControl+Alt+F', 'win32'), 'Ctrl+Alt+F');
  assert.equal(formatHotkey('Control+Shift+F', 'darwin'), 'Ctrl+Shift+F');
  assert.equal(formatHotkey('Command+Alt+F', 'darwin'), 'Cmd+Option+F');
});

test('unpackaged macOS apps cannot register the development Electron at login', () => {
  const item = loginItemMenu({ isPackaged: false }, () => assert.fail('must not register'), 'darwin');
  assert.equal(item.label, 'Start at Login');
  assert.equal(item.enabled, false);
  assert.equal(item.checked, false);
  item.click({ checked: true });
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: login checkbox reflects and changes the OS setting`, () => {
    let next;
    let refreshed = false;
    const item = loginItemMenu({
      isPackaged: true,
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: (value) => { next = value; },
    }, () => { refreshed = true; }, platform);
    assert.equal(item.enabled, true);
    assert.equal(item.checked, true);
    item.click({ checked: false });
    assert.deepEqual(next, { openAtLogin: false });
    assert.equal(refreshed, true);
  });
}
