import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCachedProject } from "../app/lib/project-cache.js";

test("cached episodes preserve API output and reset interrupted jobs", () => {
  const cached = normalizeCachedProject({ script:"Narration", audioData:"data:audio/mpeg;base64,AA==", transcription:{ duration:12 }, shots:[
    { id:"one", narration:"First", status:"generating", image:"", videoStatus:"generating" },
    { id:"two", narration:"Second", status:"generated", image:"https://example.test/image.png", variants:["variant"], video:"https://example.test/clip.mp4", videoStatus:"generated", videoProvider:"seedance" },
    { id:"three", narration:"Third", status:"generated", image:"" },
  ] });
  assert.equal(cached.script, "Narration");
  assert.equal(cached.audioData, "data:audio/mpeg;base64,AA==");
  assert.equal(cached.shots[0].status, "planned");
  assert.equal(cached.shots[0].videoStatus, "idle");
  assert.match(cached.shots[0].videoPrompt, /First/);
  assert.equal(cached.shots[1].status, "generated");
  assert.equal(cached.shots[1].videoStatus, "generated");
  assert.equal(cached.shots[1].video, "https://example.test/clip.mp4");
  assert.equal(cached.shots[2].status, "planned");
  assert.deepEqual(cached.shots[1].variants, ["variant"]);
});

test("invalid project cache values are ignored", () => {
  assert.equal(normalizeCachedProject(null), null);
  assert.equal(normalizeCachedProject("invalid"), null);
});
