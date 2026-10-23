const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { getSnapshot } = require('./src/data');
const { LiveTiming } = require('./src/livetiming');
const alerts = require('./src/alerts');
const {
  listSessions,
  getAnalysis,
  getTelemetry,
  getLapLocation,
  getWeekendTrackMap,
  getReplayInfo,
  getReplayChunk,
  setCacheDir,
} = require('./src/analysis');
const { getNews, isKnownLink } = require('./src/news');
const settings = require('./src/settings');
const { windowOptions, configureWindow, formatHotkey, loginItemMenu, idleModeMenu } = require('./src/platform');
const { readNotches, notchForDisplay, notchOrigin, containsNotch, magnetOrigin } = require('./src/notch');
const { createDemo, MODES: DEMO_MODES } = require('./src/demo');

const IS_MAC = process.platform === 'darwin';
if (IS_MAC) app.setName('F1 Island');

// The window is sized for the expanded island; everything outside the island
// is transparent and click-through. The island is centred horizontally at the
// top of the window.
// EDGE is a transparent margin around the island so its shadow and alert glow
// aren't clipped by the window; it must match --edge in renderer/styles.css.
// The window sits EDGE above the island, so it may start above the screen edge.
const EDGE = 32;
const WIN_W = 520;
const WIN_H = 600 + EDGE;
const TOP_GAP = 8; // gap between the screen top and the island
// Saved window positions from before the EDGE margin existed need shifting.
const LAYOUT_VERSION = 2;
const OLD_WIN_W = 480;
// "Double expanded" analysis view: the window grows around the island.
const BIG_W = 1000;
const BIG_H = 740 + EDGE;
const SNAP_PX = 48;

let win = null;
let tray = null;
let bigMode = false;
let normalBounds = null; // window bounds to restore when leaving big mode
let bigSize = null; // { width, height } of the window while in big mode
let drag = null;
let hotkeyOk = false;
let hitRect = null; // island's hover area, in window coordinates (reported by the renderer)
let hovering = false;
let pinned = false; // mirrors the renderer's "keep open" state
let menuOpen = false; // the island's menu is showing; keep the island open under it
let notches = [];
let attachedNotch = null;
let displayTimer = null;
let demo = null;

// Connect to live timing from shortly before a session until well after its
// scheduled end (sessions overrun with red flags).
const LIVE_LEAD_MS = 15 * 60e3;
const LIVE_TAIL_MS = 60 * 60e3;
const live = new LiveTiming();

// One island at a time. A second launch exits immediately (app.quit() would
// still let it create a window) and summons the running island instead.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => win?.webContents.send('island:toggle'));

// ---------- positioning ----------

function topCentre(display, allowNotch = true) {
  const notch = allowNotch && displayNotch(display);
  if (notch) return notchOrigin(notch, WIN_W, EDGE);
  const wa = display.workArea;
  return { x: Math.round(wa.x + (wa.width - WIN_W) / 2), y: wa.y + TOP_GAP - EDGE };
}

function displayNotch(display) {
  return notchForDisplay(display, notches, IS_MAC);
}

function homeDisplay() {
  const primary = screen.getPrimaryDisplay();
  return displayNotch(primary) ? primary : screen.getAllDisplays().find((d) => displayNotch(d)) || primary;
}

function updateAttachment(pos) {
  const display = screen.getDisplayNearestPoint({ x: pos.x + WIN_W / 2, y: pos.y + EDGE });
  const notch = displayNotch(display);
  const home = notch && notchOrigin(notch, WIN_W, EDGE);
  const next = home && Math.abs(pos.x - home.x) <= 1 && Math.abs(pos.y - home.y) <= 1 ? notch : null;
  setAttachment(next);
}

function setAttachment(next) {
  if (JSON.stringify(next) === JSON.stringify(attachedNotch)) return;
  attachedNotch = next;
  // Only the notch-attached mode draws over the menu-bar strip. This stays
  // below popup menus and system/security UI, unlike screen-saver level.
  if (IS_MAC) win.setAlwaysOnTop(true, next ? 'status' : 'floating');
  win.webContents.send('island:notch', attachedNotch);
  refreshTrayMenu();
}

