import assert from "node:assert/strict";
import test from "node:test";
import { SCREEN_RATIOS, VIDEO_RESOLUTIONS, normalizeScreenRatio, promptForScreenRatio, videoResolution, visualCoverage } from "../app/lib/video.js";

test("download presets provide the requested vertical resolutions", () => {
  assert.deepEqual(Object.keys(VIDEO_RESOLUTIONS), ["480", "720", "1080"]);
  assert.deepEqual(videoResolution("480"), { label:"480p", width:480, height:854 });
  assert.deepEqual(videoResolution("720"), { label:"720p", width:720, height:1280 });
  assert.deepEqual(videoResolution("1080"), { label:"1080p", width:1080, height:1920 });
});

test("unknown download resolutions fall back to 1080p", () => {
  assert.equal(videoResolution("unknown"), VIDEO_RESOLUTIONS["1080"]);
});

test("screen ratios reshape export dimensions and reject unsupported values", () => {
  assert.deepEqual(Object.keys(SCREEN_RATIOS), ["9:16", "16:9", "1:1"]);
  assert.deepEqual(videoResolution("720", "16:9"), { label:"720p", width:1280, height:720 });
  assert.deepEqual(videoResolution("1080", "1:1"), { label:"1080p", width:1080, height:1080 });
  assert.equal(normalizeScreenRatio("4:3"), "9:16");
});

test("screen ratio changes synchronize existing prompt framing", () => {
  const landscape = promptForScreenRatio("Cinematic scene, vertical 9:16 frame, no text. Final framing: Vertical 9:16 screen ratio.", "16:9");
  assert.match(landscape, /landscape 16:9 frame/i);
  assert.match(landscape, /Final framing: Landscape 16:9 screen ratio\.$/);
  assert.doesNotMatch(landscape, /9:16|vertical/i);
  assert.equal((landscape.match(/Final framing:/g) || []).length, 1);
  assert.match(promptForScreenRatio("Subject moves naturally.", "1:1"), /Square 1:1 screen ratio/);
});

test("build coverage accepts an image or a video for every segment", () => {
  assert.deepEqual(visualCoverage([
    { image:"image-one", video:"" },
    { image:"", video:"video-two" },
    { image:"image-three", video:"video-three" },
  ]), { total:3, ready:3, complete:true });
  assert.deepEqual(visualCoverage(Array.from({ length:6 }, (_, index) => ({ video:`video-${index + 1}` }))), { total:6, ready:6, complete:true });
  assert.deepEqual(visualCoverage([{ image:"image-one" }, {}]), { total:2, ready:1, complete:false });
});
