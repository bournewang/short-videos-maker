import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("server renders the Shortform Studio application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Shortform Studio<\/title>/i);
  assert.match(html, /Local workspace/);
  assert.match(html, /Storyboard/);
  assert.match(html, /Provider settings/);
  assert.match(html, /New episode/);
  assert.match(html, /Paste the exact English narration script here/);
  assert.match(html, /Analyze with AI/);
  assert.match(html, /Content format/);
  assert.match(html, /Visual style/);
  assert.match(html, /transcribed locally/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});
