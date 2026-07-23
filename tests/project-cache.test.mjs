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

test("cached video builds retain each ratio, render path, and download URL", () => {
  const cached = normalizeCachedProject({ videoBuilds:[
    { id:"landscape", path:"/renders/landscape.mp4", url:"http://127.0.0.1:4317/renders/landscape.mp4", screenRatio:"16:9", resolution:"1080", width:1920, height:1080, duration:42, createdAt:100 },
    { id:"vertical", path:"/renders/vertical.mp4", url:"http://127.0.0.1:4317/renders/vertical.mp4", screenRatio:"9:16", resolution:"720", width:720, height:1280, duration:42, createdAt:200 },
    { id:"invalid" },
  ], shots:[] });
  assert.equal(cached.videoBuilds.length, 2);
  assert.equal(cached.videoBuilds[0].screenRatio, "16:9");
  assert.equal(cached.videoBuilds[0].path, "/renders/landscape.mp4");
  assert.equal(cached.videoBuilds[1].url, "http://127.0.0.1:4317/renders/vertical.mp4");
  assert.deepEqual(cached.videoBuilds.map((build) => [build.width, build.height]), [[1920,1080],[720,1280]]);
});

test("cached generated covers retain headline placement, ratio, prompt, and local asset path", () => {
  const cached = normalizeCachedProject({ coverHeadline:"The truth about 1453", coverTitlePosition:"top-right", coverPrompt:"High contrast portrait", covers:[
    { id:"cover-one", path:"/assets/cover-one.png", url:"http://127.0.0.1:4317/assets/cover-one.png", screenRatio:"16:9", prompt:"Dramatic landscape cover", provider:"seedream", createdAt:300 },
    { id:"invalid" },
  ], shots:[] });
  assert.equal(cached.coverHeadline, "The truth about 1453");
  assert.equal(cached.coverTitlePosition, "top-right");
  assert.equal(cached.coverPrompt, "High contrast portrait");
  assert.equal(cached.covers.length, 1);
  assert.deepEqual(cached.covers[0], {
    id:"cover-one", path:"/assets/cover-one.png", url:"http://127.0.0.1:4317/assets/cover-one.png",
    screenRatio:"16:9", prompt:"Dramatic landscape cover", provider:"seedream", createdAt:300,
  });
});

test("invalid cover headline placement falls back to a safe lower position", () => {
  assert.equal(normalizeCachedProject({ coverTitlePosition:"over-the-face", shots:[] }).coverTitlePosition, "bottom-left");
});

test("cached long-scene settings and video-only scenes are preserved", () => {
  const cached = normalizeCachedProject({ productionMode:"long-scenes", longClipDuration:12, shots:[
    { narration:"A complete direct video scene.", status:"generated", image:"", video:"https://example.test/scene.mp4", videoStatus:"generated" },
  ] });
  assert.equal(cached.productionMode, "long-scenes");
  assert.equal(cached.longClipDuration, 12);
  assert.equal(cached.shots[0].status, "generated");
  assert.equal(cached.shots[0].videoStatus, "generated");
});

test("cached mixed-mode video selections are preserved", () => {
  const cached = normalizeCachedProject({ productionMode:"mixed", shots:[
    { narration:"Still image shot.", videoRecommended:false },
    { narration:"Animated highlight.", videoRecommended:true },
  ] });
  assert.equal(cached.productionMode, "mixed");
  assert.equal(cached.shots[0].videoRecommended, false);
  assert.equal(cached.shots[1].videoRecommended, true);
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
