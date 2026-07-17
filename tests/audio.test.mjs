import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { narrationFilters, voicePreset } from "../app/lib/audio.js";
import { processNarration } from "../scripts/render-service.mjs";

function monoWav({ seconds = 1, sampleRate = 48000, frequency = 140 } = {}) {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const tone = Math.sin(2 * Math.PI * frequency * index / sampleRate) * 0.2;
    const noise = (Math.random() - 0.5) * 0.015;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, tone + noise)) * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("voice processing offers original audio or light de-noise", () => {
  assert.equal(voicePreset("original").id, "original");
  assert.equal(voicePreset("denoise").pitchSemitones, 0);
  assert.equal(voicePreset("unknown").id, "denoise");
  assert.deepEqual(narrationFilters("original"), []);
  const chain = narrationFilters("denoise").join(",");
  assert.match(chain, /afftdn=nr=3/);
  assert.doesNotMatch(chain, /rubberband|loudnorm/);
});

test("local voice processing creates raw and de-noised WAV stages", { timeout:120000 }, async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), "shortform-audio-test-"));
  const audioData = `data:audio/wav;base64,${monoWav().toString("base64")}`;
  const result = await processNarration({ audioData, preset:"denoise" }, { id:"test-audio", jobDir });
  for (const filename of ["voice-raw.wav", "voice-clean.wav"]) {
    const file = path.join(jobDir, filename);
    assert.ok((await stat(file)).size > 1000);
    const wav = await readFile(file, { encoding:null });
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.readUInt32LE(24), 48000);
  }
  assert.equal(result.preset.id, "denoise");
  assert.equal(result.format.sampleRate, 48000);
  assert.equal(result.engines.pitch, "None");
  assert.match(result.engines.denoise, /light reduction/);
});
