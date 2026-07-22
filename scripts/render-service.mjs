import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePlannedShots } from "../app/lib/timeline.js";
import { normalizeScreenRatio, promptForScreenRatio } from "../app/lib/video.js";
import { cleanupFilters, voicePreset, voicePresetSummaries } from "../app/lib/audio.js";
import { normalizeSubtitleStyle, subtitleAssColor, subtitleAssOverrideColor } from "../app/lib/subtitle-style.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(root, ".shortform");
const exportRoot = path.join(workRoot, "exports");
const assetRoot = path.join(workRoot, "assets");
const audioPreviewRoot = path.join(workRoot, "audio-previews");
const bgmRoot = path.join(root, "public", "bgm");

async function loadEnvironmentFile(filename) {
  try {
    const source = await readFile(path.join(root, filename), "utf8");
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

// Load local overrides first, then use .env to fill any settings they omit.
await loadEnvironmentFile(".env.local");
await loadEnvironmentFile(".env");
const port = Number(process.env.SHORTFORM_PORT || 4317);

const providerDefaults = {
  image: {
    openai: { endpoint:"https://api.openai.com/v1/images/generations", model:"gpt-image-1" },
    volcengine: { endpoint:"https://ark.cn-beijing.volces.com/api/v3/images/generations", model:"doubao-seedream-5-0-260128" },
    sdwebui: { endpoint:"http://127.0.0.1:7860", model:"Local checkpoint" },
  },
  video: {
    volcengine: { endpoint:"https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", model:"doubao-seedance-2-0-260128" },
  },
  text: {
    openai: { endpoint:"https://api.openai.com/v1/chat/completions", model:"gpt-4.1-mini" },
    volcengine: { endpoint:"https://ark.cn-beijing.volces.com/api/v3/chat/completions", model:"doubao-seed-2-1-turbo-260628" },
  },
};

function selectedProvider(modality, fallback) {
  return String(process.env[`${modality.toUpperCase()}_PROVIDER`] || fallback).trim().toLowerCase();
}

function configuredProvider(modality, kind, fallbackKind) {
  const normalizedKind = String(kind || fallbackKind).trim().toLowerCase();
  const modalityName = modality.toUpperCase();
  const providerName = normalizedKind.replace(/[^a-z0-9]+/g, "_").toUpperCase();
  const defaults = providerDefaults[modality]?.[normalizedKind] || {};
  const selected = selectedProvider(modality, fallbackKind);
  return {
    kind: normalizedKind,
    endpoint: process.env[`${providerName}_${modalityName}_ENDPOINT`] || defaults.endpoint || "",
    model: (normalizedKind === selected ? process.env[`${modalityName}_MODEL`] : "") || defaults.model || "",
    apiKey: process.env[`${providerName}_API_KEY`] || "",
  };
}

const configuredImageProvider = (kind = selectedProvider("image", "openai")) => configuredProvider("image", kind, "openai");
const configuredTextProvider = (kind = selectedProvider("text", "openai")) => configuredProvider("text", kind, "openai");
const configuredVideoProvider = (kind = selectedProvider("video", "volcengine")) => configuredProvider("video", kind, "volcengine");

function environmentProviders() {
  const imageKind = selectedProvider("image", "openai");
  const textKind = selectedProvider("text", "openai");
  return {
    image: configuredImageProvider(imageKind),
    video: configuredVideoProvider(selectedProvider("video", "volcengine")),
    text: configuredTextProvider(textKind),
    transcription: {
      endpoint: process.env.TRANSCRIPTION_ENDPOINT || "http://localhost:8000/v1/transcriptions",
      language: process.env.TRANSCRIPTION_LANGUAGE || "en",
    },
  };
}

export function getProviderStatus() {
  const providers = environmentProviders();
  return {
    image: { configured: providers.image.kind === "sdwebui" ? Boolean(providers.image.endpoint) : Boolean(providers.image.apiKey), kind: providers.image.kind, endpoint: providers.image.endpoint, model: providers.image.model, source: providers.image.apiKey ? "environment" : "default" },
    video: { configured:Boolean(providers.video.apiKey && providers.video.model), kind:providers.video.kind, endpoint:providers.video.endpoint, model:providers.video.model, source:providers.video.apiKey ? "environment" : "default" },
    text: { configured: Boolean(providers.text.apiKey && providers.text.model), kind:providers.text.kind, endpoint: providers.text.endpoint, model: providers.text.model, source: providers.text.apiKey ? "environment" : "default" },
    transcription: { configured:Boolean(providers.transcription.endpoint), endpoint:providers.transcription.endpoint, language:providers.transcription.language, source:process.env.TRANSCRIPTION_ENDPOINT ? "environment" : "default" },
  };
}

function resolveVideoProvider(data = {}) {
  const kind = data.videoKind || data.kind || environmentProviders().video.kind;
  const configured = configuredVideoProvider(kind);
  return {
    kind:configured.kind,
    endpoint:data.endpoint || data.videoEndpoint || configured.endpoint,
    model:data.model || data.videoModel || configured.model,
    apiKey:data.apiKey || data.videoApiKey || configured.apiKey,
    prompt:data.prompt,
    videoPrompt:data.videoPrompt,
    image:data.image,
    motion:data.motion,
    duration:data.duration,
    screenRatio:data.screenRatio,
  };
}

function resolveImageProvider(data = {}) {
  const kind = data.kind || environmentProviders().image.kind;
  const configured = configuredImageProvider(kind);
  if (configured.kind === "sdwebui") return { ...configured, ...data, kind:configured.kind, apiKey:data.apiKey || "" };
  return {
    kind:configured.kind,
    endpoint:data.endpoint || configured.endpoint,
    model:data.model || configured.model,
    apiKey:data.apiKey || configured.apiKey,
    prompt:data.prompt,
    screenRatio:data.screenRatio,
  };
}

function resolveTextProvider(data = {}) {
  const kind = data.textKind || data.kind || environmentProviders().text.kind;
  const configured = configuredTextProvider(kind);
  return {
    kind:configured.kind,
    endpoint:data.endpoint || configured.endpoint,
    model:data.model || configured.model,
    apiKey:data.apiKey || configured.apiKey,
    lines: data.lines,
    script: data.script,
    contentFormat: data.contentFormat,
    visualStyle: data.visualStyle,
    creativeDirection: data.creativeDirection,
    screenRatio: data.screenRatio,
    audioDuration: data.audioDuration,
    transcription: data.transcription,
  };
}

function cors(extra = {}) {
  return { "Access-Control-Allow-Origin": "http://localhost:3000", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", ...extra };
}

function json(res, status, value) {
  res.writeHead(status, cors({ "Content-Type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify(value));
}

async function body(req, maxBytes = 160 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error("Request is too large"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function fromDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value || "");
  if (!match) throw new Error("Invalid media data");
  return { mime: match[1] || "application/octet-stream", data: match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3])) };
}

export function normalizeTranscription(result = {}) {
  const segments = Array.isArray(result.segments) ? result.segments.map((segment, index) => ({
    id:segment?.id ?? index,
    start:Number(segment?.start) || 0,
    end:Number(segment?.end) || 0,
    text:String(segment?.text || "").trim(),
    words:Array.isArray(segment?.words) ? segment.words.map((word) => ({ start:Number(word?.start) || 0, end:Number(word?.end) || 0, word:String(word?.word || ""), probability:Number.isFinite(Number(word?.probability)) ? Number(word.probability) : null })) : [],
  })) : [];
  const lastEnd = segments.reduce((value, segment) => Math.max(value, segment.end), 0);
  return {
    text:String(result.text || segments.map((segment) => segment.text).join(" ")).trim(),
    language:String(result.language || ""),
    languageProbability:Number.isFinite(Number(result.language_probability)) ? Number(result.language_probability) : null,
    duration:Number(result.duration) || lastEnd,
    durationAfterVad:Number(result.duration_after_vad) || 0,
    segments,
  };
}

export async function transcribeAudio(payload = {}, options = {}) {
  const providers = environmentProviders();
  const endpoint = String(payload.endpoint || providers.transcription.endpoint || "").trim();
  const language = String(payload.language || providers.transcription.language || "en").trim();
  if (!endpoint) throw new Error("A local transcription service URL is required");
  const media = fromDataUrl(payload.audioData);
  const form = new FormData();
  form.append("file", new Blob([media.data], { type:media.mime }), String(payload.filename || "narration.mp3"));
  form.append("language", language);
  form.append("word_timestamps", "true");
  const response = await (options.fetchImpl || fetch)(endpoint, { method:"POST", body:form });
  if (!response.ok) {
    let detail = "";
    try { const result = await response.json(); detail = result.error?.message || result.error || result.detail || result.message || ""; } catch { detail = await response.text().catch(() => ""); }
    throw new Error(detail || `Local transcription service returned ${response.status}`);
  }
  return normalizeTranscription(await response.json());
}

async function saveMedia(value, targetBase, fetchImpl = fetch) {
  if (!value) return "";
  let mime = "application/octet-stream"; let data; let remoteExtension = "";
  if (/^https?:\/\//.test(value)) {
    try { remoteExtension = path.extname(new URL(value).pathname).toLowerCase(); } catch { /* response MIME remains authoritative */ }
    const response = await fetchImpl(value); if (!response.ok) throw new Error(`Could not download generated media (${response.status})`);
    mime = response.headers.get("content-type") || mime; data = Buffer.from(await response.arrayBuffer());
  } else ({ mime, data } = fromDataUrl(value));
  const ext = mime.includes("png") ? ".png" : mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : mime.startsWith("video/") ? ".mp4" : mime.includes("wav") ? ".wav" : mime.includes("mpeg") ? ".mp3" : mime.includes("mp4") ? ".m4a" : [".png",".jpg",".jpeg",".mp4",".wav",".mp3",".m4a"].includes(remoteExtension) ? remoteExtension : ".bin";
  const filename = `${targetBase}${ext}`; await writeFile(filename, data); return filename;
}

export async function persistGeneratedImage(value, options = {}) {
  if (!value) throw new Error("Provider returned no image");
  await mkdir(assetRoot, { recursive:true });
  const filename = await saveMedia(value, path.join(assetRoot, options.id || randomUUID()), options.fetchImpl || fetch);
  return {
    path:filename,
    url:`http://127.0.0.1:${port}/assets/${encodeURIComponent(path.basename(filename))}`,
  };
}

export async function persistGeneratedVideo(value, options = {}) {
  if (!value) throw new Error("Provider returned no video");
  await mkdir(assetRoot, { recursive:true });
  const filename = await saveMedia(value, path.join(assetRoot, options.id || randomUUID()), options.fetchImpl || fetch);
  if (path.extname(filename).toLowerCase() !== ".mp4") throw new Error("Provider returned an unsupported video format");
  return {
    path:filename,
    url:`http://127.0.0.1:${port}/assets/${encodeURIComponent(path.basename(filename))}`,
  };
}

function assetContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

async function providerImageUrl(value) {
  if (!value) throw new Error("A generated storyboard image is required before creating a clip");
  if (/^data:image\//.test(value)) return value;
  try {
    const url = new URL(value);
    if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.pathname.startsWith("/assets/")) {
      const filename = path.join(assetRoot, path.basename(decodeURIComponent(url.pathname)));
      const mime = assetContentType(filename);
      if (!mime.startsWith("image/")) throw new Error("The local storyboard asset is not an image");
      return `data:${mime};base64,${(await readFile(filename)).toString("base64")}`;
    }
  } catch (error) {
    if (error instanceof TypeError) throw new Error("The storyboard image URL is invalid");
    throw error;
  }
  return value;
}

export async function prepareProviderImage(value, screenRatio, options = {}) {
  const ratio = normalizeScreenRatio(screenRatio);
  const dimensions = ratio === "16:9" ? { width:1280, height:720 } : ratio === "1:1" ? { width:960, height:960 } : { width:720, height:1280 };
  const workDir = options.workDir || assetRoot;
  const id = options.id || randomUUID();
  await mkdir(workDir, { recursive:true });
  const sourceValue = await providerImageUrl(value);
  const source = await saveMedia(sourceValue, path.join(workDir, `${id}-source`), options.fetchImpl || fetch);
  const output = path.join(workDir, `${id}-${ratio.replace(":", "x")}.png`);
  const filter = `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase,crop=${dimensions.width}:${dimensions.height},setsar=1`;
  try {
    await run("ffmpeg", ["-y", "-i", source, "-frames:v", "1", "-vf", filter, "-compression_level", "6", output]);
    return `data:image/png;base64,${(await readFile(output)).toString("base64")}`;
  } finally {
    await Promise.all([unlink(source).catch(() => {}), unlink(output).catch(() => {})]);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] }); let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 30000) stderr = stderr.slice(-30000); });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr.slice(-2500)}`)));
  });
}

async function renderNarrationStages(source, presetId, jobDir, prefix = "voice") {
  const preset = voicePreset(presetId);
  const raw = path.join(jobDir, `${prefix}-raw.wav`);
  const clean = path.join(jobDir, `${prefix}-clean.wav`);
  await run("ffmpeg", ["-y", "-i", source, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le", raw]);
  if (preset.id === "original") return { preset, raw, clean:raw, final:raw };
  await run("ffmpeg", ["-y", "-i", raw, "-af", cleanupFilters(preset.id).join(","), "-ar", "48000", "-c:a", "pcm_s24le", clean]);
  return { preset, raw, clean, final:clean };
}

export async function processNarration(payload = {}, options = {}) {
  if (!payload.audioData) throw new Error("Recorded narration is required");
  const preset = voicePreset(payload.preset);
  const id = options.id || randomUUID();
  const jobDir = options.jobDir || path.join(audioPreviewRoot, id);
  await mkdir(jobDir, { recursive:true });
  const source = await saveMedia(payload.audioData, path.join(jobDir, "source"));
  const stages = await renderNarrationStages(source, preset.id, jobDir);

  const base = `/audio/${encodeURIComponent(id)}`;
  return {
    id,
    preset:{ id:preset.id, label:preset.label, pitchSemitones:preset.pitchSemitones },
    stages:{ raw:`${base}/${path.basename(stages.raw)}`, clean:`${base}/${path.basename(stages.clean)}`, final:`${base}/${path.basename(stages.final)}` },
    format:{ sampleRate:48000, channels:1, bitDepth:24 },
    engines:{ denoise:preset.id === "denoise" ? "FFmpeg afftdn · light reduction" : "Off", pitch:"None" },
  };
}

function assTime(value) {
  const h = Math.floor(value / 3600); const m = Math.floor(value / 60) % 60; const s = Math.floor(value) % 60; const cs = Math.floor((value % 1) * 100);
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
}

function assText(value) { return String(value || "").replace(/\\/g, "\\\\").replace(/[\r\n]+/g, " ").replace(/\{/g, "（").replace(/\}/g, "）"); }

export function buildSubtitleAss(shots, width, height, value = {}) {
  const style = normalizeSubtitleStyle(value);
  const fontSize = Math.max(10, Math.round(height * .028 * style.fontScale / 100));
  const marginV = Math.round(height * style.position / 100); const marginH = Math.round(width * .065);
  const alignment = { left:1, center:2, right:3 }[style.alignment];
  const primary = subtitleAssColor(style.englishColor); const chinese = subtitleAssOverrideColor(style.chineseColor);
  const outline = subtitleAssColor(style.backgroundColor); const background = subtitleAssColor(style.backgroundColor, style.backgroundOpacity);
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Main,${style.fontFamily},${fontSize},${primary},&H000000FF,${outline},&HFF000000,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outline},0,${alignment},${marginH},${marginH},${marginV},1\nStyle: Box,Arial,1,${background},${background},${background},${background},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = shots.flatMap((shot) => {
    const englishText = assText(shot.narration); const chineseText = assText(shot.chinese);
    const text = [englishText, chineseText ? `{\\c${chinese}}${chineseText}` : ""].filter(Boolean).join("\\N");
    const lines = Math.max(1, Number(Boolean(englishText)) + Number(Boolean(chineseText)));
    const paddingY = Math.max(4, Math.round(fontSize * .55)); const lineHeight = Math.round(fontSize * 1.3);
    const boxHeight = lines * lineHeight + paddingY * 2; const boxWidth = width - marginH * 2;
    const boxBottom = Math.min(height, height - marginV + paddingY); const boxTop = Math.max(0, boxBottom - boxHeight);
    const box = `{\\an7\\pos(${marginH},${boxTop})\\p1}m 0 0 l ${boxWidth} 0 l ${boxWidth} ${boxHeight} l 0 ${boxHeight}{\\p0}`;
    return [
      ...(style.backgroundOpacity > 0 ? [`Dialogue: 0,${assTime(shot.start)},${assTime(shot.end)},Box,,0,0,0,,${box}`] : []),
      `Dialogue: 1,${assTime(shot.start)},${assTime(shot.end)},Main,,0,0,0,,${text}`,
    ];
  });
  return header + events.join("\n");
}

// Ken Burns-style motion for still shots. The zoom ramps across the whole shot
// (never resets mid-clip) and the source is supersampled 3x before zoompan so
// the crop window moves in sub-output-pixel steps (no jitter).
export function stillMotionFilter(motion, width, height, duration, index = 0) {
  const frames = Math.max(1, Math.round((Number(duration) || 2) * 30));
  const hiRes = `scale=${width * 3}:${height * 3}:force_original_aspect_ratio=increase:out_range=tv:out_color_matrix=bt709,crop=${width * 3}:${height * 3}`;
  const kinds = { "Slow push-in":"push", "Slow pull-out":"pull", "Slow drift":"drift", "Slow rise":"rise", "Slow sink":"sink", "Diagonal drift":"diagonal", "Push to subject":"push-subject", "Static":"static" };
  const rotation = ["push", "drift", "pull", "rise", "sink", "diagonal"];
  const kind = kinds[motion] || rotation[index % rotation.length];
  const cx = "iw/2-(iw/zoom/2)"; const cy = "ih/2-(ih/zoom/2)";
  let zoom = "1.12"; let x = cx; let y = cy;
  if (kind === "push") zoom = `1+0.14*on/${frames}`;
  else if (kind === "pull") zoom = `1.14-0.14*on/${frames}`;
  else if (kind === "drift") x = index % 2 ? `(iw-iw/zoom)*(1-on/${frames})` : `(iw-iw/zoom)*on/${frames}`;
  else if (kind === "rise") y = `(ih-ih/zoom)*on/${frames}`;
  else if (kind === "sink") y = `(ih-ih/zoom)*(1-on/${frames})`;
  else if (kind === "diagonal") { x = index % 2 ? `(iw-iw/zoom)*(1-on/${frames})` : `(iw-iw/zoom)*on/${frames}`; y = `(ih-ih/zoom)*on/${frames}`; }
  else if (kind === "push-subject") { zoom = `1+0.16*on/${frames}`; y = "(ih-ih/zoom)/3"; }
  else zoom = `1+0.04*on/${frames}`;
  return `${hiRes},zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=30,setsar=1,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`;
}

export function renderDimensions(payload = {}) {
  return {
    width:Math.min(1920, Math.max(360, Math.round(Number(payload.width) || 1080))),
    height:Math.min(1920, Math.max(360, Math.round(Number(payload.height) || 1920))),
  };
}

export async function renderEpisode(payload, options = {}) {
  if (!Array.isArray(payload.shots) || !payload.shots.length) throw new Error("At least one shot is required");
  if (payload.shots.length > 80) throw new Error("The MVP supports up to 80 shots per episode");
  const started = Date.now(); const id = options.id || randomUUID(); const jobDir = path.join(workRoot, "jobs", id);
  await mkdir(jobDir, { recursive: true }); await mkdir(exportRoot, { recursive: true });
  const { width, height } = renderDimensions(payload); const subtitleStyle = normalizeSubtitleStyle(payload.subtitleStyle);
  const total = Number(payload.shots.reduce((sum, shot) => sum + Math.max(.6, Number(shot.duration) || 2), 0).toFixed(2));
  let cursor = 0; const shots = [];
  for (let i = 0; i < payload.shots.length; i += 1) {
    if (!payload.shots[i].video && !payload.shots[i].image) throw new Error(`Shot ${i + 1} has no generated image or video clip`);
    const duration = Math.max(.6, Number(payload.shots[i].duration) || 2);
    const sourceValue = payload.shots[i].video || payload.shots[i].image;
    const source = await saveMedia(sourceValue, path.join(jobDir, `source-${String(i).padStart(3,"0")}`));
    const segment = path.join(jobDir, `segment-${String(i).padStart(3,"0")}.mp4`);
    const scale = `scale=${width}:${height}:force_original_aspect_ratio=increase:out_range=tv:out_color_matrix=bt709,crop=${width}:${height},fps=30,setsar=1`;
    const normalizedFormat = "format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709";
    const colorMetadata = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
    if (payload.shots[i].video) {
      await run("ffmpeg", ["-y", "-stream_loop", "-1", "-i", source, "-t", String(duration), "-an", "-vf", `${scale},${normalizedFormat}`, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", ...colorMetadata, segment]);
    } else {
      const stillMotion = stillMotionFilter(payload.shots[i].motion, width, height, duration, i);
      await run("ffmpeg", ["-y", "-loop", "1", "-i", source, "-t", String(duration), "-an", "-vf", stillMotion, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", ...colorMetadata, segment]);
    }
    shots.push({ ...payload.shots[i], duration, start:cursor, end:cursor + duration, source, segment }); cursor += duration;
  }
  let narration = await saveMedia(payload.narrationData, path.join(jobDir, "narration"));
  if (narration && payload.voicePreset !== "original") narration = (await renderNarrationStages(narration, "denoise", jobDir, "narration")).final;
  let customBgm = null;
  if (payload.bgmPath) {
    const filename = path.basename(String(payload.bgmPath));
    if (!/\.mp3$/i.test(filename)) throw new Error("The selected BGM format is not supported");
    customBgm = path.join(bgmRoot, filename);
    await readFile(customBgm);
  }
  const ass = path.join(jobDir, "captions.ass"); await writeFile(ass, buildSubtitleAss(shots, width, height, subtitleStyle));
  const concatFile = path.join(jobDir, "segments.txt");
  const quoteConcat = (value) => value.replace(/'/g, "'\\''");
  await writeFile(concatFile, shots.map((shot) => `file '${quoteConcat(shot.segment)}'`).join("\n"));
  const output = options.output || path.join(exportRoot, `${id}.mp4`); const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatFile];
  const audioInputs = [];
  if (narration) { audioInputs.push({ kind: "narration", index: 1 }); args.push("-i", narration); }
  if (customBgm) { audioInputs.push({ kind: "bgm", index: 1 + audioInputs.length }); args.push("-stream_loop", "-1", "-i", customBgm); }
  if (!audioInputs.length) { audioInputs.push({ kind:"silence", index:1 }); args.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"); }
  const filters = [];
  const escapedAss = ass.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  filters.push(`[0:v]setpts=PTS-STARTPTS,ass=filename='${escapedAss}'[vout]`);
  const narrationInput = audioInputs.find((item) => item.kind === "narration"); const bgmInput = audioInputs.find((item) => item.kind === "bgm");
  const requestedBgmVolume = Number(payload.bgmVolume); const bgmVolume = Number.isFinite(requestedBgmVolume) ? Math.max(0, Math.min(.2, requestedBgmVolume)) : .08;
  if (narrationInput && bgmInput) filters.push(`[${narrationInput.index}:a]volume=1[nar];[${bgmInput.index}:a]atrim=0:${total},volume=${bgmVolume}[bg];[nar][bg]amix=inputs=2:duration=longest:dropout_transition=2,alimiter=limit=.8414:level=false[aout]`);
  else if (narrationInput) filters.push(`[${narrationInput.index}:a]volume=1[aout]`);
  else if (bgmInput) filters.push(`[${bgmInput.index}:a]atrim=0:${total},volume=${bgmVolume}[aout]`);
  else filters.push(`[${audioInputs[0].index}:a]atrim=0:${total}[aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-t", String(total), "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output);
  await run("ffmpeg", args);
  return { id, output, url: `/renders/${path.basename(output)}`, seconds:(Date.now() - started) / 1000, duration:total, clipsUsed:shots.filter((shot) => shot.video).length, subtitleStyle };
}

