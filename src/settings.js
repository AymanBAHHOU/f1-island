// Small JSON settings store in the app's userData folder.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  autoHide: false,
  hotkey: 'CommandOrControl+Alt+F',
  position: null, // { x, y } window position, null = top-centre of primary display
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

let current = null;

function get() {
  if (!current) {
    try {
      current = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
    } catch {
      current = { ...DEFAULTS };
    }
  }
  return current;
}

function set(patch) {
  current = { ...get(), ...patch };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(current, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
  return current;
}

module.exports = { get, set };
