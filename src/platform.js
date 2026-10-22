// Keep desktop-specific behavior separate from the F1 data and renderer.
function windowOptions(platform = process.platform) {
  return platform === 'darwin' ? { type: 'panel', fullscreenable: false } : {};
}

function configureWindow(win, platform = process.platform) {
  // A floating panel belongs above apps, not above system/security UI.
  win.setAlwaysOnTop(true, platform === 'darwin' ? 'floating' : 'screen-saver');
  if (platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true, // the app already hides its Dock icon
    });
  }
}

function formatHotkey(hotkey, platform = process.platform) {
  return hotkey
    .replace(/CommandOrControl/g, platform === 'darwin' ? 'Cmd' : 'Ctrl')
    .replace(/Command/g, 'Cmd')
    .replace(/Control/g, 'Ctrl')
    .replace(/Alt/g, platform === 'darwin' ? 'Option' : 'Alt');
}

function loginItemMenu(app, onChange, platform = process.platform) {
  const mac = platform === 'darwin';
  // Registering the development Electron binary would reopen Electron, not
  // this app. Only offer macOS login registration from a packaged .app.
  const enabled = platform === 'win32' || (mac && app.isPackaged);
  return {
    label: mac ? 'Start at Login' : 'Start with Windows',
    type: 'checkbox',
    enabled,
    checked: enabled && app.getLoginItemSettings().openAtLogin,
    ...(mac && !enabled ? { sublabel: 'Available in the packaged F1 Island.app' } : {}),
    click: (item) => {
      if (!enabled) return;
      app.setLoginItemSettings({ openAtLogin: item.checked });
      onChange();
    },
  };
}

module.exports = { windowOptions, configureWindow, formatHotkey, loginItemMenu };
