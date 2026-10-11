const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TEAM_COLORS = {
  red_bull: '#3671C6',
  ferrari: '#E8002D',
  mercedes: '#27F4D2',
  mclaren: '#FF8000',
  aston_martin: '#229971',
  alpine: '#00A1E8',
  williams: '#64C4FF',
  rb: '#6692FF',
  sauber: '#52E252',
  audi: '#F50537',
  haas: '#B6BABD',
  cadillac: '#C8A45A',
};

const SNAPSHOT_EVERY = 5 * 60e3;
const PEEK_MS = 7000;
const HEADS_UP_MS = 5 * 60e3;
// In auto-hide mode, the pointer must rest this long before the island opens,
// so sweeping past it (e.g. to browser tabs) doesn't trigger it.
const REVEAL_DELAY = 200;
const DRAG_THRESHOLD = 4;

const zone = $('zone');
const island = $('island');
const expandedEl = $('expanded');

let settings = { autoHide: false };
let snap = null;
let liveData = null;
let hovering = false;
// pinned: sticky (click the island, or "Keep open" in its menu).
// summoned: temporary (hotkey / tray); ends when the mouse leaves the island.
let pinned = new URLSearchParams(location.search).has('pinned');
let summoned = false;
let summonSeen = false; // the mouse has been on the island since it was summoned
let peekUntil = 0;
// Double expanded (analysis) view. While it's open the window is enlarged;
// bigGeom holds that geometry until the window is restored.
let bigOpen = false;
let bigGeom = null;
let bigExitTimer = null;
const BIG_ANIM_MS = 480;
// Pages of the expanded island. Each open starts on the Weekend page.
const PAGES = [
  ['weekend', 'Weekend'],
  ['standings', 'Standings'],
  ['title', 'Title'],
  ['circuit', 'Circuit'],
  ['news', 'News'],
];
// --page=<id> (debug) opens straight on that page.
const debugPage = new URLSearchParams(location.search).get('page');
let page = debugPage || 'weekend';
let wasOpen = !!debugPage;
const NEWS_TTL = 15 * 60e3;
const news = { items: null, at: 0, loading: false, error: null, open: -1 };
// Track outline for the Circuit page, per weekend (keyed by round).
const track = { round: null, points: null, loading: false };
let lastStateKey = null;
let headsUpFor = null;
// Track status codes from live timing that stay on the pill while in force.
const TRACK_FLAGS = { 2: ['yellow', 'YEL'], 4: ['sc', 'SC'], 5: ['red', 'RED'], 6: ['vsc', 'VSC'], 7: ['vsc', 'VSC'] };
// Alerts pop out of the island one at a time.
const alertQueue = [];
let currentAlert = null;
const MAX_QUEUE = 8;
const FLAG_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 21V4m0 1h11l-2.5 4L17 13H6" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

// ---------- formatting ----------

const pad = (n) => String(n).padStart(2, '0');

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtWhen = (iso) => `${dayFmt.format(new Date(iso))} ${timeFmt.format(new Date(iso))}`;

const shortName = (name) => name.replace(/Grand Prix/i, 'GP');

// ---------- state ----------

// The session live timing says is running, which wins over the schedule:
// delays and red flags push sessions past their scheduled end. "Inactive"
// only counts once the scheduled start has passed (a delayed start).
function feedSession(w, now) {
  if (!liveData?.session) return null;
  const s = w.sessions.find((x) => x.name === liveData.session);
  if (!s) return null;
  if (liveData.status === 'Started' || liveData.status === 'Aborted') return s;
  if (liveData.status === 'Inactive' && now >= Date.parse(s.start)) return s;
  return null;
}

function computeState(now) {
  const w = snap?.weekend;
  if (!w) return { kind: snap?.error ? 'error' : 'none' };
  const fromFeed = feedSession(w, now);
  if (fromFeed) return { kind: 'live', session: fromFeed };
  const live = w.sessions.find((s) => now >= Date.parse(s.start) && now < Date.parse(s.end));
  if (live) return { kind: 'live', session: live };
  const next = w.sessions.find((s) => Date.parse(s.start) > now);
  if (next) return { kind: 'next', session: next };
  return { kind: 'finished' };
}

const stateKey = (st) => `${st.kind}:${st.session?.start ?? ''}`;

function sessionStatus(s, now) {
  const w = snap?.weekend;
  const fromFeed = w && feedSession(w, now);
  if (fromFeed) {
    if (fromFeed.start === s.start) return 'live';
    return Date.parse(s.start) < Date.parse(fromFeed.start) ? 'done' : 'upcoming';
  }
  if (now >= Date.parse(s.end)) return 'done';
  if (now >= Date.parse(s.start)) return 'live';
  return 'upcoming';
}