// Keep the whole window on the display under its centre, so the island always
// has room to expand without running off-screen.
function clampToDisplay({ x, y }, magnetic = true) {
  const display = screen.getDisplayNearestPoint({ x: x + WIN_W / 2, y: y + EDGE });
  const wa = display.workArea;
  const snap = magnetic && magnetOrigin({ x, y }, displayNotch(display), WIN_W, EDGE);
  if (snap) return { display, ...snap };
  return {
    display,
    x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - WIN_W)),
    y: Math.round(Math.min(Math.max(y, wa.y - EDGE), wa.y + wa.height - WIN_H)),
  };
}

function setPos({ x, y }) {
  if (!bigMode && !drag) updateAttachment({ x, y });
  // setBounds (not setPosition) so the size can't drift across mixed-DPI monitors.
  const { width, height } = bigMode ? bigSize : { width: WIN_W, height: WIN_H };
  win.setBounds({ x, y, width, height });
}

// Keep a position saved by an older layout pointing at the same island spot.
function migratePosition() {
  const { position, layout } = settings.get();
  if (layout === LAYOUT_VERSION) return;
  settings.set({
    layout: LAYOUT_VERSION,
    position: position && { x: position.x - (WIN_W - OLD_WIN_W) / 2, y: position.y - EDGE },
  });
}

function placeWindow() {
  if (drag) return;
  const saved = settings.get().position;
  const home = settings.get().notchAttached ? homeDisplay() : screen.getPrimaryDisplay();
  const pos = settings.get().notchAttached && displayNotch(home) ? topCentre(home)
    : saved ? clampToDisplay(saved, false) : topCentre(home, false);
  if (bigMode) {
    normalBounds = { x: pos.x, y: pos.y, width: WIN_W, height: WIN_H };
    updateAttachment(pos);
    win.webContents.send('island:big-geometry', enterBig());
  } else {
    setPos(pos);
  }
}

function displaysChanged() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    notches = readNotches(app);
    placeWindow();
    refreshTrayMenu();
  }, 150);
}

function resetPosition() {
  settings.set({ position: null, notchAttached: true });
  placeWindow();
}

// ---------- dragging ----------
// The renderer reports drag start/end; while dragging we follow the OS cursor,
// which keeps working even if the pointer briefly outruns the window.

function startDrag() {
  if (drag) return;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  if (attachedNotch) {
    setAttachment(null);
    settings.set({ notchAttached: false });
  }
  drag = {
    dx: c.x - wx,
    dy: c.y - wy,
    timer: setInterval(() => {
      const p = screen.getCursorScreenPoint();
      setPos({ x: p.x - drag.dx, y: p.y - drag.dy });
    }, 8),
  };
}

function endDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  if (bigMode) {
    endBigDrag();
    return;
  }

  const [x, y] = win.getPosition();
  const { display, ...pos } = clampToDisplay({ x, y });
  const home = topCentre(display);
  const snapped = displayNotch(display)
    ? Math.abs(pos.x - home.x) <= 1 && Math.abs(pos.y - home.y) <= 1
    : Math.abs(pos.x - home.x) < SNAP_PX && pos.y - home.y < SNAP_PX;
  const final = snapped ? home : pos;

  setPos(final);
  // Snapping to the primary display's top-centre is the default spot.
  const isDefault = snapped && display.id === screen.getPrimaryDisplay().id;
  settings.set({ position: isDefault ? null : final, notchAttached: !!attachedNotch });
}

