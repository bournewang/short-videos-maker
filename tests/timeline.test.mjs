import assert from "node:assert/strict";
import test from "node:test";
import { formatTime, normalizePlannedShots, scriptSectionForDuration } from "../app/lib/timeline.js";

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
  assert.doesNotMatch(shot.prompt, /subtitle[- ]?safe|safe lower/i);
  assert.doesNotMatch(shot.prompt, /historical|period clothing/i);
});

test("long scenes use the adjustable target duration and direct video prompt fallback", () => {
  const [scene] = normalizePlannedShots([{ narration:"The engineer enters the lab and activates the prototype." }], 10, {
    productionMode:"long-scenes", targetClipDuration:10, contentFormat:"Educational explainer", visualStyle:"Cinematic illustration", creativeDirection:"Warm practical lighting",
  });
  assert.equal(scene.duration, 10);
  assert.match(scene.videoPrompt, /complete narration/i);
  assert.match(scene.videoPrompt, /coherent sequence of visual beats/i);
  assert.match(scene.videoPrompt, /Warm practical lighting/i);
});

test("long scene source durations are limited to the provider maximum", () => {
  const [scene] = normalizePlannedShots([{ narration:"A continuous scene.", duration:30 }], 0, { productionMode:"long-scenes", targetClipDuration:12 });
  assert.equal(scene.duration, 12);
});

test("mixed mode recommends only about one video for every four shots", () => {
  const shots = normalizePlannedShots(Array.from({ length:10 }, (_, index) => ({
    narration:`Narration ${index + 1}.`, type:index === 5 ? "Climax" : index === 0 ? "Opening" : "Narrative", duration:2.5,
    videoRecommended:[1, 5, 9].includes(index),
  })), 25, { productionMode:"mixed" });
  assert.equal(shots.filter((shot) => shot.videoRecommended).length, 3);
  assert.deepEqual(shots.map((shot, index) => shot.videoRecommended ? index : -1).filter((index) => index >= 0), [1, 5, 9]);
});

test("mixed mode fills missing video recommendations across the episode", () => {
  const shots = normalizePlannedShots(Array.from({ length:8 }, (_, index) => ({ narration:`Narration ${index + 1}.`, duration:2.5 })), 20, { productionMode:"mixed" });
  assert.equal(shots.filter((shot) => shot.videoRecommended).length, 2);
  assert.equal(shots[0].videoRecommended, true);
  assert.equal(shots.at(-1).videoRecommended, true);
});

test("history image prompts enforce an era-accurate background", () => {
  const [shot] = normalizePlannedShots([{ narration:"In 1453, defenders watched the walls of Constantinople.", prompt:"Cinematic defenders overlooking a city at dawn, no text" }], 3, { contentFormat:"History documentary" });
  assert.match(shot.prompt, /exact historical era/i);
  assert.match(shot.prompt, /period-accurate background/i);
  assert.match(shot.prompt, /architecture, clothing, objects, and technology/i);
  assert.match(shot.prompt, /no anachronisms or mixed eras/i);
});

test("history prompts do not duplicate an existing historical accuracy constraint", () => {
  const prompt = "1453 Constantinople, period-accurate Theodosian walls and Ottoman clothing, no anachronisms, no text";
  const [shot] = normalizePlannedShots([{ narration:"The siege began.", prompt }], 2, { contentFormat:"History documentary" });
  assert.equal(shot.prompt, prompt);
});

test("image prompts remove subtitle-safe lower-area instructions", () => {
  const [shot] = normalizePlannedShots([{ narration:"A runner crosses the finish line.", prompt:"Cinematic runner, subtitle-safe lower area, dramatic stadium lights, no text" }], 2);
  assert.equal(shot.prompt, "Cinematic runner, dramatic stadium lights, no text");
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

test("the storyboard script section follows the selected shot time range", () => {
  const script = "One two, three four five.";
  const transcription = { segments:[{ start:0, end:5, text:script, words:[
    { start:0, end:.8, word:"One" }, { start:1, end:1.8, word:"two" }, { start:2, end:2.8, word:"three" },
    { start:3, end:3.8, word:"four" }, { start:4, end:4.8, word:"five" },
  ] }] };
  assert.equal(scriptSectionForDuration(script, transcription, 1.9, 4, 5), "three four");
  assert.equal(scriptSectionForDuration(script, transcription, 5, 6, 6), "");
});

test("the storyboard script section falls back to proportional script words", () => {
  assert.equal(scriptSectionForDuration("one two three four five six", null, 2, 4, 6), "three four");
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
