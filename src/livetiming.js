// Client for F1's live timing feed (SignalR Core over WebSocket). The topics
// used here work without an F1TV account. Emits:
//   'state'  summary of the running session (or null when disconnected)
//   'track'  track status change { status, message, prev }
//   'rc'     a new race control message
//   'status' session status change ('Started', 'Finished', ...)

const { EventEmitter } = require('events');

const BASE = 'https://livetiming.formula1.com/signalrcore';
const TOPICS = [
  'Heartbeat',
  'SessionInfo',
  'SessionStatus',
  'TrackStatus',
  'RaceControlMessages',
  'TimingData',
  'TimingAppData', // tyres per stint
  'DriverList',
  'LapCount',
  'ExtrapolatedClock',
];
const RS = '\x1e'; // SignalR record separator
const PING_MS = 15e3;

// Merge a feed delta into the stored state. Deltas address array items by
// index keys ({"3": {...}}), so arrays are patched in place too.
function merge(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' ? target : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '_kf' || k === '_deleted') continue;
    const key = Array.isArray(out) ? Number(k) : k;
    out[key] = merge(out[key], v);
  }
  return out;
}

const messageKey = (m) => `${m.Utc}|${m.Message}`;

class LiveTiming extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.wanted = false;
    this.state = {};
    this.seen = new Set();
    this.retries = 0;
    this.stateTimer = null;
  }

  get running() {
    return this.wanted;
  }

  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.retries = 0;
    this.connect();
  }

  stop() {
    if (!this.wanted) return;
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.teardown();
    this.state = {};
    this.emit('state', null);
  }

  teardown() {
    clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {}
    }
    this.ws = null;
  }

  async connect() {
    try {
      const neg = await fetch(`${BASE}/negotiate?negotiateVersion=1`, { method: 'POST', signal: AbortSignal.timeout(10000) });
      if (!neg.ok) throw new Error(`negotiate ${neg.status}`);
      // The load balancer needs its cookie on the socket too.
      const cookie = (neg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
      const { connectionToken } = await neg.json();
      if (!this.wanted) return;

      const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}?id=${encodeURIComponent(connectionToken)}`, {
        headers: cookie ? { Cookie: cookie } : {},
      });
      this.ws = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
        ws.send(JSON.stringify({ type: 1, invocationId: 'sub', target: 'Subscribe', arguments: [TOPICS] }) + RS);
        this.pingTimer = setInterval(() => ws.send(JSON.stringify({ type: 6 }) + RS), PING_MS);
      };
      ws.onmessage = (e) => {
        for (const part of String(e.data).split(RS)) {
          if (part) this.handle(JSON.parse(part));
        }
      };
      ws.onclose = () => this.reconnect();
      ws.onerror = () => {}; // onclose follows
    } catch {
      this.reconnect();
    }
  }

  reconnect() {
    this.teardown();
    if (!this.wanted) return;
    const delay = Math.min(60e3, 2000 * 2 ** this.retries++);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  handle(msg) {
    if (msg.type === 3 && msg.invocationId === 'sub') {
      // Snapshot of every topic. Existing race control messages are history,
      // not alerts.
      this.retries = 0;
      const prevTrack = this.state.TrackStatus?.Status;
      this.state = msg.result || {};
      for (const m of this.messages()) this.seen.add(messageKey(m));
      const track = this.state.TrackStatus;
      if (prevTrack && track && track.Status !== prevTrack) this.emit('track', { status: track.Status, message: track.Message, prev: prevTrack });
      this.scheduleState();
    } else if (msg.type === 1 && Array.isArray(msg.arguments)) {
      const [topic, data] = msg.arguments;
      if (typeof topic === 'string') this.apply(topic, data);
    } else if (msg.type === 7) {
      this.reconnect(); // server closed the connection
    }
  }

  messages() {
    const raw = this.state.RaceControlMessages?.Messages;
    return Array.isArray(raw) ? raw : Object.values(raw || {});
  }

  apply(topic, data) {
    if (topic === 'TrackStatus') {
      const prev = this.state.TrackStatus?.Status;
      this.state.TrackStatus = merge(this.state.TrackStatus, data);
      const { Status, Message } = this.state.TrackStatus;
      if (Status !== prev) this.emit('track', { status: Status, message: Message, prev });
    } else if (topic === 'SessionStatus') {
      const prev = this.state.SessionStatus?.Status;
      this.state.SessionStatus = merge(this.state.SessionStatus, data);
      if (this.state.SessionStatus.Status !== prev) this.emit('status', this.state.SessionStatus.Status);
    } else if (topic === 'RaceControlMessages') {
      this.state.RaceControlMessages = merge(this.state.RaceControlMessages, data);
      for (const m of this.messages()) {
        const key = messageKey(m);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.emit('rc', m);
      }
    } else {
      this.state[topic] = merge(this.state[topic], data);
    }
    this.scheduleState();
  }

  // Coalesce bursts of updates into one summary per second.
  scheduleState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.emit('state', this.summary());
    }, 1000);
  }

  // Full running order for the timing tower. Races report gap to the leader
  // and interval to the car ahead; practice and qualifying report the gap to
  // the fastest lap instead.
  order() {
    const s = this.state;
    const drivers = s.DriverList || {};
    const tyres = s.TimingAppData?.Lines || {};
    const race = s.SessionInfo?.Type === 'Race';
    const value = (v) => (v && typeof v === 'object' ? v.Value : v) || null;
    // Arrays can arrive as index-keyed objects when built from deltas.
    const list = (v) => (Array.isArray(v) ? v : Object.entries(v || {}).sort((a, b) => a[0] - b[0]).map(([, x]) => x));
    // A timed value with the timing screens' colour flags (purple / green).
    const timed = (v) =>
      v && typeof v === 'object'
        ? { value: v.Value || null, pb: !!v.PersonalFastest, overall: !!v.OverallFastest }
        : { value: v || null, pb: false, overall: false };
    // Sectors of the lap in progress fill in as they're completed; until then
    // show the previous lap's time, marked as such.
    const sector = (v) => {
      const t = timed(v);
      return t.value ? t : { value: v?.PreviousValue || null, pb: false, overall: false, previous: !!v?.PreviousValue };
    };
    return Object.entries(s.TimingData?.Lines || {})
      .map(([num, l]) => {
        const stint = list(tyres[num]?.Stints).at(-1);
        const best = value(l.BestLapTime) || list(l.BestLapTimes).map(value).filter(Boolean).at(-1) || null;
        return {
          pos: Number(l.Position),
          num,
          code: drivers[num]?.Tla || `#${num}`,
          color: drivers[num]?.TeamColour ? `#${drivers[num].TeamColour}` : null,
          gap: value(race ? l.GapToLeader : l.TimeDiffToFastest),
          interval: value(race ? l.IntervalToPositionAhead : l.TimeDiffToPositionAhead),
          best,
          last: value(l.LastLapTime),
          lastLap: timed(l.LastLapTime),
          sectors: [0, 1, 2].map((i) => sector(list(l.Sectors)[i])),
          laps: l.NumberOfLaps ?? null,
          pits: l.NumberOfPitStops ?? 0,
          inPit: !!l.InPit,
          pitOut: !!l.PitOut,
          out: !!(l.Retired || l.Stopped),
          knockedOut: !!l.KnockedOut,
          tyre: stint?.Compound ? { compound: stint.Compound, laps: stint.TotalLaps ?? null, fresh: String(stint.New) === 'true' } : null,
        };
      })
      .filter((r) => r.pos > 0)
      .sort((a, b) => a.pos - b.pos);
  }

  summary() {
    const s = this.state;
    const order = this.order();
    const top = order.slice(0, 3).map(({ pos, code, color }) => ({ pos, code, color }));
    return {
      kind: s.SessionInfo?.Type === 'Race' ? 'race' : s.SessionInfo?.Type === 'Qualifying' ? 'qualifying' : 'practice',
      order,
      session: s.SessionInfo?.Name || null,
      meeting: s.SessionInfo?.Meeting?.Name || null,
      status: s.SessionStatus?.Status || null,
      track: s.TrackStatus ? { status: s.TrackStatus.Status, message: s.TrackStatus.Message } : null,
      lap: s.LapCount?.CurrentLap ?? null,
      totalLaps: s.LapCount?.TotalLaps ?? null,
      remaining: s.ExtrapolatedClock?.Remaining ?? null,
      // The feed sends the clock occasionally; while it's running the island
      // counts down from "remaining at utc" itself.
      clock: s.ExtrapolatedClock
        ? { remaining: s.ExtrapolatedClock.Remaining, utc: s.ExtrapolatedClock.Utc, running: !!s.ExtrapolatedClock.Extrapolating }
        : null,
      gmtOffset: s.SessionInfo?.GmtOffset || null, // track local time, e.g. "08:00:00"
      // Latest race control messages, newest first. Utc has no zone suffix.
      messages: this.messages()
        .slice(-40)
        .reverse()
        .map((m) => ({ utc: `${m.Utc}Z`, category: m.Category, flag: m.Flag || null, message: m.Message })),
      top,
    };
  }
}

module.exports = { LiveTiming, merge };
