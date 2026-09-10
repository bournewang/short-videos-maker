#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { EpisodeStore } from "./episode-store.mjs";

const storageRoot = path.resolve(process.env.SHORTFORM_STORAGE_DIR || ".shortform");
const publicBaseUrl = "http://127.0.0.1:4317";
const store = new EpisodeStore({ storageRoot, publicBaseUrl });

function probeVideo(filename) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    filename,
  ], { encoding:"utf8" });
  if (result.status !== 0) throw new Error(`ffprobe failed for ${filename}: ${result.stderr}`);
  const data = JSON.parse(result.stdout);
  const stream = data.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!width || !height) throw new Error(`No video dimensions for ${filename}`);
  return { width, height, duration:Number(data.format?.duration) || 0 };
}

function resolutionFor(width, height) {
  const largest = Math.max(width, height);
  return largest >= 1900 ? "1080" : largest >= 1200 ? "720" : "480";
}

async function main() {
  await store.initialize();
  let restored = 0;
  let episodesUpdated = 0;
  for (const summary of store.listEpisodes()) {
    const project = store.getEpisode(summary.id);
    const exportsDirectory = path.join(storageRoot, "episodes", summary.slug, "exports");
    let filenames = [];
    try { filenames = (await readdir(exportsDirectory)).filter((name) => name.toLowerCase().endsWith(".mp4")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const builds = Array.isArray(project.videoBuilds) ? project.videoBuilds : [];
    const recorded = new Set(builds.map((build) => path.basename(String(build.path || build.url || "").split("?")[0])));
    let changed = false;
    for (const filename of filenames) {
      if (recorded.has(filename)) continue;
      const source = path.join(exportsDirectory, filename);
      const { width, height, duration } = probeVideo(source);
      const id = path.basename(filename, ".mp4");
      const timestamp = Number((/^build-(\d+)$/.exec(id) || [])[1]);
      builds.push({
        id,
        path:`/episodes/${summary.id}/files/exports/${encodeURIComponent(filename)}`,
        url:`${publicBaseUrl}/episodes/${summary.id}/files/exports/${encodeURIComponent(filename)}`,
        screenRatio:width > height ? "16:9" : height > width ? "9:16" : "1:1",
        resolution:resolutionFor(width, height),
        width,
        height,
        duration,
        createdAt:timestamp || Math.round((await stat(source)).mtimeMs),
      });
      recorded.add(filename);
      restored += 1;
      changed = true;
    }
    if (!changed) continue;
    project.videoBuilds = builds;
    await store.saveEpisode(project, { setActive:false });
    episodesUpdated += 1;
  }
  store.close();
  console.log(`已恢复 ${restored} 条构建记录，更新 ${episodesUpdated} 集`);
}

main().catch((error) => {
  store.close();
  console.error(error);
  process.exitCode = 1;
});