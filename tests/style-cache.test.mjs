import assert from "node:assert/strict";
import test from "node:test";
import { readStyleCache, writeStyleCache } from "../app/lib/style-cache.js";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, String(value)),
};

test("style cache is global and merges settings from multiple pages", () => {
  writeStyleCache("episode-a", { livestreamRatio: "16:9", videoPosition: 72 });
  writeStyleCache("episode-b", { subtitleStyle: { position: 95 } });

  assert.deepEqual(readStyleCache("episode-a"), {
    cacheScope: "global",
    livestreamRatio: "16:9",
    videoPosition: 72,
    subtitleStyle: { position: 95 },
  });
  assert.deepEqual(readStyleCache("episode-b"), readStyleCache("another-episode"));
});

test("style cache reads legacy episode-scoped records", () => {
  storage.set("shortform-style-options-v1", JSON.stringify({ "episode-old": { subtitleStyle: { position: 20 } } }));
  assert.deepEqual(readStyleCache("episode-old"), { subtitleStyle: { position: 20 } });
});
