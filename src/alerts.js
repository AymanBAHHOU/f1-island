// Turns live timing events into island alerts.
// Alert: { level, tile, title, sub, ms }
//   level: red | sc | vsc | yellow | green | chequered | info
//   tile:  short text on the coloured flag tile

// TrackStatus codes from F1 live timing.
const TRACK = {
  1: 'clear',
  2: 'yellow',
  4: 'sc',
  5: 'red',
  6: 'vsc',
  7: 'vsc-ending',
};
const NEUTRALISED = new Set(['sc', 'red', 'vsc', 'vsc-ending']);

function fromTrack({ status, prev }) {
  const now = TRACK[status];
  const before = TRACK[prev];
  switch (now) {
    case 'red':
      return { level: 'red', tile: '', title: 'Red flag', sub: 'Session suspended', ms: 10000 };
    case 'sc':
      return { level: 'sc', tile: 'SC', title: 'Safety Car', sub: 'Safety Car deployed', ms: 10000 };
    case 'vsc':
      return { level: 'vsc', tile: 'VSC', title: 'Virtual Safety Car', sub: 'VSC deployed', ms: 9000 };
    case 'vsc-ending':
      return { level: 'vsc', tile: 'VSC', title: 'VSC ending', sub: 'Racing resumes shortly', ms: 6000 };
    case 'clear':
      // Only worth a pop-up after a neutralisation.
      return NEUTRALISED.has(before) ? { level: 'green', tile: '', title: 'Track clear', sub: 'Green flag', ms: 6000 } : null;
    default:
      return null; // single yellows are frequent: shown as pill status only
  }
}

const IGNORE = /DELETED|TRACK LIMITS|BLUE FLAG/i;

function fromMessage(m) {
  const text = (m.Message || '').trim();
  if (!text) return null;
  const sub = text.length > 90 ? `${text.slice(0, 88)}…` : text;

  if (m.Flag === 'CHEQUERED') return { level: 'chequered', tile: '', title: 'Chequered flag', sub: 'Session over', ms: 8000 };
  if (m.Flag === 'DOUBLE YELLOW') return { level: 'yellow', tile: '!!', title: 'Double yellow', sub, ms: 6000 };
  // Red / SC / VSC arrive through track status as well; avoid doubles.
  if (m.Flag === 'RED' || m.Category === 'SafetyCar') return null;

  // Session control: delays, suspensions, restarts, start procedures.
  if (/DELAYED START|START (IS |WILL BE )?DELAYED|\bDELAYED\b/i.test(text)) return { level: 'yellow', tile: 'DLY', title: 'Start delayed', sub, ms: 9000 };
  if (/SUSPENDED/i.test(text)) return { level: 'red', tile: '', title: 'Session suspended', sub, ms: 9000 };
  // Start procedures first: "WILL START BEHIND THE SAFETY CAR" isn't a restart.
  if (/FORMATION LAP|STANDING START|ROLLING START|START BEHIND THE SAFETY CAR/i.test(text)) return { level: 'info', tile: 'LAP', title: 'Start procedure', sub, ms: 8000 };
  if (/WILL (RE)?START|WILL RESUME|RESUMPTION|\bRESUME/i.test(text)) return { level: 'green', tile: 'GO', title: 'Restart', sub, ms: 8000 };
  if (/WET (RACE|SESSION|TRACK)|DECLARED WET/i.test(text)) return { level: 'info', tile: 'RAIN', title: 'Wet conditions', sub, ms: 8000 };

  if (/PENALTY/i.test(text)) return { level: 'info', tile: 'PEN', title: 'Penalty', sub, ms: 8000 };
  if (/UNDER INVESTIGATION|WILL BE INVESTIGATED/i.test(text)) return { level: 'info', tile: 'INV', title: 'Under investigation', sub, ms: 7000 };
  if (/NO FURTHER (ACTION|INVESTIGATION)/i.test(text)) return { level: 'info', tile: 'FIA', title: 'Stewards', sub, ms: 6000 };
  if (/RAIN/i.test(text) && !IGNORE.test(text)) return { level: 'info', tile: 'RAIN', title: 'Weather', sub, ms: 7000 };
  return null;
}

function fromSessionStatus(status, sessionName) {
  if (status === 'Started') return { level: 'green', tile: '', title: `${sessionName || 'Session'} underway`, sub: 'Green light', ms: 6000 };
  if (status === 'Aborted') return { level: 'red', tile: '', title: 'Session suspended', sub: sessionName || '', ms: 8000 };
  return null;
}

// "Preview alerts": one of each kind.
const DEMO = [
  { level: 'green', tile: '', title: 'Sprint underway', sub: 'Green light', ms: 4000 },
  { level: 'yellow', tile: '!!', title: 'Double yellow', sub: 'DOUBLE YELLOW IN TRACK SECTOR 7', ms: 4000 },
  { level: 'vsc', tile: 'VSC', title: 'Virtual Safety Car', sub: 'VSC deployed', ms: 4000 },
  { level: 'sc', tile: 'SC', title: 'Safety Car', sub: 'Safety Car deployed', ms: 4000 },
  { level: 'red', tile: '', title: 'Red flag', sub: 'Session suspended', ms: 4000 },
  { level: 'info', tile: 'PEN', title: 'Penalty', sub: 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 44 (HAM) - CAUSING A COLLISION', ms: 5000 },
  { level: 'chequered', tile: '', title: 'Chequered flag', sub: 'Session over', ms: 4000 },
];

module.exports = { fromTrack, fromMessage, fromSessionStatus, TRACK, DEMO };
