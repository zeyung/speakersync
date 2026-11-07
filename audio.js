// This device's sound: decodes songs, starts them at an exact shared moment, routes left/right,
// plays Auto-sync chirps and test clicks, and records the microphone for Auto-sync.
import { channelMatrix, contextTimeFor, makeChirp, startPlan } from "./sync.js";

export class DevicePlayer {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();   // trackId → AudioBuffer
    this.source = null;
    this.extraSources = new Set();
    this.channel = "both";
    this.volume = 1;
    this.latencyMs = 0;         // set by Auto-sync / the delay slider
    this.clockOffset = 0;       // host clock − our clock
  }

  get ready() { return !!this.ctx && this.ctx.state === "running"; }

  /** Must run inside a tap: browsers (iPhone especially) only allow sound after a user gesture. */
  async unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
      // Mono songs are spread to both sides before left/right routing.
      this.input = new GainNode(this.ctx, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
      this.splitter = new ChannelSplitterNode(this.ctx, { numberOfOutputs: 2 });
      this.merger = new ChannelMergerNode(this.ctx, { numberOfInputs: 2 });
      this.matrix = [0, 1, 2, 3].map(() => new GainNode(this.ctx));
      this.output = new GainNode(this.ctx);
      this.input.connect(this.splitter);
      // matrix[0]: L→outL, [1]: R→outL, [2]: L→outR, [3]: R→outR
      this.splitter.connect(this.matrix[0], 0); this.matrix[0].connect(this.merger, 0, 0);
      this.splitter.connect(this.matrix[1], 1); this.matrix[1].connect(this.merger, 0, 0);
      this.splitter.connect(this.matrix[2], 0); this.matrix[2].connect(this.merger, 0, 1);
      this.splitter.connect(this.matrix[3], 1); this.matrix[3].connect(this.merger, 0, 1);
      this.merger.connect(this.output).connect(this.ctx.destination);
      // Test sounds bypass left/right routing so every device can be measured the same way.
      this.fxOutput = new GainNode(this.ctx);
      this.fxOutput.connect(this.ctx.destination);
      this.setChannel(this.channel);
      this.setVolume(this.volume);
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
    // iOS: a silent blip inside the gesture fully wakes the audio session.
    const blip = this.ctx.createBufferSource();
    blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    blip.connect(this.ctx.destination);
    blip.start();
  }

  setChannel(channel) {
    this.channel = channel;
    if (!this.ctx) return;
    const m = channelMatrix(channel);
    // Set directly rather than scheduled: a scheduled change isn't applied while nothing is playing.
    [m.left[0], m.left[1], m.right[0], m.right[1]].forEach((g, i) => {
      this.matrix[i].gain.cancelScheduledValues(0);
      this.matrix[i].gain.value = g;
    });
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.ctx) this.output.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  async decode(trackId, arrayBuffer) {
    const buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.buffers.set(trackId, buffer);
    return buffer;
  }

  /** Total delay between "start" and sound leaving this device: what the browser reports + what we learned. */
  get totalLatencyMs() {
    const reported = this.ctx ? ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000 : 0;
    return reported + this.latencyMs;
  }

  stamp() {
    if (this.ctx.getOutputTimestamp) {
      const s = this.ctx.getOutputTimestamp();
      if (s && s.performanceTime > 0) return s;
    }
    return { contextTime: this.ctx.currentTime, performanceTime: performance.now() };
  }

  /** Context time at which something must start to be *heard* at host time `hostTime`. */
  contextTimeFor(hostTime, { includeLatency = true } = {}) {
    return contextTimeFor({
      hostTime, clockOffset: this.clockOffset, stamp: this.stamp(), timeOrigin: performance.timeOrigin,
      latencyMs: includeLatency ? this.totalLatencyMs : 0,
    });
  }

  /** Host time (ms) for a context time, ignoring output latency (used for the microphone). */
  hostTimeFor(contextTime) {
    const s = this.stamp();
    return performance.timeOrigin + s.performanceTime + (contextTime - s.contextTime) * 1000 + this.clockOffset;
  }

  /** Plays `trackId` so that position `trackOffset` (s) is heard at host time `hostTime` (ms). */
  play(trackId, hostTime, trackOffset) {
    this.stop();
    const buffer = this.buffers.get(trackId);
    if (!buffer || !this.ready) return false;
    const plan = startPlan({ when: this.contextTimeFor(hostTime), trackOffset, contextNow: this.ctx.currentTime });
    if (plan.offset >= buffer.duration) return false;
    const source = new AudioBufferSourceNode(this.ctx, { buffer });
    source.connect(this.input);
    source.start(plan.when, plan.offset);
    this.source = source;
    this.lastStart = { ...plan, hostTime: this.hostTimeFor(plan.when) + this.totalLatencyMs, trackId };
    return true;
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch {}
      this.source.disconnect();
      this.source = null;
    }
  }

  /** Plays a short mono sound so it is heard at `hostTime`. */
  playFx(samples, hostTime, gain = 1) {
    if (!this.ready) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = new AudioBufferSourceNode(this.ctx, { buffer });
    const g = new GainNode(this.ctx, { gain });
    source.connect(g).connect(this.fxOutput);
    const when = this.contextTimeFor(hostTime);
    if (when < this.ctx.currentTime) return;
    source.start(when);
    this.extraSources.add(source);
    source.onended = () => this.extraSources.delete(source);
  }

  /** Auto-sync: a faint hiss (keeps cheap Bluetooth speakers from switching their amp off) plus
   *  this device's chirps at the given host times. */
  playCalibration(chirpTimes, untilHostTime) {
    if (!this.ready) return;
    const rate = this.ctx.sampleRate;
    const chirp = makeChirp(rate);
    const startHost = Math.min(...chirpTimes) - 600;
    const length = Math.ceil(((untilHostTime - startHost) / 1000) * rate);
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * 0.008;
    for (const t of chirpTimes) {
      const at = Math.round(((t - startHost) / 1000) * rate);
      chirp.forEach((s, i) => { if (at + i < length) samples[at + i] += s; });
    }
    this.playFx(samples, startHost);
  }

  /** Sync test: a click every half second of host time, for the next `seconds`. */
  playClicks(seconds = 12) {
    if (!this.ready) return;
    const rate = this.ctx.sampleRate;
    const click = new Float32Array(Math.round(rate * 0.008)).map((_, i) => {
      const t = i / rate;
      return Math.sin(2 * Math.PI * 2000 * t) * Math.exp(-t * 600) * 0.8;
    });
    const hostNow = performance.timeOrigin + performance.now() + this.clockOffset;
    const first = Math.ceil((hostNow + 400) / 500) * 500;
    for (let t = first; t < hostNow + seconds * 1000; t += 500) this.playFx(click, t);
  }

  stopFx() {
    for (const s of this.extraSources) { try { s.stop(); } catch {} }
    this.extraSources.clear();
  }
}

/** Records the microphone with the context time of every block, for Auto-sync. */
export class MicRecorder {
  constructor(player) { this.player = player; this.chunks = []; }

  async start() {
    const ctx = this.player.ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const code = `registerProcessor("speakersync-mic", class extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) this.port.postMessage({ time: currentTime, samples: ch.slice(0) });
        return true;
      }
    });`;
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, "speakersync-mic");
    this.node.port.onmessage = (e) => this.chunks.push(e.data);
    // Must reach the destination to run on some browsers; a zero gain keeps it silent.
    this.silent = new GainNode(ctx, { gain: 0 });
    this.source.connect(this.node).connect(this.silent).connect(ctx.destination);
  }

  /** Stops and returns { samples, sampleRate, startHostTime } on the host's clock. */
  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.source?.disconnect(); this.node?.disconnect(); this.silent?.disconnect();
    if (!this.chunks.length) return null;
    const total = this.chunks.reduce((n, c) => n + c.samples.length, 0);
    const samples = new Float32Array(total);
    let at = 0;
    for (const c of this.chunks) { samples.set(c.samples, at); at += c.samples.length; }
    return { samples, sampleRate: this.player.ctx.sampleRate, startHostTime: this.player.hostTimeFor(this.chunks[0].time) };
  }
}
