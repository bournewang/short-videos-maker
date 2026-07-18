import assert from "node:assert/strict";
import test from "node:test";
import { canStartConcurrentJob, mapWithConcurrency } from "../app/lib/concurrency.js";

test("manual video jobs can fill the configured parallel slots", () => {
  assert.equal(canStartConcurrentJob(new Set(["shot-1"]), "shot-2", 2), true);
  assert.equal(canStartConcurrentJob(new Set(["shot-1", "shot-2"]), "shot-3", 2), false);
  assert.equal(canStartConcurrentJob(new Set(["shot-1"]), "shot-1", 2), false);
});

test("parallel image worker pool respects its concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1,2,3,4,5,6], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results.map((result) => result.value), [2,4,6,8,10,12]);
});

test("parallel image worker pool keeps processing after one job fails", async () => {
  const progress = [];
  const results = await mapWithConcurrency([1,2,3], 2, async (value) => {
    if (value === 2) throw new Error("rate limited");
    return value;
  }, ({ completed }) => progress.push(completed));
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(progress.at(-1), 3);
});
