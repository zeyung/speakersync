// Pure timing and signal math for SpeakerSync Party. No browser APIs, so it runs under `node --test`.

/** Milliseconds on this device's clock (wall-clock based, so devices start out roughly aligned). */
export const localNow = () => performance.timeOrigin + performance.now();

/**
 * Estimates how far the host's clock is ahead of ours from ping/pong round trips.
 * A sample is { sent, hostTime, received } (sent/received on our clock). The fastest round trips
 * are the least distorted by Wi-Fi jitter (or a host busy sending a song), so the estimate uses only
 * samples nearly as quick as the best one.
 */
export class ClockSync {
  constructor(keep = 30) { this.keep = keep; this.samples = []; }

  add({ sent, hostTime, received }) {
    const rtt = received - sent;
    if (!(rtt >= 0)) return;
    this.samples.push({ rtt, offset: hostTime - (sent + received) / 2 });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  /** Host clock minus our clock, in ms, or null before the first sample. */
  get offset() {
    if (!this.samples.length) return null;
    const limit = this.bestRtt * 1.5 + 1;
    return median(this.samples.filter(s => s.rtt <= limit).map(s => s.offset));
  }

  /** Round trip of the best samples: a rough bound on how wrong `offset` can be (± half of it). */
  get bestRtt() {
    return this.samples.length ? Math.min(...this.samples.map(s => s.rtt)) : null;
  }
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * When to start a track on this device, in AudioContext seconds, so its sound is *heard* at `hostTime`.
 * `stamp` is AudioContext.getOutputTimestamp(): { contextTime (s), performanceTime (ms) }.
 * `latencyMs` is this device's own output delay (Bluetooth etc.), learned by Auto-sync or set by hand:
 * we start that much earlier so the sound comes out on time.
 */
export function contextTimeFor({ hostTime, clockOffset, stamp, timeOrigin, latencyMs }) {
  const localPerf = hostTime - clockOffset - timeOrigin;  // performance.now() value at the target
  return stamp.contextTime + (localPerf - stamp.performanceTime) / 1000 - latencyMs / 1000;
}

/**
 * Where to start playing (seconds into the track) and when (context seconds).
 * If the moment has already passed (we joined late, or decoding took a while) we start right away
 * at the matching later position, so we land in step with everyone else.
 */
export function startPlan({ when, trackOffset, contextNow, minLead = 0.05 }) {
  const earliest = contextNow + minLead;
  if (when >= earliest) return { when, offset: trackOffset };
  return { when: earliest, offset: trackOffset + (earliest - when) };
}

// ---------- Auto-sync signal processing (mirrors the Mac app's CalibrationDSP) ----------

/** A 20 ms rising sweep, easy to pick out of room noise by correlation. */
export function makeChirp(sampleRate, { duration = 0.02, f0 = 1500, f1 = 6000, amplitude = 0.7 } = {}) {
  const n = Math.round(sampleRate * duration);
  const rate = (f1 - f0) / duration;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = Math.sin(2 * Math.PI * (f0 * t + 0.5 * rate * t * t)) * window * amplitude;
  }
  return out;
}

/** Genuine chirps score in the hundreds; room noise stays under ~15 (measured with the Mac app). */
export const MIN_CONFIDENCE = 40;

/**
 * Finds where `template` best matches `signal`, for start positions in [from, to).
 * Returns { index, confidence } where confidence = peak |correlation| / mean |correlation|.
 */
export function locateChirp(template, signal, from, to) {
  const lo = Math.max(0, from | 0);
  const hi = Math.min(signal.length - template.length + 1, to | 0);
  if (hi <= lo) return null;
  let peak = 0, peakAt = lo, sum = 0;
  const m = template.length;
  for (let p = lo; p < hi; p++) {
    let acc = 0;
    for (let j = 0; j < m; j++) acc += signal[p + j] * template[j];
    acc = Math.abs(acc);
    sum += acc;
    if (acc > peak) { peak = acc; peakAt = p; }
  }
  const mean = sum / (hi - lo);
  return { index: peakAt, confidence: mean > 0 ? peak / mean : 0 };
}

/**
 * Turns measured arrival errors into new per-device latency settings.
 * `errorsMs[id]` = how late device id was heard compared with when it should have been (ms).
 * Adding the error to a device's latency makes it start that much earlier next time. Everything is
 * shifted so the device that was earliest stays put: the microphone's own small delay applies to all
 * devices equally and shouldn't push every device earlier.
 */
export function updatedLatencies(currentMs, errorsMs, maxMs = 1000) {
  const ids = Object.keys(errorsMs);
  if (!ids.length) return { ...currentMs };
  const floor = Math.min(...ids.map(id => errorsMs[id]));
  const out = { ...currentMs };
  for (const id of ids) {
    out[id] = Math.round(Math.min(maxMs, Math.max(0, (currentMs[id] ?? 0) + errorsMs[id] - floor)));
  }
  return out;
}

export function spread(values) {
  const v = Object.values(values);
  return v.length ? Math.max(...v) - Math.min(...v) : 0;
}

/** Gains [fromLeft, fromRight] for each output side, for "left", "right" or "both" (normal stereo). */
export function channelMatrix(channel) {
  switch (channel) {
    case "left": return { left: [1, 0], right: [1, 0] };   // play the song's left on both drivers
    case "right": return { left: [0, 1], right: [0, 1] };
    default: return { left: [1, 0], right: [0, 1] };
  }
}

/** Short room codes without look-alike characters (no 0/O, 1/I/L). */
export function makeRoomCode(random = Math.random) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
}

export function normalizeRoomCode(text) {
  return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

/** A friendly label for what kind of device this is, from its browser's user agent. */
export function deviceKind(ua = "") {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/SMART-TV|SmartTV|Tizen|Web0S|BRAVIA|AFT|CrKey/i.test(ua)) return "TV";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Device";
}
