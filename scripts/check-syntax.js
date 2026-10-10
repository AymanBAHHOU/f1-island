// Syntax-checks every JavaScript file in the app (node --check), so a broken
// template string or regex fails CI before it reaches the island.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['.', 'src', 'renderer', 'scripts', 'test'];

const files = DIRS.flatMap((dir) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f))
);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${file}\n${err.stderr.toString()}`);
  }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