// ---------- rendering ----------

// Race control quotes times in track-local time ("WILL START AT 17:15").
// Convert HH:MM on the message's local day to a UTC timestamp.
function trackTimeToUtc(hh, mm, refMs, gmtOffset) {
  const sign = String(gmtOffset || '').startsWith('-') ? -1 : 1;
  const [oh = 0, om = 0] = String(gmtOffset || '0:0').replace('-', '').split(':').map(Number);
  const offset = sign * (oh * 60 + om) * 60e3;
  const local = new Date(refMs + offset);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm) - offset;
  if (t < refMs - 12 * 3600e3) t += 86400e3; // "00:15" announced late in the evening
  return t;
}

// A new start/restart time announced by race control, if any is still ahead.
function announcedStart(now) {
  if (!liveData?.messages) return null;
  for (const m of liveData.messages) {
    const match = /\b(START|RESUME|RESTART|RESUMPTION)\b.*?\bAT (\d{1,2})[:.](\d{2})\b/i.exec(m.message);
    if (!match) continue;
    const target = trackTimeToUtc(Number(match[2]), Number(match[3]), Date.parse(m.utc), liveData.gmtOffset);
    return target > now - 10 * 60e3 ? { target, message: m.message } : null;
  }
  return null;
}

const FLAG_TEXT = { red: 'Red flag', sc: 'Safety Car', vsc: 'Virtual Safety Car', yellow: 'Yellow flag' };

// Sectors currently under yellow, from the latest "… IN TRACK SECTOR n" messages.
function yellowSectors() {
  const bySector = new Map();
  for (const m of [...(liveData?.messages || [])].reverse()) {
    const match = /(DOUBLE YELLOW|YELLOW|CLEAR) IN TRACK SECTOR (\d+)/i.exec(m.message);
    if (match) bySector.set(Number(match[2]), match[1].toUpperCase());
  }
  return [...bySector]
    .filter(([, f]) => f !== 'CLEAR')
    .sort((a, b) => a[0] - b[0])
    .map(([s, f]) => (f === 'DOUBLE YELLOW' ? `${s} (double)` : String(s)));
}

// The flag in force, described for the open island: { level, tile, title, sub }.
function flagStatus(st) {
  const flag = activeFlag(st);
  if (!flag) return null;
  const [level, tile] = flag;
  const title = liveData.track.status === '7' ? 'VSC ending' : FLAG_TEXT[level];
  const parts = [];
  if (level === 'yellow') {
    const sectors = yellowSectors();
    if (sectors.length) parts.push(`${sectors.length > 1 ? 'Sectors' : 'Sector'} ${sectors.join(', ')}`);
  }
  if (liveData.lap) parts.push(`Lap ${liveData.lap}${liveData.totalLaps ? `/${liveData.totalLaps}` : ''}`);
  return { level, tile, title, sub: parts.join(' · ') || 'In force now' };
}

// Flag badge in the big (analysis) view's header.
function updateBigFlag(st) {
  const el = $('bigFlag');
  if (!el) return;
  const f = flagStatus(st);
  el.hidden = !f;
  if (f) {
    el.className = `big-flag ${f.level}`;
    el.innerHTML = `<span class="flag-tag ${f.level}">${esc(f.tile)}</span>${esc(f.title)}`;
  }
}

// Scheduled time has passed but live timing says the session hasn't begun
// (delayed start). Only trusted when the feed is about this session.
function notStarted(st) {
  return st.kind === 'live' && liveData?.session === st.session.name && liveData.status === 'Inactive';
}

// The flag currently in force (from live timing), while a session runs.
function activeFlag(st) {
  if (st.kind !== 'live' || !liveData?.track) return null;
  if (['Finished', 'Finalised', 'Ends'].includes(liveData.status)) return null;
  return TRACK_FLAGS[liveData.track.status] || null;
}

