// Updates. Three ways, by how the app was installed:
//   auto    Windows installer (NSIS): electron-updater downloads a newer release
//           from GitHub in the background and installs it on restart or quit.
//   notify  everything else that is packaged (Windows portable, macOS): these
//           can't replace themselves (the portable exe has no installer; macOS
//           only self-updates when signed), so a newer release is announced
//           with a link to its download page.
//   off     running from source.
const { EventEmitter } = require('events');

const REPO = 'AymanBAHHOU/f1-island';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 30e3;
const CHECK_EVERY_MS = 6 * 3600e3;

function updateMode({ packaged, platform, portable }) {
  if (!packaged) return 'off';
  return platform === 'win32' && !portable ? 'auto' : 'notify';
}

// "v0.1.10" / "0.1.10-beta.1" -> [0, 1, 10]; null if it isn't a version.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// GitHub's "latest release" JSON -> { version, url }, or null for anything
// that isn't a published, final release.
function releaseInfo(json) {
  if (!json || json.draft || json.prerelease || !parseVersion(json.tag_name)) return null;
  const url = typeof json.html_url === 'string' && json.html_url.startsWith('https://github.com/') ? json.html_url : RELEASES_URL;
  return { version: String(json.tag_name).replace(/^v/, ''), url };
}

class Updater extends EventEmitter {
  // opts: { version, mode, fetch, shell, loadAutoUpdater, log }
  constructor(opts) {
    super();
    this.version = opts.version;
    this.mode = opts.mode;
    this.fetch = opts.fetch || globalThis.fetch;
    this.shell = opts.shell;
    this.loadAutoUpdater = opts.loadAutoUpdater || (() => require('electron-updater').autoUpdater);
    this.log = opts.log || (() => {});
    this.state = { status: 'idle', version: null, url: null, checkedAt: 0 };
    this.timers = [];
    this.au = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  start() {
    if (this.mode === 'off') return;
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  async check() {
    if (this.mode === 'off' || ['downloading', 'ready'].includes(this.state.status)) return;
    try {
      if (this.mode === 'auto') await this.checkAuto();
      else await this.checkNotify();
    } catch (err) {
      // Offline, rate limited, no release yet: try again at the next check.
      this.log(`update check failed: ${err.message}`);
    }
  }

  async checkNotify() {
    const res = await this.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const rel = releaseInfo(await res.json());
    if (rel && isNewer(rel.version, this.version)) this.set({ status: 'available', version: rel.version, url: rel.url, checkedAt: Date.now() });
    else this.set({ status: 'idle', checkedAt: Date.now() });
  }

  async checkAuto() {
    if (!this.au) {
      const au = this.loadAutoUpdater();
      au.autoDownload = true;
      au.autoInstallOnAppQuit = true; // a downloaded update installs when the app is next closed
      au.allowPrerelease = false;
      au.logger = null;
      au.on('update-available', (info) => this.set({ status: 'downloading', version: info.version }));
      au.on('update-not-available', () => this.set({ status: 'idle', checkedAt: Date.now() }));
      au.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
      au.on('error', (err) => {
        const firstLine = String(err?.message || err).split(/\r?\n/)[0];
        this.log(`updater error: ${firstLine}`);
        if (this.state.status === 'downloading') this.set({ status: 'idle' });
      });
      this.au = au;
    }
    await this.au.checkForUpdates();
  }

  // The user chose the update chip or menu item.
  act() {
    const { status, url } = this.state;
    if (status === 'ready' && this.au) {
      this.stop();
      this.au.quitAndInstall(true, true); // silent install, then relaunch
    } else if (status === 'available' && url) {
      this.shell.openExternal(url);
    } else if (status === 'idle') {
      this.check();
    }
  }
}

module.exports = { Updater, updateMode, parseVersion, isNewer, releaseInfo, RELEASES_URL };
