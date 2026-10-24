// Small JSON settings store in the app's userData folder.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  autoHide: false,
  docked: false, // Windows/Linux: attach the island flush to the top edge, centred
  notchAttached: true, // updated by dragging; not a manual toggle
  hotkey: 'CommandOrControl+Alt+F',
  position: null, // { x, y } window position, null = top-centre of primary display
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

let current = null;

function get() {
  if (!current) {
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      current = { ...DEFAULTS, ...saved };
      // Preserve an older manual detachment, but allow magnetic docking now.
      if (saved.notchAttached == null && saved.attachNotch === false) current.notchAttached = false;
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
