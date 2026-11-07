// Run with: node --test web/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClockSync, channelMatrix, contextTimeFor, deviceKind, locateChirp, makeChirp, makeRoomCode, median,
  MIN_CONFIDENCE, normalizeRoomCode, spread, startPlan, updatedLatencies,
} from "./sync.js";

test("clock offset comes from the quickest round trips, ignoring Wi-Fi spikes", () => {
  const sync = new ClockSync();
  const trueOffset = 1234.5;  // host is 1234.5 ms ahead
  let t = 0;
  for (const [out, back] of [[3, 3], [4, 4], [40, 2], [2, 60], [5, 5], [3, 4], [80, 80], [2, 2]]) {
    const sent = (t += 100);
    const hostTime = sent + out + trueOffset;  // asymmetric delays distort slow samples
    sync.add({ sent, hostTime, received: sent + out + back });
  }
  assert.ok(Math.abs(sync.offset - trueOffset) <= 1, `offset ${sync.offset}`);
  assert.equal(sync.bestRtt, 4);
});

// Bug: while the host was busy sending a 5 MB song, its replies took seconds. With only a few
// good samples, the old "quickest third" rule still averaged in slow ones and was 13 ms off.
test("a host busy sending a song doesn't skew the clock", () => {
  const sync = new ClockSync();
  const trueOffset = 0;
  let t = 0;
  const add = (out, back) => { const sent = (t += 80); sync.add({ sent, hostTime: sent + out + trueOffset, received: sent + out + back }); };
  add(1, 54);                                              // first ping, reply queued behind the song
  for (let k = 0; k < 12; k++) add(1, 3800 - k * 80);      // burst: replies stuck behind the transfer
  add(1, 1);                                               // the first clean round trip
  assert.ok(Math.abs(sync.offset - trueOffset) <= 0.5, `offset ${sync.offset}`);
});

test("no samples means no offset yet", () => {
  assert.equal(new ClockSync().offset, null);
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("a device starts early by its own output delay so it is heard on time", () => {
  const stamp = { contextTime: 10, performanceTime: 5_000 };  // context 10 s ↔ perf 5000 ms
  const when = contextTimeFor({ hostTime: 1_000_000 + 7_000, clockOffset: 1_000_000 - 0, stamp, timeOrigin: 0, latencyMs: 250 });
  // Host 1,007,000 → local perf 7,000 → context 12.0 s, minus 0.25 s of Bluetooth delay.
  assert.ok(Math.abs(when - 11.75) < 1e-9, String(when));
});

test("joining late starts right away at the matching later position", () => {
  assert.deepEqual(startPlan({ when: 20, trackOffset: 5, contextNow: 10 }), { when: 20, offset: 5 });
  const late = startPlan({ when: 9, trackOffset: 5, contextNow: 10, minLead: 0.05 });
  assert.equal(late.when, 10.05);
  assert.ok(Math.abs(late.offset - 6.05) < 1e-9);
});

test("finds a quiet chirp buried in noise to the exact sample", () => {
  const rate = 48_000;
  const chirp = makeChirp(rate);
  const signal = new Float32Array(rate / 2).map(() => (Math.random() - 0.5) * 0.1);
  const at = 9_137;
  chirp.forEach((s, i) => { signal[at + i] += s * 0.3; });
  const hit = locateChirp(chirp, signal, 0, signal.length);
  assert.equal(hit.index, at);
  assert.ok(hit.confidence > MIN_CONFIDENCE, String(hit.confidence));
});

test("noise alone stays below the bar", () => {
  const chirp = makeChirp(48_000);
  for (let k = 0; k < 4; k++) {
    const noise = new Float32Array(12_000).map(() => (Math.random() - 0.5) * 0.1);
    assert.ok(locateChirp(chirp, noise, 0, noise.length).confidence < MIN_CONFIDENCE);
  }
});

test("Auto-sync moves late devices earlier and leaves the earliest alone", () => {
  // Phone A heard 30 ms late, phone B (Bluetooth) 210 ms late, laptop 25 ms late.
  const next = updatedLatencies({ a: 0, b: 0, laptop: 0 }, { a: 30, b: 210, laptop: 25 });
  assert.deepEqual(next, { a: 5, b: 185, laptop: 0 });
  // A second pass refines rather than replaces.
  assert.deepEqual(updatedLatencies(next, { a: 2, b: -6, laptop: 0 }), { a: 13, b: 185, laptop: 6 });
  assert.equal(spread({ a: 1, b: 7, c: 3 }), 6);
});

test("latencies never go negative or absurd", () => {
  assert.deepEqual(updatedLatencies({ a: 0, b: 10 }, { a: 5000, b: 0 }, 1000), { a: 1000, b: 10 });
});

test("left / right / both channel routing", () => {
  assert.deepEqual(channelMatrix("left"), { left: [1, 0], right: [1, 0] });
  assert.deepEqual(channelMatrix("right"), { left: [0, 1], right: [0, 1] });
  assert.deepEqual(channelMatrix("both"), { left: [1, 0], right: [0, 1] });
});

test("room codes are short and unambiguous, and typing is forgiving", () => {
  for (let i = 0; i < 50; i++) assert.match(makeRoomCode(), /^[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(normalizeRoomCode(" ab-c d9 "), "ABCD");
});

test("device kinds", () => {
  assert.equal(deviceKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
  assert.equal(deviceKind("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile"), "Android phone");
  assert.equal(deviceKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "Mac");
  assert.equal(deviceKind("Mozilla/5.0 (Web0S; Linux/SmartTV)"), "TV");
});
