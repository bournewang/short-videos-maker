import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EpisodeStore, slugifyEpisodeName } from "../scripts/episode-store.mjs";

test("episode names become readable storage-directory slugs", () => {
  assert.equal(slugifyEpisodeName("  When Rome Fell: China in 476 AD  "), "when-rome-fell-china-in-476-ad");
  assert.equal(slugifyEpisodeName(""), "untitled-episode");
  assert.equal(slugifyEpisodeName("明朝与世界"), "明朝与世界");
});

test("episode store persists metadata in SQLite and media in named episode directories", async (t) => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "shortform-episode-store-"));
  const store = new EpisodeStore({ storageRoot, publicBaseUrl:"http://127.0.0.1:4317" });
  t.after(() => store.close());
  const saved = await store.saveEpisode({
    id:"episode-rome",
    title:"When Rome Fell: China in 476 AD",
    stage:"storyboard",
    savedAt:1234,
    audioName:"narration.wav",
    audioData:"data:audio/wav;base64,UklGRg==",
    shots:[{
      id:"shot-one", duration:2.5, narration:"Rome fell.", image:"data:image/png;base64,iVBORw0KGgo=", variants:[],
      video:"data:video/mp4;base64,AAAAIGZ0eXBpc29t", status:"generated",
    }],
    covers:[{ id:"cover-one", url:"data:image/jpeg;base64,/9j/2Q==", screenRatio:"9:16" }],
    videoBuilds:[],
  });

  assert.equal(saved.summary.slug, "when-rome-fell-china-in-476-ad");
  assert.equal((await stat(path.join(storageRoot, "episodes.sqlite"))).isFile(), true);
  const episodeDirectory = path.join(storageRoot, "episodes", saved.summary.slug);
  assert.equal((await stat(path.join(episodeDirectory, "episode.json"))).isFile(), true);
  assert.ok((await readdir(path.join(episodeDirectory, "audio"))).some((name) => name.endsWith(".wav")));
  assert.ok((await readdir(path.join(episodeDirectory, "images"))).some((name) => name.endsWith(".png")));
  assert.ok((await readdir(path.join(episodeDirectory, "videos"))).some((name) => name.endsWith(".mp4")));
  assert.ok((await readdir(path.join(episodeDirectory, "covers"))).some((name) => name.endsWith(".jpg")));
  const manifest = await readFile(path.join(episodeDirectory, "episode.json"), "utf8");
  assert.doesNotMatch(manifest, /base64/);

  assert.deepEqual(store.listEpisodes(), [{
    id:"episode-rome", title:"When Rome Fell: China in 476 AD", slug:"when-rome-fell-china-in-476-ad",
    savedAt:1234, stage:"storyboard", shotCount:1, duration:2.5, hasNarration:true,
  }]);
  const episode = store.getActiveEpisode();
  assert.match(episode.audioData, /^http:\/\/127\.0\.0\.1:4317\/episodes\/episode-rome\/files\/audio\//);
  assert.match(episode.shots[0].image, /\/episodes\/episode-rome\/files\/images\//);
  assert.match(episode.shots[0].video, /\/episodes\/episode-rome\/files\/videos\//);
});

test("episodes stay ordered by creation time even after older episodes are re-saved", async (t) => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "shortform-episode-order-"));
  const store = new EpisodeStore({ storageRoot });
  t.after(() => store.close());
  await store.saveEpisode({ id:"episode-first", title:"First", shots:[], savedAt:1000 });
  await store.saveEpisode({ id:"episode-second", title:"Second", shots:[], savedAt:1001 });
  const first = store.getEpisode("episode-first");
  await store.saveEpisode({ ...first, savedAt:9999 });
  assert.deepEqual(store.listEpisodes().map((episode) => episode.id), ["episode-second", "episode-first"]);
});

test("renames keep an episode organized and deletion moves files to recoverable trash", async (t) => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "shortform-episode-rename-"));
  const store = new EpisodeStore({ storageRoot });
  t.after(() => store.close());
  await store.saveEpisode({ id:"episode-rename", title:"Draft title", shots:[] });
  const project = store.getEpisode("episode-rename");
  await store.saveEpisode({ ...project, title:"Final episode title", savedAt:2000 });
  assert.equal(store.listEpisodes()[0].slug, "final-episode-title");
  assert.equal((await stat(path.join(storageRoot, "episodes", "final-episode-title", "episode.json"))).isFile(), true);
  assert.equal(await store.deleteEpisode("episode-rename"), true);
  assert.deepEqual(store.listEpisodes(), []);
  assert.ok((await readdir(path.join(storageRoot, ".trash", "episodes"))).some((name) => name.startsWith("final-episode-title-")));
});
