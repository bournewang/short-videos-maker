#!/usr/bin/env node
// 批量生成：按主题清单，逐条执行「脚本 → 配音 → 分镜 → 生图」，存为 episode(pending)。
// 直接 import 现有业务逻辑（render-service.mjs 导出的函数），复用 .env.local 配置。
//
// 用法：
//   node scripts/batch-generate.mjs --input topics.json
//   node scripts/batch-generate.mjs --topic "辛弃疾" --genre story --duration 3
//   node scripts/batch-generate.mjs --input topics.json --concurrency 2 --batch-id 20260907 --resume
//
// 主题清单 topics.json 示例（数组，字段均可被 CLI 覆盖）：
//   [
//     { "topic": "辛弃疾", "genre": "story", "duration": 3, "screenRatio": "9:16" },
//     { "topic": "The Battle of Hastings", "genre": "documentary", "duration": 4 }
//   ]

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EpisodeStore } from "./episode-store.mjs";
import {
  MAX_GROUP_IMAGES,
  extractCharacters,
  generateDocumentaryScript,
  generateStoryScript,
  planEpisode,
  synthesizeSpeechByGenre,
  generateImage,
  generateImageGroup,
  persistGeneratedImage,
} from "./render-service.mjs";
import { getGenre } from "../app/lib/genres.js";
import { normalizeSubtitleStyle } from "../app/lib/subtitle-style.js";
import { normalizeScreenRatio } from "../app/lib/video.js";
import { mapWithConcurrency } from "../app/lib/concurrency.js";
import { segmentCharacterShots } from "../app/lib/group-shots.js";

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.resolve(process.env.SHORTFORM_STORAGE_DIR || path.join(root, ".shortform"));
const batchRoot = path.join(workRoot, "batch");

// render-service.mjs 的 import 已触发 loadEnvironmentFile(".env.local"/".env")，
// 因此这里的 process.env 已含全部 provider 配置。
const store = new EpisodeStore({
  storageRoot: workRoot,
  assetRoot: path.join(workRoot, "assets"),
  exportRoot: path.join(workRoot, "exports"),
  publicBaseUrl: "http://127.0.0.1:4317",
});

const REVIEW_STATUSES = ["draft", "pending", "approved", "rejected"];

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

function asNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// 探测 data URL 音频时长（秒），用于 TTS 未返回字幕时间戳时的兜底。
async function probeDataUrlDuration(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!match) return 0;
  const mime = match[1] || "audio/mpeg";
  const buf = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
  const ext = mime.includes("wav") ? "wav" : mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : "m4a";
  const tmp = path.join(os.tmpdir(), `batch-probe-${randomUUID()}.${ext}`);
  await writeFile(tmp, buf);
  try {
    const { stdout } = await execFileP("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", tmp]);
    const duration = Number(String(stdout).trim());
    return Number.isFinite(duration) ? duration : 0;
  } catch { return 0; } finally { await unlink(tmp).catch(() => {}); }
}

function resolveTopic(raw, defaults) {
  const topic = String(raw?.topic || "").trim();
  const genre = String(raw?.genre || defaults.genre).trim();
  return {
    topic,
    genre: getGenre(genre).id,
    duration: asNumber(raw?.duration ?? defaults.duration, 3, 2, 6),
    productionMode: ["short-shots", "mixed", "long-scenes"].includes(raw?.productionMode) ? raw.productionMode : defaults.productionMode,
    screenRatio: normalizeScreenRatio(raw?.screenRatio || defaults.screenRatio),
    contentFormat: String(raw?.contentFormat || "").trim(),
    visualStyle: String(raw?.visualStyle || "").trim(),
    creativeDirection: String(raw?.creativeDirection || "").trim(),
  };
}

