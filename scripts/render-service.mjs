import { createServer } from "node:http";
import https from "node:https";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePlannedShots } from "../app/lib/timeline.js";
import { normalizeScreenRatio, promptForScreenRatio } from "../app/lib/video.js";
import { cleanupFilters, voicePreset, voicePresetSummaries } from "../app/lib/audio.js";
import { normalizeSubtitleStyle, subtitleAssColor, subtitleAssOverrideColor } from "../app/lib/subtitle-style.js";
import { getGenre } from "../app/lib/genres.js";
import { subtitleCues } from "../app/lib/subtitles.js";
import { EpisodeStore } from "./episode-store.mjs";
import { DigitalHumanStore } from "./digital-human-store.mjs";
import { DigitalHumanProjectStore } from "./digital-human-project-store.mjs";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
// Ensure ffmpeg / ffprobe are reachable. WorkBuddy's restricted shell PATH
// often omits /opt/homebrew/bin, which makes spawn("ffmpeg") fail with
// ENOENT. Detect known install dirs and prepend whichever holds ffmpeg.
{
  const candidates = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
  const current = String(process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of candidates) {
    if (current.includes(dir)) continue;
    if (existsSync(path.join(dir, "ffmpeg"))) { process.env.PATH = [dir, ...current].join(":"); break; }
  }
}
const port = Number(process.env.SHORTFORM_PORT || 4317);
const workRoot = path.resolve(process.env.SHORTFORM_STORAGE_DIR || path.join(root, ".shortform"));
const exportRoot = path.join(workRoot, "exports");
const assetRoot = path.join(workRoot, "assets");
const audioPreviewRoot = path.join(workRoot, "audio-previews");
const logRoot = path.join(workRoot, "logs");
const renderLogFile = path.join(logRoot, "render-service.log");
const bgmRoot = path.join(root, "public", "bgm");
const episodeStore = new EpisodeStore({ storageRoot:workRoot, assetRoot, exportRoot, publicBaseUrl:`http://127.0.0.1:${port}` });
const digitalHumanStore = new DigitalHumanStore({ storageRoot:workRoot });
const dhProjectStore = new DigitalHumanProjectStore({ storageRoot:workRoot, publicBaseUrl:`http://127.0.0.1:${port}` });

function serializeError(error) {
  if (!(error instanceof Error)) return { message:String(error || "Unexpected error") };
  const cause = error.cause && typeof error.cause === "object" ? error.cause : null;
  return {
    name:error.name,
    message:error.message,
    stack:error.stack,
    cause:cause ? {
      name:cause.name,
      message:cause.message,
      code:cause.code,
      errno:cause.errno,
      syscall:cause.syscall,
      hostname:cause.hostname,
    } : undefined,
  };
}