function renderCompact(st, now) {
  const w = snap?.weekend;
  $('cDot').classList.toggle('live', st.kind === 'live');
  $('cLabel').textContent = w ? shortName(w.name) : 'Formula 1';

  const right = $('cRight');
  switch (st.kind) {
    case 'live': {
      if (notStarted(st)) {
        const flag = activeFlag(st);
        const ann = announcedStart(now);
        right.innerHTML =
          (flag ? `<span class="flag-tag ${flag[0]}">${flag[1]}</span>` : '') +
          `${esc(st.session.short)} · <b>${ann ? `Start ${esc(timeFmt.format(new Date(ann.target)))}` : 'Delayed'}</b>`;
        break;
      }
      const leader = liveData?.top?.[0];
      const flag = activeFlag(st);
      const lap = liveData?.lap ? ` · L${liveData.lap}${liveData.totalLaps ? `/${liveData.totalLaps}` : ''}` : '';
      right.innerHTML =
        (flag ? `<span class="flag-tag ${flag[0]}">${flag[1]}</span>` : '<span class="live-tag">LIVE</span> ') +
        esc(st.session.short) +
        lap +
        (leader ? ` · <b>P1 ${esc(leader.code)}</b>` : '');
      break;
    }
    case 'next':
      right.innerHTML = `${esc(st.session.short)} <b>${fmtCountdown(Date.parse(st.session.start) - now)}</b>`;
      break;
    case 'finished': {
      const winner = snap.lastRace?.round === w.round ? snap.lastRace.podium[0] : null;
      right.innerHTML = winner ? `🏁 <b>${esc(winner.code)}</b>` : 'Chequered flag';
      break;
    }
    case 'error':
      right.textContent = 'Offline';
      break;
    default:
      right.textContent = snap ? 'Season complete' : 'Loading…';
  }
}

function heroHtml(st, now) {
  if (notStarted(st)) {
    const ann = announcedStart(now);
    if (ann) {
      return `<section class="hero"><div class="hero-label">New start ${esc(timeFmt.format(new Date(ann.target)))}<strong>${esc(
        st.session.name
      )}</strong></div><div class="hero-time" data-target="${ann.target}">${fmtCountdown(ann.target - now)}</div></section>`;
    }
    const since = Date.parse(st.session.start);
    return `<section class="hero"><div class="hero-label">Start delayed<strong>${esc(st.session.name)}</strong></div>
      <div class="hero-time" data-since="${since}"><small>Delayed by</small> ${fmtCountdown(now - since)}</div></section>`;
  }
  if (st.kind === 'live') {
    const top = liveData?.top?.length
      ? `<div class="live-top">${liveData.top
          .map(
            (d) =>
              `<span><em>P${esc(d.pos)}</em><i class="team" style="--team:${esc(d.color || '')}"></i>${esc(d.code)}</span>`
          )
          .join('')}</div>`
      : `<div class="hero-time" data-tick="elapsed">${fmtCountdown(now - Date.parse(st.session.start))}</div>`;
    const label = liveData?.top?.length
      ? liveData.lap
        ? `Lap ${liveData.lap}${liveData.totalLaps ? ` of ${liveData.totalLaps}` : ''}`
        : 'Live order'
      : 'Running for';
    return `<section class="hero live"><div class="hero-label"><strong>${esc(st.session.name)}</strong>${label}</div>${top}</section>`;
  }
  if (st.kind === 'next') {
    return `<section class="hero"><div class="hero-label">Next up<strong>${esc(st.session.name)}</strong></div>
      <div class="hero-time" data-tick="countdown">${fmtCountdown(Date.parse(st.session.start) - now)}</div></section>`;
  }
  if (st.kind === 'finished') {
    return `<section class="hero"><div class="hero-label">Weekend complete<strong>Chequered flag</strong></div></section>`;
  }
  return '';
}