// 生图：group 模式走「角色图库 + 分段组图」；single 模式或无角色图库时全部逐张并发。
// 分段组图：人物镜头按「角色出场集合」切段，每段组图 reference 段内角色定妆图（参考图数 + 生成图数 ≤ MAX_GROUP_IMAGES）；
// 环境/文字卡镜头无需一致性锚点，逐张并发生成。
async function generateShotImages(shots, ctx) {
  if (!shots.length) return;
  const characterImages = Array.isArray(ctx.characters) ? ctx.characters : [];
  const imageByName = new Map(characterImages.filter((character) => character.image).map((character) => [character.name, character.image]));

  if (ctx.imageMode !== "single" && imageByName.size) {
    const characterShots = shots.filter((shot) => !shot.image && shot.subject === "character");
    const otherShots = shots.filter((shot) => !shot.image && shot.subject !== "character");
    const segments = segmentCharacterShots(characterShots, imageByName, MAX_GROUP_IMAGES);
    for (const segment of segments) {
      const refImages = segment.characterNames.map((name) => imageByName.get(name)).filter(Boolean);
      await generateSegment(segment.shots, refImages, ctx);
    }
    if (otherShots.length) {
      console.log(`  环境/文字卡镜头 ${otherShots.length} 个，逐张并发`);
      await generateIndividualShots(otherShots, [], ctx);
    }
    return;
  }

  const remaining = shots.filter((shot) => !shot.image);
  if (!remaining.length) return;
  await generateIndividualShots(remaining, [], ctx);
}

// 一段人物镜头：组图（reference 段内角色定妆图），失败或单张则回退逐张（仍带参考图）。
async function generateSegment(shots, refImages, ctx) {
  const label = refImages.length ? `（参考角色 ${refImages.length} 人）` : "";
  if (shots.length < 2) {
    await generateIndividualShots(shots, refImages, ctx);
    return;
  }
  try {
    const images = await generateImageGroup({ shots: shots.map((shot) => ({ prompt: shot.prompt })), referenceImages: refImages, screenRatio: ctx.screenRatio });
    for (let i = 0; i < shots.length; i += 1) {
      if (!images[i]) break;
      await persistShotImage(shots[i], images[i], ctx);
    }
    console.log(`  组图完成 ${shots.filter((shot) => shot.image).length}/${shots.length}${label}`);
  } catch (error) {
    console.warn(`  组图失败（${error.message}），回退逐张生图${label ? "（带角色参考）" : ""}`);
    await generateIndividualShots(shots, refImages, ctx);
  }
}

// 逐张并发，可选带参考图（环境镜头不带，人物镜头回退时带）。
async function generateIndividualShots(shots, refImages, ctx) {
  if (!shots.length) return;
  await mapWithConcurrency(shots, ctx.concurrency, async (shot) => {
    if (shot.image) return;
    try {
      const image = await generateImage({ prompt: shot.prompt, referenceImages: refImages, screenRatio: ctx.screenRatio });
      await persistShotImage(shot, image, ctx);
    } catch (error) {
      console.warn(`    shot ${shot.index ?? ""} 生图失败：${error.message}`);
    }
  });
}

// 角色图库：每个核心角色生成一张定妆图，作为分段组图的一致性锚点。
async function generateCharacterImages(characters, ctx) {
  const result = [];
  for (const character of characters) {
    try {
      const image = await generateImage({ prompt: character.appearance, screenRatio: ctx.screenRatio });
      const cached = await store.withMediaTarget(ctx.episodeId, ctx.title, "characters", character.name, async (target) => persistGeneratedImage(image, { screenRatio: ctx.screenRatio, ...target }));
      result.push({ name: character.name, appearance: character.appearance, image: cached.url });
      console.log(`  角色「${character.name}」定妆图 ✓`);
    } catch (error) {
      console.warn(`  角色「${character.name}」定妆图失败：${error.message}`);
      result.push({ name: character.name, appearance: character.appearance, image: "" });
    }
  }
  return result;
}

async function persistShotImage(shot, image, ctx) {
  const cached = await store.withMediaTarget(ctx.episodeId, ctx.title, "images", shot.id, async (target) => persistGeneratedImage(image, { screenRatio: ctx.screenRatio, ...target }));
  shot.image = cached.url;
  shot.imageStatus = "generated";
}

