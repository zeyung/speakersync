// A SpeakerSync room: one host (holds the songs, runs the clock) and any number of devices.
// Devices connect peer-to-peer over WebRTC (PeerJS). Only the first handshake goes through the free
// PeerJS server; songs and timing flow directly between devices.
import { DevicePlayer, MicRecorder } from "./audio.js";
import { ClockSync, locateChirp, localNow, makeChirp, median, MIN_CONFIDENCE, spread, updatedLatencies } from "./sync.js";

const PEER_PREFIX = "speakersync-party-";
const CHUNK = 64 * 1024;
const LEAD_MS = 900;          // how far ahead "play" is scheduled, so every device is ready in time
const SLOT_MS = 800;          // Auto-sync: time between chirps (room for Bluetooth delay)
const DRIFT_LIMIT_MS = 12;    // re-align a playing song if this device's clock has wandered this far

export function myDeviceId() {
  let id = localStorage.getItem("speakersync.deviceId");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("speakersync.deviceId", id); }
  return id;
}

export class Room extends EventTarget {
  constructor({ code, isHost, name, kind }) {
    super();
    this.code = code;
    this.isHost = isHost;
    this.me = myDeviceId();
    this.player = new DevicePlayer();
    this.clock = new ClockSync();
    this.conns = new Map();         // host: deviceId → DataConnection
    this.files = new Map();         // host: trackId → { name, data }
    this.incoming = new Map();      // device: trackId → { parts, received }
    this.playingKey = null;
    this.calibration = null;
    this.state = {
      code, tracks: [], playback: { trackId: null, playing: false, anchorHost: 0, anchorPos: 0 },
      devices: {}, clicks: false, autoSync: { status: "idle", text: "" },
    };
    this.myInfo = { name, kind };
  }

  emit() { this.dispatchEvent(new Event("change")); }
  get hostNow() { return localNow() + (this.isHost ? 0 : (this.clock.offset ?? 0)); }
  get connected() { return this.isHost ? !!this.peer?.open : !!this.hostConn?.open; }

  // ---------------- connecting ----------------

  async open() {
    await this.player.unlock();
    if (this.isHost) return this.openAsHost();
    return this.openAsGuest();
  }