export async function generateImage(data, options = {}) {
  data = resolveImageProvider(data);
  if (!data.endpoint) throw new Error("Provider endpoint is required");
  if (!data.model && data.kind !== "sdwebui") throw new Error("Provider model or endpoint ID is required");
  const fetchImpl = options.fetchImpl || fetch;
  const screenRatio = normalizeScreenRatio(data.screenRatio);
  const prompt = promptForScreenRatio(data.prompt, screenRatio);
  const sdSize = screenRatio === "16:9" ? { width:1344, height:768 } : screenRatio === "1:1" ? { width:1024, height:1024 } : { width:768, height:1344 };
  if (data.kind === "sdwebui") {
    const endpoint = data.endpoint.includes("txt2img") ? data.endpoint : `${data.endpoint.replace(/\/$/,"")}/sdapi/v1/txt2img`;
    const response = await fetchImpl(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ prompt, negative_prompt:"text, watermark, logo, low quality, distorted anatomy, duplicate subjects", ...sdSize, steps:28 }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || `Provider returned ${response.status}`); if (!result.images?.[0]) throw new Error("Provider returned no image");
    return `data:image/png;base64,${result.images[0]}`;
  }
  const volcengineSize = screenRatio === "16:9" ? "2560x1440" : screenRatio === "1:1" ? "1920x1920" : "1440x2560";
  const openaiSize = screenRatio === "16:9" ? "1536x1024" : screenRatio === "1:1" ? "1024x1024" : "1024x1536";
  const requestBody = data.kind === "volcengine"
    ? { model:data.model, prompt, size:volcengineSize, response_format:"url", watermark:false }
    : { model:data.model, prompt, size:openaiSize, n:1, response_format:"b64_json" };
  const endpoint = data.kind === "volcengine" ? providerEndpoint(data.endpoint, "images/generations") : data.endpoint;
  const response = await fetchImpl(endpoint, { method:"POST", headers:{"Content-Type":"application/json",...(data.apiKey?{Authorization:`Bearer ${data.apiKey}`}:{})}, body:JSON.stringify(requestBody) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || result.error || `Provider returned ${response.status}`); const item = result.data?.[0]; if (!item) throw new Error("Provider returned no image");
  return item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
}