async function generateEpisode(entry, ctx, { skipImages }) {
  const genre = getGenre(entry.genre);
  const contentFormat = entry.contentFormat || genre.defaultContentFormat;
  const visualStyle = entry.visualStyle || genre.defaultVisualStyle;
  console.log(`\n▶ [${entry.genre}] ${entry.topic}（${entry.duration} 分钟）`);

  // 1. 脚本
  const scriptFn = genre.id === "story" ? generateStoryScript : generateDocumentaryScript;
  const { title, script } = await scriptFn({ topic: entry.topic, duration: entry.duration, creativeDirection: entry.creativeDirection });
  console.log(`  标题：${title}`);

  // 2. 配音（按 genre 路由 MiniMax / 豆包）
  const tts = await synthesizeSpeechByGenre({ genre: genre.id, script: entry.script || script });
  const audioDuration = Number(tts.transcription?.duration) || (await probeDataUrlDuration(tts.audioData));
  console.log(`  配音：${tts.voice} · ${audioDuration.toFixed(1)}s`);

  const episodeId = `episode-${randomUUID()}`;

  // 3. 角色提取 + 角色图库（一致性锚点：供分镜打角色标签 + 分段组图）
  const characterList = await extractCharacters({ genre: genre.id, script }).catch((error) => {
    console.warn(`  角色提取失败（${error.message}），跳过角色锚定`);
    return [];
  });
  let characters = characterList.map((character) => ({ ...character, image: "" }));
  if (characterList.length) console.log(`  角色：${characterList.map((character) => character.name).join("、")}`);
  if (!skipImages && characterList.length) {
    characters = await generateCharacterImages(characterList, { episodeId, title, screenRatio: entry.screenRatio });
  }

  // 4. 分镜（带真实配音时长 + 字幕时间戳 + 角色清单，让 shot 时长贴合配音并标注出场角色）
  const planned = await planEpisode({
    genre: genre.id,
    script,
    contentFormat,
    visualStyle,
    creativeDirection: entry.creativeDirection,
    productionMode: entry.productionMode,
    longClipDuration: 10,
    shortClipDuration: 15,
    screenRatio: entry.screenRatio,
    audioDuration,
    transcription: tts.transcription,
    characters,
  });
  const shots = planned.map((shot, index) => ({
    ...shot,
    id: `shot-${Date.now()}-${index}`,
    status: "planned",
    locked: false,
    image: "",
    variants: [],
    imageStatus: "idle",
    imageError: "",
    provider: "",
    seed: "",
    video: "",
    videoStatus: "idle",
    videoError: "",
    videoProvider: "",
  }));
  console.log(`  分镜：${shots.length} 个 shot`);

  // 5. 生图（分段组图：人物镜头锚定角色图库，环境/文字卡逐张并发）
  if (!skipImages) {
    await generateShotImages(shots, { episodeId, title, screenRatio: entry.screenRatio, concurrency: ctx.concurrency, imageMode: ctx.imageMode, characters });
    console.log(`  生图：${shots.filter((shot) => shot.image).length}/${shots.length} 完成`);
  }

  // 5. 组装 project 并保存（reviewStatus=pending，进入人工复核）
  const subtitleFont = genre.subtitleFont || "Arial";
  const project = {
    id: episodeId,
    stage: "storyboard",
    title,
    script,
    genre: genre.id,
    doubaoSpeaker: "zh_male_xuanyijieshuo_uranus_bigtts",
    doubaoSpeechRate: -10,
    contentFormat,
    visualStyle,
    creativeDirection: entry.creativeDirection,
    productionMode: entry.productionMode,
    longClipDuration: 10,
    shortClipDuration: 15,
    shots,
    characters,
    selectedId: shots[0]?.id || "",
    audioName: tts.filename,
    audioData: tts.audioData,
    audioDuration,
    transcription: tts.transcription,
    denoiseNarration: true,
    bgm: "",
    bgmVolume: 8,
    subtitleStyle: normalizeSubtitleStyle({ fontFamily: subtitleFont }),
    broadcastMode: false,
    headlineText: "",
    headlinePosition: 4,
    headlineStyle: { fontFamily: "Arial", fontScale: 100, textColor: "#ffffff", bgColor: "#000000", bgOpacity: 65, textAlign: "center" },
    mode: "Review then batch",
    previewUrl: "",
    downloadUrl: "",
    coverHeadline: title,
    coverTitlePosition: "bottom-left",
    coverTitleVertical: 90,
    coverTitleScale: 100,
    coverTitleWidth: 84,
    coverPrompt: "",
    covers: [],
    coverShotId: "",
    chosenCoverUrl: "",
    videoBuilds: [],
    downloadResolution: "1080",
    screenRatio: entry.screenRatio,
    reviewStatus: "pending",
    reviewedAt: 0,
  };
  await store.saveEpisode(project, { setActive: false });
  return { id: episodeId, title, shotCount: shots.length, audioDuration, status: "pending" };
}

