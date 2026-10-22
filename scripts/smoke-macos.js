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
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    position: { x: 400, y: 200 }, layout: 2,
  })); // upgrading from a floating layout must still attach to the notch
  process.argv.push('--pinned');
  const timeout = setTimeout(() => {
    console.error('macOS smoke test timed out');
    app.exit(1);
  }, 20000);
  app.on('quit', () => fs.rmSync(userData, { recursive: true, force: true }));
  // Keep a user's real cursor from racing the synthetic hover/leave sequence.
  // This only replaces the read inside this test process; it never moves it.
  app.whenReady().then(() => {
    screen.getCursorScreenPoint = () => ({ x: -100000, y: -100000 });
  });
  require('../main');
  app.whenReady().then(() => {
    const [win] = BrowserWindow.getAllWindows();
    async function capture(name) {
      const directory = process.argv.find((arg) => arg.startsWith('--screenshots='))?.slice(14);
      if (!directory) return;
      const rect = await win.webContents.executeJavaScript(`(() => {
        const r = document.getElementById('zone').getBoundingClientRect();
        return { x: Math.max(0, Math.floor(r.x - 20)), y: Math.max(0, Math.floor(r.y - 20)),
          width: Math.ceil(r.width + 40), height: Math.ceil(r.height + 40) };
      })()`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage(rect)).toPNG());
    }
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
        const notch = await win.webContents.executeJavaScript('window.f1.notch()');
        if (notch) {
          assert.equal(bounds.y + 32, notch.top, 'island must touch the physical top edge');
          assert.ok(Math.abs(bounds.x + bounds.width / 2 - notch.centerX) <= 1);
          assert.equal(await win.webContents.executeJavaScript('document.body.classList.contains("notched")'), true);
          const waitForAnimation = () => win.webContents.executeJavaScript('new Promise(r => setTimeout(r, 1000))');
          win.webContents.send('island:set-pinned', false);
          win.webContents.send('island:hover', false);
          await waitForAnimation();
          const compact = await win.webContents.executeJavaScript('document.getElementById("island").getBoundingClientRect().height');
          assert.ok(Math.abs(compact - (notch.height + 6)) < 1, 'closed wings fit the real notch height');
          await capture('notch-compact');
          win.webContents.send('island:hover', true);
          await waitForAnimation();
          const open = await win.webContents.executeJavaScript(`({
            expanded: document.getElementById('island').classList.contains('expanded'),
            height: document.getElementById('island').getBoundingClientRect().height,
            titleTop: document.querySelector('#expanded h1')?.getBoundingClientRect().top,
          })`);
          assert.equal(open.expanded, true, 'notch hover expands the island');
          assert.ok(open.height > compact);
          if (open.titleTop != null) assert.ok(open.titleTop >= 32 + notch.height, 'no title behind the camera');
          await capture('notch-expanded');
          win.webContents.send('island:big');
          await waitForAnimation();
          assert.equal(await win.webContents.executeJavaScript('document.getElementById("island").classList.contains("big")'), true);
          assert.equal(win.getBounds().y + 32, notch.top, 'analysis stays attached to the notch');
          const headerTop = await win.webContents.executeJavaScript('document.querySelector(".big-head").getBoundingClientRect().top');
          assert.ok(headerTop >= 32 + notch.height, 'analysis header must clear the camera');
          await capture('notch-analysis');
          await win.webContents.executeJavaScript('document.getElementById("bigBack").click()');
          await waitForAnimation();
          win.webContents.send('island:hover', true);
          await waitForAnimation();
          win.webContents.send('island:hover', false);
          await waitForAnimation();
          assert.equal(await win.webContents.executeJavaScript('document.getElementById("island").classList.contains("expanded")'), false);
          win.webContents.send('island:settings', { autoHide: true });
          // Wait for the measured result, not a fixed animation duration:
          // concurrent packaging can delay a compositor frame on a busy Mac.
          await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const deadline = performance.now() + 4000;
            function check() {
              const el = document.getElementById('island');
              const rect = el.getBoundingClientRect();
              if (el.classList.contains('hidden') && Math.abs(rect.height - ${notch.height - 1}) < 0.5 &&
                  Math.abs(rect.width - ${notch.width - 4}) < 0.5) resolve();
              else if (performance.now() > deadline) reject(new Error('Auto-hide did not settle'));
              else requestAnimationFrame(check);
            }
            check();
          })`);
          const hidden = await win.webContents.executeJavaScript('document.getElementById("island").getBoundingClientRect().height');
          assert.ok(Math.abs(hidden - (notch.height - 1)) < 1, 'auto-hide tucks inside the camera edge');
          const hiddenWidth = await win.webContents.executeJavaScript('document.getElementById("island").getBoundingClientRect().width');
          assert.ok(hiddenWidth < notch.width, 'reveal must start inside the physical side edges');
          win.webContents.send('island:set-pinned', true);
          const motion = await win.webContents.executeJavaScript(`new Promise(resolve => {
            const widths = [];
            const start = performance.now();
            function sample() {
              widths.push(document.getElementById('island').getBoundingClientRect().width);
              if (performance.now() - start >= 650) resolve({ widths,
                reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
                path: document.querySelector('.notch-surface path').getAttribute('d') });
              else requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
          })`);
          assert.ok(motion.path.includes('C '), 'one cubic vector surface draws the smooth edges');
          for (let i = 1; i < motion.widths.length; i++) {
            assert.ok(motion.widths[i] >= motion.widths[i - 1] - 0.1, 'interpolation must not bounce backwards');
            assert.ok(motion.widths[i] <= 440.1, 'interpolation must not overshoot the final edge');
          }
          if (!motion.reduced) assert.ok(new Set(motion.widths.map(Math.round)).size > 4, 'reveal interpolates intermediate shapes');
          win.webContents.debugger.attach('1.3');
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
          });
          assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.getElementById("island")).transitionDuration'), '0s');
          win.webContents.debugger.detach();
          console.log(`Native notch verified: ${notch.width} × ${notch.height} pt; hover expands and leave collapses`);
        } else {
          const area = screen.getPrimaryDisplay().workArea;
          assert.ok(bounds.y + 32 >= area.y, 'floating fallback must respect the menu bar');
        }
        const bridge = await win.webContents.executeJavaScript('typeof window.f1.snapshot');
        assert.equal(bridge, 'function');
        const image = await win.webContents.capturePage();
        assert.equal(image.isEmpty(), false);
        console.log('macOS smoke test passed: panel, Spaces, Dock, notch/fallback placement, preload, rendering');
        clearTimeout(timeout);
        app.quit();
      } catch (err) {
        console.error(err);
        app.exit(1);
      }
    });
  });
}
