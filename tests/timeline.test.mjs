import assert from "node:assert/strict";
import test from "node:test";
import { formatTime, normalizePlannedShots } from "../app/lib/timeline.js";

test("AI shot timing is normalized to the narration duration", () => {
  const shots = normalizePlannedShots([
    { narration:"A compact battery powers the prototype.", chinese:"一块紧凑型电池为原型机供电。", type:"Opening", duration:1.2, prompt:"Photorealistic technology prototype, vertical 9:16", videoPrompt:"Indicator lights pulse while the camera slowly pushes toward the battery", motion:"Slow push-in" },
    { narration:"The first test runs for an entire day.", chinese:"首次测试持续了整整一天。", type:"Narrative", duration:2.8, prompt:"Photorealistic engineering lab, vertical 9:16", motion:"Slow drift" },
  ], 6, { contentFormat:"Educational explainer", visualStyle:"Photorealistic", creativeDirection:"Clean engineering lab" });
  assert.equal(shots[0].start, 0);
  assert.ok(Math.abs(shots.at(-1).end - 6) < .02);
  assert.equal(shots.length, 2);
  assert.match(shots[0].videoPrompt, /Indicator lights pulse/);
  assert.equal(formatTime(6), "00:06.0");
});

test("a short AI plan is stretched across an 82-second narration", () => {
  const input = Array.from({ length:13 }, (_, index) => ({
    narration:`Narration section ${index + 1}.`,
    chinese:`旁白片段 ${index + 1}。`,
    type:index === 0 ? "Opening" : "Narrative",
    duration:index === 0 ? 1.2 : 2.4,
  }));
  const shots = normalizePlannedShots(input, 82);
  assert.equal(shots[0].start, 0);
  assert.equal(shots.at(-1).end, 82);
  assert.equal(shots.reduce((sum, shot) => sum + shot.duration, 0), 82);
  assert.equal(formatTime(81.99999999999997), "01:22.0");
});

test("fallback prompts use episode-level creative settings", () => {
  const [shot] = normalizePlannedShots([{ narration:"The camera follows the runner." }], 2, { contentFormat:"Narrative story", visualStyle:"Anime", creativeDirection:"Neon city at night" });
  assert.match(shot.prompt, /Anime Narrative story/i);
  assert.match(shot.prompt, /Neon city at night/i);
  assert.match(shot.videoPrompt, /camera follows the runner/i);
  assert.doesNotMatch(shot.prompt, /historical|period clothing/i);
});

test("word timestamps place shot changes inside real pauses", () => {
  const shots = normalizePlannedShots([
    { narration:"one two", duration:2 },
    { narration:"three four", duration:2 },
  ], 8, { transcription:{ duration:8, segments:[{ start:.4, end:7, text:"one two three four", words:[
    { start:.4, end:1, word:"one" }, { start:1, end:2, word:"two" },
    { start:5, end:6, word:"three" }, { start:6, end:7, word:"four" },
  ] }] } });
  assert.equal(shots[0].end, 3.5);
  assert.equal(shots[1].start, 3.5);
  assert.equal(shots[1].end, 8);
});

test("invalid AI plans are rejected", () => {
  assert.throws(() => normalizePlannedShots([], 10), /no shots/i);
  assert.throws(() => normalizePlannedShots([{ duration:2 }], 2), /no usable narrated shots/i);
});

test("isolated empty AI placeholders are removed without losing valid shots", () => {
  const shots = normalizePlannedShots([
    { narration:"The empire had become too large", duration:2.5 },
    { type:"Narrative", duration:2.5, prompt:"Unused placeholder" },
    { text:"to govern effectively.", duration:2.5 },
  ], 8);
  assert.equal(shots.length, 2);
  assert.equal(shots[1].narration, "to govern effectively.");
  assert.equal(shots.at(-1).end, 8);
});
