import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { cleanupStorage, collectStorageUsage } from "../scripts/cleanup-storage.mjs"
import { EpisodeStore } from "../scripts/episode-store.mjs"

async function missing(filename) {
  try {
    await access(filename)
    return false
  } catch (error) {
    if (error?.code === "ENOENT") return true
    throw error
  }
}

test("storage cleanup preserves episode references and removes only unused files", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "shortform-cleanup-"))
  const store = new EpisodeStore({ storageRoot })
  const saved = await store.saveEpisode({
    id:"episode-kept",
    title:"Kept episode",
    shots:[{
      id:"shot-one",
      duration:2,
      image:"data:image/png;base64,iVBORw0KGgo=",
      variants:[],
    }],
  })
  store.close()

  const keptImage = path.join(saved.directory, "images", "shot-one-image.png")
  const unusedEpisodeFile = path.join(saved.directory, "images", "old-image.jpg")
  const unusedAsset = path.join(storageRoot, "assets", "legacy.jpg")
  const unusedJob = path.join(storageRoot, "jobs", "old-job", "frame.png")
  await mkdir(path.dirname(unusedJob), { recursive:true })
  await Promise.all([
    writeFile(unusedEpisodeFile, "unused"),
    writeFile(unusedAsset, "unused"),
    writeFile(unusedJob, "unused"),
  ])

  const preview = await collectStorageUsage(storageRoot)
  assert.equal(preview.episodeCount, 1)
  assert.ok(preview.kept.includes(keptImage))
  assert.deepEqual(
    preview.unused.map(({ filename }) => filename).sort(),
    [unusedAsset, unusedEpisodeFile, unusedJob].sort(),
  )
  await access(keptImage)
  await access(unusedAsset)

  const result = await cleanupStorage(storageRoot, { apply:true, purge:true })
  assert.equal(result.unusedFiles, 3)
  assert.equal(result.purged, true)
  await access(keptImage)
  await access(path.join(saved.directory, "episode.json"))
  await access(result.reportPath)
  assert.equal(await missing(unusedAsset), true)
  assert.equal(await missing(unusedEpisodeFile), true)
  assert.equal(await missing(unusedJob), true)
})
