import assert from "node:assert/strict";
import test from "node:test";
import { VIDEO_RESOLUTIONS, videoResolution } from "../app/lib/video.js";

test("download presets provide the requested vertical resolutions", () => {
  assert.deepEqual(Object.keys(VIDEO_RESOLUTIONS), ["480", "720", "1080"]);
  assert.deepEqual(videoResolution("480"), { label:"480p", width:480, height:854 });
  assert.deepEqual(videoResolution("720"), { label:"720p", width:720, height:1280 });
  assert.deepEqual(videoResolution("1080"), { label:"1080p", width:1080, height:1920 });
});

test("unknown download resolutions fall back to 1080p", () => {
  assert.equal(videoResolution("unknown"), VIDEO_RESOLUTIONS["1080"]);
});
