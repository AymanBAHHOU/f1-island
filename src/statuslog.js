// A small log of what live timing reports about a session's status (Started,
// Finished, Inactive, ...), with times. A few lines per session; it exists to
// learn the real sequence, e.g. what happens between Q1, Q2 and Q3.
const fs = require('fs');

const MAX_BYTES = 256 * 1024;

function formatEntry(entry, now = new Date()) {
  return JSON.stringify({ t: now.toISOString(), ...entry });
}

// Appends one line. A file past maxBytes is kept as <file>.old and restarted.
// Never throws: logging must not disturb the app.
function appendEntry(file, entry, { now = new Date(), maxBytes = MAX_BYTES } = {}) {
  try {
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.old`);
    } catch {
      // no file yet
    }
    fs.appendFileSync(file, `${formatEntry(entry, now)}\n`);
  } catch {
    // ignore
  }
}

module.exports = { appendEntry, formatEntry, MAX_BYTES };
