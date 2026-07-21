import assert from "node:assert/strict";
import test from "node:test";
import { episodeCacheSummary, normalizeCachedProject } from "../app/lib/project-cache.js";

test("cached episodes preserve API output and reset interrupted jobs", () => {
  const cached = normalizeCachedProject({ script:"Narration", audioData:"data:audio/mpeg;base64,AA==", transcription:{ duration:12 }, shots:[
    { id:"one", narration:"First", status:"generating", image:"", videoStatus:"generating" },
    { id:"two", narration:"Second", status:"generated", image:"https://example.test/image.png", variants:["variant"], video:"https://example.test/clip.mp4", videoStatus:"generated", videoProvider:"seedance" },
    { id:"three", narration:"Third", status:"generated", image:"" },
  ] });
  assert.equal(cached.script, "Narration");
  assert.equal(cached.audioData, "data:audio/mpeg;base64,AA==");
  assert.equal(cached.subtitleStyle.fontFamily, "Arial");
  assert.equal(cached.subtitleStyle.backgroundOpacity, 45);
  assert.equal(cached.shots[0].status, "planned");
  assert.equal(cached.shots[0].imageStatus, "failed");
  assert.match(cached.shots[0].imageError, /interrupted/);
  assert.equal(cached.shots[0].videoStatus, "failed");
  assert.match(cached.shots[0].videoError, /interrupted/);
  assert.match(cached.shots[0].videoPrompt, /First/);
  assert.equal(cached.shots[1].status, "generated");
  assert.equal(cached.shots[1].videoStatus, "generated");
  assert.equal(cached.shots[1].imageStatus, "generated");
  assert.equal(cached.shots[1].video, "https://example.test/clip.mp4");
  assert.equal(cached.shots[2].status, "planned");
  assert.deepEqual(cached.shots[1].variants, ["variant"]);
});

test("cached generation failures preserve their provider reasons", () => {
  const cached = normalizeCachedProject({ shots:[
    { narration:"First", imageStatus:"failed", imageError:"Image quota exceeded", videoStatus:"failed", videoError:"Video request timed out" },
  ] });
  assert.equal(cached.shots[0].imageStatus, "failed");
  assert.equal(cached.shots[0].imageError, "Image quota exceeded");
  assert.equal(cached.shots[0].videoStatus, "failed");
  assert.equal(cached.shots[0].videoError, "Video request timed out");
});

test("cached subtitle styles are normalized", () => {
  const cached = normalizeCachedProject({ subtitleStyle:{ fontFamily:"Georgia", fontScale:999, englishColor:"#ABC", backgroundOpacity:-20, alignment:"sideways", bold:false }, shots:[] });
  assert.deepEqual(cached.subtitleStyle, {
    fontFamily:"Georgia", fontScale:160, englishColor:"#aabbcc", chineseColor:"#f2d79f", backgroundColor:"#000000",
    backgroundOpacity:0, position:8, alignment:"center", bold:false, outline:2,
  });
});

test("invalid project cache values are ignored", () => {
  assert.equal(normalizeCachedProject(null), null);
  assert.equal(normalizeCachedProject("invalid"), null);
});

test("episode cache summaries omit media while preserving useful history metadata", () => {
  const summary = episodeCacheSummary({ id:"episode-one", title:"  Launch story  ", savedAt:1234, stage:"storyboard", audioData:"data:audio/mpeg;base64,large", shots:[
    { duration:2.5, image:"data:image/png;base64,large" },
    { duration:3, video:"data:video/mp4;base64,large" },
  ] });
  assert.deepEqual(summary, {
    id:"episode-one", title:"Launch story", savedAt:1234, shotCount:2, duration:5.5, hasNarration:true, stage:"storyboard",
  });
  assert.equal(JSON.stringify(summary).includes("base64"), false);
});
