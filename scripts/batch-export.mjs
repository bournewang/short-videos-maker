#!/usr/bin/env node
// 批量导出：读 approved 集（或 --ids 指定），逐集「可选生视频(指定 shot) → FFmpeg 合成 MP4 → 封面生成 + sharp 烘焙标题」落盘。
// 直接 import 现有业务逻辑（render-service.mjs 导出函数），复用 .env.local 配置。
//
// 用法：
//   node scripts/batch-export.mjs                    # 导出所有 approved 集
//   node scripts/batch-export.mjs --ids ep1,ep2      # 只导指定 episode
//   node scripts/batch-export.mjs --video-shots first  # 每集第一个 shot 生视频
//   node scripts/batch-export.mjs --video-shots 0,2  --video-resolution 720p
//
// --video-shots：none(默认，纯静态图) | first(仅第一个 shot) | all(全部) | 0,2,3(指定下标)

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EpisodeStore } from "./episode-store.mjs";
import {
  renderEpisode,
  generateVideo,
  persistGeneratedVideo,
} from "./render-service.mjs";
import { normalizeScreenRatio, videoResolution } from "../app/lib/video.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.resolve(process.env.SHORTFORM_STORAGE_DIR || path.join(root, ".shortform"));
const store = new EpisodeStore({
  storageRoot: workRoot,
  assetRoot: path.join(workRoot, "assets"),
  exportRoot: path.join(workRoot, "exports"),
  publicBaseUrl: "http://127.0.0.1:4317",
});

function parseArgs(argv) {
  const args = {};
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith("--")) { args[key] = true; continue; }
    args[key] = next; i += 1;
  }
  return args;
}