function rowsHtml(rows, withPoints) {
  return `<ul class="rows">${rows
    .map(
      (r) => `<li><span class="pos">${esc(r.pos)}</span><i class="team" style="--team:${
        esc(r.color || TEAM_COLORS[r.teamId] || '')
      }"></i><span class="code">${esc(r.code)}</span>${withPoints ? `<span class="pts">${esc(r.points)}</span>` : ''}</li>`
    )
    .join('')}</ul>`;
}

function ago(iso) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60e3));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const teamBar = (teamId, color) => `<i class="team" style="--team:${esc(color || TEAM_COLORS[teamId] || '')}"></i>`;

function weekendPage(st, now, w) {
  const sessions = w.sessions
    .map((s) => {
      const status = sessionStatus(s, now);
      const isNext = st.kind === 'next' && st.session.start === s.start;
      return `<li class="${status}${isNext ? ' next' : ''}"><div class="s-short">${esc(s.short)}</div><div class="s-when">${
        status === 'live' ? (st.session?.start === s.start && notStarted(st) ? 'DELAYED' : 'LIVE') : esc(fmtWhen(s.start))
      }</div></li>`;
    })
    .join('');

  // Shortcut to the analysis of the latest finished session (this weekend, else the latest anywhere).
  const done = w.sessions.filter((s) => sessionStatus(s, now) === 'done').at(-1);
  const analysisBtn = `<button class="analysis-btn" data-start="${done ? esc(done.start) : ''}">${
    done ? `${esc(done.name)} analysis` : 'Session analysis'
  } <span>›</span></button>`;

  const last = snap.lastRace;
  const cols =
    last || snap.standings.length
      ? `<div class="cols">
          <section><h2>${last ? esc(shortName(last.name)) : 'Last race'}</h2>${last ? rowsHtml(last.podium, false) : ''}</section>
          <section><h2>Drivers’ standings</h2>${rowsHtml(snap.standings.slice(0, 5), true)}</section>
        </div>`
      : '';

  // During a session, race control is more useful than last race / standings.
  const live = liveFeed() ? rcList(liveFeed().filter((m) => !QUIET_MESSAGE.test(m.message)).slice(0, 3), 'rc-mini') : '';
  const below = live
    ? `<div class="cols rc-cols"><section><h2>Race control <button class="rc-more" data-page="control">All ›</button></h2>${live}</section></div>`
    : cols;

  return `${heroHtml(st, now)}<ul class="sessions">${sessions}</ul>${analysisBtn}${below}`;
}

// ---------- race control (live) ----------

// "CLEAR IN TRACK SECTOR 5" and lap-time deletions are noise in the short list.
const QUIET_MESSAGE = /^CLEAR IN TRACK SECTOR|\bDELETED\b/i;

// Race control messages while connected to a session, newest first.
const liveFeed = () => (liveData?.messages?.length ? liveData.messages : null);

function rcClass(m) {
  const f = (m.flag || '').toUpperCase();
  if (f === 'RED') return 'red';
  if (f.includes('YELLOW')) return 'yellow';
  if (f === 'GREEN' || f === 'CLEAR') return 'green';
  if (f === 'CHEQUERED') return 'chequered';
  if (f === 'BLUE') return 'info';
  if (m.category === 'SafetyCar') return 'sc';
  return 'plain';
}

function rcList(messages, cls) {
  return `<ul class="rc-list ${cls}">${messages
    .map(
      (m) => `<li><time>${esc(timeFmt.format(new Date(m.utc)))}</time><i class="rc-dot ${rcClass(m)}"></i><span>${esc(m.message)}</span></li>`
    )
    .join('')}</ul>`;
}

// ---------- title fight ----------

// A contender the simulation never saw win is still "<1%", not 0%.
function fmtChance(c, contender) {
  if (c <= 0) return contender ? '<1%' : '0%';
  if (c < 0.01) return '<1%';
  if (c > 0.995) return '>99%';
  return `${Math.round(c * 100)}%`;
}

function titleRows(rows, label) {
  return `<ul class="title-rows">${rows
    .map(
      (r) => `<li>
        ${teamBar(r.teamId, r.color)}<span class="who">${esc(label(r))}</span>
        <span class="pts">${esc(r.points)}</span>
        <span class="gap">${r.gap ? `−${esc(r.gap)}` : ''}</span>
        <span class="chance-bar"><i style="width:${(r.chance * 100).toFixed(1)}%;--team:${esc(r.color || TEAM_COLORS[r.teamId] || '')}"></i></span>
        <span class="pct">${fmtChance(r.chance, r.contender)}</span>
      </li>`
    )
    .join('')}</ul>`;
}

function clinchLine(t, rows, clinch, noun) {
  const leader = rows[0];
  if (!leader) return '';
  if (clinch?.decided || !(t.races + t.sprints)) return `<p class="title-note"><b>${esc(noun(leader))}</b> ${clinch?.decided ? 'has won the title.' : 'wins the title.'}</p>`;
  if (!clinch) return '';
  return `<p class="title-note"><b>${esc(noun(leader))}</b> can clinch at the <b>${esc(clinch.event.name)}</b> at the earliest: it needs a lead of more than ${esc(clinch.lead)} points after it.</p>`;
}

function titlePage() {
  const t = snap.title;
  if (!t) return '<div class="message page-body">Title fight unavailable right now.</div>';
  const left = [t.races && `${t.races} race${t.races > 1 ? 's' : ''}`, t.sprints && `${t.sprints} Sprint${t.sprints > 1 ? 's' : ''}`]
    .filter(Boolean)
    .join(' + ');
  const drivers = t.drivers.filter((d) => d.contender);
  const teams = t.teams.filter((d) => d.contender);
  const firstOut = t.drivers.find((d) => !d.contender);
  return `<div class="page-body title-page">
    <div class="standings-note">${left ? `${esc(left)} left · ${t.pointsLeft} points available` : 'Season complete'}${
      snap.standingsNote ? ` · ${esc(snap.standingsNote)}` : ''
    }</div>
    <h2>Drivers' title</h2>
    ${titleRows(drivers, (d) => d.code)}
    ${firstOut && left ? `<p class="title-note muted">${esc(firstOut.code)} and those behind can no longer win.</p>` : ''}
    ${clinchLine(t, drivers, t.clinch, (d) => d.code)}
    <h2 class="spaced">Constructors' title</h2>
    ${titleRows(teams, (d) => d.name)}
    ${t.runs ? `<p class="title-note muted small">Chances are an estimate from recent form (${t.runs.toLocaleString()} simulated seasons). Upgrades, penalties and weather aren't known to it.</p>` : ''}
  </div>`;
}

function controlPage() {
  const feed = liveFeed();
  if (!feed) return '<div class="message page-body">Race control messages appear here during a session.</div>';
  return `<div class="page-body">${rcList(feed, 'rc-full')}</div>`;
}

function standingsPage() {
  const leader = Number(snap.standings[0]?.points) || 0;
  const drivers = `<ul class="rows">${snap.standings
    .map(
      (r) => `<li><span class="pos">${esc(r.pos)}</span>${teamBar(r.teamId, r.color)}<span class="code">${esc(r.code)}</span>
        <span class="pts">${esc(r.points)}</span><span class="gap">${
          Number(r.pos) === 1 ? '' : `−${leader - Number(r.points)}`
        }</span></li>`
    )
    .join('')}</ul>`;
  const teams = `<ul class="rows">${snap.constructors
    .slice(0, 10)
    .map(
      (r) => `<li><span class="pos">${esc(r.pos)}</span>${teamBar(r.teamId, r.color)}<span class="name">${esc(r.name)}</span>
        <span class="pts">${esc(r.points)}</span></li>`
    )
    .join('')}</ul>`;
  if (!snap.standings.length && !snap.constructors.length) return '<div class="message">Standings unavailable.</div>';
  const note = snap.standingsNote ? `<div class="standings-note">${esc(snap.standingsNote)}</div>` : '';
  return `<div class="page-body">${note}<div class="cols"><section><h2>Drivers</h2>${drivers}</section><section><h2>Constructors</h2>${teams}</section></div></div>`;
}

function loadTrackMap(round) {
  if (track.loading || track.round === round) return;
  track.loading = true;
  window.f1
    .trackMap()
    .then((m) => {
      track.points = m?.points || null;
    })
    .catch(() => {
      track.points = null;
    })
    .finally(() => {
      track.round = round;
      track.loading = false;
      dirty = true;
      frame();
    });
}

function circuitPage() {
  const c = snap.circuit;
  loadTrackMap(snap.weekend.round);
  const map = track.points ? `<div class="circuit-map">${window.TrackMap.outline(track.points, 396, 128, { pad: 8, stroke: 5 })}</div>` : '';
  if (!c || (!c.last && !c.winners.length)) {
    return `<div class="page-body">${map}<div class="message">No previous races at this circuit.</div></div>`;
  }
  const fact = (label, entry, value) =>
    entry ? `<li><span class="label">${label}</span>${teamBar(entry.teamId)}<span class="code">${esc(entry.code)}</span><span class="val">${value}</span></li>` : '';
  const l = c.last;
  const lastHtml = l
    ? `<div class="cols">
        <section><h2>Last time here · ${esc(l.season)}</h2><ul class="facts">
          ${fact('Pole', l.pole, esc(l.pole?.time ?? ''))}
          ${fact('Winner', l.podium[0], esc(l.winnerTime ?? ''))}
          ${fact('Fastest lap', l.fastestLap, l.fastestLap ? `${esc(l.fastestLap.time)} <small>L${esc(l.fastestLap.lap)}</small>` : '')}
          <li><span class="label">Race laps</span><span class="val">${esc(l.laps)}</span></li>
        </ul></section>
        <section><h2>Podium</h2>${rowsHtml(l.podium, false)}</section>
      </div>`
    : '';
  const winners = c.winners.length
    ? `<h2 class="spaced">Recent winners</h2><div class="winners">${c.winners
        .map((x) => `<span><small>${esc(x.season)}</small>${teamBar(x.teamId)}<b>${esc(x.code)}</b></span>`)
        .join('')}</div>`
    : '';
  return `<div class="page-body">${map}${lastHtml}${winners}</div>`;
}

function loadNews() {
  if (news.loading) return;
  news.loading = true;
  window.f1
    .news()
    .then((items) => {
      news.items = items;
      news.error = null;
      news.at = Date.now();
    })
    .catch((err) => {
      news.error = err.message;
    })
    .finally(() => {
      news.loading = false;
      dirty = true;
      frame();
    });
}

function newsPage() {
  if (!news.items || Date.now() - news.at > NEWS_TTL) loadNews();
  if (!news.items) {
    return `<div class="message page-body">${news.error ? esc(news.error) : 'Loading headlines…'}</div>`;
  }
  return `<ul class="news-list page-body">${news.items
    .map((n, i) => {
      const open = news.open === i;
      return `<li class="${open ? 'open' : ''}">
        <button class="news-head" data-news="${i}">
          <div class="n-meta"><b>${esc(n.source)}</b> · ${esc(ago(n.date))}</div>
          <div class="n-title">${esc(n.title)}</div>
        </button>
        ${
          open
            ? `${n.summary ? `<p class="n-summary">${esc(n.summary)}</p>` : ''}<button class="news-open" data-news-open="${i}">Read on ${esc(
                n.source
              )} ↗</button>`
            : ''
        }
      </li>`;
    })
    .join('')}</ul>`;
}

const flagTile = (a, cls = 'flag-tile') =>
  `<span class="${cls} ${esc(a.level)}">${a.tile ? esc(a.tile) : a.level === 'chequered' ? '' : FLAG_ICON}</span>`;

const alertBanner = (a) =>
  `<div class="alert-banner ${esc(a.level)}">${flagTile(a, 'flag-tile small')}<div><b>${esc(a.title)}</b><span>${esc(a.sub)}</span></div></div>`;

function renderAlertView() {
  const a = currentAlert;
  if (!a) return;
  $('alertView').innerHTML = `${flagTile(a)}<div class="a-text"><div class="a-title">${esc(a.title)}</div><div class="a-sub">${esc(
    a.sub
  )}</div></div>`;
  island.dataset.level = a.level;
}

function queueAlert(a) {
  alertQueue.push(a);
  // Under a flood of messages, keep the important ones.
  while (alertQueue.length > MAX_QUEUE) {
    const i = alertQueue.findIndex((x) => x.level === 'info');
    alertQueue.splice(i >= 0 ? i : 0, 1);
  }
  if (!currentAlert) nextAlert();
}

function nextAlert() {
  currentAlert = alertQueue.shift() || null;
  dirty = true;
  if (!currentAlert) {
    delete island.dataset.level;
    frame();
    return;
  }
  renderAlertView();
  frame();
  setTimeout(() => {
    currentAlert = null;
    dirty = true;
    frame();
    // Let the island settle between alerts.
    setTimeout(nextAlert, 450);
  }, currentAlert.ms || 6000);
}

function renderExpanded(st, now) {
  const w = snap?.weekend;
  if (!w) {
    expandedEl.innerHTML = `<div class="eyebrow">Formula 1</div><h1>${
      st.kind === 'error' ? 'Can’t reach F1 data' : snap ? 'Season complete' : 'Loading…'
    }</h1><div class="message">${esc(snap?.error || 'See you next season.')}</div>`;
    return;
  }

  // A Race control page joins the switcher while connected to a session.
  const pages = liveFeed() ? [...PAGES, ['control', 'Control']] : PAGES;
  // Keep a chosen Control page across feed hiccups; show Weekend meanwhile.
  const shown = page === 'control' && !liveFeed() ? 'weekend' : page;
  const nav = `<nav class="pages">${pages
    .map(([id, label]) => `<button data-page="${id}" class="${shown === id ? 'active' : ''}">${label}</button>`)
    .join('')}</nav>`;

  const body =
    shown === 'control'
      ? controlPage()
      : page === 'standings'
      ? standingsPage()
      : page === 'title'
      ? titlePage()
      : page === 'circuit'
        ? circuitPage()
        : page === 'news'
          ? newsPage()
          : weekendPage(st, now, w);

  // Keep the news list's scroll position across re-renders.
  const scroller = expandedEl.querySelector('.news-list, .rc-full');
  const scrollTop = scroller ? scroller.scrollTop : 0;

  expandedEl.innerHTML = `
    <button class="menu-btn" title="Settings">⋯</button>
    <div class="eyebrow">Round ${esc(w.round)} · ${esc(w.season)}</div>
    <h1>${esc(w.name)}</h1>
    <div class="sub">${esc(w.circuit)} · ${esc(w.country)}</div>
    ${currentAlert ? alertBanner(currentAlert) : flagStatus(st) ? alertBanner(flagStatus(st)) : ''}
    ${nav}
    ${body}`;

  const newScroller = expandedEl.querySelector('.news-list, .rc-full');
  if (newScroller) newScroller.scrollTop = scrollTop;
}

function tickExpanded(st, now) {
  // Countdown to an announced time, or time elapsed since one.
  const target = expandedEl.querySelector('[data-target]');
  if (target) target.textContent = fmtCountdown(Number(target.dataset.target) - now);
  const since = expandedEl.querySelector('[data-since]');
  if (since) since.innerHTML = `<small>Delayed by</small> ${fmtCountdown(now - Number(since.dataset.since))}`;

  const el = expandedEl.querySelector('[data-tick]');
  if (!el || !st.session) return;
  el.textContent =
    el.dataset.tick === 'countdown'
      ? fmtCountdown(Date.parse(st.session.start) - now)
      : fmtCountdown(now - Date.parse(st.session.start));
}

function layout(now) {
  const open = pinned || summoned || hovering || now < peekUntil;
  if (open && !wasOpen && page !== 'weekend') {
    page = 'weekend';
    news.open = -1;
    renderExpanded(computeState(now), now);
  }
  wasOpen = open;
  if (!open) bigOpen = false; // collapsing closes the analysis view too
  const big = open && bigOpen;
  const alerting = !open && !!currentAlert;
  const hidden = !open && !alerting && settings.autoHide;
  island.classList.toggle('alert', alerting);
  const flag = activeFlag(computeState(now));
  if (flag) island.dataset.track = flag[0];
  else delete island.dataset.track;
  island.classList.toggle('big', big);
  island.classList.toggle('expanded', open && !big);
  island.classList.toggle('hidden', hidden);
  island.classList.toggle('pinned', pinned);
  zone.classList.toggle('autohide', hidden);
  island.style.height = big ? `${bigGeom.height - bigGeom.edge - 16}px` : open ? `${expandedEl.offsetHeight}px` : '';

  // Leaving big mode: shrink back towards the island's spot, then restore the window.
  if (!big && bigGeom) {
    zone.style.left = `${bigGeom.anchorX}px`;
    if (!bigExitTimer) bigExitTimer = setTimeout(finishBigExit, BIG_ANIM_MS);
  }
}

// Jump without animating (used when the window is resized under the island).
function placeZone(left) {
  zone.style.transition = 'none';
  zone.style.left = left;
  void zone.offsetWidth;
  zone.style.transition = '';
}

async function openBig(start) {
  clearTimeout(bigExitTimer);
  bigExitTimer = null;
  if (!bigGeom) {
    bigGeom = await window.f1.setBig(true);
    // The window grew around the island: keep it in place, then grow to the centre.
    placeZone(`${bigGeom.anchorX}px`);
    island.style.setProperty('--big-w', `${bigGeom.width - 40}px`);
  }
  bigOpen = true;
  zone.style.left = '50%';
  layout(Date.now());
  window.AnalysisView.show(start);
}

// Back from the analysis view: the island shrinks away from the cursor, so
// keep it open (summoned) until the mouse comes back onto it and leaves again.
function closeBig() {
  bigOpen = false;
  summon();
  clearTimeout(leaveTimer);
  hovering = false;
  window.f1.setInteractive(false);
  window.f1.rehover(); // re-sends "enter" if the cursor is still on the island
  layout(Date.now());
}

function summon() {
  summoned = true;
  summonSeen = false;
}

async function finishBigExit() {
  bigExitTimer = null;
  if (bigOpen || !bigGeom) return;
  bigGeom = null;
  await window.f1.setBig(false);
  placeZone('');
  reportRect();
}

let dirty = true;
let lastWasLive = false;
function frame() {
  const now = Date.now();
  const st = computeState(now);
  const key = stateKey(st);

  if (key !== lastStateKey) {
    // A session just went live: peek so the change is noticed.
    if (lastStateKey && st.kind === 'live') peekUntil = now + PEEK_MS;
    lastStateKey = key;
    dirty = true;
    // Results/standings change after a session ends.
    if (lastWasLive && st.kind !== 'live') setTimeout(refreshSnapshot, 60e3);
    lastWasLive = st.kind === 'live';
  }

  // Heads-up peek shortly before a session starts.
  if (st.kind === 'next' && Date.parse(st.session.start) - now <= HEADS_UP_MS && headsUpFor !== st.session.start) {
    headsUpFor = st.session.start;
    peekUntil = now + PEEK_MS;
  }

  renderCompact(st, now);
  updateBigFlag(st);
  if (dirty) {
    renderExpanded(st, now);
    dirty = false;
  } else {
    tickExpanded(st, now);
  }
  layout(now);
}

// ---------- data ----------

async function refreshSnapshot() {
  try {
    snap = await window.f1.snapshot();
  } catch (err) {
    snap = { weekend: null, lastRace: null, standings: [], error: String(err.message || err) };
  }
  dirty = true;
  frame();
}

window.f1.onLiveState((s) => {
  liveData = s;
  dirty = true;
});
window.f1.onAlert(queueAlert);

// ---------- interaction ----------

let leaveTimer = null;
let revealTimer = null;
let press = null;
let dragging = false;

function reveal() {
  hovering = true;
  summonSeen = true;
  window.f1.setInteractive(true);
  layout(Date.now());
}

// Hover (reported by the main process). Until the window turns interactive it
// is click-through, so a delayed reveal in auto-hide mode never steals clicks
// from the app underneath.
function onEnter() {
  clearTimeout(leaveTimer);
  if (hovering || !island.classList.contains('hidden')) reveal();
  else revealTimer = setTimeout(reveal, REVEAL_DELAY);
}
function onLeave() {
  if (dragging) return;
  clearTimeout(revealTimer);
  window.f1.setInteractive(false);
  leaveTimer = setTimeout(() => {
    hovering = false;
    if (summonSeen) summoned = false;
    layout(Date.now());
  }, 250);
}
window.f1.onHover((inside) => (inside ? onEnter() : onLeave()));

// Keep the main process's copy of the hover area in sync as the island resizes.
function reportRect() {
  const r = zone.getBoundingClientRect();
  window.f1.setRect({ x: r.x, y: r.y, width: r.width, height: r.height });
}
new ResizeObserver(reportRect).observe(zone);
zone.addEventListener('transitionend', reportRect); // position changes don't resize
reportRect();

// Press-and-drag moves the island; a press without movement toggles pinning.
zone.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !hovering || e.target.closest('button, .news-list, .rc-full')) return;
  // In the analysis view only the header drags; the rest is for reading/clicking.
  if (bigOpen && !e.target.closest('.big-head')) return;
  press = { x: e.screenX, y: e.screenY };
  zone.setPointerCapture(e.pointerId);
});
zone.addEventListener('pointermove', (e) => {
  if (!press || dragging) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > DRAG_THRESHOLD) {
    dragging = true;
    zone.classList.add('dragging');
    window.f1.dragStart();
  }
});

function release(isClick) {
  if (!press) return;
  const wasDragging = dragging;
  press = null;
  dragging = false;
  zone.classList.remove('dragging');
  if (wasDragging) {
    window.f1.dragEnd();
  } else if (isClick && !bigOpen) {
    setPinned(!pinned);
  }
}
zone.addEventListener('pointerup', () => release(true));
zone.addEventListener('lostpointercapture', () => release(false));

// Settings menu: right-click anywhere on the island, or the ⋯ button.
zone.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.f1.openMenu();
});
expandedEl.addEventListener('click', (e) => {
  if (e.target.closest('.menu-btn')) window.f1.openMenu();
  const analysis = e.target.closest('.analysis-btn');
  if (analysis) openBig(analysis.dataset.start || undefined);
  const pageBtn = e.target.closest('[data-page]');
  if (pageBtn && pageBtn.dataset.page !== page) {
    page = pageBtn.dataset.page;
    news.open = -1;
    dirty = true;
    frame();
  }
  const head = e.target.closest('[data-news]');
  if (head) {
    const i = Number(head.dataset.news);
    news.open = news.open === i ? -1 : i;
    dirty = true;
    frame();
  }
  const read = e.target.closest('[data-news-open]');
  if (read) window.f1.openArticle(news.items[Number(read.dataset.newsOpen)]?.link);
});
$('bigBack').addEventListener('click', closeBig);

function setPinned(on) {
  pinned = on;
  window.f1.reportPinned(pinned);
  layout(Date.now());
}

// Global hotkey / tray click: open temporarily, or close whatever is open.
function toggle() {
  const now = Date.now();
  if (pinned || summoned || now < peekUntil) {
    summoned = false;
    peekUntil = 0;
    if (pinned) setPinned(false);
  } else {
    summon();
  }
  layout(now);
}

window.f1.onToggle(toggle);
// The big island was dragged: the small island's spot moved with it.
window.f1.onBigAnchor((x) => {
  if (bigGeom) bigGeom.anchorX = x;
});
// Menu / tray "Session analysis": open the island straight into the big view.
window.f1.onBig(() => {
  if (!(pinned || hovering)) summon();
  openBig();
});
window.f1.onSetPinned(setPinned);
window.f1.reportPinned(pinned);
window.f1.onRefresh(refreshSnapshot);
window.f1.onSettings((s) => {
  settings = s;
  layout(Date.now());
});
window.f1.settings().then((s) => {
  settings = s;
  layout(Date.now());
});

refreshSnapshot().then(() => {
  const params = new URLSearchParams(location.search);
  if (params.has('big')) openBig(params.get('start') || undefined);
});
setInterval(refreshSnapshot, SNAPSHOT_EVERY);
setInterval(frame, 1000);
