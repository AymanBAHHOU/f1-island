const { contextBridge, ipcRenderer } = require('electron');

// Errors thrown in the main process arrive as "Error invoking remote method
// 'x': Error: message"; keep just the message.
const call = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((err) => {
    throw new Error(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  });

contextBridge.exposeInMainWorld('f1', {
  snapshot: () => call('f1:snapshot'),
  news: () => call('f1:news'),
  trackMap: () => call('f1:trackmap'),
  openArticle: (url) => ipcRenderer.send('news:open', url),
  settings: () => call('island:get-settings'),
  notch: () => call('island:get-notch'),
  onNotch: (cb) => ipcRenderer.on('island:notch', (_e, notch) => cb(notch)),
  setInteractive: (on) => ipcRenderer.send('island:interactive', on),
  dragStart: () => ipcRenderer.send('island:drag-start'),
  dragEnd: () => ipcRenderer.send('island:drag-end'),
  openMenu: () => ipcRenderer.send('island:menu'),
  setBig: (on) => call('island:big', on),
  setRect: (rect) => ipcRenderer.send('island:rect', rect),
  rehover: () => ipcRenderer.send('island:rehover'),
  onHover: (cb) => ipcRenderer.on('island:hover', (_e, inside) => cb(inside)),
  onRefresh: (cb) => ipcRenderer.on('f1:refresh', () => cb()),
  onLiveState: (cb) => ipcRenderer.on('live:state', (_e, s) => cb(s)),
  onAlert: (cb) => ipcRenderer.on('live:alert', (_e, a) => cb(a)),
  onToggle: (cb) => ipcRenderer.on('island:toggle', () => cb()),
  onBig: (cb) => ipcRenderer.on('island:big', () => cb()),
  onBigAnchor: (cb) => ipcRenderer.on('island:big-anchor', (_e, x) => cb(x)),
  onBigGeometry: (cb) => ipcRenderer.on('island:big-geometry', (_e, geometry) => cb(geometry)),
  reportPinned: (on) => ipcRenderer.send('island:pinned', on),
  onSetPinned: (cb) => ipcRenderer.on('island:set-pinned', (_e, on) => cb(on)),
  onSettings: (cb) => ipcRenderer.on('island:settings', (_e, s) => cb(s)),
  analysis: {
    sessions: () => call('analysis:sessions'),
    get: (key) => call('analysis:get', key),
    pick: (key) => call('analysis:pick', key),
    telemetry: (sessionKey, driver, lap) => call('analysis:telemetry', sessionKey, driver, lap),
    choose: (items) => call('island:choose', items),
    location: (sessionKey, driver, lap) => call('analysis:location', sessionKey, driver, lap),
    replayInfo: (sessionKey) => call('replay:info', sessionKey),
    replayChunk: (sessionKey, index) => call('replay:chunk', sessionKey, index),
  },
});
