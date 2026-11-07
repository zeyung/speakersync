import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCalibration } from "./room.js";
import { makeChirp } from "./sync.js";

/** A fake mic recording: each slot's chirp heard `lateMs[deviceId]` after it was due (null = silent). */
function recording(slots, lateMs, { rate = 48_000, startHostTime = 10_000, noise = 0.01, jitter = 0 } = {}) {
  const end = Math.max(...slots.map(s => s.time)) + 1500;
  const samples = new Float32Array(Math.ceil(((end - startHostTime) / 1000) * rate)).map(() => (Math.random() - 0.5) * noise);
  const chirp = makeChirp(rate);
  for (const s of slots) {
    const late = lateMs[s.deviceId];
    if (late == null) continue;
    const at = Math.round(((s.time + late + (Math.random() - 0.5) * jitter - startHostTime) / 1000) * rate);
    chirp.forEach((v, i) => { samples[at + i] += v * 0.3; });
  }
  return { samples, sampleRate: rate, startHostTime };
}

function plan(ids, rounds = 4, start = 12_000, slot = 800) {
  const slots = [];
  for (let r = 0; r < rounds; r++) ids.forEach((id, k) => slots.push({ deviceId: id, round: r, time: start + (r * ids.length + k) * slot }));
  return slots;
}

test("measures how late each device was heard", () => {
  const slots = plan(["phone", "bluetooth", "laptop"]);
  const { errors, heard } = analyzeCalibration(recording(slots, { phone: 40, bluetooth: 260, laptop: 35 }, { jitter: 2 }), slots);
  assert.deepEqual(heard, { phone: 3, bluetooth: 3, laptop: 3 });
  assert.ok(Math.abs(errors.phone - 40) < 2.5, `phone ${errors.phone}`);
  assert.ok(Math.abs(errors.bluetooth - 260) < 2.5, `bluetooth ${errors.bluetooth}`);
  assert.ok(Math.abs(errors.laptop - 35) < 2.5, `laptop ${errors.laptop}`);
});

test("a device already a little early is measured as negative", () => {
  const slots = plan(["a", "b"]);
  const { errors } = analyzeCalibration(recording(slots, { a: -60, b: 10 }), slots);
  assert.ok(Math.abs(errors.a + 60) < 1.5, `a ${errors.a}`);
});

test("a silent device is reported as not heard rather than guessed", () => {
  const slots = plan(["a", "silent"]);
  const { errors, heard } = analyzeCalibration(recording(slots, { a: 20, silent: null }), slots);
  assert.equal(errors.silent, undefined);
  assert.equal(heard.silent, 0);
  assert.ok(errors.a != null);
});
