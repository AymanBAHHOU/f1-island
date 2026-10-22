// Launch the real main process and assert macOS window/preload behavior. This
// needs a graphical macOS login session; the unit tests do not.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

if (process.platform !== 'darwin') {
  console.error('test:mac requires macOS. Run npm test for portable unit tests.');
  app.exit(1);
} else {
  // Never read or change a developer's real settings, position, or data cache.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-island-smoke-'));
  app.setPath('userData', userData);
  process.argv.push('--pinned');
  const timeout = setTimeout(() => {
    console.error('macOS smoke test timed out');
    app.exit(1);
  }, 20000);
  app.on('quit', () => fs.rmSync(userData, { recursive: true, force: true }));
  require('../main');
  app.whenReady().then(() => {
    const [win] = BrowserWindow.getAllWindows();
    win.once('ready-to-show', async () => {
      try {
        assert.equal(app.name, 'F1 Island');
        assert.equal(app.dock.isVisible(), false, 'Dock icon must stay hidden');
        assert.equal(win.isVisible(), true);
        assert.equal(win.isFocusable(), false, 'overlay must not steal focus');
        assert.equal(win.isAlwaysOnTop(), true);
        assert.equal(win.isVisibleOnAllWorkspaces(), true);
        assert.equal(win.isFullScreenable(), false);
        const bounds = win.getBounds();
        const area = screen.getPrimaryDisplay().workArea;
        // The transparent shadow margin may extend above the work area, but
        // the actual pill must sit below the menu bar / camera notch.
        assert.ok(bounds.y + 32 >= area.y, 'pill must respect the menu bar');
        const bridge = await win.webContents.executeJavaScript('typeof window.f1.snapshot');
        assert.equal(bridge, 'function');
        const image = await win.webContents.capturePage();
        assert.equal(image.isEmpty(), false);
        console.log('macOS smoke test passed: panel, Spaces, Dock, safe placement, preload, rendering');
        clearTimeout(timeout);
        app.quit();
      } catch (err) {
        console.error(err);
        app.exit(1);
      }
    });
  });
}
