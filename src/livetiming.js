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

  summary() {
    const s = this.state;
    const drivers = s.DriverList || {};
    const lines = Object.entries(s.TimingData?.Lines || {});
    const top = lines
      .map(([num, l]) => ({ num, pos: Number(l.Position) }))
      .filter((l) => l.pos > 0)
      .sort((a, b) => a.pos - b.pos)
      .slice(0, 3)
      .map(({ num, pos }) => ({
        pos,
        code: drivers[num]?.Tla || `#${num}`,
        color: drivers[num]?.TeamColour ? `#${drivers[num].TeamColour}` : null,
      }));
    return {
      session: s.SessionInfo?.Name || null,
      meeting: s.SessionInfo?.Meeting?.Name || null,
      status: s.SessionStatus?.Status || null,
      track: s.TrackStatus ? { status: s.TrackStatus.Status, message: s.TrackStatus.Message } : null,
      lap: s.LapCount?.CurrentLap ?? null,
      totalLaps: s.LapCount?.TotalLaps ?? null,
      remaining: s.ExtrapolatedClock?.Remaining ?? null,
      top,
    };
  }
}

module.exports = { LiveTiming, merge };
