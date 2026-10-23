const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform === 'darwin') {
  const root = path.join(__dirname, '..');
  const source = path.join(root, 'native', 'notch-info.m');
  const output = path.join(root, 'build', 'notch-info');
  if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < fs.statSync(source).mtimeMs) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    execFileSync('xcrun', [
      'clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
      '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0',
      '-framework', 'AppKit', source, '-o', output,
    ], { stdio: 'inherit' });
    console.log('Built universal macOS notch geometry helper');
  }
}