async function logRenderError(event, error, details = {}) {
  const entry = { time:new Date().toISOString(), event, ...details, error:serializeError(error) };
  try {
    await mkdir(logRoot, { recursive:true });
    await appendFile(renderLogFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (logError) {
    console.error("[render-service] failed to write log:", logError instanceof Error ? logError.message : logError);
  }
}

/* General-purpose debug log line (success paths and intermediate steps). */
async function logRenderEvent(event, details = {}) {
  const entry = { time:new Date().toISOString(), event, ...details };
  try {
    await mkdir(logRoot, { recursive:true });
    await appendFile(renderLogFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (logError) {
    console.error("[render-service] failed to write log:", logError instanceof Error ? logError.message : logError);
  }
}

/* Re-check a non-terminal HeyGen video record against the API and persist the result. */
async function syncHeyGenVideoRecord(video) {
  if (!video || !video.heygenTaskId) return video;
  if (video.status === "completed" || video.status === "failed") return video;
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return video;
  try {
    const heyGenRes = await fetch(`https://api.heygen.com/v3/videos/${video.heygenTaskId}`, {
      headers: { "x-api-key": apiKey },
    });
    const heyGenData = await heyGenRes.json();
    if (!heyGenRes.ok) return video;
    const status = heyGenData.data?.status || "unknown";
    const videoUrl = heyGenData.data?.video_url || "";
    if (status === "completed" && videoUrl) {
      return dhProjectStore.updateVideo(video.id, { status, videoUrl });
    }
    if (status === "failed") {
      return dhProjectStore.updateVideo(video.id, { status, videoUrl: heyGenData.data?.error || "" });
    }
  } catch (err) {
    console.error(`[HeyGen] status sync failed for ${video.heygenTaskId}:`, err instanceof Error ? err.message : err);
  }
  return video;
}

const providerDefaults = {
  image: {
    openai: { endpoint:"https://api.openai.com/v1/images/generations", model:"gpt-image-1" },
    volcengine: { endpoint:"https://ark.cn-beijing.volces.com/api/v3/images/generations", model:"doubao-seedream-4-0-250828" },
    dashscope: { endpoint:"https://dashscope.aliyuncs.com", model:"qwen-image-3.0-pro" },
    sdwebui: { endpoint:"http://127.0.0.1:7860", model:"Local checkpoint" },
  },
  video: {
    volcengine: { endpoint:"https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", model:"doubao-seedance-2-0-260128" },
    dashscope: { endpoint:"https://dashscope.aliyuncs.com", model:"wan3.0-video" },
    pixstag: { endpoint:"https://pixstag.com", model:"MiniMax-H3" },
  },
  text: {
    openai: { endpoint:"https://api.openai.com/v1/chat/completions", model:"gpt-4.1-mini" },
    volcengine: { endpoint:"https://ark.cn-beijing.volces.com/api/v3/chat/completions", model:"doubao-seed-2-1-turbo-260628" },
  },
};

const speechDefaults = {
  endpoint:"http://localhost:8010/v1/audio/speech",
  model:"mlx-community/Kokoro-82M-bf16",
  voice:"af_heart",
  language:"a",
  speed:1,
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
  // DashScope (Aliyun Bailian) keys share one host: DASHSCOPE_HOST is accepted
  // alongside the per-modality DASHSCOPE_<MODALITY>_ENDPOINT override.
  const dashscopeHost = normalizedKind === "dashscope" ? String(process.env.DASHSCOPE_HOST || "").trim() : "";
  return {
    kind: normalizedKind,
    endpoint: process.env[`${providerName}_${modalityName}_ENDPOINT`] || dashscopeHost || defaults.endpoint || "",
    // Per-provider model override ({PROVIDER}_{MODALITY}_MODEL) always wins, so
    // VIDEO_PROVIDER can switch freely without model names leaking across
    // providers. The legacy global {MODALITY}_MODEL still applies, but only
    // to the currently selected provider (backward compatibility).
    model: process.env[`${providerName}_${modalityName}_MODEL`] || (normalizedKind === selected ? process.env[`${modalityName}_MODEL`] : "") || defaults.model || "",
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
    speech: {
      endpoint:process.env.SPEECH_ENDPOINT || speechDefaults.endpoint,
      model:process.env.SPEECH_MODEL || speechDefaults.model,
      voice:process.env.SPEECH_VOICE || speechDefaults.voice,
      voices:String(process.env.SPEECH_VOICES || "").split(",").map((v) => v.trim()).filter(Boolean),
      language:process.env.SPEECH_LANGUAGE || speechDefaults.language,
      speed:Number(process.env.SPEECH_SPEED) || speechDefaults.speed,
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
    speech: { configured:Boolean(providers.speech.endpoint && providers.speech.model), endpoint:providers.speech.endpoint, model:providers.speech.model, voice:providers.speech.voice, voices:providers.speech.voices, language:providers.speech.language, speed:providers.speech.speed, source:process.env.SPEECH_ENDPOINT || process.env.SPEECH_MODEL ? "environment" : "default" },
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
    generationMode:data.generationMode,
    motion:data.motion,
    duration:data.duration,
    screenRatio:data.screenRatio,
    resolution:data.resolution,
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
    shots:data.shots,
    referenceImages:data.referenceImages,
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
    productionMode: data.productionMode,
    longClipDuration: data.longClipDuration,
    shortClipDuration: data.shortClipDuration,
    screenRatio: data.screenRatio,
    audioDuration: data.audioDuration,
    transcription: data.transcription,
    characters: data.characters,
  };
}

function resolveSpeechProvider(data = {}) {
  const configured = environmentProviders().speech;
  return {
    endpoint:String(data.speechEndpoint || data.endpoint || configured.endpoint || "").trim(),
    model:String(data.speechModel || data.model || configured.model || "").trim(),
    voice:String(data.speechVoice || data.voice || configured.voice || "").trim(),
    language:String(data.speechLanguage || data.language || configured.language || "").trim(),
    speed:Math.max(.25, Math.min(4, Number(data.speechSpeed ?? data.speed ?? configured.speed) || 1)),
    instruct:String(data.speechInstruct || data.instruct || "").trim(),
    input:String(data.input || data.text || "").trim(),
  };
}

function speechApiBase(endpoint) {
  return String(endpoint || "").trim().replace(/\/+$/, "").replace(/\/v1\/audio\/speech$/, "").replace(/\/audio\/speech$/, "").replace(/\/v1$/, "");
}

function speechGenerationEndpoint(endpoint) {
  const value = String(endpoint || "").trim().replace(/\/+$/, "");
  if (/\/(?:v1\/)?audio\/speech$/.test(value)) return value;
  if (/\/v1$/.test(value)) return `${value}/audio/speech`;
  return `${value}/v1/audio/speech`;
}

function cors(extra = {}) {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", ...extra };
}

function json(res, status, value) {
  res.writeHead(status, cors({ "Content-Type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify(value));
}

const renderJobs = new Map();
const RENDER_JOB_TTL_MS = 30 * 60 * 1000;

function updateRenderJob(id, patch) {
  if (!id) return;
  const current = renderJobs.get(id) || { id, status:"running", stage:"Queued", percent:0, completedShots:0, totalShots:0 };
  renderJobs.set(id, { ...current, ...patch, updatedAt:Date.now() });
  for (const [key, job] of renderJobs) if (Date.now() - job.updatedAt > RENDER_JOB_TTL_MS) renderJobs.delete(key);
}

export function getRenderJob(id) {
  return renderJobs.get(id) || null;
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

export async function synthesizeSpeech(payload = {}, options = {}) {
  const config = resolveSpeechProvider(payload);
  if (!config.endpoint) throw new Error("An MLX Audio service URL is required");
  if (!config.model) throw new Error("An MLX Audio TTS model is required");
  if (!config.input) throw new Error("Add a narration script before generating speech");
  const request = {
    model:config.model,
    input:config.input,
    voice:config.voice || undefined,
    speed:config.speed,
    lang_code:config.language || undefined,
    instruct:config.instruct || undefined,
    response_format:"wav",
    stream:false,
  };
  const timeoutMs = Math.max(1000, Number(process.env.SPEECH_REQUEST_TIMEOUT_MS) || 600000);
  const response = await (options.fetchImpl || fetch)(speechGenerationEndpoint(config.endpoint), {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify(request),
    signal:options.signal || AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    let detail = "";
    try { const result = await response.json(); detail = result.error?.message || result.error || result.detail || result.message || ""; } catch { detail = await response.text().catch(() => ""); }
    throw new Error(detail || `MLX Audio returned ${response.status}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error("MLX Audio returned an empty audio file");
  const voiceStem = (config.voice || "voice").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "voice";
  return {
    audioData:`data:audio/wav;base64,${audio.toString("base64")}`,
    filename:`mlx-${voiceStem}.wav`,
    mimeType:"audio/wav",
    model:config.model,
    voice:config.voice,
    language:config.language,
    speed:config.speed,
  };
}

// MiniMax T2A subtitle JSON uses millisecond timestamps. Normalize a single
// timestamp to seconds, detecting the scale from the value (a narration longer
// than one second reports values well above 1000 when expressed in ms).
function minimaxTimeSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Convert a MiniMax subtitle file (data.subtitle_file, JSON) into the same
// transcription shape the app already consumes from the local transcriber:
// { text, language, duration, segments: [{ id, start, end, text, words:[...] }] }.
// Handles both sentence-level entries and word-level entries, and tolerates
// millisecond or second timestamps.
export function minimaxSubtitleToTranscription(payload = {}, fallbackText = "") {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.subtitle) ? payload.subtitle
    : Array.isArray(payload?.data?.subtitle) ? payload.data.subtitle
    : [];

  const entries = list.map((entry, index) => ({
    text: String(entry?.text ?? entry?.word ?? entry?.content ?? "").trim(),
    start: minimaxTimeSeconds(entry?.start_time ?? entry?.startTime ?? entry?.start),
    end: minimaxTimeSeconds(entry?.end_time ?? entry?.endTime ?? entry?.end),
    sentenceId: entry?.sentence_id ?? entry?.sentenceId ?? index,
    language: String(entry?.language ?? entry?.lang ?? ""),
  })).filter((entry) => entry.text && entry.end >= entry.start);

  if (!entries.length) return null;

  // MiniMax documents millisecond timestamps; detect and normalize the scale.
  const maxEnd = entries.reduce((max, entry) => Math.max(max, entry.end), 0);
  const scale = maxEnd > 1000 ? 1 / 1000 : 1;

  const words = entries.map((entry) => ({
    start: entry.start * scale,
    end: entry.end * scale,
    text: entry.text,
  }));

  // Sentence-level entries contain multiple space-separated words or long runs.
  const sentenceLevel = words.some((word) => /\s/.test(word.text) || word.text.length > 30);

  const segments = [];
  let segmentWords = [];
  const flushSegment = () => {
    if (!segmentWords.length) return;
    segments.push({
      id: segments.length,
      start: segmentWords[0].start,
      end: segmentWords[segmentWords.length - 1].end,
      text: segmentWords.map((word) => word.text).join(" "),
      words: segmentWords.map((word) => ({ start: word.start, end: word.end, word: word.text, probability: null })),
    });
    segmentWords = [];
  };

  if (sentenceLevel) {
    for (const entry of words) {
      const parts = entry.text.split(/\s+/).filter(Boolean);
      const timedWords = parts.length > 1
        ? parts.map((part, i) => ({ start: entry.start + (entry.end - entry.start) * i / parts.length, end: entry.start + (entry.end - entry.start) * (i + 1) / parts.length, word: part, probability: null }))
        : [{ start: entry.start, end: entry.end, word: entry.text, probability: null }];
      segments.push({ id: segments.length, start: entry.start, end: entry.end, text: entry.text, words: timedWords });
    }
  } else {
    // Word-level entries: group into sentence-like segments at punctuation or ~15 words.
    for (const word of words) {
      segmentWords.push(word);
      if (/[.!?;。！？；]$/.test(word.text) || segmentWords.length >= 15) flushSegment();
    }
    flushSegment();
  }

  if (!segments.length) return null;

  return {
    text: entries.map((entry) => entry.text).join(" ") || String(fallbackText || ""),
    language: entries[0].language || "",
    languageProbability: null,
    duration: segments[segments.length - 1].end,
    durationAfterVad: 0,
    segments,
  };
}

async function synthesizeSpeechMiniMax({ script, voiceId, model = "speech-2.8-hd", speed = 1, subtitleType = "word", languageBoost, fetchImpl = fetch }) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY is not configured");
  if (!script) throw new Error("Script is required for TTS");
  if (!voiceId) throw new Error("MiniMax voice_id is required");

  const requestBody = {
    model,
    text: script,
    stream: false,
    voice_setting: { voice_id: voiceId, speed },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    subtitle_enable: true,
    subtitle_type: subtitleType,
  };
  if (languageBoost) requestBody.language_boost = languageBoost;

  const response = await fetchImpl("https://api.minimaxi.com/v1/t2a_v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  const result = await response.json();
  if (!response.ok || result.base_resp?.status_code !== 0) {
    throw new Error(result.base_resp?.status_msg || result.error?.message || `MiniMax returned ${response.status}`);
  }

  const audioHex = result.data?.audio;
  if (!audioHex) throw new Error("MiniMax returned no audio data");

  const audioBuffer = Buffer.from(audioHex, "hex");

  let transcription = null;
  if (result.data?.subtitle_file) {
    try {
      const subtitleResponse = await fetchImpl(result.data.subtitle_file);
      if (subtitleResponse.ok) {
        transcription = minimaxSubtitleToTranscription(await subtitleResponse.json(), script);
      }
    } catch (error) {
      console.error("[MiniMax TTS] subtitle download/parse failed: %s", error.message);
    }
  }

  return {
    audioData: `data:audio/mp3;base64,${audioBuffer.toString("base64")}`,
    filename: `minimax-${voiceId}.mp3`,
    mimeType: "audio/mp3",
    model,
    voice: voiceId,
    speed,
    transcription,
  };
}

// Convert Doubao query "sentences" (each with startTime/endTime/text/words,
// all in seconds) into the app's transcription shape:
// { text, language, duration, segments: [{ id, start, end, text, words:[...] }] }.
function doubaoSentencesToTranscription(sentences = [], fallbackText = "") {
  const list = Array.isArray(sentences) ? sentences : [];
  const segments = list.map((sentence, index) => ({
    id: index,
    start: Number(sentence?.startTime) || 0,
    end: Number(sentence?.endTime) || 0,
    text: String(sentence?.text || "").trim(),
    words: Array.isArray(sentence?.words)
      ? sentence.words.map((word) => ({
          start: Number(word?.startTime) || 0,
          end: Number(word?.endTime) || 0,
          word: String(word?.word || ""),
          probability: Number.isFinite(Number(word?.confidence)) ? Number(word.confidence) : null,
        }))
      : [],
  })).filter((segment) => segment.text && segment.end >= segment.start);

  if (!segments.length) return null;
  const lastEnd = segments[segments.length - 1].end;
  return {
    text: segments.map((segment) => segment.text).join("") || String(fallbackText || ""),
    language: "zh",
    languageProbability: null,
    duration: lastEnd,
    durationAfterVad: 0,
    segments,
  };
}

// Doubao (Volcengine Speech) TTS via the asynchronous submit → query → download
// flow. Uses the new X-Api-Key auth (DOUBAO_TTS_API_KEY) with resource
// seed-tts-2.0, and returns sentence/word timestamps for caption alignment.
async function synthesizeSpeechDoubao({ script, speaker, model = "seed-tts-2.0", speechRate = 0, format = "mp3", sampleRate = 24000, explicitLanguage = "zh-cn", fetchImpl = fetch }) {
  const apiKey = process.env.DOUBAO_TTS_API_KEY;
  if (!apiKey) throw new Error("DOUBAO_TTS_API_KEY is not configured");
  if (!script) throw new Error("Script is required for TTS");
  if (!speaker) throw new Error("Doubao speaker_id is required");

  const headers = {
    "Content-Type": "application/json",
    "X-Api-Key": apiKey,
    "X-Api-Resource-Id": model,
    "X-Api-Request-Id": randomUUID(),
  };

  const submitResp = await fetchImpl("https://openspeech.bytedance.com/api/v3/tts/submit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      user: { uid: "shortform-studio" },
      req_params: {
        text: script,
        speaker,
        audio_params: { format, sample_rate: sampleRate, speech_rate: speechRate, enable_timestamp: true },
        explicit_language: explicitLanguage,
      },
    }),
  });
  const submitJson = await submitResp.json().catch(() => ({}));
  if (!submitResp.ok || submitJson.code !== 20000000 || !submitJson.data?.task_id) {
    throw new Error(submitJson.message || `Doubao TTS submit returned ${submitResp.status}`);
  }
  const taskId = submitJson.data.task_id;

  let audioUrl = null;
  let sentences = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const queryResp = await fetchImpl("https://openspeech.bytedance.com/api/v3/tts/query", {
      method: "POST",
      headers,
      body: JSON.stringify({ task_id: taskId }),
    });
    const queryJson = await queryResp.json().catch(() => ({}));
    const data = queryJson.data || {};
    if (queryJson.code !== 20000000 || data.task_status === 3) {
      throw new Error(queryJson.message || "Doubao TTS synthesis failed");
    }
    if (data.task_status === 2) {
      audioUrl = data.audio_url || null;
      sentences = Array.isArray(data.sentences) ? data.sentences : [];
      break;
    }
  }
  if (!audioUrl) throw new Error("Doubao TTS synthesis timed out");

  const audioResp = await fetchImpl(audioUrl);
  if (!audioResp.ok) throw new Error(`Doubao TTS audio download returned ${audioResp.status}`);
  const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
  if (!audioBuffer.length) throw new Error("Doubao TTS returned an empty audio file");

  return {
    audioData: `data:audio/mp3;base64,${audioBuffer.toString("base64")}`,
    filename: `doubao-${speaker}.mp3`,
    mimeType: "audio/mp3",
    model,
    voice: speaker,
    speed: speechRate,
    transcription: doubaoSentencesToTranscription(sentences, script),
  };
}

// Route TTS to the provider declared by the genre config (story → Doubao
// suspense narrator, documentary → MiniMax English narrator). Returns the same
// shape both provider implementations produce so batch pipelines can treat the
// result uniformly: { audioData, filename, mimeType, model, voice, speed, transcription }.
export async function synthesizeSpeechByGenre(payload = {}, options = {}) {
  const genre = getGenre(payload.genre);
  const script = String(payload.script || payload.input || "").trim();
  if (!script) throw new Error("Script is required for TTS");
  const fetchImpl = options.fetchImpl || fetch;
  if (genre.id === "story") {
    const speaker = String(payload.speaker || payload.voice || genre.tts.voice).trim();
    const speechRate = Number.isFinite(Number(payload.speechRate)) ? Number(payload.speechRate) : (Number.isFinite(Number(genre.tts.speechRate)) ? Number(genre.tts.speechRate) : 0);
    const model = String(payload.model || genre.tts.model);
    return synthesizeSpeechDoubao({ script, speaker, model, speechRate, format:"mp3", sampleRate:24000, explicitLanguage:"zh-cn", fetchImpl });
  }
  const voiceId = String(payload.voice || payload.voiceId || genre.tts.voice).trim();
  const speed = Number(payload.speed ?? genre.tts.speed);
  const model = String(payload.model || genre.tts.model);
  return synthesizeSpeechMiniMax({ script, voiceId, model, speed, subtitleType:"word", fetchImpl });
}

// Fetch and normalize the MiniMax voice list. The voice list API endpoint and
// response shape vary by account, so a few known endpoints are tried in order.
async function listMiniMaxVoices(fetchImpl = fetch) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY is not configured");

  const urls = [
    "https://api.minimaxi.com/v1/voice/list",
    "https://api.minimaxi.com/v1/voices",
    "https://api.minimax.chat/v1/voice/list",
  ];
  const voices = [];
  for (const url of urls) {
    try {
      const resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      const text = await resp.text();
      console.error("[MiniMax voices] %s → HTTP %s", url, resp.status);
      console.error("[MiniMax voices] body: %s", text.slice(0, 500));

      let data;
      try { data = JSON.parse(text); } catch { continue; }

      const voiceList =
        data.data?.voice_list ||
        data.data?.voices ||
        data.data?.list ||
        data.voice_list ||
        data.voices ||
        data.list ||
        [];
      const ok = data.base_resp?.status_code === 0 || data.code === 0 || data.status === 0 || resp.ok;

      if (ok && Array.isArray(voiceList) && voiceList.length > 0) {
        for (const v of voiceList) {
          voices.push({
            voice_id: v.voice_id,
            name: v.name || v.voice_name || v.voice_id,
            type: v.type || "system",
            language: v.language || "",
          });
        }
      }
    } catch (err) {
      console.error("[MiniMax voices] %s → %s", url, err.message);
    }
  }
  // deduplicate by voice_id
  const seen = new Set();
  return voices.filter((v) => !seen.has(v.voice_id) && seen.add(v.voice_id));
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
  const directory = options.directory || assetRoot;
  await mkdir(directory, { recursive:true });
  const id = options.baseName || options.id || randomUUID();
  const source = await saveMedia(value, path.join(directory, id), options.fetchImpl || fetch);
  let filename = source;
  if (options.screenRatio) {
    const ratio = normalizeScreenRatio(options.screenRatio);
    // Keep the provider's native 4K resolution so exports always downscale
    // from real detail instead of upscaling a shrunken cache.
    const dimensions = ratio === "16:9" ? { width:3840, height:2160 } : ratio === "1:1" ? { width:4096, height:4096 } : ratio === "2:3" ? { width:2730, height:4096 } : { width:2160, height:3840 };
    const output = path.join(directory, `${id}-${ratio.replace(":", "x")}.png`);
    const filter = `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase,crop=${dimensions.width}:${dimensions.height},setsar=1`;
    try {
      await run("ffmpeg", ["-y", "-i", source, "-frames:v", "1", "-vf", filter, "-compression_level", "6", output]);
      filename = output;
      await unlink(source).catch(() => {});
    } catch (error) {
      await unlink(output).catch(() => {});
      throw error;
    }
  }
  const urlPrefix = options.urlPrefix || "/assets";
  return {
    path:filename,
    url:`http://127.0.0.1:${port}${urlPrefix}/${encodeURIComponent(path.basename(filename))}?v=${Date.now()}`,
  };
}

export async function persistGeneratedVideo(value, options = {}) {
  if (!value) throw new Error("Provider returned no video");
  const directory = options.directory || assetRoot;
  await mkdir(directory, { recursive:true });
  const filename = await saveMedia(value, path.join(directory, options.baseName || options.id || randomUUID()), options.fetchImpl || fetch);
  if (path.extname(filename).toLowerCase() !== ".mp4") throw new Error("Provider returned an unsupported video format");
  const urlPrefix = options.urlPrefix || "/assets";
  return {
    path:filename,
    url:`http://127.0.0.1:${port}${urlPrefix}/${encodeURIComponent(path.basename(filename))}?v=${Date.now()}`,
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

function coverDimensions(screenRatio) {
  const ratio = normalizeScreenRatio(screenRatio);
  return ratio === "16:9" ? { width:1280, height:720 } : ratio === "1:1" ? { width:1080, height:1080 } : { width:1080, height:1920 };
}

function escapeSvgText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function coverTextUnits(value) {
  return Array.from(String(value)).reduce((total, character) => {
    if (/\s/.test(character)) return total + .28;
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uF900-\uFAFF]/.test(character)) return total + 1;
    if (/[A-Z0-9]/.test(character)) return total + .64;
    if (/[a-z]/.test(character)) return total + .53;
    return total + .36;
  }, 0);
}

function coverTextLines(headline, maxUnits) {
  const text = String(headline || "").trim();
  if (!text) return [];
  const tokens = /\s/.test(text) ? text.split(/\s+/).filter(Boolean) : Array.from(text);
  const separator = /\s/.test(text) ? " " : "";
  const lines = []; let line = "";
  for (const word of tokens) {
    const candidate = line ? `${line}${separator}${word}` : word;
    if (line && coverTextUnits(candidate) > maxUnits) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function coverTitleSvg(width, height, headline, options = {}) {
  const titleScale = Math.max(50, Math.min(200, Number(options.titleScale) || 100));
  const titleWidth = Math.max(50, Math.min(95, Number(options.titleWidth) || 84));
  const titleVertical = Math.max(2, Math.min(92, Number(options.titleVertical) || 90));
  const horizontal = String(options.titlePosition || "bottom-left").split("-")[1] || "left";
  const maxWidth = width * titleWidth / 100;
  let fontSize = Math.round(width * .085 * titleScale / 100);
  let lines = coverTextLines(headline, maxWidth / fontSize);
  while (lines.length > 3 && fontSize > width * .045) {
    fontSize -= Math.max(2, Math.round(width * .004));
    lines = coverTextLines(headline, maxWidth / fontSize);
  }
  lines = lines.slice(0, 3);
  if (!lines.length) return "";
  const lineHeight = Math.round(fontSize * 1.06);
  const marginX = (1 - titleWidth / 100) / 2;
  const x = horizontal === "center" ? width * .5 : horizontal === "right" ? width * (1 - marginX) : width * marginX;
  const baseline = Math.max(fontSize, Math.min(height - fontSize * .2, height * titleVertical / 100 - lineHeight * (lines.length - 1) * .5 + fontSize * .35));
  const strokeWidth = Math.max(5, fontSize * .12);
  const accentWidth = width * .13;
  const accentHeight = Math.max(6, width * .008);
  const accentX = horizontal === "center" ? x - accentWidth * .5 : horizontal === "right" ? x - accentWidth : x;
  const accentY = Math.max(height * .025, baseline - fontSize * .82 - strokeWidth * .5 - Math.max(8, fontSize * .18) - accentHeight);
  const anchor = horizontal === "center" ? "middle" : horizontal === "right" ? "end" : "start";
  const v = titleVertical / 100;
  const stops = [[0,0],[Math.max(0,v-.35),0],[Math.max(0,v-.18),.18],[v,.76],[Math.min(1,v+.18),.18],[1,0]].map(([offset, opacity]) => `<stop offset="${offset.toFixed(3)}" stop-color="#000" stop-opacity="${opacity.toFixed(3)}"/>`).join("");
  const text = lines.map((line, index) => `<text x="${Math.round(x)}" y="${Math.round(baseline + index * lineHeight)}" font-family="'PingFang SC','Heiti SC',Arial,sans-serif" font-size="${fontSize}" font-weight="800" fill="#fffdf7" stroke="rgba(0,0,0,.82)" stroke-width="${strokeWidth.toFixed(1)}" stroke-linejoin="round" paint-order="stroke" text-anchor="${anchor}">${escapeSvgText(line)}</text>`).join("");
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs><rect width="${width}" height="${height}" fill="url(#shade)"/><rect x="${Math.round(accentX)}" y="${Math.round(accentY)}" width="${Math.round(accentWidth)}" height="${Math.round(accentHeight)}" fill="#d7a552"/>${text}</svg>`;
}

export async function bakeEpisodeCover(payload) {
  const episodeId = String(payload?.episodeId || "");
  const renderedImage = String(payload?.image || "");
  if (episodeId && renderedImage) {
    const { mime, data } = fromDataUrl(renderedImage);
    if (!mime.startsWith("image/")) throw new Error("The saved cover must be an image");
    const screenRatio = normalizeScreenRatio(payload.screenRatio);
    const coverId = `cover-${screenRatio.replace(":", "x")}`;
    return await episodeStore.withMediaTarget(episodeId, payload.title, "covers", coverId, async (target) => {
      const filename = path.join(target.directory, `${target.baseName}.jpg`);
      await writeFile(filename, data);
      await unlink(path.join(target.directory, `${target.baseName}.png`)).catch(() => {});
      const publicPath = `${target.urlPrefix}/${encodeURIComponent(`${target.baseName}.jpg`)}`;
      const createdAt = Date.now();
      return { id:coverId, path:publicPath, url:`http://127.0.0.1:${port}${publicPath}?v=${createdAt}`, screenRatio, createdAt };
    });
  }
  const backgroundUrl = String(payload?.backgroundUrl || "");
  if (!episodeId || !backgroundUrl) throw new Error("An episode and cover background are required");
  let backgroundPathname = "";
  try {
    const url = new URL(backgroundUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("Invalid cover background host");
    backgroundPathname = url.pathname;
  } catch { throw new Error("The cover background must be a local episode image"); }
  const backgroundPath = /^\/episodes\/([^/]+)\/files\/(.+)$/.exec(backgroundPathname);
  if (!backgroundPath || decodeURIComponent(backgroundPath[1]) !== episodeId) throw new Error("The cover background must belong to this episode");
  const { filename } = await episodeStore.fileForRequest(episodeId, backgroundPath[2].split("/").map(decodeURIComponent).join(path.sep));
  const dimensions = coverDimensions(payload.screenRatio);
  const base = await sharp(filename).resize(dimensions.width, dimensions.height, { fit:"cover", position:"attention" }).png().toBuffer();
  const output = await sharp(base).composite([{ input:Buffer.from(coverTitleSvg(dimensions.width, dimensions.height, payload.headline, payload)) }]).jpeg({ quality:92 }).toBuffer();
  const screenRatio = normalizeScreenRatio(payload.screenRatio);
  const coverId = `cover-${screenRatio.replace(":", "x")}`;
  return await episodeStore.withMediaTarget(episodeId, payload.title, "covers", coverId, async (target) => {
    const filename = path.join(target.directory, `${target.baseName}.jpg`);
    await writeFile(filename, output);
    const publicPath = `${target.urlPrefix}/${encodeURIComponent(`${target.baseName}.jpg`)}`;
    const createdAt = Date.now();
    return { id:coverId, path:publicPath, url:`http://127.0.0.1:${port}${publicPath}?v=${createdAt}`, screenRatio, createdAt };
  });
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
    const episodeMatch = /^\/episodes\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
    if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && episodeMatch) {
      const { filename, contentType } = await episodeStore.fileForRequest(decodeURIComponent(episodeMatch[1]), episodeMatch[2].split("/").map(decodeURIComponent).join(path.sep));
      if (!contentType.startsWith("image/")) throw new Error("The local storyboard asset is not an image");
      return `data:${contentType};base64,${(await readFile(filename)).toString("base64")}`;
    }
  } catch (error) {
    if (error instanceof TypeError) throw new Error("The storyboard image URL is invalid");
    throw error;
  }
  return value;
}

/* Aliyun OSS helpers. PixStag (MiniMax-H3) only accepts a publicly reachable
   first-frame URL, so local storyboard frames are uploaded to a private OSS
   bucket and replaced with a short-lived presigned GET URL. */
function ossConfig() {
  return {
    region: String(process.env.OSS_REGION || "").trim(),
    bucket: String(process.env.OSS_BUCKET || "").trim(),
    accessKeyId: String(process.env.OSS_ACCESS_KEY_ID || "").trim(),
    accessKeySecret: String(process.env.OSS_ACCESS_KEY_SECRET || "").trim(),
  };
}

function ossRegionForSdk(region) {
  const value = String(region || "").trim();
  if (!value) return "";
  if (value.startsWith("oss-") || value.includes("aliyuncs.com")) return value;
  return `oss-${value}`;
}

function ossObjectKey(mime) {
  const extension = (String(mime || "").split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  return `shortform/pixstag-firstframe/${randomUUID()}.${extension}`;
}

async function ossClient(config) {
  const OSS = (await import("ali-oss")).default;
  return new OSS({
    region: ossRegionForSdk(config.region),
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    bucket: config.bucket,
    secure: true,
    timeout: 120000,
  });
}

async function uploadToOssAndSign(dataUrl) {
  const config = ossConfig();
  if (!config.region || !config.bucket || !config.accessKeyId || !config.accessKeySecret) {
    throw new Error("OSS is not configured for PixStag first-frame upload. Set OSS_REGION, OSS_BUCKET, OSS_ACCESS_KEY_ID, and OSS_ACCESS_KEY_SECRET in .env.local, or switch to Aliyun Bailian (Wan) / Volcengine (Seedance) for image-to-video.");
  }
  const { mime, data } = fromDataUrl(dataUrl);
  const client = await ossClient(config);
  const key = ossObjectKey(mime);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.put(key, data, { mime });
      return client.signatureUrl(key, { expires: 900 });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

export async function prepareProviderImage(value, screenRatio, options = {}) {
  const ratio = normalizeScreenRatio(screenRatio);
  const dimensions = ratio === "16:9" ? { width:1920, height:1080 } : ratio === "1:1" ? { width:1080, height:1080 } : { width:1080, height:1920 };
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

function probeHasAudio(file) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", file]);
    let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve(false)); child.on("close", () => resolve(stdout.trim().length > 0));
  });
}

function probeMediaDuration(file) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve(0)); child.on("close", () => {
      const duration = Number(stdout.trim());
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
    });
  });
}

function fitShotsToDuration(input, duration) {
  const shots = Array.isArray(input) ? input : [];
  const currentTotal = shots.reduce((sum, shot) => sum + Math.max(.6, Number(shot.duration) || 2), 0);
  if (!shots.length || !Number.isFinite(duration) || duration <= 0 || Math.abs(currentTotal - duration) < .01) return shots;
  const scale = duration / currentTotal;
  return shots.map((shot, index) => ({ ...shot, duration:index === shots.length - 1
    ? Number((duration - shots.slice(0, index).reduce((sum, prior) => sum + Math.max(.6, Number(prior.duration) || 2) * scale, 0)).toFixed(3))
    : Number((Math.max(.6, Number(shot.duration) || 2) * scale).toFixed(3)) }));
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

export function buildSubtitleAss(shots, width, height, value = {}, broadcastMode = false, headlineText = "", headlinePosition = 4, transcription = null) {
  const style = normalizeSubtitleStyle(value);
  const fontSizeBase = width > height ? width * .0252 : height * .028;
  const fontSize = Math.max(10, Math.round(fontSizeBase * style.fontScale / 100));
  const marginV = Math.round(height * style.position / 100); const marginH = Math.round(width * .065);
  const alignment = { left:1, center:2, right:3 }[style.alignment];
  const primary = subtitleAssColor(style.englishColor); const chinese = subtitleAssOverrideColor(style.chineseColor);
  const outline = subtitleAssColor(style.backgroundColor); const background = subtitleAssColor(style.backgroundColor, style.backgroundOpacity);
  const hasHeadline = broadcastMode && String(headlineText || "").trim().length > 0;
  console.log(`[buildSubtitleAss] broadcastMode=${broadcastMode}, headlineText="${headlineText}", hasHeadline=${hasHeadline}`);
  const headlineFontSize = Math.max(12, Math.round(fontSize * 1.15));
  const headlineColor = subtitleAssColor("#ffffff");
  const headlineBg = subtitleAssColor("#000000", 65);
  const headlineMarginV = Math.round(height * headlinePosition / 100);
  const headlineBarHeight = Math.round(headlineFontSize * 2.2);
  let header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Main,${style.fontFamily},${fontSize},${primary},&H000000FF,${outline},&HFF000000,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outline},0,${alignment},${marginH},${marginH},${marginV},1\nStyle: Box,Arial,1,${background},${background},${background},${background},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`;
  if (hasHeadline) {
    header += `\nStyle: Headline,${style.fontFamily},${headlineFontSize},${headlineColor},&H000000FF,&H00000000,&HEE000000,1,0,0,0,100,100,0,0,1,2.5,0,8,${marginH},${marginH},${headlineMarginV},1`;
  }
  header += `\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  // Cue timing comes from subtitleCues — the same word-timestamp sync used by the
  // live preview and SRT export. With a transcription, cue times follow the actual
  // speech even when planned shot times diverge;
  // without one it falls back to proportional timing within each shot.
  const cues = subtitleCues(shots, transcription);
  const headlineEvents = hasHeadline ? shots.flatMap((shot) => {
    const shotStart = Number(shot.start) || 0;
    const shotEnd = Number(shot.end) || (shotStart + (Number(shot.duration) || 1));
    return [
      `Dialogue: 0,${assTime(shotStart)},${assTime(shotEnd)},Box,,0,0,0,,{\\an7\\pos(0,0)\\p1}m 0 0 l ${width} 0 l ${width} ${headlineBarHeight} l 0 ${headlineBarHeight}{\\p0}`,
      `Dialogue: 1,${assTime(shotStart)},${assTime(shotEnd)},Headline,,0,0,0,,${assText(headlineText)}`,
    ];
  }) : [];
  const cueEvents = cues.flatMap((cue) => {
    const englishText = assText(cue.chunk.english);
    const chineseText = assText(cue.chunk.chinese);
    const text = [englishText, chineseText ? `{\\c${chinese}}${chineseText}` : ""].filter(Boolean).join("\\N");
    if (!text) return [];
    const lines = Math.max(1, Number(Boolean(englishText)) + Number(Boolean(chineseText)));
    const paddingY = Math.max(4, Math.round(fontSize * .35)); const lineHeight = Math.round(fontSize * 1.3);
    const boxHeight = lines * lineHeight + paddingY * 2; const boxWidth = width - marginH * 2;
    const boxBottom = Math.min(height, height - marginV + paddingY); const boxTop = Math.max(0, boxBottom - boxHeight);
    const box = `{\\an7\\pos(${marginH},${boxTop})\\p1}m 0 0 l ${boxWidth} 0 l ${boxWidth} ${boxHeight} l 0 ${boxHeight}{\\p0}`;
    return [
      ...(style.backgroundOpacity > 0 ? [`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Box,,0,0,0,,${box}`] : []),
      `Dialogue: 1,${assTime(cue.start)},${assTime(cue.end)},Main,,0,0,0,,${text}`,
    ];
  });
  const events = [...headlineEvents, ...cueEvents];
  const ass = header + events.join("\n");
  if (hasHeadline) console.log(`[buildSubtitleAss] Generated ASS with headline, first 600 chars: ${ass.substring(0, 600)}`);
  return ass;
}

// Ken Burns-style motion for still shots. The zoom ramps across the whole shot
// (never resets mid-clip) and the source is supersampled 3x before zoompan so
// the crop window moves in sub-output-pixel steps (no jitter).
export function stillMotionFilter(motion, width, height, duration, index = 0) {
  const frames = Math.max(1, Math.round((Number(duration) || 2) * 30));
  const hiRes = `scale=${width * 3}:${height * 3}:force_original_aspect_ratio=increase:out_range=tv:out_color_matrix=bt709:flags=lanczos,crop=${width * 3}:${height * 3}`;
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

// "fill" crops sources to cover the whole canvas; "fit" keeps the source's
// original aspect ratio and centers it with black bars (headline on top,
// subtitles at the bottom bar).
export function segmentFrameFilter(width, height, layout = "fill") {
  if (layout === "fit") return `scale=${width}:${height}:force_original_aspect_ratio=decrease:out_range=tv:out_color_matrix=bt709:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1`;
  return `scale=${width}:${height}:force_original_aspect_ratio=increase:out_range=tv:out_color_matrix=bt709:flags=lanczos,crop=${width}:${height},fps=30,setsar=1`;
}

export async function renderEpisode(payload, options = {}) {
  if (!Array.isArray(payload.shots) || !payload.shots.length) throw new Error("At least one shot is required");
  if (payload.shots.length > 80) throw new Error("The MVP supports up to 80 shots per episode");
  const started = Date.now(); const id = options.id || randomUUID(); const jobDir = path.join(workRoot, "jobs", id);
  await mkdir(jobDir, { recursive: true }); await mkdir(exportRoot, { recursive: true });
  const { width, height } = renderDimensions(payload); const subtitleStyle = normalizeSubtitleStyle(payload.subtitleStyle);
  const frameLayout = payload.frameLayout === "fit" ? "fit" : "fill";
  let narration = await saveMedia(payload.narrationData, path.join(jobDir, "narration"));
  if (narration && payload.voicePreset !== "original") narration = (await renderNarrationStages(narration, "denoise", jobDir, "narration")).final;
  const narrationDuration = narration ? await probeMediaDuration(narration) : 0;
  const requestedTimelineDuration = Number(payload.timelineDuration);
  const timelineDuration = requestedTimelineDuration > 0 && requestedTimelineDuration <= narrationDuration + .05 ? requestedTimelineDuration : narrationDuration;
  const renderShots = fitShotsToDuration(payload.shots, timelineDuration);
  const total = Number(renderShots.reduce((sum, shot) => sum + Math.max(.6, Number(shot.duration) || 2), 0).toFixed(3));
  const totalShots = renderShots.length;
  const report = (stage, percent, completedShots = 0) => { if (typeof options.onProgress === "function") options.onProgress({ stage, percent, completedShots, totalShots }); };
  report("Preparing sources", 2);
  let cursor = 0; let hasClipAudio = false; const shots = [];
  for (let i = 0; i < renderShots.length; i += 1) {
    if (!renderShots[i].video && !renderShots[i].image) throw new Error(`Shot ${i + 1} has no generated image or video clip`);
    const duration = Math.max(.6, Number(renderShots[i].duration) || 2);
    const sourceValue = renderShots[i].video || renderShots[i].image;
    const source = await saveMedia(sourceValue, path.join(jobDir, `source-${String(i).padStart(3,"0")}`));
    const segment = path.join(jobDir, `segment-${String(i).padStart(3,"0")}.mp4`);
    const scale = segmentFrameFilter(width, height, frameLayout);
    const normalizedFormat = "format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709";
    const colorMetadata = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
    // Intermediate segments are encoded near-lossless so the single final
    // encode (which burns subtitles) is the only lossy step.
    const segmentEncoding = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p"];
    const clipAudioSource = renderShots[i].video && await probeHasAudio(source) ? source : "";
    if (clipAudioSource) hasClipAudio = true;
    if (renderShots[i].video) {
      await run("ffmpeg", ["-y", "-stream_loop", "-1", "-i", source, "-t", String(duration), "-an", "-vf", `${scale},${normalizedFormat}`, "-r", "30", ...segmentEncoding, ...colorMetadata, segment]);
    } else if (frameLayout === "fit") {
      // Letterboxed layouts keep the whole still visible, so Ken Burns motion
      // is skipped in favor of a static fit.
      await run("ffmpeg", ["-y", "-loop", "1", "-i", source, "-t", String(duration), "-an", "-vf", `${scale},${normalizedFormat}`, "-r", "30", ...segmentEncoding, ...colorMetadata, segment]);
    } else {
      const stillMotion = stillMotionFilter(renderShots[i].motion, width, height, duration, i);
      await run("ffmpeg", ["-y", "-loop", "1", "-i", source, "-t", String(duration), "-an", "-vf", stillMotion, "-r", "30", ...segmentEncoding, ...colorMetadata, segment]);
    }
    shots.push({ ...renderShots[i], duration, start:cursor, end:cursor + duration, source, segment, clipAudioSource }); cursor += duration;
    report(`Encoding shot ${i + 1}/${totalShots}`, 2 + Math.round(68 * (i + 1) / totalShots), i + 1);
  }
  report("Processing narration", 74, totalShots);
  let customBgm = null;
  if (payload.bgmPath) {
    const filename = path.basename(String(payload.bgmPath));
    if (!/\.mp3$/i.test(filename)) throw new Error("The selected BGM format is not supported");
    customBgm = path.join(bgmRoot, filename);
    await readFile(customBgm);
  }
  const quoteConcat = (value) => value.replace(/'/g, "'\\''");
  let clipAudio = "";
  if (hasClipAudio) {
    report("Mixing clip audio", 76, totalShots);
    const clipAudioFiles = [];
    for (let i = 0; i < shots.length; i += 1) {
      const clipAudioPart = path.join(jobDir, `clip-audio-${String(i).padStart(3,"0")}.wav`);
      if (shots[i].clipAudioSource) {
        await run("ffmpeg", ["-y", "-stream_loop", "-1", "-i", shots[i].clipAudioSource, "-t", String(shots[i].duration), "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", clipAudioPart]);
      } else {
        await run("ffmpeg", ["-y", "-f", "lavfi", "-t", String(shots[i].duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-c:a", "pcm_s16le", clipAudioPart]);
      }
      clipAudioFiles.push(clipAudioPart);
    }
    const clipAudioList = path.join(jobDir, "clip-audio-list.txt");
    await writeFile(clipAudioList, clipAudioFiles.map((file) => `file '${quoteConcat(file)}'`).join("\n"));
    clipAudio = path.join(jobDir, "clip-audio.wav");
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", clipAudioList, "-c", "copy", clipAudio]);
  }
  report("Writing subtitles", 78, totalShots);
  const ass = path.join(jobDir, "captions.ass"); await writeFile(ass, buildSubtitleAss(shots, width, height, subtitleStyle, payload.broadcastMode, payload.headlineText, payload.headlinePosition, payload.transcription));
  const concatFile = path.join(jobDir, "segments.txt");
  await writeFile(concatFile, shots.map((shot) => `file '${quoteConcat(shot.segment)}'`).join("\n"));
  const output = options.output || path.join(exportRoot, `${id}.mp4`); const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatFile];
  if (narration) args.push("-i", narration);
  if (customBgm) args.push("-stream_loop", "-1", "-i", customBgm);
  if (clipAudio) args.push("-i", clipAudio);
  let audioIndex = 1;
  const narrationIndex = narration ? audioIndex++ : 0;
  const bgmIndex = customBgm ? audioIndex++ : 0;
  const clipIndex = clipAudio ? audioIndex++ : 0;
  const filters = [];
  const escapedAss = ass.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  filters.push(`[0:v]setpts=PTS-STARTPTS,ass=filename='${escapedAss}'[vout]`);
  const requestedBgmVolume = Number(payload.bgmVolume); const bgmVolume = Number.isFinite(requestedBgmVolume) ? Math.max(0, Math.min(.2, requestedBgmVolume)) : .08;
  // Mix clip audio (real sound from video clips, silence for stills) with
  // narration and BGM. normalize=0 keeps each source at its explicit volume
  // instead of dividing by the number of inputs.
  const mixLabels = [];
  if (clipIndex) { filters.push(`[${clipIndex}:a]atrim=0:${total}[clip]`); mixLabels.push("[clip]"); }
  if (narrationIndex) { filters.push(`[${narrationIndex}:a]volume=1[nar]`); mixLabels.push("[nar]"); }
  if (bgmIndex) { filters.push(`[${bgmIndex}:a]atrim=0:${total},volume=${bgmVolume}[bg]`); mixLabels.push("[bg]"); }
  if (mixLabels.length === 0) filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${total}[aout]`);
  else if (mixLabels.length === 1) filters.push(`${mixLabels[0]}anull[aout]`);
  else filters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0:dropout_transition=2,alimiter=limit=.8414:level=false[aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-t", String(total), "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output);
  report("Final assembly", 82, totalShots);
  const ffmpegCmd = `ffmpeg ${args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")}`;
  const subtitleFontSize = Math.max(10, Math.round(height * .028 * subtitleStyle.fontScale / 100));
  const ratioLabel = width > height ? "16:9" : width === height ? "1:1" : "9:16";
  const logEntry = `=== Build ${new Date().toISOString()} ===
Video: ${width}x${height} · ${ratioLabel} · ${total}s · ${totalShots} shots
Subtitle font: ${subtitleFontSize}px (height=${height} * 0.028 * fontScale=${subtitleStyle.fontScale} / 100)
Font family: ${subtitleStyle.fontFamily}
Position: ${subtitleStyle.position}% · Alignment: ${subtitleStyle.alignment}
Outline: ${subtitleStyle.outline} · Bold: ${subtitleStyle.bold}
English color: ${subtitleStyle.englishColor} · Chinese color: ${subtitleStyle.chineseColor}
Background opacity: ${subtitleStyle.backgroundOpacity}
Command:
${ffmpegCmd}
`;
  await writeFile(path.join(root, "ffmpeg-build.log"), logEntry);
  await run("ffmpeg", args);
  return { id, output, url:options.publicUrl || `/renders/${path.basename(output)}`, seconds:(Date.now() - started) / 1000, duration:total, clipsUsed:shots.filter((shot) => shot.video).length, subtitleStyle };
}

// Bridge-local reference images (e.g. http://127.0.0.1:4317/episodes/<id>/files/...)
// are unreachable from external providers like Volcengine Ark. Convert them to
// downscaled JPEG data URLs before forwarding as `image` reference inputs.
// External URLs and data URLs pass through; Volcengine will fetch them itself.
const LOCAL_REFERENCE_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/episodes\/([^/]+)\/files\/(.+)$/;
const REFERENCE_MAX_SIDE = 1024;
const REFERENCE_JPEG_QUALITY = 85;

async function resolveReferenceImage(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) return trimmed;
  const match = LOCAL_REFERENCE_PATTERN.exec(trimmed);
  if (!match) return trimmed; // External URL — let the provider fetch.
  try {
    const episodeId = decodeURIComponent(match[1]);
    const relativePath = match[2].split("/").map(decodeURIComponent).join(path.sep);
    const { filename } = await episodeStore.fileForRequest(episodeId, relativePath);
    const pipeline = sharp(filename).resize({ width:REFERENCE_MAX_SIDE, height:REFERENCE_MAX_SIDE, fit:"inside", withoutEnlargement:true }).jpeg({ quality:REFERENCE_JPEG_QUALITY, mozjpeg:true });
    const buffer = await pipeline.toBuffer();
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch (error) {
    // Don't fail the whole generation just because one neighbor reference can't
    // be resolved — the caller can still produce a usable image without it.
    return null;
  }
}

async function resolveReferenceImages(urls) {
  if (!Array.isArray(urls) || !urls.length) return [];
  const resolved = await Promise.all(urls.map((url) => resolveReferenceImage(url)));
  return resolved.filter((url) => Boolean(url));
}

export async function generateImage(data, options = {}) {
  data = resolveImageProvider(data);
  if (!data.endpoint) throw new Error("Provider endpoint is required");
  if (!data.model && data.kind !== "sdwebui") throw new Error("Provider model or endpoint ID is required");
  const fetchImpl = options.fetchImpl || fetch;
  const screenRatio = normalizeScreenRatio(data.screenRatio);
  const prompt = promptForScreenRatio(data.prompt, screenRatio);
  const sdSize = screenRatio === "16:9" ? { width:1344, height:768 } : screenRatio === "1:1" ? { width:1024, height:1024 } : screenRatio === "2:3" ? { width:832, height:1248 } : { width:768, height:1344 };
  if (data.kind === "sdwebui") {
    const endpoint = data.endpoint.includes("txt2img") ? data.endpoint : `${data.endpoint.replace(/\/$/,"")}/sdapi/v1/txt2img`;
    const response = await fetchImpl(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ prompt, negative_prompt:"text, watermark, logo, low quality, distorted anatomy, duplicate subjects", ...sdSize, steps:28 }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || `Provider returned ${response.status}`); if (!result.images?.[0]) throw new Error("Provider returned no image");
    return `data:image/png;base64,${result.images[0]}`;
  }
  const volcengineSize = "2k";
  const openaiSize = screenRatio === "16:9" ? "1536x1024" : screenRatio === "1:1" ? "1024x1024" : "1024x1536";
  if (data.kind === "dashscope") {
    // Qwen-Image 3.0 (sync multimodal-generation API); free pixel budget is
    // 512*512 to 2048*2048, so 16:9 / 9:16 / 1:1 map to 2048-wide frames.
    const dashscopeSize = screenRatio === "16:9" ? "2048*1152" : screenRatio === "1:1" ? "2048*2048" : screenRatio === "2:3" ? "1365*2048" : "1152*2048";
    const response = await fetchImpl(dashscopeImageGenerationEndpoint(data.endpoint), { method:"POST", headers:{"Content-Type":"application/json", Authorization:`Bearer ${data.apiKey}`}, body:JSON.stringify({
      model:data.model,
      input:{ messages:[{ role:"user", content:[{ text:prompt }] }] },
      parameters:{ size:dashscopeSize, n:1, prompt_extend:false, watermark:false, negative_prompt:"text, watermark, logo, low quality, distorted anatomy, duplicate subjects" },
    }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || result.code || `Provider returned ${response.status}`);
    const item = result.output?.choices?.[0]?.message?.content?.find((entry) => entry?.image);
    if (!item?.image) throw new Error("Provider returned no image");
    return item.image;
  }
  const referenceImages = await resolveReferenceImages(data.referenceImages);
  const requestBody = data.kind === "volcengine"
    ? { model:data.model, prompt, size:volcengineSize, ...(referenceImages.length ? { image:referenceImages } : {}), response_format:"url", watermark:false }
    : { model:data.model, prompt, size:openaiSize, n:1, response_format:"b64_json" };
  const endpoint = data.kind === "volcengine" ? providerEndpoint(data.endpoint, "images/generations") : data.endpoint;
  const response = await fetchImpl(endpoint, { method:"POST", headers:{"Content-Type":"application/json",...(data.apiKey?{Authorization:`Bearer ${data.apiKey}`}:{})}, body:JSON.stringify(requestBody) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || result.error || `Provider returned ${response.status}`); const item = result.data?.[0]; if (!item) throw new Error("Provider returned no image");
  return item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
}

// 组图（sequential_image_generation）单次请求最多可生成的图片数。
// 火山方舟 Seedream 官方上限：文生组图 ≤15；单图生组图 ≤14；多图生组图「参考图数 + 生成图数 ≤15」。
// 本项目组图走纯文生（无参考图），故取官方上限 15。
export const MAX_GROUP_IMAGES = 15;

export async function generateImageGroup(data, options = {}) {
  data = resolveImageProvider(data);
  const referenceImages = await resolveReferenceImages(data.referenceImages);
  const referenceCount = referenceImages.length;
  // 官方约束：参考图数 + 生成图数 ≤ 15。有参考图时生成额度相应减少。
  const maxShots = Math.max(1, MAX_GROUP_IMAGES - referenceCount);
  const shots = Array.isArray(data.shots) ? data.shots.slice(0, maxShots) : [];
  if (data.kind !== "volcengine") throw new Error("Group image generation is only available for Volcengine Seedream");
  if (!supportsImageGroups(data.model)) throw new Error(`Model ${data.model} does not support sequential image generation. Use Seedream 5.0 Lite, 4.5, or 4.0 for image groups.`);
  if (!data.endpoint) throw new Error("Provider endpoint is required");
  if (!data.model) throw new Error("Provider model or endpoint ID is required");
  if (!shots.length) throw new Error("At least one shot is required");
  const fetchImpl = options.fetchImpl || fetch;
  const screenRatio = normalizeScreenRatio(data.screenRatio);
  const size = "2k";
  const prompt = `Create a coherent sequential storyboard with one image for each numbered scene. Maintain character identity, wardrobe, setting, color grade, and cinematic style across the full sequence.\n\n${shots.map((shot, index) => `Scene ${index + 1}: ${promptForScreenRatio(shot.prompt, screenRatio)}`).join("\n\n")}`;
  const request = { method:"POST", headers:{ "Content-Type":"application/json", ...(data.apiKey ? { Authorization:`Bearer ${data.apiKey}` } : {}) }, body:JSON.stringify({ model:data.model, prompt, size, sequential_image_generation:"auto", sequential_image_generation_options:{ max_images:shots.length }, ...(referenceImages.length ? { image:referenceImages } : {}), stream:false, response_format:"url", watermark:false }) };
  const endpoint = providerEndpoint(data.endpoint, "images/generations");
  const sleepImpl = options.sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let response;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await fetchImpl(endpoint, request);
      break;
    } catch (error) {
      const code = error?.cause?.code || error?.code;
      const retryable = ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ENOTFOUND"].includes(code);
      if (!retryable || attempt === 2) throw new Error(`Ark did not respond while generating the image group (${code || "network failure"}). Try again, or generate individual shots for this batch.`, { cause:error });
      await sleepImpl(1000);
    }
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || `Provider returned ${response.status}`);
  const images = (result.data || []).map((item) => item?.b64_json ? `data:image/png;base64,${item.b64_json}` : item?.url).filter(Boolean);
  if (!images.length) throw new Error("Provider returned no images");
  return images;
}

function imageUrlsFromStreamEvent(value) {
  const urls = [];
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (typeof entry.url === "string") urls.push(entry.url);
    if (typeof entry.image === "string") urls.push(entry.image);
    Object.values(entry).forEach((child) => { if (child && typeof child === "object") visit(child); });
  };
  visit(value);
  return [...new Set(urls)];
}

export async function streamImageGroup(data, onImage, options = {}) {
  data = resolveImageProvider(data);
  const referenceImages = await resolveReferenceImages(data.referenceImages);
  const referenceCount = referenceImages.length;
  const maxShots = Math.max(1, MAX_GROUP_IMAGES - referenceCount);
  const shots = Array.isArray(data.shots) ? data.shots.slice(0, maxShots) : [];
  if (data.kind !== "volcengine" || !supportsImageGroups(data.model)) throw new Error("The selected model does not support streamed image groups");
  const screenRatio = normalizeScreenRatio(data.screenRatio);
  const prompt = `Create a coherent sequential storyboard with one image for each numbered scene. Maintain character identity, wardrobe, setting, color grade, and cinematic style across the full sequence.\n\n${shots.map((shot, index) => `Scene ${index + 1}: ${promptForScreenRatio(shot.prompt, screenRatio)}`).join("\n\n")}`;
  const response = await (options.fetchImpl || fetch)(providerEndpoint(data.endpoint, "images/generations"), { method:"POST", headers:{ "Content-Type":"application/json", Accept:"text/event-stream", ...(data.apiKey ? { Authorization:`Bearer ${data.apiKey}` } : {}) }, body:JSON.stringify({ model:data.model, prompt, size:"2k", sequential_image_generation:"auto", sequential_image_generation_options:{ max_images:shots.length }, ...(referenceImages.length ? { image:referenceImages } : {}), stream:true, response_format:"url", watermark:false }) });
  if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message || result.error || `Provider returned ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Ark did not return a streaming response");
  const decoder = new TextDecoder(); let buffer = ""; let nextIndex = 0; const seen = new Set();
  const consume = async (line) => {
    if (!line.startsWith("data:")) return;
    const text = line.slice(5).trim();
    if (!text || text === "[DONE]") return;
    try {
      for (const image of imageUrlsFromStreamEvent(JSON.parse(text))) {
        if (seen.has(image) || nextIndex >= shots.length) continue;
        seen.add(image); await onImage(image, shots[nextIndex], nextIndex); nextIndex += 1;
      }
    } catch { /* Ignore non-JSON SSE keepalive events. */ }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream:!done });
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
    for (const line of lines) await consume(line);
    if (done) break;
  }
  if (!nextIndex) throw new Error("Ark completed the stream without returning an image");
}

export function supportsImageGroups(model) {
  const normalized = String(model || "").toLowerCase();
  return /seedream[-.]5[-.]0[-.]lite|seedream[-.]5[-.]0[-.]260128|seedream[-.]4[-.]5|seedream[-.]4[-.]0/.test(normalized);
}

function providerEndpoint(endpoint, pathSuffix) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  if (!base) return "";
  return base.endsWith(`/${pathSuffix}`) ? base : `${base}/${pathSuffix}`;
}

function videoTasksEndpoint(endpoint) {
  return providerEndpoint(endpoint, "contents/generations/tasks");
}

/* DashScope native API helpers: the endpoint may be a bare host
   (DASHSCOPE_HOST) or already carry an /api/v1/... path. */
function dashscopeApiBase(endpoint) {
  return String(endpoint || "").replace(/\/+$/, "").replace(/\/api\/v1.*$/, "");
}

function dashscopeVideoSynthesisEndpoint(endpoint) {
  return `${dashscopeApiBase(endpoint)}/api/v1/services/aigc/video-generation/video-synthesis`;
}

function dashscopeTasksEndpoint(endpoint) {
  return `${dashscopeApiBase(endpoint)}/api/v1/tasks`;
}

function dashscopeImageGenerationEndpoint(endpoint) {
  return `${dashscopeApiBase(endpoint)}/api/v1/services/aigc/multimodal-generation/generation`;
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

/* Providers occasionally answer errors as plain text ("invalid parameter...").
   Parse defensively so the real message surfaces instead of a SyntaxError. */
async function readProviderBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { return text.trim() ? { error:text.trim() } : {}; }
}

/* Retry a fetch on transient network failures (connection reset, socket close,
   DNS flaps). HTTP responses — even error statuses — are returned as-is so
   callers can surface the provider's real message. */
async function fetchWithRetry(fetchImpl, url, options = {}, { attempts = 3, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await fetchImpl(url, options); }
    catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastError;
}

export async function generateVideo(data, options = {}) {
  data = resolveVideoProvider(data);
  if (data.kind !== "volcengine" && data.kind !== "dashscope" && data.kind !== "pixstag") throw new Error("Volcengine Ark, Aliyun DashScope (Wan), and PixStag (MiniMax-H3) are the only configured video providers");
  if (!data.endpoint || !data.apiKey || !data.model) throw new Error("Video endpoint, API key, and model are required");
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || Number(process.env.VIDEO_POLL_INTERVAL_MS) || 5000);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || Number(process.env.VIDEO_REQUEST_TIMEOUT_MS) || 15 * 60 * 1000);
  const screenRatio = normalizeScreenRatio(data.screenRatio);
  const duration = Math.max(2, Math.min(12, Math.ceil(Number(data.duration) || 5)));
  const directTextToVideo = data.generationMode === "long-scenes" || !data.image;
  /* PixStag only accepts a publicly reachable first-frame URL (its url field
     rejects data URLs with an over-length error). Public URLs pass through
     as-is; local storyboard frames and data URLs are uploaded to Aliyun OSS
     and replaced with a short-lived presigned URL. */
  let image = "";
  if (!directTextToVideo) {
    if (data.kind === "pixstag") {
      const resolved = await providerImageUrl(data.image);
      const isPublicUrl = /^https?:\/\//i.test(resolved) && !/localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(resolved);
      image = isPublicUrl ? resolved : await (options.ossUpload || uploadToOssAndSign)(resolved);
      await logRenderEvent("video-frame-prepared", { kind:data.kind, viaOss:!isPublicUrl, framePrefix:String(image || "").slice(0, 80) });
    } else {
      image = await prepareProviderImage(data.image, screenRatio, { fetchImpl:options.imageFetchImpl });
    }
  }
  const direction = String(data.motion || "Slow push-in").trim();
  const motionPrompt = promptForScreenRatio(data.videoPrompt || data.prompt || (directTextToVideo ? "Create a coherent cinematic scene with natural subject and environmental motion" : "Animate this storyboard frame naturally with coherent subject and environmental motion"), screenRatio);
  const prompt = directTextToVideo
    ? `${motionPrompt}. Camera direction: ${direction}. Generate the full scene directly from this description as one continuous take with coherent visual beats, stable identity and anatomy, consistent setting, lighting, and style; avoid text, logos, cuts, flicker, warping, morphing, or unrelated subjects.`
    : `${motionPrompt}. Camera direction override: ${direction}. Treat the supplied image as the exact first frame. Preserve its subject identity, composition, lighting, and visual style throughout one continuous shot; avoid text, logos, cuts, flicker, warping, morphing, or new subjects.`;
  if (data.kind === "dashscope") {
    return generateDashscopeVideo({ ...data, prompt, image, screenRatio, duration, directTextToVideo }, { fetchImpl, sleepImpl, pollIntervalMs, timeoutMs });
  }
  if (data.kind === "pixstag") {
    return generatePixstagVideo({ ...data, prompt, image, screenRatio, duration, directTextToVideo }, { fetchImpl, sleepImpl, pollIntervalMs, timeoutMs });
  }
  const endpoint = videoTasksEndpoint(data.endpoint);
  const headers = { "Content-Type":"application/json", Authorization:`Bearer ${data.apiKey}` };
  // Some Seedance variants (e.g. *-fast) reject higher resolutions, especially
  // for image-to-video. Start high and fall back when the provider complains.
  const requestedResolution = /^(1080|720|480)p$/.test(String(data.resolution || "")) ? String(data.resolution) : "1080p";
  const resolutionCandidates = [...new Set([requestedResolution, "720p", "480p"])];
  let created = null;
  for (const resolution of resolutionCandidates) {
    const createdResponse = await fetchImpl(endpoint, { method:"POST", headers, body:JSON.stringify({
      model:data.model,
      content:directTextToVideo ? [{ type:"text", text:prompt }] : [
        { type:"text", text:prompt },
        { type:"image_url", image_url:{ url:image }, role:"first_frame" },
      ],
      duration,
      ratio:screenRatio,
      resolution,
      generate_audio:false,
      watermark:false,
    }) });
    created = await readProviderBody(createdResponse);
    if (createdResponse.ok) break;
    const message = providerError(created, createdResponse.status);
    const resolutionRejected = /resolution/i.test(message) && resolutionCandidates.indexOf(resolution) < resolutionCandidates.length - 1;
    if (!resolutionRejected) throw new Error(message);
  }
  if (!created.id) throw new Error("Video provider returned no task ID");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleepImpl(pollIntervalMs);
    const response = await fetchImpl(`${endpoint}/${encodeURIComponent(created.id)}`, { headers });
    const result = await readProviderBody(response);
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

/* Aliyun Bailian (DashScope) Wan video generation. Creates an asynchronous
   task via /api/v1/services/aigc/video-generation/video-synthesis (requires
   the X-DashScope-Async header) and polls /api/v1/tasks/{task_id} until the
   clip URL appears in output.video_url. */
async function generateDashscopeVideo(data, options = {}) {
  const { fetchImpl, sleepImpl, pollIntervalMs, timeoutMs } = options;
  const endpoint = dashscopeVideoSynthesisEndpoint(data.endpoint);
  const tasksEndpoint = dashscopeTasksEndpoint(data.endpoint);
  const headers = { "Content-Type":"application/json", Authorization:`Bearer ${data.apiKey}`, "X-DashScope-Async":"enable" };
  const requestedResolution = /^(1080|720|480)p$/i.test(String(data.resolution || "")) ? `${String(data.resolution).replace(/p$/i, "").toUpperCase()}P` : "1080P";
  const resolutionCandidates = [...new Set([requestedResolution, "720P", "480P"])];
  // Wan clips support discrete lengths (5s / 10s); snap the requested duration.
  const duration = Number(data.duration) >= 8 ? 10 : 5;
  let created = null;
  for (const resolution of resolutionCandidates) {
    const createdResponse = await fetchImpl(endpoint, { method:"POST", headers, body:JSON.stringify({
      model:data.model,
      input: data.directTextToVideo
        ? { prompt:data.prompt }
        : { prompt:data.prompt, media:[{ type:"first_frame", url:data.image }] },
      parameters:{ resolution, ratio:data.screenRatio, duration, prompt_extend:false, watermark:false },
    }) });
    created = await readProviderBody(createdResponse);
    if (createdResponse.ok) break;
    const message = providerError(created, createdResponse.status);
    const resolutionRejected = /resolution/i.test(message) && resolutionCandidates.indexOf(resolution) < resolutionCandidates.length - 1;
    if (!resolutionRejected) throw new Error(message);
  }
  const taskId = created?.output?.task_id;
  if (!taskId) throw new Error(created?.message || created?.code || "Video provider returned no task ID");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleepImpl(pollIntervalMs);
    const response = await fetchImpl(`${tasksEndpoint}/${encodeURIComponent(taskId)}`, { headers:{ Authorization:`Bearer ${data.apiKey}` } });
    const result = await readProviderBody(response);
    if (!response.ok) throw new Error(providerError(result, response.status));
    const status = String(result.output?.task_status || "").toUpperCase();
    if (status === "SUCCEEDED") {
      if (!result.output?.video_url) throw new Error("Video task succeeded without a download URL");
      return { taskId, videoUrl:result.output.video_url, duration:Number(result.output?.duration) || duration, status:"succeeded" };
    }
    if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") throw new Error(result.output?.message || result.output?.code || `Video task failed (${status})`);
    if (status !== "PENDING" && status !== "RUNNING" && status !== "QUEUED") throw new Error(`Video provider returned unexpected task status: ${status || "unknown"}`);
  }
  throw new Error(`Video generation timed out after ${Math.round(timeoutMs / 1000)} seconds`);
}

/* PixStag endpoint helpers: the endpoint may be a bare host
   (https://pixstag.com) or already carry an /api/v2/... path. */
function pixstagApiBase(endpoint) {
  return String(endpoint || "").replace(/\/+$/, "").replace(/\/api\/v2.*$/, "");
}

function pixstagVideoGenerationEndpoint(endpoint) {
  return `${pixstagApiBase(endpoint)}/api/v2/video_generation`;
}

function pixstagQueryVideoEndpoint(endpoint, taskId) {
  return `${pixstagApiBase(endpoint)}/api/v2/query/video_generation/${encodeURIComponent(taskId)}`;
}

/* PixStag (MiniMax-H3) video generation. Mirrors the MiniMax V2 protocol:
   POST /api/v2/video_generation with a multimodal content[] array, then poll
   GET /api/v2/query/video_generation/{task_id} until task.status succeeds and
   the clip URL appears in task.content.url. */
async function generatePixstagVideo(data, options = {}) {
  const { fetchImpl, sleepImpl, pollIntervalMs, timeoutMs } = options;
  const endpoint = pixstagVideoGenerationEndpoint(data.endpoint);
  const headers = { "Content-Type":"application/json", Authorization:`Bearer ${data.apiKey}` };
  // PixStag supports 720P / 768P / 1080P / 2K. Map the app's 480p budget
  // tier up to 720P (PixStag's cheapest) and fall back when rejected.
  const normalizedResolution = String(data.resolution || "").toLowerCase();
  const requestedResolution = normalizedResolution === "480p" || normalizedResolution === "720p" ? "720P" : normalizedResolution === "2k" ? "2K" : "1080P";
  const resolutionCandidates = [...new Set([requestedResolution, "720P"])];
  // MiniMax-H3 accepts integer durations from 4 to 15 seconds.
  const duration = Math.max(4, Math.min(15, Math.ceil(Number(data.duration) || 5)));
  let created = null;
  for (const resolution of resolutionCandidates) {
    const createdResponse = await fetchWithRetry(fetchImpl, endpoint, { method:"POST", headers, body:JSON.stringify({
      model:data.model,
      content: data.directTextToVideo
        ? [{ type:"text", text:data.prompt }]
        : [
            { type:"text", text:data.prompt },
            { type:"image_url", image_url:{ url:data.image }, role:"first_frame" },
          ],
      duration,
      ratio:data.screenRatio,
      resolution,
    }) });
    created = await readProviderBody(createdResponse);
    if (createdResponse.ok) break;
    const message = providerError(created, createdResponse.status);
    const resolutionRejected = /resolution/i.test(message) && resolutionCandidates.indexOf(resolution) < resolutionCandidates.length - 1;
    if (!resolutionRejected) throw new Error(message);
  }
  const taskId = created?.task_id;
  if (!taskId) throw new Error(providerError(created, 0) || "Video provider returned no task ID");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleepImpl(pollIntervalMs);
    const response = await fetchWithRetry(fetchImpl, pixstagQueryVideoEndpoint(data.endpoint, taskId), { headers:{ Authorization:`Bearer ${data.apiKey}` } });
    const result = await readProviderBody(response);
    if (!response.ok) throw new Error(providerError(result, response.status));
    const task = result.task || {};
    const status = String(task.status || "").toLowerCase();
    if (status === "succeeded") {
      if (!task.content?.url) throw new Error("Video task succeeded without a download URL");
      return { taskId, videoUrl:task.content.url, duration:Number(task.duration) || duration, status };
    }
    if (status === "failed" || status === "cancelled" || status === "expired") throw new Error(task.error?.message || task.error?.code || `Video task failed (${status})`);
    if (status !== "queued" && status !== "running") throw new Error(`Video provider returned unexpected task status: ${status || "unknown"}`);
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
      await logRenderError("text-provider-fetch-failed", retryError, { kind:data.kind, endpoint, model:data.model });
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

export async function generateDocumentaryScript(data, options = {}) {
  const config = resolveTextProvider(data);
  if (!config.endpoint || !config.apiKey || !config.model) throw new Error("Text endpoint, API key, and model or endpoint ID are required");
  const topic = String(data.topic || "").trim();
  if (!topic) throw new Error("A topic is required to generate the script");
  const duration = Math.max(2, Math.min(6, Math.round(Number(data.duration) || 3)));
  const creativeDirection = String(data.creativeDirection || "").trim();
  const genre = getGenre(data.genre);
  const templateDirection = genre.id === "documentary"
    ? ""
    : `\n\nSELECTED CONTENT TEMPLATE: ${genre.label}. Write this as a ${genre.defaultContentFormat}. Follow this editorial structure: ${genre.planningStyle}. Visual planning later uses this tone: ${genre.visualTone}. Treat any history-specific instruction below as applicable only when the topic itself is historical.`;
  const wordRanges = { 2:[180,220], 3:[270,330], 4:[360,440], 5:[450,550], 6:[540,660] };
  const [minWords, maxWords] = wordRanges[duration];
  const hookTimes = { 2:"0–15 sec", 3:"0–20 sec", 4:"0–30 sec", 5:"0–35 sec", 6:"0–45 sec" };
  const setupTimes = { 2:"15–45 sec", 3:"20–65 sec", 4:"30–90 sec", 5:"35–110 sec", 6:"45–135 sec" };
  const coreTimes = { 2:"45–100 sec", 3:"65–150 sec", 4:"90–200 sec", 5:"110–250 sec", 6:"135–300 sec" };
  const closeTimes = { 2:"100–120 sec", 3:"150–180 sec", 4:"200–240 sec", 5:"250–300 sec", 6:"300–360 sec" };
  const system = `You are a senior documentary scriptwriter for a history channel aimed at B1–B2 English learners. Write one accurate, high-retention English history documentary script from the user's topic.

Return one compact RFC 8259 JSON object only, without Markdown, comments, or explanation. The JSON must have two fields: "title" (a clear, interesting, historically accurate video title) and "script" (the full narration-only script in plain text, with no headings, timing labels, or word-count notes). Escape every quote, backslash, and line break inside string values.

BUILD THE STORY: Identify the central historical question, time span, geography, major actors, turning point, and consequences. Choose one clear narrative path. Arrange facts as cause and effect. Verify dates, names, and chronology. Distinguish established fact from interpretation. Never invent dialogue, motives, or precise details.

ENGLISH LEVEL: Use common everyday words. Write clear sentences with one main idea, mostly 8–16 words. Prefer active voice. Avoid rare words, academic language, old-fashioned language, abstract noun chains, and complex idioms. Keep necessary historical names and terms — explain each difficult term in simple words when it first appears. Simple English must not become childish, vague, or inaccurate.

DURATION: ${duration} minutes. Write ${minWords}–${maxWords} words of narration at 90–110 words per minute. Count narration only.

STRUCTURE:
1. HOOK (${hookTimes[duration]}): Treat the first two spoken sentences as a cold open for a video hook. Sentence 1 must begin inside the story's most vivid, verified climax, reversal, danger, or irreversible decision, using a concrete image and active present-tense narration where natural. Sentence 2 must immediately reveal the stakes or a sharp unanswered question that makes the viewer need the backstory. Do not begin chronologically, with broad context, greetings, or "Today we will learn." Do not invent drama or reveal the entire outcome. Keep these two sentences concise and visually arresting; the later setup can return to when, where, and who.
2. SETUP (${setupTimes[duration]}): Establish when, where, who, and why this moment matters. State what could be gained, lost, changed, or remembered.
3. CONFLICT & PAYOFF (${coreTimes[duration]}): Build the decisive sequence through actions, choices, pressure, setbacks, and rising consequences. Add one natural midpoint re-hook (new danger, reversal, or surprising fact). Reach a clear turning point, then deliver the answer promised by the opening.
4. GLOBAL VIEW & CLOSE (${closeTimes[duration]}): Show why the payoff mattered. Pull back to a wider global-history perspective on the event's consequences and legacy. End with one memorable, reflective sentence.

NARRATIVE VOICE: Calm, confident, cinematic, humane at a measured documentary pace. Create tension from real stakes and uncertainty — not clickbait. Center human agency while acknowledging institutions, geography, technology, belief, and chance. Do not add shot lists, editing directions, or music cues.

QUALITY: Create attention through real stakes — not invented drama. Do not use unsupported superlatives. Do not repeat facts merely to fill time. Do not add calls to action.${templateDirection}`;

  const userMessage = JSON.stringify({
    topic,
    durationMinutes: duration,
    targetWordRange: `${minWords}–${maxWords} words`,
    creativeDirection: creativeDirection || undefined,
    instruction: `Write a ${duration}-minute ${genre.id === "documentary" ? "history documentary" : genre.label} script about "${topic}". The script field must contain only the spoken narration (no headings, no timing labels, no word counts). The title field must be a clear, engaging video title.`,
  });

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || Number(process.env.TEXT_REQUEST_TIMEOUT_MS) || 120000);
  const endpoint = config.kind === "volcengine" ? textCompletionsEndpoint(config.endpoint) : config.endpoint;
  const payload = config.kind === "volcengine" && isVolcenginePlanEndpoint(endpoint)
    ? { model:config.model, messages:[{ role:"system", content:system }, { role:"user", content:userMessage }], max_tokens:8000 }
    : { model:config.model, temperature:.3, max_tokens:8000, response_format:{ type:"json_object" }, ...(config.kind === "volcengine" ? { thinking:{ type:"disabled" } } : {}), messages:[{ role:"system", content:system }, { role:"user", content:userMessage }] };
  const request = { method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${config.apiKey}`}, body:JSON.stringify(payload) };
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
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Provider returned ${response.status}`);
  const raw = result.choices?.[0]?.message?.content || "{}";
  const parsed = parseProviderJson(raw);
  const title = String(parsed.title || "").trim();
  const script = String(parsed.script || "").trim();
  if (!title) throw new Error("The provider did not return a title");
  if (!script) throw new Error("The provider did not return a script");
  return { title, script };
}

// Chinese suspense-driven character-story script generator (story genre),
// matching the "档案 / 悬疑解说" account tone. Mirrors generateDocumentaryScript's
// request flow but produces a single-language Chinese narration with hook,
// layered reveals, and period-accurate historical grounding.
export async function generateStoryScript(data, options = {}) {
  const config = resolveTextProvider(data);
  if (!config.endpoint || !config.apiKey || !config.model) throw new Error("Text endpoint, API key, and model or endpoint ID are required");
  const topic = String(data.topic || "").trim();
  if (!topic) throw new Error("A topic is required to generate the script");
  const duration = Math.max(2, Math.min(6, Math.round(Number(data.duration) || 3)));
  const creativeDirection = String(data.creativeDirection || "").trim();
  const genre = getGenre(data.genre);
  const isHistoricalStory = genre.id === "story";
  const charRanges = { 2:[440,520], 3:[660,780], 4:[880,1040], 5:[1100,1300], 6:[1320,1560] };
  const [minChars, maxChars] = charRanges[duration];
  const hookTimes = { 2:"0–15秒", 3:"0–20秒", 4:"0–30秒", 5:"0–35秒", 6:"0–45秒" };
  const setupTimes = { 2:"15–45秒", 3:"20–65秒", 4:"30–90秒", 5:"35–110秒", 6:"45–135秒" };
  const coreTimes = { 2:"45–100秒", 3:"65–150秒", 4:"90–200秒", 5:"110–250秒", 6:"135–300秒" };
  const closeTimes = { 2:"100–120秒", 3:"150–180秒", 4:"200–240秒", 5:"250–300秒", 6:"300–360秒" };
  const system = isHistoricalStory
    ? `你是深耕历史人物故事的短视频解说编剧，对标头部「人物档案 / 悬疑解说」账号的调性。根据用户给出的人物或历史事件，写一条高留存的中文人物故事解说文案。`
    : `你是中文短视频知识类解说编剧。请按「${genre.labelZh}」模板写一条高留存、事实准确的中文口播。模板结构：${genre.planningStyle}。视觉基调：${genre.visualTone}。围绕一个具体、可回答的问题展开，先给反直觉钩子，再用清晰因果解释，结尾回到观众日常理解。不要将题目泛化成宽泛的百科介绍，不要编造事实或数字。`;
  const requirements = isHistoricalStory ? `

只返回一个紧凑的 RFC 8259 JSON 对象，不要 Markdown、注释或解释。JSON 必须包含两个字段："title"（一个清晰、有钩子、史实准确的中文视频标题）和 "script"（纯口播解说文案，不要任何小标题、时间标签或字数备注）。字符串值内的引号、反斜杠和换行都要转义。

史实要求：人名、年代、地点、事件必须真实可考；明确区分史实与传说/演义，不虚构对话、动机或细节；拿不准的用更宽泛但准确的历史时期表述，不编造精确数字。

叙事要求：
1. 悬疑钩子：开头不按时间顺序，不从"今天讲谁"这类套路开场。第一句直接切入人物一生中最戏剧性的转折、绝境、反转或致命抉择，用具体画面感加一个悬而未决的问题，让观众必须看下去。前两句是冷开场钩子。
2. 分层揭示：正文像剥洋葱一样层层推进——先给悬念，再给背景，再给冲突与抉择，最后揭晓真相与余波。中间至少埋一个「重新钩住」的反转或惊人事实。
3. 语言：口语化、克制、有电影感，多用短句，节奏张弛有度。用人物的真实处境制造张力，不靠耸动标题党，不滥用最高级形容词。
4. 视角：第三人称、冷静有分寸的旁白，像在讲述一段被重新发现的档案。

时长：${duration} 分钟，写 ${minChars}–${maxChars} 字的口播（按每分钟约 240 字），只统计口播字数。

结构：
1. HOOK（${hookTimes[duration]}）：冷开场钩子，切入最戏剧性的绝境/反转/抉择，用具体画面加悬念问题。
2. 背景铺垫（${setupTimes[duration]}）：交代人物、时代、处境，以及这件事为什么重要。
3. 冲突与揭示（${coreTimes[duration]}）：用行动、抉择、压力、挫折、反转层层推进，中间埋一个重新钩住的反转；到达关键转折点后揭晓开头埋下的答案。
4. 全局视角与收尾（${closeTimes[duration]}）：点明这件事的历史影响与余波，用一句留白式、可回味的结尾收束。

不要加镜头表、剪辑提示、配乐提示或行动号召。` : `

只返回一个紧凑的 RFC 8259 JSON 对象，不要 Markdown、注释或解释。JSON 必须包含 "title"（清晰、有钩子的中文标题）和 "script"（纯中文口播正文，不要小标题、时间标签或字数备注）字段。引用事实时保持准确；不确定的信息要用审慎、可验证的表述，不能虚构来源、数据或经历。

时长：${duration} 分钟，写 ${minChars}–${maxChars} 字口播（每分钟约 240 字），只统计口播字数。

结构：
1. HOOK（${hookTimes[duration]}）：第一句直接抛出观众熟悉却不知道答案的具体反差、问题或场景，第二句承诺解释关键原因。
2. 拆解（${setupTimes[duration]}）：明确对象、条件和核心概念，用最少必要背景建立理解。
3. 原理与证据（${coreTimes[duration]}）：按因果链分步解释；至少有一个能改变直觉的细节或反转；例子必须服务于结论。
4. 收束（${closeTimes[duration]}）：回到开头的问题，说明这条机制会怎样影响真实世界或日常选择。

语言：自然、口语化、具体、克制；短句为主，避免空泛形容词、标题党和行动号召。不要加镜头表、剪辑提示或配乐提示。`;
  const fullSystem = `${system}${requirements}`;

  const userMessage = JSON.stringify({
    topic,
    durationMinutes: duration,
    targetCharRange: `${minChars}–${maxChars} 字`,
    creativeDirection: creativeDirection || undefined,
    instruction: `围绕「${topic}」写一条 ${duration} 分钟的${isHistoricalStory ? "中文人物故事" : `中文${genre.labelZh}`}解说文案。script 字段只放口播正文（无小标题、无时间标签、无字数备注），title 字段放一个清晰有钩子的标题。`,
  });

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || Number(process.env.TEXT_REQUEST_TIMEOUT_MS) || 120000);
  const endpoint = config.kind === "volcengine" ? textCompletionsEndpoint(config.endpoint) : config.endpoint;
  const payload = config.kind === "volcengine" && isVolcenginePlanEndpoint(endpoint)
    ? { model:config.model, messages:[{ role:"system", content:fullSystem }, { role:"user", content:userMessage }], max_tokens:8000 }
    : { model:config.model, temperature:.3, max_tokens:8000, response_format:{ type:"json_object" }, ...(config.kind === "volcengine" ? { thinking:{ type:"disabled" } } : {}), messages:[{ role:"system", content:fullSystem }, { role:"user", content:userMessage }] };
  const request = { method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${config.apiKey}`}, body:JSON.stringify(payload) };
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
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Provider returned ${response.status}`);
  const raw = result.choices?.[0]?.message?.content || "{}";
  const parsed = parseProviderJson(raw);
  const title = String(parsed.title || "").trim();
  const script = String(parsed.script || "").trim();
  if (!title) throw new Error("The provider did not return a title");
  if (!script) throw new Error("The provider did not return a script");
  return { title, script };
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
  const raw = await completeText(data, [{role:"system",content:"Translate English short-video subtitles into concise, natural Simplified Chinese. Preserve names, numbers, dates, tone, and factual meaning. Keep the exact same sentence boundaries as the English source — every period, exclamation, and question mark must correspond to a matching Chinese sentence break. Never merge two English sentences into one Chinese sentence or split one English sentence into multiple Chinese sentences. Return one compact RFC 8259 JSON object with a translations array in the same order. Do not use Markdown. Escape all quotes, backslashes, and line breaks inside strings."},{role:"user",content:JSON.stringify({lines:data.lines})}], { temperature:.2, maxTokens:8000 });
  const parsed = await parseOrRepairProviderJson(raw, resolveTextProvider(data), {}, "an object with a translations array"); if (!Array.isArray(parsed.translations)) throw new Error("Translation provider returned an unexpected format"); return parsed.translations;
}

// 从剧本提取核心角色清单，供「角色定妆图 + 分段组图」使用。
// 返回 [{ name, appearance }]，appearance 是英文生图 prompt（供定妆图与一致性锚点）。
export async function extractCharacters(data, options = {}) {
  const config = resolveTextProvider(data);
  if (!config.apiKey || !config.model) throw new Error("No planning API key or model is configured");
  const script = String(data.script || "").trim();
  if (!script) throw new Error("A script is required");
  const narrationLang = getGenre(data.genre).primaryLanguage === "zh" ? "Simplified Chinese" : "English";
  const system = `You are a casting director for a short-form ${narrationLang} narrative video. Extract the core recurring human characters from the supplied narration so their appearance stays consistent across AI-generated images. Return one compact RFC 8259 JSON object only, without Markdown, comments, or explanation, with a "characters" array. Each entry must contain: name (the canonical name used in the narration) and appearance (a concise visual description for a portrait reference image, written in English for the image model — age, face, build, hairstyle, distinctive clothing, and one era-accurate wardrobe detail; at most 45 words; no text, no watermark). Include only characters who appear in multiple scenes or are visually central; skip one-off or unnamed background figures. Return at most 8 characters, ordered by story importance. If the narration has no recurring human characters, return an empty characters array.`;
  const raw = await completeText(config, [
    { role:"system", content:system },
    { role:"user", content:JSON.stringify({ script }) },
  ], { temperature:.2, maxTokens:4000, fetchImpl:options.fetchImpl });
  const parsed = await parseOrRepairProviderJson(raw, config, options, "an object with a characters array");
  const characters = (Array.isArray(parsed.characters) ? parsed.characters : [])
    .map((item) => ({ name:String(item?.name || "").trim(), appearance:String(item?.appearance || "").trim() }))
    .filter((item) => item.name && item.appearance);
  return characters.slice(0, 8);
}

export async function planEpisode(data, options = {}) {
  const config = resolveTextProvider(data);
  if (!config.apiKey || !config.model) throw new Error("No planning API key or model is configured");
  if (!String(config.script || "").trim()) throw new Error("A script is required");
  const productionMode = config.productionMode === "long-scenes" ? "long-scenes" : config.productionMode === "mixed" ? "mixed" : "short-shots";
  const longScenes = productionMode === "long-scenes";
  const mixedMode = productionMode === "mixed";
  const targetClipDuration = Math.max(6, Math.min(12, Math.round(Number(config.longClipDuration) || 10)));
  const shortClipDuration = Math.max(5, Math.min(20, Math.round(Number(config.shortClipDuration) || 15)));
  const genre = getGenre(data.genre);
  const storyGenre = genre.primaryLanguage === "zh";
  const narrationLang = storyGenre ? "Simplified Chinese" : "English";
  const formatDirective = storyGenre
    ? `for a suspense-driven character story in the style of ${genre.visualTone}`
    : `for ${genre.planningStyle}, with the visual tone of ${genre.visualTone}`;
  const chineseField = storyGenre ? "" : ", chinese (concise Simplified Chinese translation)";
  const shortSystem = `You are a senior storyboard editor for short-form social video. Break the supplied ${narrationLang} narration into compelling visual shots ${formatDirective}. Preserve every spoken word in order across the narration fields; do not add unsupported facts. Return one compact RFC 8259 JSON object only, without Markdown, comments, or explanation, with a shots array. Escape every quote, backslash, and line break inside string values. Each shot must contain: narration (a non-empty exact consecutive excerpt)${chineseField}, type (Opening, Narrative, Climax, Map, Timeline, or Emotion), duration in seconds, prompt (a concise still-image generation prompt, at most 55 words, faithful to the narration, content format, visual style, creative direction, and requested screen ratio, with subject, setting, composition, lighting, and exclusions for text and watermark), videoPrompt (a separate image-to-video prompt, at most 55 words, describing specific subject action, secondary environmental motion, pace, camera behavior, and continuity from the supplied first frame; demand one continuous shot with stable identity and anatomy, and exclude cuts, new subjects, text, logos, flicker, warping, and morphing), and motion (one of Slow push-in, Slow pull-out, Slow drift, Slow rise, Slow sink, Diagonal drift, Push to subject, Static; vary the choice across shots, prefer Push to subject when the frame's subject occupies the upper third), subject (one of "character", "environment", "text-card": whether the shot features the story's named human subject(s), a location/object/atmosphere without the named characters, or a diagram/text card such as a map or timeline), and characters (an array of canonical character names from the supplied character list who visibly appear in this shot; an empty array if none appear). For historical subjects or whenever the narration contains a date or period cue, every image prompt must explicitly name the most accurate era or date and location supported by the script, then describe a period-accurate background and relevant architecture, landscape or interior, clothing, materials, props, transport, weapons, and technology. Never mix eras or include anachronisms. If the precise year is uncertain, use a broader historically accurate period rather than inventing specificity. The videoPrompt must animate what is already established by prompt and must agree with motion; it must not invent a different scene. The first shot (type Opening) is the visual hook that determines whether viewers stay or swipe away — over half of viewers leave within 2 seconds if the opening image is weak. Its image prompt must create immediate visual impact: dramatic cinematic lighting (chiaroscuro, golden hour, atmospheric haze, volumetric light), striking composition (strong focal point, depth, scale contrast, leading lines), and visual tension or mystery that sparks curiosity. Never use a map, chart, timeline, diagram, split-screen comparison, or flat informational establishing shot as the first shot. Prefer a dramatic close-up, an epic wide shot with scale contrast, or a moment of human emotion over a flat wide establishing shot. The opening image should feel like a movie poster or a cinematic teaser, not a textbook illustration. Never return an empty object, empty narration, placeholder shot, or trailing item merely to reach a requested count. Timing guidance: the requested target shot length is ${shortClipDuration} seconds. Keep every ordinary shot close to ${shortClipDuration} seconds and never longer than ${shortClipDuration + 4} seconds. Prefer natural topic shifts, scene changes, or turning points, but split as soon as the subject, location, or action changes instead of bundling unrelated sentences to fill time. The opening hook must be about 5 seconds; ordinary narration ${Math.max(5, shortClipDuration - 3)}–${shortClipDuration + 2}; climaxes 6–12; maps and timelines ${shortClipDuration}–${Math.max(12, shortClipDuration + 6)}; emotional turns ${Math.max(5, shortClipDuration - 3)}–${shortClipDuration + 2}. Avoid shots shorter than 5 seconds, except the opening hook. When narration duration and shot-count guidance are supplied, create at least the minimum number of shots and aim for the target count by grouping sentences into meaningful clusters; if the script cannot be grouped further, return fewer complete shots rather than an empty placeholder. The sum of shot durations must match the supplied narration duration. Adapt visual vocabulary to the episode instead of assuming any particular topic.`;
  const unrestrictedShortSystem = shortSystem
    .replace("The opening hook must be about 5 seconds; ", "")
    .replace("Avoid shots shorter than 5 seconds, except the opening hook.", "Avoid arbitrary fixed durations; let each shot follow its narration excerpt.");
  const mixedSystem = `${unrestrictedShortSystem} This request uses mixed mode to control generation cost. Add videoRecommended (boolean) to every shot. When targetAnimatedShotCount is supplied, mark exactly that many shots true; otherwise mark roughly one in every four shots true. Mark all others false. Spread the selections across the full episode and prioritize the opening hook, climaxes, emotional turns, and shots where real subject or environmental motion adds clear value. A recommended video still begins from its generated storyboard image; write every videoPrompt so it also works as a strong image-to-video instruction. Do not recommend adjacent shots unless the narrative makes both essential.`;
  const longSystem = `You are a senior text-to-video scene planner for short-form social video. Divide the supplied ${narrationLang} narration into meaningful consecutive scenes for direct text-to-video generation, without creating or relying on storyboard images. Preserve every spoken word in order across the narration fields and do not add unsupported facts. Prefer natural pauses, complete ideas, and real changes of setting or action over arbitrary cuts. Return one compact RFC 8259 JSON object only, without Markdown, comments, or explanation, with a shots array. Escape every quote, backslash, and line break inside string values. Each scene must contain: narration (a non-empty exact consecutive excerpt)${chineseField}, type (Opening, Narrative, Climax, Map, Timeline, or Emotion), duration in seconds, videoPrompt (a detailed direct text-to-video prompt of at most 100 words), and motion (one of Slow push-in, Slow pull-out, Slow drift, Slow rise, Slow sink, Diagonal drift, Push to subject, Static). The videoPrompt must faithfully visualize the complete narration excerpt as a coherent sequence of two or three timed visual beats within one continuous take. Describe subject identity and appearance, setting, actions in order, environmental motion, lighting, pace, camera path, and continuity. Do not refer to a supplied image or first frame. Exclude cuts, unrelated subjects, text, logos, flicker, unstable anatomy, warping, and morphing. The first scene (type Opening) is the visual hook that determines whether viewers stay or swipe away — over half of viewers leave within 2 seconds if the opening is weak. Its videoPrompt must create immediate visual impact: dramatic cinematic lighting, striking composition, and visual tension or mystery. Never open with a map, chart, diagram, split-screen comparison, or flat informational establishing shot. Prefer a dramatic close-up, an epic wide shot with scale contrast, or a moment of human emotion. The opening should feel like a movie teaser, not a textbook illustration. For historical subjects or whenever the narration contains a date or period cue, explicitly name the most accurate era or date and location supported by the script and require period-accurate architecture, landscape or interiors, clothing, materials, props, transport, weapons, and technology; never mix eras or include anachronisms. Target the requested clip length, keep every normal scene between 6 and 12 seconds, and rebalance neighboring scenes so the final scene is not needlessly short. A narration shorter than 6 seconds may remain one scene. When duration and scene-count guidance are supplied, return at least the minimum count and aim for the target count. Never return an empty object, empty narration, placeholder, or trailing item merely to reach a count. The sum of scene durations must match the supplied narration duration. Adapt visual vocabulary to the episode instead of assuming any particular topic.`;
  const system = longScenes ? longSystem : mixedMode ? mixedSystem : unrestrictedShortSystem;
  const transcriptionSegments = Array.isArray(config.transcription?.segments) ? config.transcription.segments.map((segment) => ({ start:segment.start, end:segment.end, text:segment.text })) : [];
  const narrationDuration = Number(config.audioDuration) || Number(config.transcription?.duration) || 0;
  const minimumShotCount = narrationDuration ? Math.max(1, Math.ceil(narrationDuration / (longScenes ? 12 : 20))) : null;
  const targetShotCount = narrationDuration ? Math.max(minimumShotCount, longScenes ? Math.round(narrationDuration / targetClipDuration) : Math.ceil(narrationDuration / shortClipDuration)) : null;
  const maximumShotCount = narrationDuration && longScenes ? Math.max(targetShotCount, Math.floor(narrationDuration / 6)) : null;
  const targetAnimatedShotCount = mixedMode && targetShotCount ? Math.max(1, Math.ceil(targetShotCount / 4)) : null;
  const screenRatio = normalizeScreenRatio(config.screenRatio);
  const raw = await completeText(config, [{role:"system",content:system},{role:"user",content:JSON.stringify({script:config.script, contentFormat:config.contentFormat || "Documentary", visualStyle:config.visualStyle || "Photorealistic", creativeDirection:config.creativeDirection || "", productionMode, targetClipDurationSeconds:longScenes ? targetClipDuration : null, targetShotDurationSeconds:longScenes ? null : shortClipDuration, targetAnimatedShotCount, screenRatio, narrationDurationSeconds:narrationDuration || null, minimumShotCount, targetShotCount, maximumShotCount, localTranscriptionSegments:transcriptionSegments, characters:(Array.isArray(config.characters) ? config.characters : []).map((character) => ({ name:character.name, appearance:character.appearance }))})}], { temperature:.25, maxTokens:8000, fetchImpl:options.fetchImpl });
  const parsed = await parseOrRepairProviderJson(raw, config, options, "an object with a shots array");
  return normalizePlannedShots(parsed.shots, Number(config.audioDuration) || 0, { genre:genre.id, contentFormat:config.contentFormat, visualStyle:config.visualStyle, creativeDirection:config.creativeDirection, productionMode, targetClipDuration, shortClipDuration, screenRatio, transcription:config.transcription });
}

async function regenerateOpeningHook(data) {
  const config = resolveTextProvider(data);
  if (!config.apiKey || !config.model) throw new Error("No planning API key or model is configured");
  const narration = String(data.narration || "").trim();
  if (!narration) throw new Error("Opening narration is required");
  const contentFormat = String(data.contentFormat || "Documentary");
  const visualStyle = String(data.visualStyle || "Photorealistic");
  const creativeDirection = String(data.creativeDirection || "").trim();
  const screenRatio = String(data.screenRatio || "9:16");
  const system = `You are a visual designer for short-form social video openings. Write a single image generation prompt for the opening shot that stops viewers from scrolling. Return one compact RFC 8259 JSON object only, without Markdown, with a prompt field (at most 55 words). The image must create immediate visual impact: dramatic cinematic lighting (chiaroscuro, golden hour, atmospheric haze, volumetric light), striking composition (strong focal point, depth, scale contrast, leading lines), and visual tension or mystery. Never describe a map, chart, timeline, diagram, split-screen comparison, or flat informational establishing shot. Prefer a dramatic close-up, an epic wide shot with scale contrast, or a moment of human emotion. The image should feel like a movie poster, not a textbook illustration. For historical subjects, include period-accurate era, location, architecture, clothing, and props. Always exclude text, watermarks, and logos. The screen ratio is ${screenRatio}.`;
  const raw = await completeText(config, [
    { role:"system", content:system },
    { role:"user", content:JSON.stringify({ narration, contentFormat, visualStyle, creativeDirection }) },
  ], { temperature:.3, maxTokens:2000 });
  const parsed = await parseOrRepairProviderJson(raw, config, {}, "an object with a prompt field");
  const prompt = String(parsed.prompt || "").trim();
  if (!prompt) throw new Error("The provider returned an empty prompt");
  return { prompt };
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
  const target = data.target === "speech" ? "speech" : data.target === "text" ? "text" : data.target === "video" ? "video" : "image";
  const config = target === "speech" ? resolveSpeechProvider(data) : target === "text" ? resolveTextProvider(data) : target === "video" ? resolveVideoProvider(data) : resolveImageProvider(data);
  if (!config.endpoint) throw new Error("Provider endpoint is required");
  if (target === "text" && !config.apiKey) throw new Error("No translation API key is configured");
  if (target === "video" && !config.apiKey) throw new Error("No video API key is configured");
  if (target === "image" && config.kind !== "sdwebui" && !config.apiKey) throw new Error("No image API key is configured");
  const fetchImpl = options.fetchImpl || fetch;
  if (target === "video" && config.kind === "pixstag") {
    // PixStag mirrors the MiniMax V2 API: probing the task query endpoint
    // with a dummy task ID returns 401 "login fail" for a rejected key and
    // a not-found error for a valid one.
    const probe = await fetchImpl(pixstagQueryVideoEndpoint(config.endpoint, "connection-probe"), { headers:{ Authorization:`Bearer ${config.apiKey}` } });
    if (probe.status === 401 || probe.status === 403) {
      const body = await probe.json().catch(() => ({}));
      throw new Error(body?.message || "PixStag rejected the API key");
    }
    return { ok:true, target, model:config.model, endpoint:config.endpoint };
  }
  if ((target === "image" || target === "video") && config.kind === "dashscope") {
    // DashScope's native API has no /models route. Probe the task query
    // endpoint with a dummy task ID: a rejected key returns 401
    // InvalidApiKey, while a valid key returns 404 "task not found".
    const probe = await fetchImpl(`${dashscopeTasksEndpoint(config.endpoint)}/connection-probe`, { headers:{ Authorization:`Bearer ${config.apiKey}` } });
    const body = await probe.json().catch(() => ({}));
    if (probe.status === 401 || probe.status === 403 || body?.code === "InvalidApiKey") throw new Error(body?.message || "DashScope rejected the API key");
    return { ok:true, target, model:config.model, endpoint:config.endpoint };
  }
  const planText = target === "text" && config.kind === "volcengine" && isVolcenginePlanEndpoint(config.endpoint);
  const endpoint = target === "speech" ? `${speechApiBase(config.endpoint)}/v1/models` : planText ? textCompletionsEndpoint(config.endpoint) : target === "video" ? `${videoTasksEndpoint(config.endpoint)}?page_num=1&page_size=1` : modelsEndpoint(config.endpoint, config.kind);
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
    const startedAt = Date.now();
    let requestLabel = `${req.method || "GET"} ${req.url || "/"}`;
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, cors()); res.end(); return; }
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      requestLabel = `${req.method || "GET"} ${url.pathname}`;
      await episodeStore.initialize();
      if (req.method === "GET" && url.pathname === "/health") { json(res, 200, { ok:true, ffmpeg:"available", storage:{ kind:"sqlite+files", root:workRoot } }); return; }
      if (req.method === "GET" && url.pathname === "/audio/presets") { json(res, 200, { presets:voicePresetSummaries(), processing:"local" }); return; }
      if (req.method === "GET" && url.pathname === "/config/status") { json(res, 200, { ...getProviderStatus(), storage:{ configured:true, kind:"sqlite+files", root:workRoot } }); return; }
      if (req.method === "GET" && url.pathname === "/episodes") { json(res, 200, { episodes:episodeStore.listEpisodes() }); return; }
      if (req.method === "GET" && url.pathname === "/episodes/active") { json(res, 200, { episode:episodeStore.getActiveEpisode() }); return; }
      if (req.method === "POST" && url.pathname === "/episodes/import") {
        const payload = await body(req);
        const imported = await episodeStore.importEpisodes(payload.episodes, payload.activeEpisodeId);
        json(res, 200, { imported, episodes:episodeStore.listEpisodes() }); return;
      }
      const episodeFileMatch = /^\/episodes\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && episodeFileMatch) {
        const relativePath = episodeFileMatch[2].split("/").map(decodeURIComponent).join(path.sep);
        const { filename, contentType } = await episodeStore.fileForRequest(decodeURIComponent(episodeFileMatch[1]), relativePath);
        const disposition = contentType === "video/mp4" ? `attachment; filename="${path.basename(filename)}"` : "inline";
        res.writeHead(200, cors({ "Content-Type":contentType, "Content-Disposition":disposition, "Cache-Control":"public, max-age=31536000, immutable" }));
        createReadStream(filename).pipe(res); return;
      }
      const episodeActivateMatch = /^\/episodes\/([^/]+)\/activate$/.exec(url.pathname);
      if (req.method === "POST" && episodeActivateMatch) {
        episodeStore.activateEpisode(decodeURIComponent(episodeActivateMatch[1]));
        json(res, 200, { ok:true }); return;
      }
      const episodeReviewMatch = /^\/episodes\/([^/]+)\/review$/.exec(url.pathname);
      if (req.method === "POST" && episodeReviewMatch) {
        const payload = await body(req, 64 * 1024);
        const result = await episodeStore.setReviewStatus(decodeURIComponent(episodeReviewMatch[1]), String(payload.status || "pending"));
        json(res, 200, result); return;
      }
      const episodeCharactersMatch = /^\/episodes\/([^/]+)\/characters$/.exec(url.pathname);
      if (req.method === "GET" && episodeCharactersMatch) {
        json(res, 200, { characters:await episodeStore.listCharacterAssets(decodeURIComponent(episodeCharactersMatch[1])) }); return;
      }
      const episodeMatch = /^\/episodes\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && episodeMatch) {
        const episode = episodeStore.getEpisode(decodeURIComponent(episodeMatch[1]));
        if (!episode) { json(res, 404, { error:"Episode was not found" }); return; }
        json(res, 200, { episode }); return;
      }
      if (req.method === "PUT" && episodeMatch) {
        const payload = await body(req);
        const id = decodeURIComponent(episodeMatch[1]);
        if (payload.project?.id && payload.project.id !== id) throw new Error("Episode ID does not match the request path");
        const saved = await episodeStore.saveEpisode({ ...(payload.project || {}), id });
        json(res, 200, saved); return;
      }
      if (req.method === "DELETE" && episodeMatch) {
        const deleted = await episodeStore.deleteEpisode(decodeURIComponent(episodeMatch[1]));
        json(res, deleted ? 200 : 404, deleted ? { ok:true } : { error:"Episode was not found" }); return;
      }
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
      const renderJobMatch = /^\/render\/jobs\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && renderJobMatch) {
        const job = getRenderJob(decodeURIComponent(renderJobMatch[1]));
        if (!job) { json(res, 404, { error:"Render job was not found" }); return; }
        json(res, 200, { job }); return;
      }
      if (req.method === "POST" && url.pathname === "/render") {
        const payload = await body(req);
        const jobId = typeof payload.renderJobId === "string" ? payload.renderJobId.slice(0, 80) : "";
        if (jobId) updateRenderJob(jobId, { status:"running", stage:"Queued", percent:0 });
        try {
          const onProgress = jobId ? (event) => updateRenderJob(jobId, event) : undefined;
          let result;
          if (payload.episodeId) {
            const id = randomUUID();
            result = await episodeStore.withMediaTarget(payload.episodeId, payload.title, "exports", id, async (target) => {
              return await renderEpisode(payload, { id, onProgress, output:path.join(target.directory, `${target.baseName}.mp4`), publicUrl:`${target.urlPrefix}/${encodeURIComponent(`${target.baseName}.mp4`)}` });
            });
          } else {
            result = await renderEpisode(payload, { onProgress });
          }
          if (jobId) updateRenderJob(jobId, { status:"done", stage:"Complete", percent:100 });
          json(res, 200, result); return;
        } catch (error) {
          if (jobId) updateRenderJob(jobId, { status:"error", stage:"Failed", error:error instanceof Error ? error.message : "Render failed" });
          throw error;
        }
      }
      if (req.method === "POST" && url.pathname === "/image/generate") {
        const payload = await body(req, 16*1024*1024);
        const generated = await generateImage(payload);
        const assetDirectory = payload.assetKind === "covers" ? "covers" : payload.assetKind === "characters" ? "characters" : "images";
        const cached = payload.episodeId
          ? await episodeStore.withMediaTarget(payload.episodeId, payload.episodeTitle, assetDirectory, payload.assetName || randomUUID(), async (target) => await persistGeneratedImage(generated, { screenRatio:payload.screenRatio, ...target }))
          : await persistGeneratedImage(generated, { screenRatio:payload.screenRatio });
        json(res, 200, { image:cached.url, path:cached.path }); return;
      }
      if (req.method === "POST" && url.pathname === "/text/characters") {
        const payload = await body(req);
        json(res, 200, { characters:await extractCharacters(payload) }); return;
      }
      if (req.method === "POST" && url.pathname === "/covers/bake") { json(res, 200, await bakeEpisodeCover(await body(req, 16*1024*1024))); return; }
      if (req.method === "POST" && url.pathname === "/image/generate-group") {
        const payload = await body(req, 2*1024*1024);
        const generated = await generateImageGroup(payload);
        const images = await Promise.all(generated.map(async (image, index) => {
          const shot = payload.shots?.[index] || {};
          const cached = payload.episodeId
            ? await episodeStore.withMediaTarget(payload.episodeId, payload.episodeTitle, "images", shot.id || randomUUID(), async (target) => await persistGeneratedImage(image, { screenRatio:payload.screenRatio, ...target }))
            : await persistGeneratedImage(image, { screenRatio:payload.screenRatio });
          return { id:shot.id, image:cached.url, path:cached.path };
        }));
        json(res, 200, { images }); return;
      }
      if (req.method === "POST" && url.pathname === "/image/generate-group/stream") {
        const payload = await body(req, 2*1024*1024);
        res.writeHead(200, cors({ "Content-Type":"text/event-stream", "Cache-Control":"no-cache", Connection:"keep-alive" }));
        const send = (event, value) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
        try {
          await streamImageGroup(payload, async (image, shot, index) => {
            const cached = payload.episodeId
              ? await episodeStore.withMediaTarget(payload.episodeId, payload.episodeTitle, "images", shot?.id || randomUUID(), async (target) => await persistGeneratedImage(image, { screenRatio:payload.screenRatio, ...target }))
              : await persistGeneratedImage(image, { screenRatio:payload.screenRatio });
            send("image", { id:shot?.id, index, image:cached.url, path:cached.path });
          });
          send("complete", {});
        } catch (error) { send("error", { error:error instanceof Error ? error.message : "Group generation failed" }); }
        res.end(); return;
      }
      if (req.method === "POST" && url.pathname === "/image/upload") {
        const payload = await body(req, 16*1024*1024);
        if (!payload.image) throw new Error("No image data provided");
        const assetName = payload.assetName || randomUUID();
        const cached = payload.episodeId
          ? await episodeStore.withMediaTarget(payload.episodeId, payload.episodeTitle, "images", assetName, async (target) => await persistGeneratedImage(payload.image, { screenRatio:payload.screenRatio, ...target }))
          : await persistGeneratedImage(payload.image, { screenRatio:payload.screenRatio });
        json(res, 200, { image:cached.url, path:cached.path }); return;
      }
      if (req.method === "POST" && url.pathname === "/video/generate") {
        const payload = await body(req, 24*1024*1024);
        await logRenderEvent("video-generate-start", { kind:payload.videoKind || payload.kind || null, generationMode:payload.generationMode || null, hasImage:Boolean(payload.image), imageKind:String(payload.image || "").slice(0, 40), episodeId:payload.episodeId || null, duration:payload.duration || null });
        const generated = await generateVideo(payload);
        await logRenderEvent("video-generate-done", { taskId:generated.taskId || null, status:generated.status || null, videoUrlLen:String(generated.videoUrl || "").length, videoUrlPrefix:String(generated.videoUrl || "").slice(0, 80) });
        const cached = payload.episodeId
          ? await episodeStore.withMediaTarget(payload.episodeId, payload.episodeTitle, "videos", payload.assetName || randomUUID(), async (target) => await persistGeneratedVideo(generated.videoUrl, target))
          : await persistGeneratedVideo(generated.videoUrl);
        await logRenderEvent("video-generate-persisted", { localUrl:cached?.url || null, localPath:cached?.path || null });
        json(res, 200, { video:cached.url, path:cached.path, taskId:generated.taskId, duration:generated.duration }); return;
      }
      if (req.method === "POST" && url.pathname === "/text/translate") { json(res, 200, { lines:await translate(await body(req, 2*1024*1024)) }); return; }
      if (req.method === "POST" && url.pathname === "/text/plan") { json(res, 200, { shots:await planEpisode(await body(req, 4*1024*1024)) }); return; }
      if (req.method === "POST" && url.pathname === "/text/generate-documentary-script") { json(res, 200, await generateDocumentaryScript(await body(req, 4*1024*1024))); return; }
      if (req.method === "POST" && url.pathname === "/text/generate-story-script") { json(res, 200, await generateStoryScript(await body(req, 4*1024*1024))); return; }
      if (req.method === "POST" && url.pathname === "/text/opening-hook") { json(res, 200, await regenerateOpeningHook(await body(req, 2*1024*1024))); return; }
      if (req.method === "POST" && url.pathname === "/audio/synthesize") { json(res, 200, await synthesizeSpeech(await body(req, 2*1024*1024))); return; }
      if (req.method === "POST" && url.pathname === "/audio/synthesize-minimax") {
        const payload = await body(req, 2 * 1024 * 1024);
        const result = await synthesizeSpeechMiniMax({
          script: payload.script || payload.input,
          voiceId: payload.voice || payload.voiceId,
          model: payload.model || "speech-2.8-hd",
          speed: payload.speed ?? 1,
          subtitleType: payload.subtitleType || "word",
          languageBoost: payload.languageBoost || undefined,
        });
        json(res, 200, result); return;
      }
      if (req.method === "POST" && url.pathname === "/audio/synthesize-doubao") {
        const payload = await body(req, 2 * 1024 * 1024);
        const result = await synthesizeSpeechDoubao({
          script: payload.script || payload.input,
          speaker: payload.speaker || payload.voice,
          model: payload.model || "seed-tts-2.0",
          speechRate: payload.speechRate ?? payload.speed ?? 0,
          format: payload.format || "mp3",
          sampleRate: payload.sampleRate || 24000,
          explicitLanguage: payload.explicitLanguage || "zh-cn",
        });
        json(res, 200, result); return;
      }
      if (req.method === "GET" && url.pathname === "/audio/voices") {
        const provider = String(new URLSearchParams(url.search).get("provider") || "minimax").trim().toLowerCase();
        json(res, 200, { voices: provider === "minimax" ? await listMiniMaxVoices() : [] }); return;
      }
      if (req.method === "POST" && url.pathname === "/audio/transcribe") { json(res, 200, await transcribeAudio(await body(req))); return; }
      if (req.method === "POST" && url.pathname === "/audio/process") { json(res, 200, await processNarration(await body(req))); return; }
      if (req.method === "POST" && url.pathname === "/providers/test") { json(res, 200, await testProviderConnection(await body(req, 2*1024*1024))); return; }

      /* Digital Human CRUD */
      if (req.method === "GET" && url.pathname === "/digital-humans") {
        json(res, 200, { humans: await digitalHumanStore.list() }); return;
      }
      if (req.method === "POST" && url.pathname === "/digital-humans") {
        const payload = await body(req, 16 * 1024 * 1024);
        if (!payload.name) throw new Error("Digital human name is required");
        const human = await digitalHumanStore.create(payload);
        json(res, 201, human); return;
      }
      const dhMatch = /^\/digital-humans\/([^/]+)$/.exec(url.pathname);
      if (req.method === "PUT" && dhMatch) {
        const payload = await body(req, 16 * 1024 * 1024);
        const human = await digitalHumanStore.update(decodeURIComponent(dhMatch[1]), payload);
        json(res, 200, human); return;
      }
      if (req.method === "DELETE" && dhMatch) {
        await digitalHumanStore.delete(decodeURIComponent(dhMatch[1]));
        json(res, 200, { ok: true }); return;
      }

      /* Digital Human TTS */
      if (req.method === "GET" && url.pathname === "/digital-human/voices") {
        const provider = String(new URLSearchParams(url.search).get("provider") || "minimax").trim().toLowerCase();
        json(res, 200, { voices: provider === "minimax" ? await listMiniMaxVoices() : [] }); return;
      }
      if (req.method === "POST" && url.pathname === "/digital-human/tts") {
        const payload = await body(req, 2 * 1024 * 1024);
        const provider = String(payload.provider || "mlx").trim().toLowerCase();
        let result;
        if (provider === "minimax") {
          result = await synthesizeSpeechMiniMax({
            script: payload.script,
            voiceId: payload.voice,
            model: payload.model || "speech-2.8-hd",
            speed: payload.speed ?? 1,
          });
        } else {
          result = await synthesizeSpeech({
            input: payload.script,
            voice: payload.voice,
            speed: payload.speed ?? 1,
            language: payload.language ?? "zh",
          });
        }
        // Persist audio to project if projectId is provided
        if (payload.projectId) {
          await dhProjectStore.update(payload.projectId, {
            audioData: result.audioData,
            audioProvider: provider,
            audioVoice: payload.voice,
            audioModel: payload.model || "",
            audioSpeed: payload.speed ?? 1,
            audioLanguage: payload.language ?? "zh",
            voiceLabel: payload.voiceLabel || payload.voice,
          });
        }
        json(res, 200, result); return;
      }

      /* HeyGen video generation */
      if (req.method === "POST" && url.pathname === "/digital-human/video/generate") {
        const payload = await body(req, 32 * 1024 * 1024);
        const apiKey = process.env.HEYGEN_API_KEY;
        if (!apiKey) throw new Error("HEYGEN_API_KEY is not configured");
        if (!payload.photo) throw new Error("Photo data is required");
        if (!payload.audio) throw new Error("Audio data is required");

        const videoName = payload.videoName || "Digital Human Video";

        const apiHeaders = { "x-api-key": apiKey };

        // Helper: upload a buffer as a HeyGen asset via https.request (manual multipart)
        function uploadHeyGenAsset(buf, filename, contentType) {
          return new Promise((resolve, reject) => {
            const boundary = `----FormBoundary${Date.now()}`;
            const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
            const footer = `\r\n--${boundary}--\r\n`;
            const body = Buffer.concat([Buffer.from(header), buf, Buffer.from(footer)]);

            const req = https.request({
              hostname: "api.heygen.com",
              path: "/v3/assets",
              method: "POST",
              headers: {
                "x-api-key": apiKey,
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": String(body.length),
              },
            }, (heyRes) => {
              let data = "";
              heyRes.on("data", (chunk) => data += chunk);
              heyRes.on("end", () => {
                try { resolve(JSON.parse(data)); } catch { resolve(data); }
              });
            });
            req.on("error", reject);
            req.on("socket", (socket) => socket.on("error", reject));
            req.write(body);
            req.end();
          });
        }

        // Step 1: upload image as asset
        const imgMatch = payload.photo.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!imgMatch) throw new Error("Photo must be a base64 data URL");
        const imgExt = imgMatch[1] === "jpeg" ? "jpg" : imgMatch[1];
        const imgBuffer = Buffer.from(imgMatch[2], "base64");

        const imgAssetData = await uploadHeyGenAsset(imgBuffer, `avatar.${imgExt}`, `image/${imgExt}`);
        if (!imgAssetData.data?.asset_id) {
          throw new Error(imgAssetData.error?.message || "HeyGen image upload failed");
        }
        const imageAssetId = imgAssetData.data.asset_id;

        // Step 2: upload audio as asset
        const audioMatch = payload.audio.match(/^data:audio\/(\w+);base64,(.+)$/);
        if (!audioMatch) throw new Error("Audio must be a base64 data URL");
        const audioMime = audioMatch[1] === "mpeg" ? "mp3" : audioMatch[1];
        const audioBuffer = Buffer.from(audioMatch[2], "base64");

        const audioAssetData = await uploadHeyGenAsset(audioBuffer, `tts.${audioMime}`, `audio/${audioMime}`);
        if (!audioAssetData.data?.asset_id) {
          throw new Error(audioAssetData.error?.message || "HeyGen audio upload failed");
        }
        const audioAssetId = audioAssetData.data.asset_id;

        // Step 3: create video
        const videoBody = {
          type: "image",
          image: { type: "asset_id", asset_id: imageAssetId },
          audio_asset_id: audioAssetId,
          title: videoName,
          resolution: "720p",
          aspect_ratio: "9:16",
        };

        const videoRes = await fetch("https://api.heygen.com/v3/videos", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiHeaders },
          body: JSON.stringify(videoBody),
        });
        const videoData = await videoRes.json();
        console.error("[HeyGen] create video → HTTP %s body: %s", videoRes.status, JSON.stringify(videoData).slice(0, 500));
        if (!videoRes.ok || !videoData.data?.video_id) {
          throw new Error(videoData.error?.message || `HeyGen video creation failed (HTTP ${videoRes.status})`);
        }
        // Save video record to project if projectId provided
        if (payload.projectId) {
          await dhProjectStore.addVideo(payload.projectId, {
            type: payload.duration === 15 ? "preview" : "full",
            videoUrl: "",
            heygenTaskId: videoData.data.video_id,
            status: "processing",
          });
        }
        json(res, 200, { taskId: videoData.data.video_id }); return;
      }

      const dhVideoStatusMatch = /^\/digital-human\/video\/status\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && dhVideoStatusMatch) {
        const apiKey = process.env.HEYGEN_API_KEY;
        if (!apiKey) throw new Error("HEYGEN_API_KEY is not configured");
        const taskId = decodeURIComponent(dhVideoStatusMatch[1]);
        const heyGenRes = await fetch(`https://api.heygen.com/v3/videos/${taskId}`, {
          headers: { "x-api-key": apiKey },
        });
        const heyGenData = await heyGenRes.json();
        if (!heyGenRes.ok) {
          throw new Error(heyGenData.error?.message || `HeyGen status check failed (HTTP ${heyGenRes.status})`);
        }
        const status = heyGenData.data?.status || "unknown";
        const videoUrl = heyGenData.data?.video_url || "";
        // Update video record if it exists
        const video = await dhProjectStore.findVideoByTaskId(taskId);
        if (video) {
          if (status === "completed" && videoUrl) {
            await dhProjectStore.updateVideo(video.id, { status, videoUrl });
          } else if (status === "failed") {
            await dhProjectStore.updateVideo(video.id, { status, videoUrl: heyGenData.data?.error || "" });
          }
        }
        json(res, 200, {
          status,
          videoUrl,
          error: heyGenData.data?.error || "",
        }); return;
      }

      /* Digital Human Project CRUD */
      if (req.method === "GET" && url.pathname === "/digital-human/projects") {
        const projects = await dhProjectStore.list();
        json(res, 200, { projects }); return;
      }
      if (req.method === "POST" && url.pathname === "/digital-human/projects") {
        const payload = await body(req, 2 * 1024 * 1024);
        const project = await dhProjectStore.create(payload);
        json(res, 201, project); return;
      }

      /* Audio version list/delete */
      const dhAudioVersionDeleteMatch = /^\/digital-human\/projects\/([^/]+)\/audio-versions\/([^/]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && dhAudioVersionDeleteMatch) {
        await dhProjectStore.deleteAudioVersion(
          decodeURIComponent(dhAudioVersionDeleteMatch[1]),
          decodeURIComponent(dhAudioVersionDeleteMatch[2])
        );
        json(res, 200, { ok: true }); return;
      }
      const dhProjectAudioVersionsMatch = /^\/digital-human\/projects\/([^/]+)\/audio-versions$/.exec(url.pathname);
      if (req.method === "GET" && dhProjectAudioVersionsMatch) {
        const versions = await dhProjectStore.listAudioVersions(decodeURIComponent(dhProjectAudioVersionsMatch[1]));
        json(res, 200, { versions }); return;
      }

      const dhProjectMatch = /^\/digital-human\/projects\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && dhProjectMatch) {
        const project = await dhProjectStore.get(decodeURIComponent(dhProjectMatch[1]));
        if (!project) { json(res, 404, { error: "Project not found" }); return; }
        const versions = await dhProjectStore.listAudioVersions(project.id);
        const covers = await dhProjectStore.listCovers(project.id);
        json(res, 200, { ...project, audioVersions: versions, covers }); return;
      }
      if (req.method === "PUT" && dhProjectMatch) {
        const payload = await body(req, 32 * 1024 * 1024);
        const project = await dhProjectStore.update(decodeURIComponent(dhProjectMatch[1]), payload);
        json(res, 200, project); return;
      }
      if (req.method === "DELETE" && dhProjectMatch) {
        await dhProjectStore.delete(decodeURIComponent(dhProjectMatch[1]));
        json(res, 200, { ok: true }); return;
      }

      /* Digital Human Project Videos */
      const dhProjectVideosMatch = /^\/digital-human\/projects\/([^/]+)\/videos$/.exec(url.pathname);
      if (req.method === "GET" && dhProjectVideosMatch) {
        const videos = await dhProjectStore.listVideos(decodeURIComponent(dhProjectVideosMatch[1]));
        const synced = await Promise.all(videos.map((v) => syncHeyGenVideoRecord(v)));
        json(res, 200, { videos: synced }); return;
      }
      const dhVideoDeleteMatch = /^\/digital-human\/projects\/([^/]+)\/videos\/([^/]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && dhVideoDeleteMatch) {
        await dhProjectStore.deleteVideo(decodeURIComponent(dhVideoDeleteMatch[2]));
        json(res, 200, { ok: true }); return;
      }
      const dhVideoUpdateMatch = /^\/digital-human\/projects\/([^/]+)\/videos\/([^/]+)$/.exec(url.pathname);
      if (req.method === "PUT" && dhVideoUpdateMatch) {
        const payload = await body(req, 2 * 1024 * 1024);
        const video = await dhProjectStore.updateVideo(decodeURIComponent(dhVideoUpdateMatch[2]), payload);
        json(res, 200, video); return;
      }

      /* Digital Human Project Covers */
      const dhProjectCoversMatch = /^\/digital-human\/projects\/([^/]+)\/covers$/.exec(url.pathname);
      if (req.method === "GET" && dhProjectCoversMatch) {
        const covers = await dhProjectStore.listCovers(decodeURIComponent(dhProjectCoversMatch[1]));
        json(res, 200, { covers }); return;
      }
      if (req.method === "POST" && dhProjectCoversMatch) {
        const projectId = decodeURIComponent(dhProjectCoversMatch[1]);
        const project = await dhProjectStore.get(projectId);
        if (!project) { json(res, 404, { error: "Project not found" }); return; }
        const payload = await body(req, 2 * 1024 * 1024);
        const prompt = String(payload.prompt || "").trim();
        if (!prompt) throw new Error("A cover prompt is required");
        const generated = await generateImage({ prompt, screenRatio: payload.screenRatio });
        const coverId = randomUUID();
        const cached = await persistGeneratedImage(generated, {
          directory: dhProjectStore.coversDir(projectId),
          urlPrefix: `/dh-projects/${encodeURIComponent(projectId)}/covers`,
          baseName: coverId,
          screenRatio: payload.screenRatio,
        });
        const cover = await dhProjectStore.addCover(projectId, { id: coverId, imagePath: cached.path, prompt });
        json(res, 201, cover); return;
      }
      const dhCoverDeleteMatch = /^\/digital-human\/projects\/([^/]+)\/covers\/([^/]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && dhCoverDeleteMatch) {
        await dhProjectStore.deleteCover(
          decodeURIComponent(dhCoverDeleteMatch[1]),
          decodeURIComponent(dhCoverDeleteMatch[2])
        );
        json(res, 200, { ok: true }); return;
      }

      /* Serve project cover images */
      const dhCoverFileMatch = /^\/dh-projects\/([^/]+)\/covers\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && dhCoverFileMatch) {
        const projectId = decodeURIComponent(dhCoverFileMatch[1]);
        const filename = path.basename(decodeURIComponent(dhCoverFileMatch[2]));
        const coverFile = path.join(dhProjectStore.coversDir(projectId), filename);
        await readFile(coverFile);
        res.writeHead(200, cors({ "Content-Type": assetContentType(coverFile), "Content-Disposition": "inline" }));
        createReadStream(coverFile).pipe(res); return;
      }

      /* Serve a specific audio version file */
      const dhAudioVersionMatch = /^\/dh-projects\/([^/]+)\/audio\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && dhAudioVersionMatch) {
        const projectId = decodeURIComponent(dhAudioVersionMatch[1]);
        const versionId = decodeURIComponent(dhAudioVersionMatch[2]);
        const version = await dhProjectStore.getAudioVersion(projectId, versionId);
        if (!version || !version.audioPath) { json(res, 404, { error: "Audio version not found" }); return; }
        const audioFile = version.audioPath;
        await readFile(audioFile);
        const ext = path.extname(audioFile).toLowerCase();
        const contentType = ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : "audio/mp4";
        res.writeHead(200, cors({ "Content-Type": contentType, "Content-Disposition": "inline" }));
        createReadStream(audioFile).pipe(res); return;
      }

      /* Serve project audio files */
      const dhAudioMatch = /^\/dh-projects\/([^/]+)\/audio$/.exec(url.pathname);
      if (req.method === "GET" && dhAudioMatch) {
        const project = await dhProjectStore.get(decodeURIComponent(dhAudioMatch[1]));
        if (!project?.audioPath) { json(res, 404, { error: "Audio not found" }); return; }
        const audioFile = project.audioPath;
        await readFile(audioFile);
        const ext = path.extname(audioFile).toLowerCase();
        const contentType = ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : "audio/mp4";
        res.writeHead(200, cors({ "Content-Type": contentType, "Content-Disposition": "inline" }));
        createReadStream(audioFile).pipe(res); return;
      }

      json(res, 404, { error:"Not found" });
    } catch (error) {
      await logRenderError("request-failed", error, { request:requestLabel, durationMs:Date.now() - startedAt });
      json(res, 500, { error:error instanceof Error ? error.message : "Unexpected error", log:renderLogFile });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await Promise.all([mkdir(exportRoot, { recursive:true }), mkdir(assetRoot, { recursive:true }), episodeStore.initialize()]); const server = createRenderServer(); server.listen(port, "127.0.0.1", () => console.log(`Shortform render service: http://127.0.0.1:${port}`));
}
