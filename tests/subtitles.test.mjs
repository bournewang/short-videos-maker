import assert from "node:assert/strict";
import test from "node:test";
import { buildSrt, formatSrtTime, subtitleFileName, transcriptionForShots } from "../app/lib/subtitles.js";

const shots = [
  { start:0, end:1.234, narration:"The story begins.", chinese:"故事开始了。" },
  { start:1.234, end:62.5, narration:"A second line.\nWith an edit.", chinese:"第二行。" },
];

// Two shots whose planned times deliberately diverge from the spoken audio:
// the opening hook is pinned to 5s on the timeline but its speech runs 0–16s.
const syncShots = [
  { index:0, start:0, end:5, duration:5, narration:"Welcome back to history.", chinese:"欢迎回到历史。" },
  { index:1, start:5, end:10, duration:5, narration:"Today we explore Rome.", chinese:"今天我们探索罗马。" },
];
const syncTranscription = { duration:32, segments:[{ start:0, end:32, words:[
  { start:0, end:4, word:"Welcome" }, { start:4, end:8, word:"back" },
  { start:8, end:12, word:"to" }, { start:12, end:16, word:"history." },
  { start:16, end:20, word:"Today" }, { start:20, end:24, word:"we" },
  { start:24, end:28, word:"explore" }, { start:28, end:32, word:"Rome." },
] }] };

test("SRT timestamps use YouTube-compatible millisecond timing", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(3661.009), "01:01:01,009");
});

test("bilingual SRT keeps both caption languages in each cue", () => {
  assert.equal(buildSrt(shots), "1\n00:00:00,000 --> 00:00:01,234\nThe story begins.\n故事开始了。\n\n2\n00:00:01,234 --> 00:00:31,867\nA second line.\n第二行。\n\n3\n00:00:31,867 --> 00:01:02,500\nWith an edit.\n第二行。\n");
});

test("SRT timing follows transcription word timestamps, not planned shot times", () => {
  assert.equal(buildSrt(syncShots, "bilingual", syncTranscription),
    "1\n00:00:00,000 --> 00:00:16,000\nWelcome back to history.\n欢迎回到历史。\n\n2\n00:00:16,000 --> 00:00:32,000\nToday we explore Rome.\n今天我们探索罗马。\n");
  // Without a transcription it falls back to the planned shot timing.
  assert.equal(buildSrt(syncShots, "english"),
    "1\n00:00:00,000 --> 00:00:05,000\nWelcome back to history.\n\n2\n00:00:05,000 --> 00:00:10,000\nToday we explore Rome.\n");
});

test("transcriptionForShots trims the word list to a shot subset", () => {
  const trimmed = transcriptionForShots(syncTranscription, [syncShots[0]]);
  assert.equal(trimmed.segments[0].words.length, 4);
  assert.equal(trimmed.duration, 16);
  // A shot set covering the whole recording keeps the original transcription.
  assert.equal(transcriptionForShots(syncTranscription, syncShots), syncTranscription);
  assert.equal(transcriptionForShots(null, syncShots), null);
});

test("language-specific SRT files omit empty cues and renumber the rest", () => {
  const english = buildSrt([{ start:0, end:1, narration:"", chinese:"第一行" }, { start:1, end:2, narration:"Second", chinese:"第二行" }], "english");
  assert.equal(english, "1\n00:00:01,000 --> 00:00:02,000\nSecond\n");
  assert.doesNotMatch(buildSrt(shots, "chinese"), /The story begins/);
});

test("subtitle filenames are safe and identify the language track", () => {
  assert.equal(subtitleFileName("My Episode: 1453!", "english"), "my-episode-1453-en.srt");
  assert.equal(subtitleFileName("", "chinese"), "shortform-video-zh-cn.srt");
});

// The transcriber expanded the first shot's narration into more words than the
// script ("Alpha bravo." -> six spoken words), so word-count proportion would
// start the second shot's cue inside the first shot's speech (at 25s). Text
// alignment keeps each cue on its own spoken words.
const driftShots = [
  { index:0, start:0, end:30, duration:30, narration:"Alpha bravo.", chinese:"阿尔法布拉沃。" },
  { index:1, start:30, end:33, duration:3, narration:"Charlie.", chinese:"查理。" },
];
const driftTranscription = { duration:33, segments:[{ start:0, end:33, words:[
  { start:0, end:5, word:"Alpha" }, { start:5, end:10, word:"one" },
  { start:10, end:15, word:"two" }, { start:15, end:20, word:"three" },
  { start:20, end:25, word:"four" }, { start:25, end:30, word:"bravo" },
  { start:30, end:33, word:"Charlie" },
] }] };

test("subtitle timing aligns shots to transcription text, not word-count proportion", () => {
  assert.equal(buildSrt(driftShots, "english", driftTranscription),
    "1\n00:00:00,000 --> 00:00:30,000\nAlpha bravo.\n\n2\n00:00:30,000 --> 00:00:33,000\nCharlie.\n");
});
