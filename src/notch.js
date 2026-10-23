const path = require('path');
const { execFileSync } = require('child_process');

function readNotches(app, platform = process.platform) {
  if (platform !== 'darwin') return [];
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'notch-info')
    : path.join(__dirname, '..', 'build', 'notch-info');
  try {
    const data = JSON.parse(execFileSync(helper, { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 }));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('Notch geometry unavailable; using the floating island:', err.message);
    return [];
  }
}

function notchForDisplay(display, notches, enabled = true) {
  if (!enabled) return null;
  const n = notches.find((item) => item?.id === display.id);
  if (!n || ![n.width, n.height, n.centerX].every(Number.isFinite) ||
      n.width <= 0 || n.width >= display.bounds.width / 2 || n.height <= 0 || n.height > 100 ||
      n.centerX - n.width / 2 < 0 || n.centerX + n.width / 2 > display.bounds.width) return null;
  return { ...n, top: display.bounds.y, centerX: display.bounds.x + n.centerX };
}

function notchOrigin(notch, width, edge) {
  return { x: Math.round(notch.centerX - width / 2), y: notch.top - edge };
}

function containsNotch(point, notch) {
  return !!notch && point.x >= notch.centerX - notch.width / 2 - 8 &&
    point.x <= notch.centerX + notch.width / 2 + 8 &&
    point.y >= notch.top && point.y <= notch.top + notch.height + 8;
}

function magnetOrigin(origin, notch, width, edge) {
  if (!notch) return null;
  const home = notchOrigin(notch, width, edge);
  // The island's centre enters a forgiving target around the camera. Attach
  // only on drop: changing layouts while a pointer is captured causes jumps.
  return Math.abs(origin.x - home.x) <= notch.width / 2 + 24 &&
    Math.abs(origin.y - home.y) <= Math.max(72, notch.height + 32) ? home : null;
}

module.exports = { readNotches, notchForDisplay, notchOrigin, containsNotch, magnetOrigin };