function providerEndpoint(endpoint, pathSuffix) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  if (!base) return "";
  return base.endsWith(`/${pathSuffix}`) ? base : `${base}/${pathSuffix}`;
}

function videoTasksEndpoint(endpoint) {
  return providerEndpoint(endpoint, "contents/generations/tasks");
}

function textCompletionsEndpoint(endpoint) {
  return providerEndpoint(endpoint, "chat/completions");
}

function isVolcenginePlanEndpoint(endpoint) {
  return /\/api\/plan\/v3(?:\/|$)/.test(String(endpoint || ""));
}

function providerError(result, status) {
  return result?.error?.message || (typeof result?.error === "string" ? result.error : "") || result?.message || `Provider returned ${status}`;
}

export async function generateVideo(data, options = {}) {
  data = resolveVideoProvider(data);
  if (data.kind !== "volcengine") throw new Error("Volcengine Ark is the only configured video provider");
  if (!data.endpoint || !data.apiKey || !data.model) throw new Error("Video endpoint, API key, and model are required");
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || Number(process.env.VIDEO_POLL_INTERVAL_MS) || 5000);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || Number(process.env.VIDEO_REQUEST_TIMEOUT_MS) || 15 * 60 * 1000);
  const endpoint = videoTasksEndpoint(data.endpoint);
  const screenRatio = normalizeScreenRatio(data.screenRatio);
  const duration = Math.max(2, Math.min(12, Math.ceil(Number(data.duration) || 5)));
  const image = await prepareProviderImage(data.image, screenRatio, { fetchImpl:options.imageFetchImpl });
  const direction = String(data.motion || "Slow push-in").trim();
  const motionPrompt = promptForScreenRatio(data.videoPrompt || data.prompt || "Animate this storyboard frame naturally with coherent subject and environmental motion", screenRatio);
  const prompt = `${motionPrompt}. Camera direction override: ${direction}. Treat the supplied image as the exact first frame. Preserve its subject identity, composition, lighting, and visual style throughout one continuous shot; avoid text, logos, cuts, flicker, warping, morphing, or new subjects.`;
  const headers = { "Content-Type":"application/json", Authorization:`Bearer ${data.apiKey}` };
  const createdResponse = await fetchImpl(endpoint, { method:"POST", headers, body:JSON.stringify({
    model:data.model,
    content:[
      { type:"text", text:prompt },
      { type:"image_url", image_url:{ url:image }, role:"first_frame" },
    ],
    duration,
    ratio:screenRatio,
    resolution:"720p",
    generate_audio:false,
    watermark:false,
  }) });
  const created = await createdResponse.json();
  if (!createdResponse.ok) throw new Error(providerError(created, createdResponse.status));
  if (!created.id) throw new Error("Video provider returned no task ID");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleepImpl(pollIntervalMs);
    const response = await fetchImpl(`${endpoint}/${encodeURIComponent(created.id)}`, { headers });
    const result = await response.json();
    if (!response.ok) throw new Error(providerError(result, response.status));
    if (result.status === "succeeded") {
      if (!result.content?.video_url) throw new Error("Video task succeeded without a download URL");
      return { taskId:created.id, videoUrl:result.content.video_url, duration:Number(result.duration) || duration, status:result.status };
    }
    if (result.status === "failed" || result.status === "cancelled") throw new Error(providerError(result, result.status));
    if (result.status !== "queued" && result.status !== "running") throw new Error(`Video provider returned unexpected task status: ${result.status || "unknown"}`);
  }
  throw new Error(`Video generation timed out after ${Math.round(timeoutMs / 1000)} seconds`);
}

