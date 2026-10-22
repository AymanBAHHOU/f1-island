// Launch the real main process and assert macOS window/preload behavior. This
// needs a graphical macOS login session; the unit tests do not.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const { createDemo } = require('../src/demo');

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
  }, 30000);
  app.on('quit', () => fs.rmSync(userData, { recursive: true, force: true }));
  // Keep a user's real cursor from racing the synthetic hover/leave sequence.
  // This only replaces the read inside this test process; it never moves it.
  let cursor = { x: -100000, y: -100000 };
  app.whenReady().then(() => { screen.getCursorScreenPoint = () => cursor; });
  // No live data services in graphical tests: the real renderer/main process
  // receive a deterministic dummy schedule, and analysis never makes HTTP calls.
  const fixture = createDemo('next');
  require('../src/data').getSnapshot = async () => structuredClone(fixture.snapshot);
  require('../src/analysis').listSessions = async () => [];
  require('../src/news').getNews = async () => [];
  require('../main');
  app.whenReady().then(() => {
    const [win] = BrowserWindow.getAllWindows();
    async function capture(name) {
      const directory = process.argv.find((arg) => arg.startsWith('--screenshots='))?.slice(14);
      const rect = await win.webContents.executeJavaScript(`(() => {
        const r = document.getElementById('zone').getBoundingClientRect();
        return { x: Math.max(0, Math.floor(r.x - 20)), y: Math.max(0, Math.floor(r.y - 20)),
          width: Math.ceil(r.width + 40), height: Math.ceil(r.height + 40) };
      })()`);
      const image = await win.webContents.capturePage(rect);
      if (directory) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, `${name}.png`), image.toPNG());
      }
      return image;
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
          assert.ok(Math.abs(compact - (notch.height + 24)) < 1, 'stretched mode reserves a camera-safe event ticker');
          assert.equal(await win.webContents.executeJavaScript('document.getElementById("island").classList.contains("stretched")'), true);
          assert.match(await win.webContents.executeJavaScript('document.getElementById("idleStatus").textContent'), /Q · STARTS IN/);
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
          for (const mode of ['next', 'race', 'safety-car', 'red-flag', 'penalty']) {
            win.webContents.send('island:demo', createDemo(mode));
            await waitForAnimation();
            const idle = await win.webContents.executeJavaScript(`({
              stretched: document.getElementById('island').classList.contains('stretched'),
              expanded: document.getElementById('island').classList.contains('expanded'),
              label: document.getElementById('idleKicker').textContent,
              detail: document.getElementById('idleDetail').textContent,
              status: document.getElementById('idleStatus').textContent,
              tickerTop: document.querySelector('.idle-ticker').getBoundingClientRect().top,
              surfaceStroke: getComputedStyle(document.querySelector('.notch-surface path')).stroke,
              surfaceFill: getComputedStyle(document.querySelector('.notch-surface path')).fill,
              surfaceFilter: getComputedStyle(document.querySelector('.notch-surface')).filter,
              backgroundImage: getComputedStyle(document.getElementById('notchIdle')).backgroundImage,
              flagRing: document.getElementById('island').getAttribute('data-track'),
            })`);
            assert.equal(idle.stretched, true, `${mode} preview must stay horizontally stretched without hovering`);
            assert.equal(idle.expanded, false, 'live events must not unexpectedly open the full panel');
            assert.match(idle.label, /DEMO/);
            assert.ok(idle.tickerTop >= 32 + notch.height, 'ticker stays below the physical camera');
            assert.equal(idle.surfaceStroke, 'none', `${mode}: no idle outline across the camera`);
            assert.equal(idle.flagRing, null, 'global flag-ring styles must not activate around idle hardware');
            assert.equal(idle.surfaceFill, 'rgb(0, 0, 0)', 'idle surface must blend with the black camera');
            assert.equal(idle.backgroundImage, 'none', 'no coloured wash behind the camera');
            for (const color of idle.surfaceFilter.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)) {
              assert.deepEqual(color.slice(1).map(Number), [0, 0, 0], `${mode}: only neutral shadows, no coloured halo`);
            }
            if (mode === 'safety-car') assert.equal(idle.status, 'SAFETY CAR');
            if (mode === 'red-flag') assert.equal(idle.status, 'RED FLAG');
            if (mode === 'penalty') assert.match(idle.detail, /PENALTY/);
            const preview = await capture(`notch-idle-${mode}`);
            const pixels = preview.toBitmap({ scaleFactor: 1 });
            const size = preview.getSize(1);
            assert.equal(pixels.length, size.width * size.height * 4);
            // Check the actual composited top margin, not just computed CSS:
            // no status-coloured border/halo may expose the camera silhouette.
            for (let y = 0; y < Math.min(10, size.height); y++) {
              for (let x = 0; x < size.width; x++) {
                const i = (y * size.width + x) * 4;
                if (pixels[i + 3] < 4) continue;
                const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
                assert.ok(Math.max(...rgb) - Math.min(...rgb) < 8, `${mode}: coloured pixels leaked into the top margin`);
              }
            }
          }
          win.webContents.send('island:demo', null);
          await waitForAnimation();
          assert.equal(await win.webContents.executeJavaScript('document.getElementById("island").classList.contains("hidden")'), true,
            'stopping a preview restores the selected Notch only mode');
          // Drive the real dragging IPC with a synthetic cursor, without
          // moving the user's actual mouse or relying on Accessibility access.
          const startBounds = win.getBounds();
          const offset = { x: startBounds.width / 2, y: 80 };
          cursor = { x: startBounds.x + offset.x, y: startBounds.y + offset.y };
          await win.webContents.executeJavaScript('window.f1.dragStart()');
          assert.equal(await win.webContents.executeJavaScript('window.f1.notch()'), null, 'dragging away detaches without a toggle');
          cursor = { x: startBounds.x + 160 + offset.x, y: 200 + offset.y };
          await win.webContents.executeJavaScript('new Promise(r => setTimeout(r, 100))');
          await win.webContents.executeJavaScript('window.f1.dragEnd()');
          await waitForAnimation();
          assert.equal(await win.webContents.executeJavaScript('window.f1.settings().then(s => s.notchAttached)'), false);
          const floatingBounds = win.getBounds();
          screen.emit('display-metrics-changed', screen.getPrimaryDisplay(), ['workArea']);
          await waitForAnimation();
          assert.deepEqual(win.getBounds(), floatingBounds, 'display refresh must not reattach a deliberately detached island');
          cursor = { x: floatingBounds.x + offset.x, y: floatingBounds.y + offset.y };
          await win.webContents.executeJavaScript('window.f1.dragStart()');
          cursor = { x: notch.centerX + 35, y: notch.top - 32 + 40 + offset.y };
          await win.webContents.executeJavaScript('new Promise(r => setTimeout(r, 100))');
          await win.webContents.executeJavaScript('window.f1.dragEnd()');
          await waitForAnimation();
          assert.ok(await win.webContents.executeJavaScript('window.f1.notch()'), 'dropping near the camera automatically reattaches');
          assert.equal(await win.webContents.executeJavaScript('window.f1.settings().then(s => s.notchAttached)'), true);
          assert.equal(win.getBounds().y + 32, notch.top);
          cursor = { x: -100000, y: -100000 };
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