// 把 episode 里存的媒体引用（相对 server path 或本地 URL）转成本地绝对文件路径。
function serverMediaPath(id, value) {
  const text = String(value || "");
  if (!text) return "";
  // 只有真实文件系统绝对路径才直接返回；以 /episodes/ 开头的服务端相对路径需继续解析成本地文件
  if (path.isAbsolute(text) && !/^\/episodes\//.test(text)) return text;
  let pathname = text;
  try { pathname = new URL(text, "http://127.0.0.1").pathname; } catch { /* keep as-is */ }
  const match = /^\/episodes\/([^/]+)\/files\/(.+)$/.exec(pathname);
  if (!match) return text;
  const row = store.row(decodeURIComponent(match[1]));
  if (!row) return text;
  return store.safeEpisodeFile(row.slug, match[2].split("/").map(decodeURIComponent).join(path.sep));
}

async function fileToDataUrl(filename) {
  const buf = await readFile(filename);
  const ext = path.extname(filename).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".mp4" ? "video/mp4" : ext === ".mp3" ? "audio/mpeg" : ext === ".m4a" || ext === ".aac" ? "audio/mp4" : ext === ".wav" ? "audio/wav" : "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function resolveVideoShotIndexes(spec, shotCount) {
  if (!spec || spec === "none") return [];
  if (spec === "all") return Array.from({ length: shotCount }, (_, index) => index);
  if (spec === "first") return shotCount ? [0] : [];
  const indexes = String(spec).split(",").map((part) => Number.parseInt(part.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < shotCount);
  return [...new Set(indexes)];
}

export function hasMatchingBuild(project, resolution) {
  const screenRatio = normalizeScreenRatio(project?.screenRatio);
  return (Array.isArray(project?.videoBuilds) ? project.videoBuilds : []).some((build) =>
    normalizeScreenRatio(build?.screenRatio) === screenRatio && String(build?.resolution || "") === String(resolution)
  );
}

export async function hasExportArtifact(episode, project, resolution, storageRoot = workRoot) {
  const slug = String(episode?.slug || "").trim();
  if (!slug) return false;
  const build = (Array.isArray(project?.videoBuilds) ? project.videoBuilds : []).find((item) =>
    normalizeScreenRatio(item?.screenRatio) === normalizeScreenRatio(project?.screenRatio) && String(item?.resolution || "") === String(resolution)
  );
  if (!build) return false;
  let pathname = String(build.path || build.url || "");
  try {
    pathname = new URL(pathname, "http://127.0.0.1").pathname;
  } catch {
    // A filesystem path can still be a valid artifact reference.
  }
  const prefix = `/episodes/${encodeURIComponent(episode.id)}/files/exports/`;
  const filename = pathname.startsWith(prefix)
    ? path.join(storageRoot, "episodes", slug, "exports", ...pathname.slice(prefix.length).split("/").map(decodeURIComponent))
    : pathname;
  try {
    return (await stat(filename)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function generateVideos(project, indexes, videoResolution, videoProvider) {
  for (const index of indexes) {
    const shot = project.shots[index];
    if (!shot || !shot.image) continue;
    if (shot.video) { console.log(`    shot ${index + 1} 已有视频，跳过`); continue; }
    const imageDataUrl = await fileToDataUrl(serverMediaPath(project.id, shot.image));
    console.log(`    shot ${index + 1} 生视频中（provider=${videoProvider || "env"}）…`);
    const generated = await generateVideo({
      kind: videoProvider || undefined,
      image: imageDataUrl,
      videoPrompt: shot.videoPrompt,
      motion: shot.motion,
      duration: Math.min(12, Math.max(5, Math.round(Number(shot.duration) || 5))),
      screenRatio: project.screenRatio,
      generationMode: "short-shots",
      resolution: videoResolution,
    });
    const cached = await store.withMediaTarget(project.id, project.title, "videos", shot.id, async (target) => persistGeneratedVideo(generated.videoUrl, target));
    shot.video = cached.url;
    shot.videoStatus = "generated";
    shot.videoProvider = String(generated.taskId || "generated");
    console.log(`    shot ${index + 1} 视频完成`);
  }
}

async function exportEpisode(episode, opts) {
  const project = store.getEpisode(episode.id);
  if (!project) throw new Error("Episode not found");
  console.log(`\n▶ ${project.title}（${episode.id}）`);

  const shots = Array.isArray(project.shots) ? project.shots : [];
  if (!shots.length) throw new Error("No shots to export");
  const covered = shots.filter((shot) => shot.image || shot.video).length;
  if (covered !== shots.length) throw new Error(`存在未生图的 shot（${covered}/${shots.length}），请先在 Web 复核里补齐生图`);

  // 1. 可选生视频
  const videoIndexes = resolveVideoShotIndexes(opts.videoShots, shots.length);
  if (videoIndexes.length) await generateVideos(project, videoIndexes, opts.videoResolution, opts.videoProvider);

  // 2. 合成 MP4
  const resolution = String(opts.resolution || "1080");
  const preset = videoResolution(resolution, project.screenRatio);
  const narrationPath = serverMediaPath(project.id, project.audioPath || project.audioData);
  const narrationData = narrationPath ? await fileToDataUrl(narrationPath) : "";
  if (!narrationData) throw new Error("No narration audio found for this episode");
  console.log(`  合成 ${preset.label} ${project.screenRatio} 视频…`);
  const builtShots = [];
  for (const shot of shots) {
    const copy = { ...shot };
    if (shot.video) copy.video = await fileToDataUrl(serverMediaPath(project.id, shot.video));
    else copy.image = await fileToDataUrl(serverMediaPath(project.id, shot.image));
    builtShots.push(copy);
  }
  const buildId = `build-${Date.now()}`;
  const result = await store.withMediaTarget(project.id, project.title, "exports", buildId, async (target) => {
    return renderEpisode({
      shots: builtShots,
      narrationData,
      transcription: project.transcription,
      voicePreset: project.denoiseNarration !== false ? "denoise" : "original",
      bgmPath: project.bgm || "",
      bgmVolume: Number(project.bgmVolume) / 100,
      subtitleStyle: project.subtitleStyle,
      broadcastMode: Boolean(project.broadcastMode),
      headlineText: project.headlineText || "",
      headlinePosition: Number(project.headlinePosition) || 4,
      width: preset.width,
      height: preset.height,
    }, {
      id: buildId,
      output: path.join(target.directory, `${target.baseName}.mp4`),
      publicUrl: `${target.urlPrefix}/${encodeURIComponent(`${target.baseName}.mp4`)}`,
    });
  });
  const buildRecord = {
    id: String(result.id || buildId),
    path: String(result.url || ""),
    url: `http://127.0.0.1:4317${result.url}`,
    screenRatio: project.screenRatio,
    resolution: String(resolution),
    width: preset.width,
    height: preset.height,
    duration: Number(result.duration) || 0,
    createdAt: Date.now(),
  };
  project.videoBuilds = [buildRecord, ...(Array.isArray(project.videoBuilds) ? project.videoBuilds : [])];
  console.log(`  MP4 完成：${result.duration.toFixed(1)}s`);

  // 3. 回写 episode（封面需在 Web 编辑器中审核后手动保存）
  await store.saveEpisode(project, { setActive: false });
  return { id: project.id, title: project.title, buildUrl: buildRecord.url };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log(`批量导出历史故事视频 + 封面（只处理 approved 集）

用法：
  node scripts/batch-export.mjs [选项]

选项：
  --ids <ep1,ep2>         只导指定 episode id（逗号分隔）
  --all                   导出全部（含非 approved），默认只导 approved
  --video-shots <spec>    none(默认) | first(仅第1个shot) | all | 0,2,3(指定下标)
  --video-provider <p>    生视频 provider：pixstag|volcengine|dashscope（默认取 .env.local 的 VIDEO_PROVIDER）
  --resolution <r>        渲染分辨率 480|720|1080，默认 1080
  --video-resolution <r>  生视频分辨率 480p|720p|1080p|2k，默认 720p
  --force                 即使已有相同画幅和分辨率的成片也重新导出
  --dry-run               只打印将导出的集，不执行`);
    return;
  }

  await store.initialize();
  const all = store.listEpisodes();
  let targets;
  if (args.ids) {
    const ids = new Set(String(args.ids).split(",").map((id) => id.trim()).filter(Boolean));
    targets = all.filter((episode) => ids.has(episode.id));
  } else if (args.all) {
    targets = all;
  } else {
    targets = all.filter((episode) => episode.reviewStatus === "approved");
  }

  const opts = {
    videoShots: args["video-shots"] || "none",
    resolution: args.resolution || "1080",
    videoResolution: args["video-resolution"] || "720p",
    videoProvider: args["video-provider"] || "",
    force: Boolean(args.force),
  };
  const skipped = [];
  if (!opts.force) {
    const pending = [];
    for (const episode of targets) {
      const project = store.getEpisode(episode.id);
      if (hasMatchingBuild(project, opts.resolution) && await hasExportArtifact(episode, project, opts.resolution)) skipped.push(episode);
      else pending.push(episode);
    }
    targets = pending;
  }

  if (args["dry-run"]) {
    console.log(`待导出 ${targets.length} 集（dry-run）：`);
    targets.forEach((episode, index) => console.log(`  ${index + 1}. [${episode.reviewStatus}] ${episode.title} · ${episode.shotCount} shots · ${episode.id}`));
    if (skipped.length) console.log(`跳过已导出 ${skipped.length} 集（使用 --force 可重导）：\n${skipped.map((episode) => `  ${episode.title} · ${episode.id}`).join("\n")}`);
    return;
  }

  if (skipped.length) console.log(`跳过已导出 ${skipped.length} 集（使用 --force 可重导）`);
  console.log(`待导出 ${targets.length} 集${opts.videoShots !== "none" ? ` · 生视频 ${opts.videoShots}${opts.videoProvider ? `（${opts.videoProvider}）` : ""}` : " · 纯静态图"}`);

  const results = [];
  for (const episode of targets) {
    try {
      const result = await exportEpisode(episode, opts);
      results.push({ ...result, status: "success" });
      console.log(`✅ ${result.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id: episode.id, title: episode.title, status: "failed", error: message });
      console.error(`❌ ${episode.title} → ${message}`);
    }
  }

  const succeeded = results.filter((item) => item.status === "success").length;
  console.log(`\n完成：成功 ${succeeded} · 失败 ${results.filter((item) => item.status === "failed").length}`);
  if (results.some((item) => item.status === "failed")) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