async function readManifest(batchId) {
  const file = path.join(batchRoot, batchId, "manifest.json");
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function writeManifest(batchId, manifest) {
  const dir = path.join(batchRoot, batchId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  const help = args.help || args.h;
  if (help) {
    console.log(`批量生成历史故事（脚本→配音→分镜→生图→存 episode pending）

用法：
  node scripts/batch-generate.mjs --input topics.json [选项]
  node scripts/batch-generate.mjs --topic "辛弃疾" --genre story --duration 3 [选项]

选项：
  --input <file>          主题清单 JSON 文件（数组）
  --topic <str>           单个主题（不用 --input 时）
  --genre <id>            默认 genre：story（中文人物故事）| documentary（英语纪录片）
  --duration <min>        时长（2-6 分钟），默认 3
  --production-mode <m>   short-shots | mixed | long-scenes，默认 short-shots
  --screen-ratio <r>      9:16 | 16:9 | 1:1，默认 9:16
  --content-format <s>    覆盖 genre 默认内容格式
  --visual-style <s>      覆盖 genre 默认视觉风格
  --creative-direction <s> 创作方向说明
  --concurrency <n>       生图/并发数，默认 2
  --image-mode <m>       group(默认，角色图库+分段组图，锚定主角一致性) | single(逐张并发，更快)
  --batch-id <id>         批次 ID（用于断点续传）
  --resume                跳过本批次已成功的主题
  --force                 即使已成功也重跑
  --skip-images           只生成脚本+配音+分镜，跳过生图
  --dry-run               只打印将要生成的主题清单，不执行`);
    return;
  }

  await store.initialize();

  // 主题清单
  let entries = [];
  if (args.input) {
    const raw = JSON.parse(await readFile(path.resolve(args.input), "utf8"));
    entries = (Array.isArray(raw) ? raw : raw.topics || []).map((item) => resolveTopic(item, args)).filter((item) => item.topic);
  } else if (args.topic) {
    entries = [resolveTopic({ topic: args.topic }, args)];
  } else {
    throw new Error("请提供 --input <file> 或 --topic <str>");
  }

  const batchId = String(args["batch-id"] || `batch-${Date.now()}`);
  const concurrency = Math.max(1, Math.floor(Number(args.concurrency) || 2));
  const imageMode = args["image-mode"] === "single" ? "single" : "group";
  const skipImages = Boolean(args["skip-images"] || args.skipImages);
  const force = Boolean(args.force);

  // 断点续传：读已有 manifest，跳过已成功主题
  const previous = args.resume ? await readManifest(batchId) : null;
  const doneTopics = new Set((previous?.topics || []).filter((item) => item.status === "success").map((item) => item.topic));

  if (args["dry-run"]) {
    console.log(`批次 ${batchId} · ${entries.length} 个主题（dry-run）：`);
    entries.forEach((entry, index) => console.log(`  ${index + 1}. [${entry.genre}] ${entry.topic} · ${entry.duration} 分钟 · ${entry.screenRatio}`));
    return;
  }

  console.log(`批次 ${batchId} · 共 ${entries.length} 个主题 · 并发 ${concurrency}${skipImages ? " · 跳过生图" : ""}`);

  const manifest = { batchId, createdAt: Date.now(), topics: [] };
  const results = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const label = `[${i + 1}/${entries.length}] [${entry.genre}] ${entry.topic}`;
    if (!force && doneTopics.has(entry.topic)) {
      console.log(`\n⏭ ${label} 已在本批次成功过，跳过（--force 可重跑）`);
      results.push({ ...entry, status: "skipped" });
      manifest.topics.push({ topic: entry.topic, genre: entry.genre, status: "skipped" });
      continue;
    }
    try {
      const result = await generateEpisode(entry, { concurrency, imageMode }, { skipImages });
      results.push({ ...entry, ...result, status: "success" });
      manifest.topics.push({ topic: entry.topic, genre: entry.genre, status: "success", episodeId: result.id, title: result.title, shotCount: result.shotCount, audioDuration: result.audioDuration });
      console.log(`✅ ${label} → ${result.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ...entry, status: "failed", error: message });
      manifest.topics.push({ topic: entry.topic, genre: entry.genre, status: "failed", error: message });
      console.error(`❌ ${label} → ${message}`);
    }
  }

  await writeManifest(batchId, manifest);
  const succeeded = results.filter((item) => item.status === "success").length;
  const failed = results.filter((item) => item.status === "failed").length;
  console.log(`\n完成：成功 ${succeeded} · 失败 ${failed} · 跳过 ${results.filter((item) => item.status === "skipped").length}`);
  console.log(`manifest：${path.join(batchRoot, batchId, "manifest.json")}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