  openAsHost() {
    const saved = JSON.parse(localStorage.getItem("speakersync.hostDevices") || "{}");
    this.saved = saved;
    this.addDevice(this.me, this.myInfo, true);
    return new Promise((resolve, reject) => {
      this.peer = new Peer(PEER_PREFIX + this.code.toLowerCase(), { debug: 0 });
      this.peer.on("open", () => { this.emit(); resolve(); });
      this.peer.on("error", (err) => {
        if (err.type === "unavailable-id") reject(new Error("That room code is already in use. Try again."));
        else if (!this.peer.open) reject(new Error(`Couldn't create the room (${err.type || err.message}). Check your internet connection.`));
        else this.dispatchEvent(Object.assign(new Event("problem"), { message: String(err.message || err) }));
      });
      this.peer.on("connection", (conn) => this.acceptGuest(conn));
      this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch {} });
      this.keepRoomListed();
    }).then(() => this.applyAsDevice());
  }

  openAsGuest() {
    return new Promise((resolve, reject) => {
      this.peer = new Peer({ debug: 0 });
      let settled = false, attempts = 0, retryTimer = null;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(retryTimer);
        reject(new Error(message));
      };
      const notFound = `Couldn't find room ${this.code}. Check the code, and that the host still has SpeakerSync open.`;
      this.peer.on("error", (err) => {
        if (settled) return;
        // "Not found" can be a momentary blip at the connection service: retry before believing it.
        if (err.type === "peer-unavailable") {
          clearTimeout(retryTimer);
          if (attempts >= 3) fail(`Room ${this.code} wasn't found. Check the code, and that the host still has SpeakerSync open.`);
          else retryTimer = setTimeout(attempt, 1500);
        }
        else if (!this.hostConn?.open) fail(`Couldn't connect (${err.type || err.message}). Check your internet connection.`);
      });
      // The first handshake occasionally gets lost; try again a few times before giving up.
      const attempt = () => {
        if (settled) return;
        if (attempts++ >= 3) return fail(notFound);
        this.hostConn?.close();
        const conn = this.peer.connect(PEER_PREFIX + this.code.toLowerCase(), { reliable: true });
        this.hostConn = conn;
        retryTimer = setTimeout(attempt, 6000);
        conn.on("open", () => {
          if (settled || conn !== this.hostConn) return;
          settled = true;
          clearTimeout(retryTimer);
          conn.send({ t: "hello", deviceId: this.me, ...this.myInfo });
          this.startPinging();
          resolve();
        });
        conn.on("data", (msg) => { if (conn === this.hostConn) this.onHostMessage(msg); });
        conn.on("close", () => {
          if (conn !== this.hostConn || !settled) return;
          this.player.stop();
          this.dispatchEvent(Object.assign(new Event("problem"), { message: "Lost the connection to the host." }));
          this.emit();
        });
      };
      this.peer.on("open", attempt);
    });
  }

  /** The connection service forgets a room whose host goes quiet for a minute. Browsers slow down
   *  timers in background tabs, so the "still here" signal comes from a worker, which they don't. */
  keepRoomListed() {
    const code = "setInterval(() => postMessage(0), 5000);";
    this.heartbeat = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    this.heartbeat.onmessage = () => {
      if (this.peer?.disconnected && !this.peer.destroyed) { try { this.peer.reconnect(); } catch {} }
      else this.peer?.socket?.send?.({ type: "HEARTBEAT" });
    };
  }

  close() {
    this.heartbeat?.terminate();
    this.player.stop();
    this.player.stopFx();
    clearInterval(this.pingTimer);
    clearInterval(this.driftTimer);
    this.peer?.destroy();
  }

  // ---------------- host side ----------------

  addDevice(id, info, online) {
    const saved = this.saved?.[id] || {};
    const existing = this.state.devices[id] || {};
    this.state.devices[id] = {
      latency: 0, volume: 1, channel: "both", ...saved, ...existing,
      name: info.name || existing.name || saved.name || "Device", kind: info.kind || existing.kind || "Device",
      online, have: existing.have || [], progress: existing.progress || {}, rtt: existing.rtt ?? null,
    };
  }

  persistDevices() {
    const keep = {};
    for (const [id, d] of Object.entries(this.state.devices)) keep[id] = { latency: d.latency, volume: d.volume, channel: d.channel, name: d.name };
    localStorage.setItem("speakersync.hostDevices", JSON.stringify(keep));
  }

  acceptGuest(conn) {
    let deviceId = null;
    conn.on("data", (msg) => {
      if (msg.t === "hello") {
        deviceId = msg.deviceId;
        // Two tabs on one device share an ID; give the newcomer its own so neither replaces the other.
        if (deviceId === this.me || this.conns.get(deviceId)?.open) {
          let n = 2;
          while (this.state.devices[`${msg.deviceId}~${n}`]?.online) n++;
          deviceId = `${msg.deviceId}~${n}`;
          conn.send({ t: "assignedId", deviceId });
        }
        this.conns.get(deviceId)?.close();
        this.conns.set(deviceId, conn);
        this.addDevice(deviceId, msg, true);
        this.broadcastState();
        for (const trackId of this.files.keys()) this.sendFile(conn, trackId);
        return;
      }
      if (!deviceId) return;
      this.onGuestMessage(deviceId, msg, conn);
    });
    conn.on("close", () => {
      if (deviceId && this.conns.get(deviceId) === conn) {
        this.conns.delete(deviceId);
        if (this.state.devices[deviceId]) this.state.devices[deviceId].online = false;
        this.broadcastState();
      }
    });
  }

  onGuestMessage(deviceId, msg, conn) {
    const device = this.state.devices[deviceId];
    switch (msg.t) {
      case "ping":
        conn.send({ t: "pong", sent: msg.sent, hostTime: localNow() });
        break;
      case "rtt":
        device.rtt = msg.rtt;
        this.broadcastState();
        break;
      case "progress":
        device.progress[msg.trackId] = msg.pct;
        if (msg.pct >= 100 && !device.have.includes(msg.trackId)) device.have.push(msg.trackId);
        this.broadcastState();
        break;
      case "set":
        this.setDevice(msg.deviceId, msg.field, msg.value);
        break;
      case "command":
        this.command(msg.name, msg.args || {}, deviceId);
        break;
      case "calibrationResult":
        this.finishCalibrationPass(msg);
        break;
    }
  }

  broadcastState() {
    if (!this.isHost) return;
    const msg = { t: "state", state: this.state };
    for (const conn of this.conns.values()) if (conn.open) conn.send(msg);
    this.applyAsDevice();
    this.emit();
  }

  async sendFile(conn, trackId) {
    const file = this.files.get(trackId);
    const total = Math.ceil(file.data.byteLength / CHUNK);
    for (let index = 0; index < total; index++) {
      if (!conn.open) return;
      // Don't flood the channel: wait while lots is still queued.
      while (conn.dataChannel && conn.dataChannel.bufferedAmount > 1_000_000) await new Promise(r => setTimeout(r, 30));
      conn.send({ t: "chunk", trackId, index, total, data: file.data.slice(index * CHUNK, (index + 1) * CHUNK) });
    }
  }

  async addFiles(fileList) {
    for (const file of fileList) {
      const data = await file.arrayBuffer();
      const trackId = crypto.randomUUID();
      let duration = null;
      try { duration = (await this.player.decode(trackId, data)).duration; } catch {
        this.dispatchEvent(Object.assign(new Event("problem"), { message: `${file.name} isn't an audio file this device can play.` }));
        continue;
      }
      this.files.set(trackId, { name: file.name, data });
      this.state.tracks.push({ id: trackId, name: file.name.replace(/\.[^.]+$/, ""), duration });
      this.state.devices[this.me].have.push(trackId);
      this.state.devices[this.me].progress[trackId] = 100;
      if (!this.state.playback.trackId) this.state.playback.trackId = trackId;
      this.broadcastState();
      for (const conn of this.conns.values()) this.sendFile(conn, trackId);
    }
  }

  /** Current song position (s) on the shared clock. */
  position(playback = this.state.playback, at = this.hostNow) {
    if (!playback.trackId) return 0;
    return playback.playing ? playback.anchorPos + (at - playback.anchorHost) / 1000 : playback.anchorPos;
  }

  /** Playback and room commands. Guests send these to the host; the host applies them. */
  command(name, args = {}, from = this.me) {
    if (!this.isHost) { this.hostConn?.send({ t: "command", name, args }); return; }
    const pb = this.state.playback;
    const now = localNow();
    switch (name) {
      case "play":
        if (!pb.trackId) return;
        pb.anchorPos = Math.max(0, this.position(pb, now));
        pb.anchorHost = now + LEAD_MS;
        pb.playing = true;
        break;
      case "pause":
        pb.anchorPos = this.position(pb, now);
        pb.playing = false;
        break;
      case "seek":
        pb.anchorPos = Math.max(0, args.position);
        pb.anchorHost = now + LEAD_MS;
        break;
      case "select": {
        pb.trackId = args.trackId;
        pb.anchorPos = 0;
        pb.anchorHost = now + LEAD_MS;
        if (args.play) pb.playing = true;
        break;
      }
      case "next": case "previous": {
        const i = this.state.tracks.findIndex(t => t.id === pb.trackId);
        const next = this.state.tracks[i + (name === "next" ? 1 : -1)];
        if (!next) { if (name === "next") { pb.playing = false; pb.anchorPos = 0; } break; }
        pb.trackId = next.id; pb.anchorPos = 0; pb.anchorHost = now + LEAD_MS;
        break;
      }
      case "clicks":
        this.state.clicks = !!args.on;
        break;
      case "autoSync":
        this.startCalibration(args.listener || from);
        return;
      case "remove": {
        this.state.tracks = this.state.tracks.filter(t => t.id !== args.trackId);
        this.files.delete(args.trackId);
        if (pb.trackId === args.trackId) Object.assign(pb, { trackId: this.state.tracks[0]?.id ?? null, playing: false, anchorPos: 0 });
        break;
      }
    }
    this.broadcastState();
  }

  /** Change a device's delay / volume / left-right / name. Anyone in the room may, the host applies it. */
  setDevice(deviceId, field, value) {
    if (!this.isHost) { this.hostConn?.send({ t: "set", deviceId, field, value }); return; }
    const d = this.state.devices[deviceId];
    if (!d || !["latency", "volume", "channel", "name"].includes(field)) return;
    d[field] = field === "latency" ? Math.round(Math.min(1000, Math.max(0, value)))
      : field === "volume" ? Math.min(1, Math.max(0, value))
      : field === "channel" ? (["left", "right", "both"].includes(value) ? value : "both")
      : String(value).slice(0, 40);
    this.persistDevices();
    this.broadcastState();
  }

  // ---------------- device side (host and guests alike) ----------------

  onHostMessage(msg) {
    switch (msg.t) {
      case "assignedId":
        this.me = msg.deviceId;
        break;
      case "pong":
        this.clock.add({ sent: msg.sent, hostTime: msg.hostTime, received: localNow() });
        this.player.clockOffset = this.clock.offset;
        break;
      case "state":
        this.state = msg.state;
        this.applyAsDevice();
        this.emit();
        break;
      case "chunk":
        this.receiveChunk(msg);
        break;
      case "calibrate":
        this.runCalibrationPass(msg);
        break;
    }
  }

  startPinging() {
    const ping = () => this.hostConn?.open && this.hostConn.send({ t: "ping", sent: localNow() });
    for (let i = 0; i < 12; i++) setTimeout(ping, i * 80);  // quick burst for a good first estimate
    this.pingTimer = setInterval(() => {
      ping();
      if (this.clock.bestRtt != null) this.hostConn?.send({ t: "rtt", rtt: this.clock.bestRtt });
    }, 1500);
  }

  async receiveChunk({ trackId, index, total, data }) {
    let entry = this.incoming.get(trackId);
    if (!entry) { entry = { parts: new Array(total), received: 0, lastPct: -1 }; this.incoming.set(trackId, entry); }
    if (entry.parts[index]) return;
    entry.parts[index] = data;
    entry.received++;
    const pct = Math.floor((entry.received / total) * 100);
    if (pct >= entry.lastPct + 10 && pct < 100) { entry.lastPct = pct; this.hostConn.send({ t: "progress", trackId, pct }); }
    if (entry.received === total) {
      const bytes = new Uint8Array(entry.parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of entry.parts) { bytes.set(new Uint8Array(p), at); at += p.byteLength; }
      this.incoming.delete(trackId);
      try {
        await this.player.decode(trackId, bytes.buffer);
        this.hostConn.send({ t: "progress", trackId, pct: 100 });
        this.applyAsDevice();
      } catch {
        this.dispatchEvent(Object.assign(new Event("problem"), { message: "This device can't play one of the songs (unsupported format)." }));
      }
    }
  }

  /** Makes this device's sound match the room state: settings, and which song plays from when. */
  applyAsDevice() {
    const mine = this.state.devices[this.me];
    if (mine) {
      if (this.player.latencyMs !== mine.latency) { this.player.latencyMs = mine.latency; this.playingKey = null; }
      if (this.player.volume !== mine.volume) this.player.setVolume(mine.volume);
      if (this.player.channel !== mine.channel) this.player.setChannel(mine.channel);
    }
    if (this.isHost === false && this.clock.offset == null) return;  // no clock yet

    const pb = this.state.playback;
    const key = pb.playing && pb.trackId && this.player.buffers.has(pb.trackId)
      ? `${pb.trackId}@${pb.anchorHost}@${pb.anchorPos}@${this.player.latencyMs}` : null;
    if (key !== this.playingKey) {
      this.playingKey = key;
      if (key) this.startPlayback(); else this.player.stop();
    }

    if (this.state.clicks && !this.clicksOn) {
      this.clicksOn = true;
      const loop = () => { if (!this.state.clicks) { this.clicksOn = false; this.player.stopFx(); return; } this.player.playClicks(10); this.clickTimer = setTimeout(loop, 9000); };
      loop();
    } else if (!this.state.clicks && this.clicksOn) {
      clearTimeout(this.clickTimer);
      this.clicksOn = false;
      this.player.stopFx();
    }
  }

  startPlayback() {
    const pb = this.state.playback;
    const playingAt = this.player.play(pb.trackId, pb.anchorHost, pb.anchorPos);
    this.startedWith = { offset: this.player.clockOffset, when: this.player.contextTimeFor(pb.anchorHost) };
    clearInterval(this.driftTimer);
    if (!playingAt) return;
    // Clocks wander apart slowly (a few ms a minute). Re-align if this device has drifted noticeably.
    this.driftTimer = setInterval(() => {
      if (!this.player.source) return;
      const nowWhen = this.player.contextTimeFor(pb.anchorHost);
      if (Math.abs(nowWhen - this.startedWith.when) * 1000 > DRIFT_LIMIT_MS) this.startPlayback();
    }, 3000);
    // Host moves on to the next song at the end.
    if (this.isHost) {
      const track = this.state.tracks.find(t => t.id === pb.trackId);
      clearTimeout(this.endTimer);
      if (track?.duration) {
        const remaining = (track.duration - this.position()) * 1000;
        this.endTimer = setTimeout(() => {
          if (this.state.playback.playing && this.state.playback.trackId === track.id && this.position() >= track.duration - 0.25) this.command("next");
        }, Math.max(0, remaining + 300));
      }
    }
  }

  // ---------------- Auto-sync ----------------
  // Every device chirps in turn while one device's microphone listens. Two passes: measure and fix,
  // then measure again to confirm.

  startCalibration(listener) {
    const ids = Object.entries(this.state.devices).filter(([, d]) => d.online).map(([id]) => id);
    if (ids.length < 1) return;
    this.calibration = { listener, ids, pass: 1 };
    this.state.clicks = false;
    this.state.autoSync = { status: "running", text: `Listening with ${this.state.devices[listener]?.name ?? "a device"}… keep the room quiet.` };
    this.broadcastState();
    this.sendCalibrationPass();
  }

  sendCalibrationPass() {
    const { ids, listener } = this.calibration;
    const rounds = 4;  // the first is a warm-up and isn't counted
    const start = localNow() + 2500;
    const slots = [];
    for (let r = 0; r < rounds; r++) ids.forEach((id, k) => slots.push({ deviceId: id, round: r, time: start + (r * ids.length + k) * SLOT_MS }));
    const until = slots[slots.length - 1].time + SLOT_MS;
    const msg = { t: "calibrate", listener, slots, until };
    for (const conn of this.conns.values()) if (conn.open) conn.send(msg);
    this.runCalibrationPass(msg);
  }

  async runCalibrationPass({ listener, slots, until }) {
    this.player.playCalibration(slots.filter(s => s.deviceId === this.me).map(s => s.time), until);
    if (listener !== this.me) return;
    const mic = new MicRecorder(this.player);
    try { await mic.start(); } catch (e) {
      return this.reportCalibration({ error: "Microphone access was blocked. Allow it for this site, then try again." });
    }
    await new Promise(r => setTimeout(r, Math.max(0, until - this.hostNow) + 600));
    const rec = mic.stop();
    if (!rec) return this.reportCalibration({ error: "The microphone didn't record anything." });
    this.reportCalibration(analyzeCalibration(rec, slots));
  }

  reportCalibration(result) {
    if (this.isHost) this.finishCalibrationPass(result);
    else this.hostConn.send({ t: "calibrationResult", ...result });
  }

  finishCalibrationPass({ errors, heard, error }) {
    const cal = this.calibration;
    if (!cal) return;
    const name = (id) => this.state.devices[id]?.name ?? "a device";
    if (error) { this.state.autoSync = { status: "failed", text: error }; this.calibration = null; return this.broadcastState(); }
    const missing = cal.ids.filter(id => errors[id] == null);
    if (missing.length) {
      this.state.autoSync = { status: "failed", text: `Couldn't hear ${missing.map(name).join(", ")} clearly (${missing.map(id => `${heard[id] ?? 0}/3`).join(", ")} chirps). Turn it up or bring the listening device closer, then try again. Delays weren't changed.` };
      this.calibration = null;
      return this.broadcastState();
    }
    if (cal.pass === 1) {
      const current = Object.fromEntries(cal.ids.map(id => [id, this.state.devices[id].latency]));
      const next = updatedLatencies(current, errors);
      for (const id of cal.ids) this.state.devices[id].latency = next[id];
      this.persistDevices();
      cal.pass = 2;
      this.state.autoSync = { status: "running", text: "Checking the new delays…" };
      this.broadcastState();
      setTimeout(() => this.sendCalibrationPass(), 600);
      return;
    }
    const gap = spread(errors);
    this.state.autoSync = gap <= 15
      ? { status: "done", text: `Synced: all ${cal.ids.length} devices within ${Math.round(gap)} ms of each other.` }
      : { status: "warn", text: `Delays updated; devices were ${Math.round(gap)} ms apart on the re-check. Run Auto-sync again or fine-tune with the delay sliders.` };
    this.calibration = null;
    this.broadcastState();
  }
}

/** Finds each device's chirps in the recording: how late (ms) each was heard vs. when it was due. */
export function analyzeCalibration({ samples, sampleRate, startHostTime }, slots) {
  const chirp = makeChirp(sampleRate);
  const found = {};
  for (const slot of slots) {
    if (slot.round === 0) continue;
    const due = ((slot.time - startHostTime) / 1000) * sampleRate;
    const hit = locateChirp(chirp, samples, due - 0.1 * sampleRate, due + (SLOT_MS / 1000 - 0.15) * sampleRate);
    if (!hit || hit.confidence < MIN_CONFIDENCE) continue;
    (found[slot.deviceId] ||= []).push(((hit.index - due) / sampleRate) * 1000);
  }
  const errors = {}, heard = {};
  for (const id of new Set(slots.map(s => s.deviceId))) {
    const values = found[id] || [];
    heard[id] = values.length;
    if (values.length >= 2) errors[id] = median(values);
  }
  return { errors, heard };
}
