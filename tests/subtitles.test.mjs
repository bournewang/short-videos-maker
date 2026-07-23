import assert from "node:assert/strict";
import test from "node:test";
import { buildSrt, formatSrtTime, subtitleFileName } from "../app/lib/subtitles.js";

const shots = [
  { start:0, end:1.234, narration:"The story begins.", chinese:"故事开始了。" },
  { start:1.234, end:62.5, narration:"A second line.\nWith an edit.", chinese:"第二行。" },
];

test("SRT timestamps use YouTube-compatible millisecond timing", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(3661.009), "01:01:01,009");
});

test("bilingual SRT keeps both caption languages in each cue", () => {
  assert.equal(buildSrt(shots), "1\n00:00:00,000 --> 00:00:01,234\nThe story begins.\n故事开始了。\n\n2\n00:00:01,234 --> 00:01:02,500\nA second line. With an edit.\n第二行。\n");
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
