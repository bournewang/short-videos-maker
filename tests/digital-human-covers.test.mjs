import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DigitalHumanProjectStore } from "../scripts/digital-human-project-store.mjs";

test("digital human project store persists covers per project", async (t) => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "shortform-dh-covers-"));
  const store = new DigitalHumanProjectStore({ storageRoot, publicBaseUrl: "http://127.0.0.1:4317" });
  t.after(() => store.close());

  const project = await store.create({ humanId: "human-1", name: "Demo", script: "" });
  const coversDir = store.coversDir(project.id);
  await mkdir(coversDir, { recursive: true });
  const imagePath = path.join(coversDir, "cover-1-9x16.png");
  await writeFile(imagePath, Buffer.from("fake-png"));

  const cover = await store.addCover(project.id, { id: "cover-1", imagePath, prompt: "A bold cover" });
  assert.equal(cover.imageUrl, `http://127.0.0.1:4317/dh-projects/${encodeURIComponent(project.id)}/covers/cover-1-9x16.png`);
  assert.equal(cover.prompt, "A bold cover");

  const covers = await store.listCovers(project.id);
  assert.equal(covers.length, 1);
  assert.equal(covers[0].id, "cover-1");
  assert.equal(covers[0].projectId, project.id);

  assert.equal(await store.deleteCover(project.id, "cover-1"), true);
  assert.equal((await store.listCovers(project.id)).length, 0);
  await assert.rejects(stat(imagePath));
  assert.equal(await store.deleteCover(project.id, "cover-1"), false);
});

test("deleting a digital human project removes its covers", async (t) => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "shortform-dh-covers-"));
  const store = new DigitalHumanProjectStore({ storageRoot, publicBaseUrl: "http://127.0.0.1:4317" });
  t.after(() => store.close());

  const project = await store.create({ humanId: "human-1", name: "Demo", script: "" });
  const coversDir = store.coversDir(project.id);
  await mkdir(coversDir, { recursive: true });
  const imagePath = path.join(coversDir, "cover-1-9x16.png");
  await writeFile(imagePath, Buffer.from("fake-png"));
  await store.addCover(project.id, { imagePath, prompt: "A bold cover" });
  assert.equal((await store.listCovers(project.id)).length, 1);

  assert.equal(await store.delete(project.id), true);
  assert.equal((await store.listCovers(project.id)).length, 0);
  await assert.rejects(stat(imagePath));
});