export async function completeText(data, messages, options = {}) {
  data = resolveTextProvider(data);
  if (!data.endpoint || !data.apiKey || !data.model) throw new Error("Text endpoint, API key, and model or endpoint ID are required");
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || Number(process.env.TEXT_REQUEST_TIMEOUT_MS) || 120000);
  const endpoint = data.kind === "volcengine" ? textCompletionsEndpoint(data.endpoint) : data.endpoint;
  const requestedMaxTokens = Number(options.maxTokens);
  const payload = data.kind === "volcengine" && isVolcenginePlanEndpoint(endpoint)
    ? { model:data.model, messages, ...(Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0 ? { max_tokens:Math.floor(requestedMaxTokens) } : {}) }
    : { model:data.model, temperature:options.temperature ?? .2, max_tokens:options.maxTokens ?? 8000, response_format:{type:"json_object"}, ...(data.kind === "volcengine" ? { thinking:{ type:"disabled" } } : {}), messages };
  const request = { method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${data.apiKey}`}, body:JSON.stringify(payload) };
  const callProvider = () => fetchImpl(endpoint, { ...request, signal:AbortSignal.timeout(timeoutMs) });
  let response;
  try { response = await callProvider(); }
  catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new Error(`Text provider timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { response = await callProvider(); }
    catch (retryError) {
      if (retryError?.name === "TimeoutError" || retryError?.name === "AbortError") throw new Error(`Text provider timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      throw retryError;
    }
  }
  if (response.status === 429 || response.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await callProvider();
  }
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || `Provider returned ${response.status}`);
  return result.choices?.[0]?.message?.content || "{}";
}

function parseProviderJson(raw) {
  let source = String(raw || "").trim();
  source = source.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const objectStart = source.indexOf("{");
  const objectEnd = source.lastIndexOf("}");
  if (objectStart >= 0) source = objectEnd > objectStart ? source.slice(objectStart, objectEnd + 1) : source.slice(objectStart);
  return JSON.parse(source);
}

async function parseOrRepairProviderJson(raw, config, options, expectedShape) {
  try { return parseProviderJson(raw); }
  catch (initialError) {
    const repaired = await completeText(config, [
      { role:"system", content:`Repair malformed or truncated JSON. Return one compact RFC 8259 JSON object only, without Markdown, comments, or explanation. Preserve the supplied schema and all complete data. Escape quotes, backslashes, and line breaks inside strings. If the input ends in an incomplete trailing array item, discard only that item and close the remaining arrays and objects. The required top-level shape is ${expectedShape}.` },
      { role:"user", content:String(raw || "") },
    ], { temperature:0, maxTokens:8000, fetchImpl:options.fetchImpl });
    try { return parseProviderJson(repaired); }
    catch (repairError) {
      throw new Error(`Text provider returned invalid JSON (${initialError.message}); automatic repair also failed (${repairError.message})`);
    }
  }
}

async function translate(data) {
  if (!Array.isArray(data.lines)) throw new Error("Subtitle lines are required");
  const raw = await completeText(data, [{role:"system",content:"Translate English short-video subtitles into concise, natural Simplified Chinese. Preserve names, numbers, dates, tone, and factual meaning. Return one compact RFC 8259 JSON object with a translations array in the same order. Do not use Markdown. Escape all quotes, backslashes, and line breaks inside strings."},{role:"user",content:JSON.stringify({lines:data.lines})}], { temperature:.2, maxTokens:8000 });
  const parsed = await parseOrRepairProviderJson(raw, resolveTextProvider(data), {}, "an object with a translations array"); if (!Array.isArray(parsed.translations)) throw new Error("Translation provider returned an unexpected format"); return parsed.translations;
}

export async function planEpisode(data, options = {}) {
  const config = resolveTextProvider(data);
  if (!config.apiKey || !config.model) throw new Error("No planning API key or model is configured");
  if (!String(config.script || "").trim()) throw new Error("A script is required");
  const system = `You are a senior storyboard editor for short-form social video. Break the supplied English narration into compelling visual shots suited to the requested content format and visual style. Preserve every spoken word in order across the narration fields; do not add unsupported facts. Return one compact RFC 8259 JSON object only, without Markdown, comments, or explanation, with a shots array. Escape every quote, backslash, and line break inside string values. Each shot must contain: narration (a non-empty exact consecutive excerpt), chinese (concise Simplified Chinese translation), type (Opening, Narrative, Climax, Map, Timeline, or Emotion), duration in seconds, prompt (a concise still-image generation prompt, at most 55 words, faithful to the narration, content format, visual style, creative direction, and requested screen ratio, with subject, setting, composition, lighting, and exclusions for text and watermark), videoPrompt (a separate image-to-video prompt, at most 55 words, describing specific subject action, secondary environmental motion, pace, camera behavior, and continuity from the supplied first frame; demand one continuous shot with stable identity and anatomy, and exclude cuts, new subjects, text, logos, flicker, warping, and morphing), and motion (one of Slow push-in, Slow pull-out, Slow drift, Slow rise, Slow sink, Diagonal drift, Push to subject, Static; vary the choice across shots, prefer Push to subject when the frame's subject occupies the upper third). For historical subjects or whenever the narration contains a date or period cue, every image prompt must explicitly name the most accurate era or date and location supported by the script, then describe a period-accurate background and relevant architecture, landscape or interior, clothing, materials, props, transport, weapons, and technology. Never mix eras or include anachronisms. If the precise year is uncertain, use a broader historically accurate period rather than inventing specificity. The videoPrompt must animate what is already established by prompt and must agree with motion; it must not invent a different scene. Never return an empty object, empty narration, placeholder shot, or trailing item merely to reach a requested count. Timing guidance: first five seconds 0.8–1.5 seconds per shot; ordinary narration 2–3; climaxes 1.5–2.5; maps and timelines 3–5; emotional turns 3–4; avoid static images over 4 seconds. When narration duration and shot-count guidance are supplied, create at least the minimum number of shots and aim for the target count by splitting long sentences into consecutive clauses; if the script cannot be split further, return fewer complete shots rather than an empty placeholder. The sum of shot durations must match the supplied narration duration. Adapt visual vocabulary to the episode instead of assuming any particular topic.`;
  const transcriptionSegments = Array.isArray(config.transcription?.segments) ? config.transcription.segments.map((segment) => ({ start:segment.start, end:segment.end, text:segment.text })) : [];
  const narrationDuration = Number(config.audioDuration) || Number(config.transcription?.duration) || 0;
  const minimumShotCount = narrationDuration ? Math.ceil(narrationDuration / 4) : null;
  const targetShotCount = narrationDuration ? Math.ceil(narrationDuration / 3.3) : null;
  const screenRatio = normalizeScreenRatio(config.screenRatio);
  const raw = await completeText(config, [{role:"system",content:system},{role:"user",content:JSON.stringify({script:config.script, contentFormat:config.contentFormat || "Documentary", visualStyle:config.visualStyle || "Photorealistic", creativeDirection:config.creativeDirection || "", screenRatio, narrationDurationSeconds:narrationDuration || null, minimumShotCount, targetShotCount, localTranscriptionSegments:transcriptionSegments})}], { temperature:.25, maxTokens:8000, fetchImpl:options.fetchImpl });
  const parsed = await parseOrRepairProviderJson(raw, config, options, "an object with a shots array");
  return normalizePlannedShots(parsed.shots, Number(config.audioDuration) || 0, { contentFormat:config.contentFormat, visualStyle:config.visualStyle, creativeDirection:config.creativeDirection, screenRatio, transcription:config.transcription });
}

function modelsEndpoint(endpoint, kind) {
  if (kind === "sdwebui") {
    const base = endpoint.replace(/\/sdapi\/v1\/txt2img\/?$/, "").replace(/\/$/, "");
    return `${base}/sdapi/v1/sd-models`;
  }
  const base = String(endpoint || "").replace(/\/+$/, "");
  if (/\/models$/.test(base)) return base;
  if (/\/(images\/generations|chat\/completions|contents\/generations\/tasks)$/.test(base)) return base.replace(/\/(images\/generations|chat\/completions|contents\/generations\/tasks)$/, "/models");
  return `${base}/models`;
}

export async function testProviderConnection(data, options = {}) {
  const target = data.target === "text" ? "text" : data.target === "video" ? "video" : "image";
  const config = target === "text" ? resolveTextProvider(data) : target === "video" ? resolveVideoProvider(data) : resolveImageProvider(data);
  if (!config.endpoint) throw new Error("Provider endpoint is required");
  if (target === "text" && !config.apiKey) throw new Error("No translation API key is configured");
  if (target === "video" && !config.apiKey) throw new Error("No video API key is configured");
  if (target === "image" && config.kind !== "sdwebui" && !config.apiKey) throw new Error("No image API key is configured");
  const fetchImpl = options.fetchImpl || fetch;
  const planText = target === "text" && config.kind === "volcengine" && isVolcenginePlanEndpoint(config.endpoint);
  const endpoint = planText ? textCompletionsEndpoint(config.endpoint) : target === "video" ? `${videoTasksEndpoint(config.endpoint)}?page_num=1&page_size=1` : modelsEndpoint(config.endpoint, config.kind);
  const response = await fetchImpl(endpoint, planText ? {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${config.apiKey}` },
    body:JSON.stringify({ model:config.model, messages:[{ role:"user", content:"Reply with OK." }] }),
  } : { headers: config.apiKey ? { Authorization:`Bearer ${config.apiKey}` } : {} });
  if (!response.ok) {
    let detail = "";
    try { const result = await response.json(); detail = result.error?.message || result.error || result.message || ""; } catch { /* status is enough */ }
    throw new Error(detail || `Provider returned ${response.status}`);
  }
  return { ok:true, target, model:config.model, endpoint:config.endpoint };
}

export function createRenderServer() {
  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, cors()); res.end(); return; }
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") { json(res, 200, { ok:true, ffmpeg:"available" }); return; }
      if (req.method === "GET" && url.pathname === "/audio/presets") { json(res, 200, { presets:voicePresetSummaries(), processing:"local" }); return; }
      if (req.method === "GET" && url.pathname === "/config/status") { json(res, 200, getProviderStatus()); return; }
      if (req.method === "GET" && url.pathname.startsWith("/audio/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length !== 3) throw new Error("Audio preview was not found");
        const file = path.join(audioPreviewRoot, path.basename(parts[1]), path.basename(parts[2])); await readFile(file);
        res.writeHead(200, cors({"Content-Type":"audio/wav","Content-Disposition":`inline; filename="${path.basename(file)}"`})); createReadStream(file).pipe(res); return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/renders/")) {
        const filename = path.basename(url.pathname); const file = path.join(exportRoot, filename); await readFile(file);
        res.writeHead(200, cors({"Content-Type":"video/mp4","Content-Disposition":`attachment; filename="${filename}"`})); createReadStream(file).pipe(res); return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const filename = path.basename(decodeURIComponent(url.pathname)); const file = path.join(assetRoot, filename); await readFile(file);
        res.writeHead(200, cors({"Content-Type":assetContentType(filename),"Cache-Control":"public, max-age=31536000, immutable"})); createReadStream(file).pipe(res); return;
      }
      if (req.method === "POST" && url.pathname === "/render") { const result = await renderEpisode(await body(req)); json(res, 200, result); return; }
      if (req.method === "POST" && url.pathname === "/image/generate") {
        const generated = await generateImage(await body(req, 2*1024*1024));
        const cached = await persistGeneratedImage(generated);
        json(res, 200, { image:cached.url }); return;
      }
      if (req.method === "POST" && url.pathname === "/video/generate") {
        const generated = await generateVideo(await body(req, 24*1024*1024));
        const cached = await persistGeneratedVideo(generated.videoUrl);
        json(res, 200, { video:cached.url, taskId:generated.taskId, duration:generated.duration }); return;
      }
      if (req.method === "POST" && url.pathname === "/text/translate") { json(res, 200, { lines:await translate(await body(req, 2*1024*1024)) }); return; }
      if (req.method === "POST" && url.pathname === "/text/plan") { json(res, 200, { shots:await planEpisode(await body(req, 4*1024*1024)) }); return; }
      if (req.method === "POST" && url.pathname === "/audio/transcribe") { json(res, 200, await transcribeAudio(await body(req))); return; }
      if (req.method === "POST" && url.pathname === "/audio/process") { json(res, 200, await processNarration(await body(req))); return; }
      if (req.method === "POST" && url.pathname === "/providers/test") { json(res, 200, await testProviderConnection(await body(req, 2*1024*1024))); return; }
      json(res, 404, { error:"Not found" });
    } catch (error) { json(res, 500, { error:error instanceof Error ? error.message : "Unexpected error" }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await Promise.all([mkdir(exportRoot, { recursive:true }), mkdir(assetRoot, { recursive:true })]); const server = createRenderServer(); server.listen(port, "127.0.0.1", () => console.log(`Shortform render service: http://127.0.0.1:${port}`));
}