// Dropping the big (analysis) island: keep it on screen, snap it to the
// top-centre if it's close, and move the small island's home under its top
// centre so leaving big mode lands there.
function endBigDrag() {
  const [x, y] = win.getPosition();
  const { width, height } = bigSize;
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: y + EDGE });
  const wa = display.workArea;
  let nx = Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - width));
  let ny = Math.round(Math.max(wa.y - EDGE, Math.min(y, wa.y + wa.height - height)));
  const home = topCentre(display);
  const homeX = Math.round(home.x + WIN_W / 2 - width / 2);
  const homeY = home.y;
  const magnet = magnetOrigin({ x, y }, displayNotch(display), width, EDGE);
  const snapped = !!magnet || (!displayNotch(display) && Math.abs(nx - homeX) < SNAP_PX && ny - homeY < SNAP_PX);
  if (snapped) {
    nx = magnet ? magnet.x : homeX;
    ny = magnet ? magnet.y : homeY;
  }
  setPos({ x: nx, y: ny });

  const { display: homeScreen, ...normal } = clampToDisplay({ x: Math.round(nx + width / 2 - WIN_W / 2), y: ny }, !!magnet);
  normalBounds = { ...normal, width: WIN_W, height: WIN_H };
  updateAttachment(normal);
  const isDefault = snapped && homeScreen.id === screen.getPrimaryDisplay().id;
  settings.set({ position: isDefault ? null : normal, notchAttached: !!attachedNotch });
  // Where the small island now sits inside the big window.
  win.webContents.send('island:big-anchor', normal.x + WIN_W / 2 - nx);
}

// ---------- hover ----------
// The window is click-through, so it can't see the mouse itself. Poll the OS
// cursor and tell the renderer when it enters/leaves the island; the renderer
// then decides when to make the window clickable.

function pollHover() {
  if (!win || win.isDestroyed() || drag || menuOpen || !hitRect) return;
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const x = c.x - b.x;
  const y = c.y - b.y;
  // The camera cutout cannot emit DOM pointer events, so also poll the OS
  // cursor against its native geometry, even when the island is auto-hidden.
  const inside = containsNotch(c, attachedNotch) ||
    (x >= hitRect.x && x < hitRect.x + hitRect.width && y >= hitRect.y && y < hitRect.y + hitRect.height);
  if (inside !== hovering) {
    hovering = inside;
    win.webContents.send('island:hover', inside);
  }
}

// ---------- live timing & alerts ----------

function sendAlert(alert) {
  if (!alert || !win || win.isDestroyed()) return;
  const lap = live.state.LapCount?.CurrentLap;
  win.webContents.send('live:alert', lap && alert.level !== 'info' ? { ...alert, sub: `${alert.sub} · Lap ${lap}` } : alert);
}

live.on('state', (s) => win?.webContents.send('live:state', s));
live.on('track', (e) => sendAlert(alerts.fromTrack(e)));
// Double yellows come in bursts (marshals clearing the track, pre-start
// inspections): pop them only while the session runs, at most every 45 s.
const DOUBLE_YELLOW_GAP_MS = 45e3;
let lastDoubleYellow = 0;
const CONDITIONS_GAP_MS = 120e3;
let lastConditions = 0;
live.on('rc', (m) => {
  if (m.Flag === 'DOUBLE YELLOW') {
    if (live.state.SessionStatus?.Status !== 'Started' || Date.now() - lastDoubleYellow < DOUBLE_YELLOW_GAP_MS) return;
    lastDoubleYellow = Date.now();
  }
  const alert = alerts.fromMessage(m);
  // Conditions messages arrive per sector; one pop-up per couple of minutes is plenty.
  if (alert?.title === 'Track conditions') {
    if (Date.now() - lastConditions < CONDITIONS_GAP_MS) return;
    lastConditions = Date.now();
  }
  sendAlert(alert);
});
live.on('status', (status) => sendAlert(alerts.fromSessionStatus(status, live.state.SessionInfo?.Name)));

async function syncLiveTiming() {
  let weekend = null;
  try {
    weekend = (await getSnapshot()).weekend;
  } catch {
    return;
  }
  const now = Date.now();
  const near = (weekend?.sessions || []).some(
    (s) => now >= Date.parse(s.start) - LIVE_LEAD_MS && now <= Date.parse(s.end) + LIVE_TAIL_MS
  );
  // Stay connected while a session is running or suspended, even past the window.
  const running = ['Started', 'Aborted'].includes(live.state.SessionStatus?.Status);
  if (near || running) live.start();
  else live.stop();
}

function previewAlerts() {
  for (const a of alerts.DEMO) sendAlert(a);
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    ...windowOptions(),
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  configureWindow(win);
  win.setIgnoreMouseEvents(true);
  placeWindow();
  // Debug flags: --pinned starts expanded, --big opens the analysis view,
  // --tab=<summary|short|long|tyres> picks its tab.
  const query = {};
  if (process.argv.includes('--pinned')) query.pinned = '1';
  if (process.argv.includes('--big')) query.big = '1';
  const tabArg = process.argv.find((a) => a.startsWith('--tab='));
  if (tabArg) query.tab = tabArg.slice(6);
  const pageArg = process.argv.find((a) => a.startsWith('--page='));
  if (pageArg) query.page = pageArg.slice(7);
  const startArg = process.argv.find((a) => a.startsWith('--start='));
  if (startArg) query.start = startArg.slice(8);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  win.once('ready-to-show', () => {
    win.showInactive();
    if (process.argv.includes('--demo-alerts')) setTimeout(previewAlerts, 2500);
    scheduleScreenshot();
  });
}

// ---------- big (analysis) mode ----------

// Grow the window so the island can expand into the analysis view. The island
// stays where it is unless the screen edge forces the window to shift; the
// renderer gets the island's position inside the bigger window as anchorX.
function enterBig() {
  if (!bigMode) normalBounds = win.getBounds();
  bigMode = true;
  const nb = normalBounds;
  const cx = nb.x + nb.width / 2;
  const wa = screen.getDisplayNearestPoint({ x: Math.round(cx), y: nb.y + EDGE }).workArea;
  const width = Math.min(BIG_W, wa.width);
  const height = Math.min(BIG_H, wa.y + wa.height - nb.y);
  const x = Math.round(Math.min(Math.max(cx - width / 2, wa.x), wa.x + wa.width - width));
  bigSize = { width, height };
  win.setBounds({ x, y: nb.y, width, height });
  return { anchorX: cx - x, width, height, edge: EDGE };
}

function exitBig() {
  if (!bigMode) return;
  bigMode = false;
  win.setBounds(normalBounds);
  placeWindow();
}

// Generic pop-up list for the island: items are { label, value, checked } or
// { separator: true }. Resolves with the chosen value, or null.
function choose(items) {
  return new Promise((resolve) => {
    const template = (Array.isArray(items) ? items : []).slice(0, 80).map((it) =>
      it.separator
        ? { type: 'separator' }
        : it.header
          ? { label: String(it.label), enabled: false }
          : { label: String(it.label), type: 'checkbox', checked: !!it.checked, click: () => resolve(it.value) }
    );
    if (!template.length) return resolve(null);
    menuOpen = true;
    Menu.buildFromTemplate(template).popup({
      window: win,
      callback: () => {
        menuOpen = false;
        setTimeout(() => resolve(null), 200);
      },
    });
  });
}

// Session picker for the analysis view, as a native menu (a <select> can't
// open reliably in a window that never takes focus).
async function pickSession(currentKey) {
  const sessions = await listSessions();
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.meeting)) groups.set(s.meeting, []);
    groups.get(s.meeting).push(s);
  }
  return new Promise((resolve) => {
    const item = (s) => ({
      label: s.name,
      type: 'checkbox',
      checked: s.key === currentKey,
      click: () => resolve(s.key),
    });
    const [[latest, latestList] = [], ...older] = groups;
    const template = latest
      ? [
          { label: latest, enabled: false },
          ...latestList.map(item),
          { type: 'separator' },
          ...older.map(([meeting, list]) => ({ label: meeting, submenu: list.map(item) })),
        ]
      : [{ label: 'No completed sessions yet', enabled: false }];
    menuOpen = true;
    Menu.buildFromTemplate(template).popup({
      window: win,
      callback: () => {
        menuOpen = false;
        // A clicked item resolves first; this covers dismissing the menu.
        setTimeout(() => resolve(null), 200);
      },
    });
  });
}

// --screenshot=<file.png> [--screenshot-delay=<ms>]: save a PNG of just the
// island (with its shadow, transparent around it) and quit. Used for the README.
function scheduleScreenshot() {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const file = arg('screenshot');
  if (!file) return;
  setTimeout(async () => {
    const r = hitRect || { x: 0, y: 0, ...win.getContentBounds() };
    const pad = EDGE - 6;
    const rect = {
      x: Math.max(0, Math.floor(r.x - pad)),
      y: Math.max(0, Math.floor(r.y - pad)),
      width: Math.ceil(r.width + 2 * pad),
      height: Math.ceil(r.height + 2 * pad),
    };
    const image = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.resolve(file), image.toPNG());
    app.quit();
  }, Number(arg('screenshot-delay')) || 8000);
}

function registerHotkey() {
  const { hotkey } = settings.get();
  try {
    hotkeyOk = globalShortcut.register(hotkey, () => win?.webContents.send('island:toggle'));
  } catch {
    hotkeyOk = false;
  }
  if (!hotkeyOk) console.warn(`Hotkey ${hotkey} is unavailable (in use by another app?)`);
}

const hotkeyLabel = () => formatHotkey(settings.get().hotkey);

// ---------- tray ----------

// 16x16 red dot for the tray, drawn into a BGRA bitmap.
function trayIcon() {
  if (IS_MAC) {
    // A 2x checkered flag template stays legible in light/dark menu bars.
    const size = 36;
    const buf = Buffer.alloc(size * size * 4);
    for (let y = 4; y < 32; y++) {
      for (let x = 6; x < 30; x++) {
        const pole = x < 9;
        const flag = y < 24 && (Math.floor((x - 9) / 5) + Math.floor((y - 4) / 5)) % 2 === 0;
        if (pole || flag) buf[(y * size + x) * 4 + 3] = 255;
      }
    }
    const image = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
    image.setTemplateImage(true);
    return image;
  }
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const a = Math.max(0, Math.min(1, 7 - d));
      const i = (y * size + x) * 4;
      buf[i] = 0x00; // B
      buf[i + 1] = 0x06; // G
      buf[i + 2] = 0xe1; // R
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// The tray menu offers Show / hide; the island's own menu (right-click or ⋯)
// is only reachable while it's open, so it offers Keep open instead.
function buildMenu({ fromIsland = false } = {}) {
  return Menu.buildFromTemplate([
    fromIsland
      ? {
          label: 'Keep open',
          type: 'checkbox',
          checked: pinned,
          click: (item) => win.webContents.send('island:set-pinned', item.checked),
        }
      : {
          label: hotkeyOk ? `Show / hide	${hotkeyLabel()}` : 'Show / hide',
          click: () => win.webContents.send('island:toggle'),
        },
    IS_MAC && attachedNotch ? idleModeMenu(settings.get().autoHide, (autoHide) => {
      settings.set({ autoHide });
      if (demo) setDemo(null);
      win.webContents.send('island:settings', settings.get());
      refreshTrayMenu();
    }) : {
      label: 'Auto-hide until hovered',
      type: 'checkbox',
      checked: settings.get().autoHide,
      click: (item) => {
        settings.set({ autoHide: item.checked });
        if (demo) setDemo(null);
        win.webContents.send('island:settings', settings.get());
        refreshTrayMenu();
      },
    },
    { label: 'Reset position', click: resetPosition },
    { type: 'separator' },
    { label: 'Session analysis', click: () => win.webContents.send('island:big') },
    { label: 'Preview alerts', click: previewAlerts },
    ...(IS_MAC ? [{ label: 'Preview stretched bar', enabled: !!attachedNotch, submenu: [
      { label: 'Live data (stop preview)', type: 'radio', checked: !demo, click: () => setDemo(null) },
      ...DEMO_MODES.map((mode) => ({
        label: { next: 'Next session', race: 'Race / overtakes', 'safety-car': 'Safety Car',
          'red-flag': 'Red flag', penalty: 'Penalty' }[mode] + ' (dummy)',
        type: 'radio', checked: demo?.mode === mode, click: () => setDemo(mode),
      })),
    ] }] : []),
    { label: 'Refresh data', click: () => win.webContents.send('f1:refresh') },
    loginItemMenu(app, refreshTrayMenu),
    { type: 'separator' },
    { label: IS_MAC ? 'Quit F1 Island' : 'Quit', click: () => app.quit() },
  ]);
}

function setDemo(mode) {
  demo = mode ? createDemo(mode) : null;
  win.webContents.send('island:demo', demo);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  tray?.setContextMenu(buildMenu());
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(hotkeyOk ? `F1 Island (${hotkeyLabel()} to show/hide)` : 'F1 Island');
  // On macOS the left click opens the attached menu. Toggling as well would
  // expand/collapse the island every time someone opens its settings.
  if (!IS_MAC) tray.on('click', () => win.webContents.send('island:toggle'));
  refreshTrayMenu();
}

// ---------- IPC ----------

ipcMain.handle('f1:snapshot', () => getSnapshot());
ipcMain.handle('f1:news', () => getNews());
ipcMain.on('news:open', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url) && isKnownLink(url)) shell.openExternal(url);
});
ipcMain.handle('island:get-settings', () => settings.get());
ipcMain.handle('island:get-notch', () => attachedNotch);
ipcMain.handle('island:get-demo', () => demo);
ipcMain.on('island:interactive', (_e, on) => {
  win?.setIgnoreMouseEvents(!on);
});
ipcMain.on('island:rect', (_e, rect) => {
  hitRect = rect;
});
// Forget the hover state so the next poll reports "enter" again if the cursor is on the island.
ipcMain.on('island:rehover', () => {
  hovering = false;
});
ipcMain.on('island:drag-start', startDrag);
ipcMain.on('island:drag-end', endDrag);
ipcMain.on('island:menu', () => {
  menuOpen = true;
  // Hover polling resumes on close; if the cursor has left by then, the island collapses.
  buildMenu({ fromIsland: true }).popup({ window: win, callback: () => (menuOpen = false) });
});
ipcMain.handle('island:big', (_e, on) => (on ? enterBig() : exitBig()));
ipcMain.handle('analysis:sessions', () => listSessions());
ipcMain.handle('analysis:get', (_e, key) => getAnalysis(key));
ipcMain.handle('analysis:pick', (_e, key) => pickSession(key));
ipcMain.handle('analysis:telemetry', (_e, sessionKey, driver, lap) => getTelemetry(sessionKey, driver, lap));
ipcMain.handle('analysis:location', (_e, sessionKey, driver, lap) => getLapLocation(sessionKey, driver, lap));
ipcMain.handle('replay:info', (_e, sessionKey) => getReplayInfo(sessionKey));
ipcMain.handle('replay:chunk', (_e, sessionKey, index) => getReplayChunk(sessionKey, index));
// Map for the weekend shown on the island's Circuit page.
ipcMain.handle('f1:trackmap', async () => {
  const w = (await getSnapshot()).weekend;
  if (!w) return null;
  return getWeekendTrackMap({
    start: w.sessions[0].start,
    end: w.sessions.at(-1).end,
    country: w.country,
    locality: w.locality,
  });
});
ipcMain.handle('island:choose', (_e, items) => choose(items));
ipcMain.on('island:pinned', (_e, on) => {
  pinned = on;
});

app.whenReady().then(() => {
  // A menu-bar utility should not occupy the Dock or the Cmd-Tab switcher.
  if (IS_MAC) app.dock.hide();
  notches = readNotches(app);
  const demoArg = process.argv.find((arg) => arg.startsWith('--demo='))?.slice(7);
  if (DEMO_MODES.includes(demoArg)) demo = createDemo(demoArg);
  const idleArg = process.argv.find((arg) => arg.startsWith('--idle='))?.slice(7);
  if (IS_MAC && ['notch', 'stretched'].includes(idleArg)) settings.set({ autoHide: idleArg === 'notch' });
  migratePosition();
  setCacheDir(path.join(app.getPath('userData'), 'cache'));
  createWindow();
  registerHotkey();
  createTray();
  setInterval(pollHover, 50);
  syncLiveTiming();
  setInterval(syncLiveTiming, 60e3);
  screen.on('display-metrics-changed', displaysChanged);
  screen.on('display-added', displaysChanged);
  screen.on('display-removed', displaysChanged);
  powerMonitor.on('resume', () => {
    displaysChanged();
    syncLiveTiming();
    win?.webContents.send('f1:refresh');
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  live.stop();
});
app.on('window-all-closed', () => app.quit());
