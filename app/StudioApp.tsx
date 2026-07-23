"use client";
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect, react-hooks/exhaustive-deps, @next/next/no-img-element */

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { canStartConcurrentJob, mapWithConcurrency } from "./lib/concurrency";
import { activateProjectCache, createEpisodeId, deleteProjectCache, listProjectCaches, normalizeCachedProject, readProjectCache, writeProjectCache } from "./lib/project-cache";
import { DEFAULT_SUBTITLE_STYLE, SUBTITLE_FONTS, normalizeSubtitleStyle, subtitleCssBackground } from "./lib/subtitle-style";
import { buildSrt, subtitleFileName } from "./lib/subtitles";
import { SHOT_MOTIONS, formatTime, scriptSectionForDuration } from "./lib/timeline";
import { SCREEN_RATIOS, VIDEO_RESOLUTIONS, normalizeScreenRatio, promptForScreenRatio, videoResolution, visualCoverage } from "./lib/video";

type Shot = {
  id: string; index: number; start: number; end: number; duration: number;
  type: string; narration: string; chinese: string; prompt: string; videoPrompt: string; status: string;
  locked: boolean; image: string; variants: string[]; provider: string; seed: string; motion: string;
  imageStatus: string; imageError: string;
  video: string; videoStatus: string; videoError: string; videoProvider: string; videoRecommended: boolean;
};

type ProviderSettings = {
  kind: "openai" | "volcengine" | "sdwebui"; endpoint: string; model: string; apiKey: string;
  videoKind: "volcengine"; videoEndpoint: string; videoModel: string; videoApiKey: string; videoConcurrency: number;
  textKind: "openai" | "volcengine"; textEndpoint: string; textModel: string; textApiKey: string;
  transcriptionEndpoint: string; transcriptionLanguage: string; imageConcurrency: number;
};

type Transcription = {
  text:string; language:string; languageProbability:number | null; duration:number; durationAfterVad:number;
  segments:Array<{ id:number; start:number; end:number; text:string; words:Array<{ start:number; end:number; word:string; probability:number | null }> }>;
};

type SubtitleStyle = ReturnType<typeof normalizeSubtitleStyle>;

type EpisodeSummary = {
  id:string; title:string; savedAt:number; shotCount:number; duration:number; hasNarration:boolean; stage:string;
};

type ProviderStatus = {
  image: { configured: boolean; kind: "openai" | "volcengine" | "sdwebui"; endpoint: string; model: string; source: string };
  video: { configured: boolean; kind: "volcengine"; endpoint: string; model: string; source: string };
  text: { configured: boolean; kind:"openai" | "volcengine"; endpoint: string; model: string; source: string };
  transcription: { configured:boolean; endpoint:string; language:string; source:string };
};

const SERVICE = "http://127.0.0.1:4317";
const STORAGE_KEY = "shortform-studio-project-v1";
const BGM_TRACKS = [
  { id:"none", label:"No background music", artist:"Narration only", path:"" },
  { id:"monume-documentary", label:"Documentary", artist:"Monume", path:"/bgm/monume-documentary-documentary-music-547923.mp3" },
  { id:"paulyudin-history", label:"History Storytelling", artist:"Paul Yudin", path:"/bgm/paulyudin-documentary-history-storytelling-155326.mp3" },
  { id:"solarflex-documentary", label:"Documentary", artist:"Solarflex", path:"/bgm/solarflex-documentary-documentary-music-558248.mp3" },
];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file); const audio = new Audio(objectUrl);
    const finish = (duration = 0) => { URL.revokeObjectURL(objectUrl); resolve(Number.isFinite(duration) ? duration : 0); };
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(0);
  });
}

function downloadSubtitleFile(title:string, shots:Shot[], language:string) {
  const content = buildSrt(shots, language);
  if (!content) return;
  const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type:"application/x-subrip;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = subtitleFileName(title, language); document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function StudioApp() {
  const [episodeId, setEpisodeId] = useState(() => createEpisodeId());
  const [stage, setStage] = useState("episode");
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [contentFormat, setContentFormat] = useState("Documentary");
  const [visualStyle, setVisualStyle] = useState("Photorealistic");
  const [creativeDirection, setCreativeDirection] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [audioName, setAudioName] = useState("");
  const [audioData, setAudioData] = useState("");
  const [audioDuration, setAudioDuration] = useState(0);
  const [denoiseNarration, setDenoiseNarration] = useState(true);
  const [transcription, setTranscription] = useState<Transcription | null>(null);
  const [bgm, setBgm] = useState("");
  const [bgmVolume, setBgmVolume] = useState(8);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(() => normalizeSubtitleStyle());
  const [mode, setMode] = useState("Review then batch");
  const [productionMode, setProductionMode] = useState("short-shots");
  const [longClipDuration, setLongClipDuration] = useState(10);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [episodeHistory, setEpisodeHistory] = useState<EpisodeSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("Ready");
  const [previewUrl, setPreviewUrl] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadResolution, setDownloadResolution] = useState("1080");
  const [screenRatio, setScreenRatio] = useState("9:16");
  const [provider, setProvider] = useState<ProviderSettings>({
    kind: "openai", endpoint: "https://api.openai.com/v1/images/generations", model: "gpt-image-1",
    apiKey: "", videoKind:"volcengine", videoEndpoint:"https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", videoModel:"doubao-seedance-2-0-260128", videoApiKey:"", videoConcurrency:2,
    textKind:"openai", textEndpoint: "https://api.openai.com/v1/chat/completions", textModel: "gpt-4.1-mini", textApiKey: "",
    transcriptionEndpoint:"http://localhost:8000/v1/transcriptions", transcriptionLanguage:"en", imageConcurrency:3,
  });
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({
    image: { configured:false, kind:"openai", endpoint:"", model:"", source:"default" },
    video: { configured:false, kind:"volcengine", endpoint:"", model:"", source:"default" },
    text: { configured:false, kind:"openai", endpoint:"", model:"", source:"default" },
    transcription: { configured:true, endpoint:"http://localhost:8000/v1/transcriptions", language:"en", source:"default" },
  });
  const initialized = useRef(false);
  const allowSave = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheEpoch = useRef(0);
  const episodeIdRef = useRef(episodeId);
  const activeManualVideoIds = useRef(new Set<string>());
  const [activeManualVideoCount, setActiveManualVideoCount] = useState(0);
  const activeManualImageIds = useRef(new Set<string>());
  const [activeManualImageCount, setActiveManualImageCount] = useState(0);

  function projectSnapshot(overrides:Record<string, unknown> = {}) {
    return { id:episodeId, stage, title, script, contentFormat, visualStyle, creativeDirection, productionMode, longClipDuration, shots, selectedId, audioName, audioData, audioDuration, transcription, denoiseNarration, bgm, bgmVolume, subtitleStyle, mode, previewUrl, downloadUrl, downloadResolution, screenRatio, ...overrides };
  }

  function persistProject(snapshot = projectSnapshot()) {
    const epoch = cacheEpoch.current;
    try {
      const safeShots = (snapshot.shots as Shot[] || []).map((shot) => ({ ...shot, image:"", variants:[], imageStatus:"idle", imageError:"", video:"", videoStatus:"idle", videoError:"", status:shot.status === "generated" ? "planned" : shot.status }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...snapshot, audioData:"", previewUrl:"", downloadUrl:"", shots:safeShots }));
    } catch { /* IndexedDB remains the primary local cache */ }
    return writeProjectCache(snapshot).then(() => {
      if (epoch !== cacheEpoch.current) return activateProjectCache(episodeIdRef.current);
    }).catch(() => { /* lightweight localStorage fallback is already saved */ });
  }

  function applyProjectState(parsed:any, recoveryMessage = "") {
    const id = String(parsed.id || "").trim() && parsed.id !== "legacy-active" ? String(parsed.id) : createEpisodeId();
    episodeIdRef.current = id; setEpisodeId(id);
    allowSave.current = true;
    setTitle(parsed.title || ""); setScript(parsed.script || "");
    setContentFormat(parsed.contentFormat || "Documentary"); setVisualStyle(parsed.visualStyle || "Photorealistic");
    setCreativeDirection(parsed.creativeDirection || ""); setProductionMode(parsed.productionMode === "long-scenes" ? "long-scenes" : parsed.productionMode === "mixed" ? "mixed" : "short-shots"); setLongClipDuration(Math.max(6, Math.min(12, Math.round(Number(parsed.longClipDuration) || 10)))); setShots(parsed.shots || []); setSelectedId(parsed.shots?.[0]?.id || "");
    setAudioName(parsed.audioData ? (parsed.audioName || "") : ""); setAudioData(parsed.audioData || ""); setAudioDuration(Number(parsed.audioDuration) || 0); setTranscription(parsed.transcription || null);
    const savedBgmVolume = Number(parsed.bgmVolume);
    setBgm(BGM_TRACKS.some((track) => track.path === parsed.bgm) ? parsed.bgm : ""); setBgmVolume(Number.isFinite(savedBgmVolume) ? Math.max(0, Math.min(20, savedBgmVolume)) : 8); setMode(parsed.mode || "Review then batch"); setDenoiseNarration(parsed.denoiseNarration ?? parsed.voicePresetId !== "original");
    setSubtitleStyle(normalizeSubtitleStyle(parsed.subtitleStyle));
    setPreviewUrl(parsed.previewUrl || ""); setDownloadUrl(parsed.downloadUrl || ""); setDownloadResolution(String(parsed.downloadResolution || "1080")); setScreenRatio(normalizeScreenRatio(parsed.screenRatio));
    setStage(["episode","storyboard","captions","export"].includes(parsed.stage) ? parsed.stage : (parsed.shots?.length ? "storyboard" : "episode"));
    if (recoveryMessage) setMessage(recoveryMessage);
    if (id !== parsed.id) void writeProjectCache({ ...parsed, id }).catch(() => {});
    return id;
  }

  useEffect(() => {
    if (initialized.current) return;
    let cancelled = false;
    void (async () => {
      let parsed = null;
      localStorage.removeItem("chronicle-studio-project");
      localStorage.removeItem("chronicle-studio-project-v2");
      localStorage.removeItem("chronicle-studio-project-v3");
      try { parsed = await readProjectCache(); } catch { /* use compact fallback below */ }
      if (!parsed) {
        try { parsed = normalizeCachedProject(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); } catch { /* no recoverable cache */ }
      }
      if (cancelled) return;
      initialized.current = true;
      if (parsed) {
        applyProjectState(parsed, `Recovered locally saved episode · ${parsed.shots?.length || 0} shots.`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!initialized.current || !allowSave.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persistProject(), 250);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [episodeId, stage, title, script, contentFormat, visualStyle, creativeDirection, productionMode, longClipDuration, shots, selectedId, audioName, audioData, audioDuration, transcription, denoiseNarration, bgm, bgmVolume, subtitleStyle, mode, previewUrl, downloadUrl, downloadResolution, screenRatio]);

  async function refreshProviderStatus() {
    try {
      const response = await fetch(`${SERVICE}/config/status`);
      const status = await response.json();
      if (!response.ok) throw new Error(status.error || "Could not read provider status");
      setProviderStatus(status);
      if (status.image.configured) setProvider((current) => ({ ...current, kind:status.image.kind, endpoint:status.image.endpoint, model:status.image.model }));
      if (status.video?.configured) setProvider((current) => ({ ...current, videoKind:status.video.kind, videoEndpoint:status.video.endpoint, videoModel:status.video.model }));
      if (status.text.configured) setProvider((current) => ({ ...current, textKind:status.text.kind, textEndpoint:status.text.endpoint, textModel:status.text.model }));
      if (status.transcription?.endpoint) setProvider((current) => ({ ...current, transcriptionEndpoint:status.transcription.endpoint, transcriptionLanguage:status.transcription.language || "en" }));
    } catch { /* render bridge may still be starting */ }
  }

  useEffect(() => { refreshProviderStatus(); }, []);

  const selected = shots.find((shot) => shot.id === selectedId) || shots[0];
  const totalDuration = shots.reduce((sum, shot) => sum + shot.duration, 0);
  const approved = shots.filter((shot) => shot.status === "approved" || shot.status === "generated").length;

  function touchProject() { allowSave.current = true; }

  function changeProductionMode(value:string) {
    const next = value === "long-scenes" ? "long-scenes" : value === "mixed" ? "mixed" : "short-shots";
    if (next === productionMode) return;
    if (shots.length && !window.confirm("Switching visual workflow requires a new AI plan and will replace the current storyboard. Continue?")) return;
    touchProject(); setProductionMode(next); setShots([]); setSelectedId(""); setPreviewUrl(""); setDownloadUrl("");
    setMessage(next === "long-scenes" ? "Long-scene workflow selected. Run AI analysis to create direct text-to-video scenes." : next === "mixed" ? "Mixed workflow selected. Run AI analysis to create a full image storyboard with a few recommended video clips." : "Short-shot workflow selected. Run AI analysis to create an image-led storyboard.");
  }

  function goToStage(nextStage:string) {
    if (nextStage === "storyboard" && stage !== "storyboard") setSelectedId(shots[0]?.id || "");
    setEpisodesOpen(false);
    setStage(nextStage);
  }

  async function refreshEpisodeHistory() {
    setHistoryLoading(true);
    try { setEpisodeHistory(await listProjectCaches() as EpisodeSummary[]); }
    catch { setMessage("Could not read the local episode library."); }
    finally { setHistoryLoading(false); }
  }

  async function openEpisodeLibrary() {
    setEpisodesOpen(true);
    if (allowSave.current) await persistProject();
    await refreshEpisodeHistory();
  }

  async function newEpisode(keepCurrent = true) {
    if (keepCurrent && allowSave.current) await persistProject();
    cacheEpoch.current += 1;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const id = createEpisodeId();
    const blank = { id, stage:"episode", title:"", script:"", contentFormat:"Documentary", visualStyle:"Photorealistic", creativeDirection:"", productionMode:"short-shots", longClipDuration:10, shots:[], selectedId:"", audioName:"", audioData:"", audioDuration:0, transcription:null, denoiseNarration:true, bgm:"", bgmVolume:8, subtitleStyle:normalizeSubtitleStyle(), mode:"Review then batch", previewUrl:"", downloadUrl:"", downloadResolution:"1080", screenRatio:"9:16" };
    applyProjectState(blank, "New empty episode created. Your previous episodes remain in the library.");
    setEpisodesOpen(false);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(blank)); } catch { /* IndexedDB is the primary cache */ }
    await writeProjectCache(blank).catch(() => {});
  }

  async function openSavedEpisode(id:string) {
    if (id === episodeId) { setEpisodesOpen(false); return; }
    if (allowSave.current) await persistProject();
    const parsed = await readProjectCache(id).catch(() => null);
    if (!parsed) { setMessage("That saved episode could not be opened."); await refreshEpisodeHistory(); return; }
    cacheEpoch.current += 1;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    applyProjectState(parsed, `Opened ${parsed.title || "Untitled episode"} · ${parsed.shots?.length || 0} shots.`);
    await activateProjectCache(id).catch(() => {});
    setEpisodesOpen(false);
  }

  async function removeSavedEpisode(summary:EpisodeSummary) {
    if (!window.confirm(`Delete “${summary.title}” from this device? This cannot be undone.`)) return;
    cacheEpoch.current += 1;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const deleted = await deleteProjectCache(summary.id).then(() => true).catch(() => { setMessage("Could not delete the saved episode."); return false; });
    if (!deleted) return;
    if (summary.id === episodeId) { await newEpisode(false); return; }
    setMessage(`${summary.title} deleted from local history.`);
    await refreshEpisodeHistory();
  }

  async function analyze() {
    touchProject();
    if (!script.trim()) { setMessage("Add the episode script before planning shots."); return; }
    if (audioName && !transcription) { setMessage("Wait for local transcription to finish before planning shots. Its word timestamps are the master timeline."); return; }
    if (!provider.textApiKey && !providerStatus.text.configured) { setMessage("Configure a text AI provider before analyzing the script."); setSettingsOpen(true); return; }
    setBusy("AI is planning the episode");
    try {
      const response = await fetch(`${SERVICE}/text/plan`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ textKind:provider.textKind, endpoint:provider.textEndpoint, model:provider.textModel, apiKey:provider.textApiKey, script, contentFormat, visualStyle, creativeDirection, productionMode, longClipDuration, screenRatio, audioDuration, transcription }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Planning failed");
      const planned:Shot[] = data.shots.map((shot:Partial<Shot>, index:number) => ({ ...shot, id:`shot-${Date.now()}-${index}`, index, status:"planned", locked:false, image:"", variants:[], imageStatus:"idle", imageError:"", provider:"", seed:"", video:"", videoStatus:"idle", videoError:"", videoProvider:"" })) as Shot[];
      persistProject(projectSnapshot({ shots:planned, selectedId:planned[0]?.id || "", stage:"storyboard", previewUrl:"", downloadUrl:"" }));
      setPreviewUrl(""); setDownloadUrl("");
      setShots(planned); setSelectedId(planned[0]?.id || ""); setStage("storyboard");
      setMessage(`${planned.length} ${productionMode === "long-scenes" ? "long scenes" : "production shots"} planned${productionMode === "mixed" ? ` · ${planned.filter((shot) => shot.videoRecommended).length} selected for video` : ""}${audioDuration ? " and fitted to the narration duration" : ""}.`);
      if (mode === "Fully automatic") {
        if (productionMode === "long-scenes") {
          await generateAllVideos(planned);
        } else if (provider.kind !== "sdwebui" && !provider.apiKey && !providerStatus.image.configured) {
          setMessage("Storyboard planned. Configure the image provider to continue automatic generation."); setSettingsOpen(true);
        } else {
          const generated = await generatePlannedShots(planned);
          if (productionMode === "mixed" && generated) await generateAllVideos(generated, true);
        }
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Planning failed"); }
    finally { setBusy(""); }
  }

  function updateShot(id: string, patch: Partial<Shot>) {
    touchProject();
    setPreviewUrl(""); setDownloadUrl("");
    setShots((current) => {
      const updated = current.map((shot) => shot.id === id ? { ...shot, ...patch } : shot);
      if (patch.duration === undefined) return updated;
      let cursor = 0;
      return updated.map((shot, index) => {
        const duration = Math.max(.6, Number(shot.duration) || 2);
        const timed = { ...shot, index, duration, start: Number(cursor.toFixed(2)), end: Number((cursor + duration).toFixed(2)) };
        cursor += duration;
        return timed;
      });
    });
  }

  async function handleAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    touchProject();
    setPreviewUrl(""); setDownloadUrl("");
    setBusy("Reading narration timing");
    const dataUrl = await fileToDataUrl(file);
    setAudioName(file.name); setAudioData(dataUrl); setTranscription(null);
    const browserDuration = await readAudioDuration(file);
    if (browserDuration) setAudioDuration(browserDuration);
    setBusy("Transcribing narration locally");
    try {
      const response = await fetch(`${SERVICE}/audio/transcribe`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ endpoint:provider.transcriptionEndpoint, language:provider.transcriptionLanguage, filename:file.name, audioData:dataUrl }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Local transcription failed");
      const recoveredScript = !script.trim() && result.text ? result.text : script;
      persistProject(projectSnapshot({ audioName:file.name, audioData:dataUrl, audioDuration:result.duration || browserDuration, transcription:result, script:recoveredScript }));
      setTranscription(result); if (result.duration) setAudioDuration(result.duration);
      if (!script.trim() && result.text) setScript(result.text);
      setMessage(`Local transcription ready: ${result.segments?.length || 0} timed segments · ${formatTime(result.duration || audioDuration)}`);
    } catch (error) {
      setMessage(`Narration loaded, but local transcription failed: ${error instanceof Error ? error.message : "Service unavailable"}`);
    } finally { setBusy(""); }
  }

  function selectBgm(path: string) {
    touchProject();
    setPreviewUrl(""); setDownloadUrl("");
    setBgm(path);
    const track = BGM_TRACKS.find((item) => item.path === path);
    setMessage(path ? `${track?.label || "Background music"} selected.` : "Background music disabled.");
  }

  function changeSubtitleStyle(patch:Partial<SubtitleStyle> | SubtitleStyle) {
    touchProject(); setPreviewUrl(""); setDownloadUrl("");
    setSubtitleStyle((current) => normalizeSubtitleStyle({ ...current, ...patch }));
  }

  function imageProviderReady() {
    if (provider.kind === "sdwebui" || provider.apiKey || providerStatus.image.configured) return true;
    setMessage("Configure an image AI provider before generating shots."); setSettingsOpen(true); return false;
  }

  async function requestShotImage(shot: Shot) {
    updateShot(shot.id, { status:"generating", imageStatus:"generating", imageError:"" });
    try {
      const response = await fetch(`${SERVICE}/image/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...provider, prompt: shot.prompt, screenRatio }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Generation failed"); const image = data.image;
      const generatedShot = { ...shot, image, variants:[...shot.variants, image], status:"generated", imageStatus:"generated", imageError:"", provider:provider.model, video:"", videoStatus:"idle", videoError:"", videoProvider:"" };
      updateShot(shot.id, generatedShot);
      return { ok:true, shot:generatedShot };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Generation failed";
      updateShot(shot.id, { status:"planned", imageStatus:"failed", imageError:reason });
      return { ok:false, shot, error:reason };
    }
  }

  async function generateOne(shot: Shot) {
    if (shot.locked || busy || !imageProviderReady()) return;
    const concurrency = Math.max(1, Math.min(6, Math.floor(provider.imageConcurrency) || 3));
    if (!canStartConcurrentJob(activeManualImageIds.current, shot.id, concurrency)) {
      setMessage(activeManualImageIds.current.has(shot.id) ? `Shot ${shot.index + 1} is already generating.` : `All ${concurrency} parallel image slots are currently in use.`);
      return;
    }
    activeManualImageIds.current.add(shot.id);
    setActiveManualImageCount(activeManualImageIds.current.size);
    setMessage(`Generating shot ${shot.index + 1} · ${activeManualImageIds.current.size}/${concurrency} slots active.`);
    try {
      const result = await requestShotImage(shot);
      setMessage(result.ok ? `Shot ${shot.index + 1} generated.` : result.error || "Generation failed");
    } finally {
      activeManualImageIds.current.delete(shot.id);
      setActiveManualImageCount(activeManualImageIds.current.size);
    }
  }

  async function generateBatch(source: Shot[], successMessage: string) {
    if (!imageProviderReady()) return null;
    const pending = source.filter((shot) => !shot.locked && !shot.image && shot.status !== "generating");
    if (!pending.length) { setMessage("No unlocked shots are waiting for image generation."); return source; }
    touchProject();
    const concurrency = Math.max(1, Math.min(6, Math.floor(provider.imageConcurrency) || 3));
    const workerCount = Math.min(concurrency, pending.length);
    const failures: string[] = [];
    const pendingIds = new Set(pending.map((shot) => shot.id));
    setShots((current) => current.map((shot) => pendingIds.has(shot.id) ? { ...shot, imageStatus:"queued", imageError:"" } : shot));
    setBusy(`Generating images · 0/${pending.length} · ${workerCount} parallel`);
    try {
      const results = await mapWithConcurrency(pending, concurrency, async (shot:Shot) => {
        const result = await requestShotImage(shot);
        if (!result.ok) failures.push(`Shot ${shot.index + 1}: ${result.error}`);
        return result;
      }, ({ completed }: { completed:number }) => setBusy(`Generating images · ${completed}/${pending.length} · ${workerCount} parallel`));
      const completed = pending.length - failures.length;
      setMessage(failures.length ? `${completed}/${pending.length} images generated. ${failures.length} failed and can be retried.` : successMessage);
      const generatedById = new Map(results.filter((result:any) => result.status === "fulfilled" && result.value?.ok).map((result:any) => [result.value.shot.id, result.value.shot]));
      return source.map((shot) => generatedById.get(shot.id) || shot) as Shot[];
    } finally { setBusy(""); }
  }

  async function generateAll() {
    await generateBatch(shots, "All unlocked shots are ready for review.");
  }

  async function generatePlannedShots(planned:Shot[]) {
    return await generateBatch(planned, "AI planning and image generation completed.");
  }

  async function videoProviderReady() {
    if (provider.videoApiKey || providerStatus.video?.configured) return true;
    try {
      const response = await fetch(`${SERVICE}/config/status`);
      const status = await response.json();
      if (!response.ok) throw new Error(status.error || "Could not read provider status");
      setProviderStatus(status);
      if (!status.video) {
        setMessage("The running provider bridge predates video support. Restart “npm run dev”, then try Animate again.");
        return false;
      }
      if (status.video.configured) {
        setProvider((current) => ({ ...current, videoKind:status.video.kind, videoEndpoint:status.video.endpoint, videoModel:status.video.model }));
        return true;
      }
      setMessage("Configure Volcengine Ark video generation before animating shots."); setSettingsOpen(true); return false;
    } catch {
      setMessage("The local provider bridge is not reachable. Start or restart “npm run dev”, then try Animate again.");
      return false;
    }
  }

  async function requestShotVideo(shot:Shot) {
    const directTextToVideo = productionMode === "long-scenes";
    if (!directTextToVideo && !shot.image) return { ok:false, shot, error:"Generate the storyboard image first" };
    updateShot(shot.id, { videoStatus:"generating", videoError:"", ...(directTextToVideo ? { status:"generating" } : {}) });
    try {
      const response = await fetch(`${SERVICE}/video/generate`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ videoKind:provider.videoKind, endpoint:provider.videoEndpoint, model:provider.videoModel, apiKey:provider.videoApiKey, generationMode:productionMode, videoPrompt:shot.videoPrompt, image:directTextToVideo ? "" : shot.image, motion:shot.motion, duration:shot.duration, screenRatio }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Video generation failed");
      updateShot(shot.id, { video:data.video, videoStatus:"generated", videoError:"", videoProvider:provider.videoModel, ...(directTextToVideo ? { status:"generated" } : {}), ...(productionMode === "mixed" ? { videoRecommended:true } : {}) });
      return { ok:true, shot };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Video generation failed";
      updateShot(shot.id, { videoStatus:"failed", videoError:reason, ...(directTextToVideo ? { status:"planned" } : {}) });
      return { ok:false, shot, error:reason };
    }
  }

  async function generateOneVideo(shot:Shot) {
    if (shot.locked || shot.videoStatus === "generating") return;
    if (productionMode !== "long-scenes" && !shot.image) { setMessage(`Generate the image for shot ${shot.index + 1} before animating it.`); return; }
    if (busy) return;
    if (!await videoProviderReady()) return;
    const concurrency = Math.max(1, Math.min(4, Math.floor(provider.videoConcurrency) || 2));
    if (!canStartConcurrentJob(activeManualVideoIds.current, shot.id, concurrency)) {
      setMessage(activeManualVideoIds.current.has(shot.id) ? `Shot ${shot.index + 1} is already animating.` : `All ${concurrency} parallel video slots are currently in use.`);
      return;
    }
    activeManualVideoIds.current.add(shot.id);
    setActiveManualVideoCount(activeManualVideoIds.current.size);
    setMessage(`${productionMode === "long-scenes" ? "Generating long scene" : "Animating shot"} ${shot.index + 1} with Volcengine · ${activeManualVideoIds.current.size}/${concurrency} slots active.`);
    try {
      const result = await requestShotVideo(shot);
      setMessage(result.ok ? `${productionMode === "long-scenes" ? "Long scene" : "Shot"} ${shot.index + 1} video clip generated and cached locally.` : result.error || "Video generation failed");
    } finally {
      activeManualVideoIds.current.delete(shot.id);
      const remaining = activeManualVideoIds.current.size;
      setActiveManualVideoCount(remaining);
    }
  }

  async function generateAllVideos(source:Shot[] = shots, recommendedOnly = productionMode === "mixed") {
    if (!await videoProviderReady()) return;
    const blockedRecommended = recommendedOnly ? source.filter((shot) => shot.videoRecommended && !shot.image && !shot.video) : [];
    const pending = source.filter((shot) => !shot.locked && (productionMode === "long-scenes" || shot.image) && (!recommendedOnly || shot.videoRecommended) && !shot.video && shot.videoStatus !== "generating");
    if (!pending.length) { setMessage(productionMode === "long-scenes" ? "No unlocked long scenes are waiting for video generation." : recommendedOnly && blockedRecommended.length ? `${blockedRecommended.length} recommended shots still need images before animation.` : recommendedOnly ? "No recommended storyboard shots are waiting for animation." : "No unlocked storyboard images are waiting for animation."); return; }
    touchProject();
    const concurrency = Math.max(1, Math.min(4, Math.floor(provider.videoConcurrency) || 2));
    const failures:string[] = [];
    const pendingIds = new Set(pending.map((shot) => shot.id));
    setShots((current) => current.map((shot) => pendingIds.has(shot.id) ? { ...shot, videoStatus:"queued", videoError:"" } : shot));
    setBusy(`${productionMode === "long-scenes" ? "Generating long scenes" : recommendedOnly ? "Animating selected shots" : "Animating clips"} · 0/${pending.length} · Volcengine may take several minutes`);
    try {
      await mapWithConcurrency(pending, concurrency, async (shot:Shot) => {
        const result = await requestShotVideo(shot);
        if (!result.ok) failures.push(`Shot ${shot.index + 1}: ${result.error}`);
        return result;
      }, ({ completed }:{ completed:number }) => setBusy(`${productionMode === "long-scenes" ? "Generating long scenes" : recommendedOnly ? "Animating selected shots" : "Animating clips"} · ${completed}/${pending.length} · ${Math.min(concurrency, pending.length)} parallel`));
      const completed = pending.length - failures.length;
      setMessage(failures.length ? `${completed}/${pending.length} clips generated. ${failures.length} failed and can be retried.` : productionMode === "long-scenes" ? "All long scenes now have locally cached video clips." : recommendedOnly && blockedRecommended.length ? `${completed} recommended clips generated; ${blockedRecommended.length} selected shots still need images.` : recommendedOnly ? "All recommended mixed-mode shots now have video clips." : "All unlocked shots now have locally cached video clips.");
    } finally { setBusy(""); }
  }

  async function translateAll() {
    touchProject();
    setBusy("Creating bilingual subtitles");
    try {
      if (!provider.textApiKey && !providerStatus.text.configured) {
        setMessage("Configure a text AI provider before translating subtitles."); setSettingsOpen(true); return;
      }
      const response = await fetch(`${SERVICE}/text/translate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ textKind:provider.textKind, endpoint: provider.textEndpoint, model: provider.textModel, apiKey: provider.textApiKey, lines: shots.map((shot) => shot.narration) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Translation failed");
      setPreviewUrl(""); setDownloadUrl("");
      setShots((current) => current.map((shot, index) => ({ ...shot, chinese: data.lines[index] || shot.chinese })));
      setMessage("Bilingual subtitles translated and ready for review.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Translation failed"); }
    finally { setBusy(""); }
  }

  async function renderVideo(resolution:string) {
    if (!audioData) { setMessage("Upload the recorded narration before building the video."); setStage("episode"); return; }
    if (!shots.length) { setMessage("Analyze the script before building the video."); setStage("episode"); return; }
    if (!visualCoverage(shots).complete) { setMessage("Every storyboard segment needs either a generated image or a video clip before building."); goToStage("storyboard"); return; }
    const preset = videoResolution(resolution, screenRatio);
    setPreviewUrl(""); setDownloadUrl("");
    setBusy(`Building ${preset.label} video`);
    try {
      const response = await fetch(`${SERVICE}/render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, shots, narrationData: audioData, voicePreset:denoiseNarration ? "denoise" : "original", bgmPath:bgm, bgmVolume:bgmVolume / 100, subtitleStyle, width:preset.width, height:preset.height }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Render failed");
      const requestedStyle = normalizeSubtitleStyle(subtitleStyle); const renderedStyle = data.subtitleStyle ? normalizeSubtitleStyle(data.subtitleStyle) : null;
      if (!renderedStyle || JSON.stringify(renderedStyle) !== JSON.stringify(requestedStyle)) throw new Error("The render service is outdated and did not apply the current subtitle style. Restart npm run dev, then rebuild the video");
      const url = `${SERVICE}${data.url}`;
      setPreviewUrl(url); setDownloadUrl(url);
      setMessage(`${preset.label} video built in ${data.seconds.toFixed(1)} seconds and ready to download.`);
    } catch (error) { setMessage(error instanceof Error ? `${error.message}. Start the local render service with “npm run render-service”.` : "Render failed"); }
    finally { setBusy(""); }
  }

  function changeScreenRatio(value:string) {
    const next = normalizeScreenRatio(value);
    if (next === screenRatio) return;
    touchProject(); setScreenRatio(next); setPreviewUrl(""); setDownloadUrl("");
    setShots((current) => current.map((shot) => ({ ...shot, prompt:promptForScreenRatio(shot.prompt, next), videoPrompt:promptForScreenRatio(shot.videoPrompt, next) })));
    setMessage(`Screen ratio changed to ${next} and shot prompts were updated. Existing assets are preserved; regenerate them to apply the new framing.`);
  }

  const manualImageLimit = Math.max(1, Math.min(6, Math.floor(provider.imageConcurrency) || 3));
  const manualVideoLimit = Math.max(1, Math.min(4, Math.floor(provider.videoConcurrency) || 2));
  const manualActivity = [
    activeManualImageCount ? `Generating images · ${activeManualImageCount}/${manualImageLimit}` : "",
    activeManualVideoCount ? `Animating clips · ${activeManualVideoCount}/${manualVideoLimit}` : "",
  ].filter(Boolean).join(" · ");
  const activityLabel = busy || (manualActivity ? `${manualActivity} manual jobs active` : "");

  return (
    <main className="studio-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">S</div><div><strong>Shortform</strong><span>STUDIO</span></div></div>
        <nav aria-label="Workspace navigation">
          <button type="button" onClick={() => void openEpisodeLibrary()} className={episodesOpen ? "nav-active" : ""} disabled={!!activityLabel} aria-current={episodesOpen ? "page" : undefined}><span>LIB</span>Episodes</button>
          {[['episode','01','Episode'],['storyboard','02','Storyboard'],['captions','03','Audio & captions'],['export','04','Build & Preview']].map(([id, n, label]) => (
            <button key={id} onClick={() => goToStage(id)} className={!episodesOpen && stage === id ? "nav-active" : ""}><span>{n}</span>{label}</button>
          ))}
        </nav>
        <div className="sidebar-foot"><span className="local-dot"/>Local workspace<div>Nothing leaves this device until a provider is called.</div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><span className="eyebrow">CURRENT EPISODE</span><input className="title-input" value={title} placeholder="Untitled episode" onChange={(e) => { touchProject(); setTitle(e.target.value); }} aria-label="Episode title" /></div>
          <div className="top-actions"><span className="save-state">● Saved locally</span><button className="ghost" onClick={() => void newEpisode()} disabled={!!activityLabel}>New episode</button><button className="ghost" onClick={() => setSettingsOpen(true)}>Provider settings</button><button className="primary" onClick={() => setStage("export")} disabled={!!busy}>Build & Preview</button></div>
        </header>

        {episodesOpen ? <EpisodeLibrary episodes={episodeHistory} currentId={episodeId} loading={historyLoading} openEpisode={(id:string) => void openSavedEpisode(id)} deleteEpisode={(summary:EpisodeSummary) => void removeSavedEpisode(summary)} newEpisode={() => void newEpisode()} /> : <>
          {stage === "episode" && <EpisodePanel title={title} setTitle={setTitle} script={script} setScript={setScript} contentFormat={contentFormat} setContentFormat={setContentFormat} visualStyle={visualStyle} setVisualStyle={setVisualStyle} creativeDirection={creativeDirection} setCreativeDirection={setCreativeDirection} productionMode={productionMode} setProductionMode={changeProductionMode} longClipDuration={longClipDuration} setLongClipDuration={setLongClipDuration} mode={mode} setMode={setMode} touchProject={touchProject} audioName={audioName} transcription={transcription} handleAudio={handleAudio} analyze={analyze} busy={busy} />}
          {stage === "storyboard" && <Storyboard productionMode={productionMode} script={script} transcription={transcription} audioData={audioData} shots={shots} selected={selected} setSelectedId={setSelectedId} updateShot={updateShot} generateOne={generateOne} generateAll={generateAll} generateOneVideo={generateOneVideo} generateAllVideos={generateAllVideos} totalDuration={totalDuration} busy={busy} activeManualImageCount={activeManualImageCount} activeManualVideoCount={activeManualVideoCount} imageConcurrency={provider.imageConcurrency} videoConcurrency={provider.videoConcurrency} screenRatio={screenRatio} setScreenRatio={changeScreenRatio} subtitleStyle={subtitleStyle} setSubtitleStyle={changeSubtitleStyle} />}
          {stage === "captions" && <Captions script={script} shots={shots} updateShot={updateShot} translateAll={translateAll} audioName={audioName} audioData={audioData} transcription={transcription} denoiseNarration={denoiseNarration} setDenoiseNarration={(checked:boolean)=>{ touchProject(); setDenoiseNarration(checked); setPreviewUrl(""); setDownloadUrl(""); }} bgm={bgm} selectBgm={selectBgm} bgmVolume={bgmVolume} setBgmVolume={(value:number)=>{ touchProject(); setBgmVolume(value); setPreviewUrl(""); setDownloadUrl(""); }} />}
          {stage === "export" && <ExportPanel title={title} productionMode={productionMode} shots={shots} approved={approved} duration={totalDuration} audioName={audioName} bgm={BGM_TRACKS.find((track) => track.path === bgm)?.label || "None"} build={() => renderVideo(downloadResolution)} previewUrl={previewUrl} downloadUrl={downloadUrl} downloadResolution={downloadResolution} setDownloadResolution={(value:string) => { touchProject(); setDownloadResolution(value); setPreviewUrl(""); setDownloadUrl(""); }} screenRatio={screenRatio} busy={busy} />}
        </>}
      </section>

      <div className="statusbar"><span>{activityLabel ? <><i className="spinner"/>{activityLabel}</> : message}</span><span>{shots.length} {productionMode === "long-scenes" ? "scenes" : "shots"} · {shots.filter((shot)=>shot.video).length} clips · {formatTime(totalDuration)} · {screenRatio}</span></div>
      {settingsOpen && <Settings provider={provider} setProvider={setProvider} status={providerStatus} refreshStatus={refreshProviderStatus} close={() => setSettingsOpen(false)} />}
    </main>
  );
}

function EpisodeLibrary({ episodes, currentId, loading, openEpisode, deleteEpisode, newEpisode }:any) {
  return <div className="panel episode-library-page"><div className="section-head"><div><span className="eyebrow">LOCAL WORKSPACE</span><h1>Episodes</h1><p>Every episode is saved locally on this device, including its script, narration, storyboard, captions, and generated assets.</p></div><button className="primary large" onClick={newEpisode}>New episode</button></div>
    {loading ? <div className="episode-library-empty">Loading saved episodes…</div> : episodes.length ? <div className="episode-history">{episodes.map((episode:EpisodeSummary) => <article key={episode.id} className={episode.id === currentId ? "current" : ""}><button className="episode-open" onClick={() => openEpisode(episode.id)}><span className="episode-title"><b>{episode.title}</b>{episode.id === currentId && <em>Current</em>}</span><span className="episode-meta"><time>{formatEpisodeDate(episode.savedAt)}</time><i>{episode.shotCount} shots</i><i>{formatTime(episode.duration)}</i><i>{episode.hasNarration ? "Narration attached" : "No narration"}</i></span></button><button className="episode-delete" onClick={() => deleteEpisode(episode)} aria-label={`Delete ${episode.title}`}>Delete</button></article>)}</div> : <div className="episode-library-empty"><b>No saved episodes yet</b><span>Start a new episode and it will appear here automatically.</span></div>}
  </div>;
}

function formatEpisodeDate(savedAt:number) {
  if (!savedAt) return "Not saved yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(new Date(savedAt));
}

function EpisodePanel({ title, setTitle, script, setScript, contentFormat, setContentFormat, visualStyle, setVisualStyle, creativeDirection, setCreativeDirection, productionMode, setProductionMode, longClipDuration, setLongClipDuration, mode, setMode, touchProject, audioName, transcription, handleAudio, analyze, busy }: any) {
  return <div className="panel intake-panel"><div className="section-head"><div><span className="eyebrow">SOURCE MATERIAL</span><h1>Create an episode</h1><p>Add the finished script and recorded narration. Choose quick image-led shots or longer text-to-video scenes.</p></div><button className="primary large" onClick={analyze} disabled={!!busy}>{busy || "Analyze with AI"}</button></div>
    <div className="intake-grid"><label className="field episode-title-field"><span>Episode title</span><input value={title} placeholder="Give this episode a recognizable title…" onChange={(e) => { touchProject(); setTitle(e.target.value); }} autoComplete="off"/></label><label className="field span-2"><span>English script</span><textarea value={script} placeholder="Paste the exact English narration script here…" onChange={(e) => { touchProject(); setScript(e.target.value); }} rows={13}/><small>{script.trim() ? script.trim().split(/\s+/).length : 0} words</small></label>
      <div className="stack"><label className="field"><span>Content format</span><select value={contentFormat} onChange={(e) => { touchProject(); setContentFormat(e.target.value); }}><option>Documentary</option><option>Educational explainer</option><option>Narrative story</option><option>News recap</option><option>Product story</option><option>History documentary</option><option>Other</option></select></label><label className="field"><span>Visual style</span><select value={visualStyle} onChange={(e) => { touchProject(); setVisualStyle(e.target.value); }}><option>Photorealistic</option><option>Cinematic illustration</option><option>Editorial collage</option><option>3D animation</option><option>Anime</option><option>Minimal graphic</option></select></label><label className="field"><span>Creative direction</span><input value={creativeDirection} placeholder="Audience, mood, setting, visual constraints…" onChange={(e) => { touchProject(); setCreativeDirection(e.target.value); }}/></label><label className="field workflow-field"><span>Visual workflow</span><select value={productionMode} onChange={(e) => { touchProject(); setProductionMode(e.target.value); }}><option value="short-shots">Dynamic short shots · image first</option><option value="mixed">Mixed · all images + selected videos</option><option value="long-scenes">Long scenes · direct text to video</option></select><small>{productionMode === "long-scenes" ? "No storyboard images are generated." : productionMode === "mixed" ? "All shots get images; about one in four is selected for video." : "Create images, then optionally animate them."}</small></label>{productionMode === "long-scenes" && <label className="field clip-length-field"><span>Target clip length</span><div><input aria-label="Target long-scene clip length" type="range" min="6" max="12" step="1" value={longClipDuration} onChange={(e) => { touchProject(); setLongClipDuration(Number(e.target.value)); }}/><output>{longClipDuration}s</output></div><small>Adjustable from 6–12 seconds; scene boundaries follow natural pauses.</small></label>}<label className="field"><span>Generation mode</span><select value={mode} onChange={(e) => { touchProject(); setMode(e.target.value); }}><option>Plan only</option><option>Review then batch</option><option>Fully automatic</option></select></label>
        <label className="upload-card"><input type="file" accept="audio/*" onChange={handleAudio}/><b>{audioName ? "Narration attached" : "Add recorded narration"}</b><span>{audioName || "MP3, WAV, M4A or AAC · transcribed locally"}</span></label>{audioName && <div className={`transcript-note ${transcription ? "ready" : ""}`}><b>{transcription ? "Local transcript ready" : "Waiting for local transcript"}</b><span>{transcription ? `${transcription.segments.length} timed segments · ${formatTime(transcription.duration)}` : "Check the speech-to-text URL in Provider settings."}</span></div>}</div></div></div>;
}

function motionPreviewClass(motion: string, index: number) {
  const kinds: Record<string, string> = { "Slow push-in":"kb-push", "Slow pull-out":"kb-pull", "Slow rise":"kb-rise", "Slow sink":"kb-sink", "Push to subject":"kb-subject", "Static":"kb-static" };
  if (motion === "Slow drift") return index % 2 ? "kb-drift-b" : "kb-drift-a";
  if (motion === "Diagonal drift") return index % 2 ? "kb-diag-b" : "kb-diag-a";
  return kinds[motion] || "kb-push";
}

function RatioSelect({ screenRatio, setScreenRatio }:any) {
  return <label className="ratio-select"><span>Screen ratio</span><select value={screenRatio} onChange={(event)=>setScreenRatio(event.target.value)}>{Object.entries(SCREEN_RATIOS).map(([value, option]) => <option key={value} value={value}>{value} · {option.label}</option>)}</select></label>;
}

function SubtitleOverlay({ shot, subtitleStyle, baseFontSize = 9 }:any) {
  const style = normalizeSubtitleStyle(subtitleStyle); const fontSize = baseFontSize * style.fontScale / 100;
  const shadow = style.outline ? `0 0 ${style.outline}px ${style.backgroundColor}, 0 1px ${Math.max(1, style.outline)}px ${style.backgroundColor}` : "none";
  return <div className="preview-captions" style={{ bottom:`${style.position}%`, backgroundColor:subtitleCssBackground(style), fontFamily:style.fontFamily, fontWeight:style.bold ? 700 : 400, textAlign:style.alignment, textShadow:shadow }}><b style={{ color:style.englishColor, fontSize:`${fontSize}px`, fontWeight:"inherit" }}>{shot?.narration || "Your English subtitle appears here"}</b>{(shot?.chinese || !shot) && <span style={{ color:style.chineseColor, fontSize:`${fontSize}px` }}>{shot?.chinese || "中文字幕显示在这里"}</span>}</div>;
}

function SubtitleStyleControls({ subtitleStyle, setSubtitleStyle }:any) {
  return <section className="subtitle-style-dock" aria-label="Subtitle style"><div className="subtitle-dock-title"><span className="eyebrow">SUBTITLES</span><b>Style</b></div><div className="subtitle-dock-controls">
    <label className="dock-select"><span>Font</span><select value={subtitleStyle.fontFamily} onChange={(event)=>setSubtitleStyle({ fontFamily:event.target.value })}>{SUBTITLE_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>
    <label className="dock-select alignment"><span>Align</span><select value={subtitleStyle.alignment} onChange={(event)=>setSubtitleStyle({ alignment:event.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
    <label className="dock-range"><span>Size</span><input aria-label="Subtitle text size" type="range" min="70" max="160" step="5" value={subtitleStyle.fontScale} onChange={(event)=>setSubtitleStyle({ fontScale:Number(event.target.value) })}/><output>{subtitleStyle.fontScale}%</output></label>
    <label className="dock-range"><span>Position</span><input aria-label="Subtitle bottom position" type="range" min="3" max="35" step="1" value={subtitleStyle.position} onChange={(event)=>setSubtitleStyle({ position:Number(event.target.value) })}/><output>{subtitleStyle.position}%</output></label>
    <label className="dock-color" title="English text color"><span>EN</span><input aria-label="English subtitle color" type="color" value={subtitleStyle.englishColor} onChange={(event)=>setSubtitleStyle({ englishColor:event.target.value })}/></label>
    <label className="dock-color" title="Chinese text color"><span>中文</span><input aria-label="Chinese subtitle color" type="color" value={subtitleStyle.chineseColor} onChange={(event)=>setSubtitleStyle({ chineseColor:event.target.value })}/></label>
    <label className="dock-color" title="Subtitle background color"><span>BG</span><input aria-label="Subtitle background color" type="color" value={subtitleStyle.backgroundColor} onChange={(event)=>setSubtitleStyle({ backgroundColor:event.target.value })}/></label>
    <label className="dock-range"><span>BG alpha</span><input aria-label="Subtitle background opacity" type="range" min="0" max="100" step="5" value={subtitleStyle.backgroundOpacity} onChange={(event)=>setSubtitleStyle({ backgroundOpacity:Number(event.target.value) })}/><output>{subtitleStyle.backgroundOpacity}%</output></label>
    <label className="dock-range outline"><span>Outline</span><input aria-label="Subtitle outline size" type="range" min="0" max="5" step="0.5" value={subtitleStyle.outline} onChange={(event)=>setSubtitleStyle({ outline:Number(event.target.value) })}/><output>{subtitleStyle.outline}px</output></label>
    <label className="dock-toggle"><input type="checkbox" checked={subtitleStyle.bold} onChange={(event)=>setSubtitleStyle({ bold:event.target.checked })}/><span>Bold</span></label>
    <button type="button" className="ghost dock-reset" onClick={() => setSubtitleStyle(DEFAULT_SUBTITLE_STYLE)}>Reset</button>
  </div></section>;
}

function Storyboard({ productionMode, script, transcription, audioData, shots, selected, setSelectedId, updateShot, generateOne, generateAll, generateOneVideo, generateAllVideos, totalDuration, busy, activeManualImageCount, activeManualVideoCount, imageConcurrency, videoConcurrency, screenRatio, setScreenRatio, subtitleStyle, setSubtitleStyle }: any) {
  const shotListRef = useRef<HTMLDivElement | null>(null);
  const shotAudioRef = useRef<HTMLAudioElement | null>(null);
  const [shotAudioPlaying, setShotAudioPlaying] = useState(false);
  const [shotAudioElapsed, setShotAudioElapsed] = useState(0);
  useEffect(() => {
    if (!shots.length) return;
    const handleKeyDown = (event:KeyboardEvent) => {
      if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const currentIndex = Math.max(0, shots.findIndex((shot:Shot) => shot.id === selected?.id));
      const nextIndex = Math.max(0, Math.min(shots.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      setSelectedId(shots[nextIndex].id);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shots, selected?.id, setSelectedId]);
  useEffect(() => {
    const selectedRow = Array.from(shotListRef.current?.querySelectorAll<HTMLElement>("[data-shot-id]") || []).find((row) => row.dataset.shotId === selected?.id);
    selectedRow?.scrollIntoView({ block:"nearest" });
  }, [selected?.id]);
  useEffect(() => {
    const audio = shotAudioRef.current;
    audio?.pause();
    setShotAudioPlaying(false);
    setShotAudioElapsed(0);
    let playFrame = 0;
    if (audio?.readyState && selected) {
      const previewStart = Math.max(0, Number(selected.start) || 0);
      audio.currentTime = Math.min(previewStart, audio.duration || previewStart);
      if (audioData && Number(selected.duration) > 0) {
        playFrame = window.requestAnimationFrame(() => {
          void audio.play().catch(() => setShotAudioPlaying(false));
        });
      }
    }
    return () => { if (playFrame) window.cancelAnimationFrame(playFrame); };
  }, [audioData, selected?.id, selected?.start, selected?.duration]);
  const longScenes = productionMode === "long-scenes";
  const mixedMode = productionMode === "mixed";
  if (!shots.length) return <div className="panel storyboard-panel"><div className="section-head compact storyboard-head"><div><span className="eyebrow">VISUAL PLAN</span><h1>{longScenes ? "Long scenes" : mixedMode ? "Mixed storyboard" : "Storyboard"}</h1><p>Your {longScenes ? "text-to-video scenes" : mixedMode ? "image shots and selected video moments" : "production shots"} will appear here after AI analysis.</p></div><RatioSelect screenRatio={screenRatio} setScreenRatio={setScreenRatio}/></div><div className="empty-state"><span>01</span><h2>No visual plan yet</h2><p>Open Episode, add your script and narration, then run AI analysis.</p></div></div>;
  const manualImageLimit = Math.max(1, Math.min(6, Math.floor(Number(imageConcurrency)) || 3));
  const manualImageSlotFull = activeManualImageCount >= manualImageLimit;
  const manualVideoLimit = Math.max(1, Math.min(4, Math.floor(Number(videoConcurrency)) || 2));
  const manualVideoSlotFull = activeManualVideoCount >= manualVideoLimit;
  const otherWorkBusy = Boolean(busy);
  const batchActionsBusy = otherWorkBusy || activeManualImageCount > 0 || activeManualVideoCount > 0;
  const currentScript = selected ? scriptSectionForDuration(script, transcription, selected.start, selected.end, totalDuration) : "";
  const shotStart = Math.max(0, Number(selected?.start) || 0);
  const shotAudioStart = shotStart;
  const shotAudioEnd = shotStart + Math.max(0, Number(selected?.duration) || 0);
  const shotAudioDuration = shotAudioEnd - shotAudioStart;
  function resetShotAudio(audio:HTMLAudioElement) {
    audio.pause();
    if (audio.readyState) audio.currentTime = Math.min(shotAudioStart, audio.duration || shotAudioStart);
    setShotAudioPlaying(false);
    setShotAudioElapsed(0);
  }
  async function toggleShotAudio() {
    const audio = shotAudioRef.current;
    if (!audio || !audioData || !shotAudioDuration) return;
    if (!audio.paused) { audio.pause(); setShotAudioPlaying(false); return; }
    if (audio.currentTime < shotAudioStart || audio.currentTime >= shotAudioEnd - .02) audio.currentTime = shotAudioStart;
    try { await audio.play(); setShotAudioPlaying(true); }
    catch { setShotAudioPlaying(false); }
  }
  const recommendedVideos = shots.filter((shot:Shot) => shot.videoRecommended).length;
  return <div className="panel storyboard-panel"><div className="section-head compact storyboard-head"><div><span className="eyebrow">VISUAL PLAN</span><h1>{longScenes ? "Long scenes" : mixedMode ? "Mixed storyboard" : "Storyboard"}</h1><p>{shots.length} {longScenes ? "scenes" : "shots"} aligned across {formatTime(totalDuration)} · {shots.filter((shot:Shot)=>shot.video).length} clips ready{mixedMode ? ` · ${recommendedVideos} recommended` : ""} <span className="hotkey-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span></p></div><div className="story-actions"><RatioSelect screenRatio={screenRatio} setScreenRatio={setScreenRatio}/>{!longScenes && <button className="ghost" onClick={generateAll} disabled={batchActionsBusy}>{batchActionsBusy ? "Working…" : "Generate images"}</button>}<button className="primary" onClick={() => generateAllVideos()} disabled={batchActionsBusy}>{batchActionsBusy ? "Working…" : longScenes ? "Generate all long clips" : mixedMode ? `Animate recommended (${recommendedVideos})` : "Animate all shots"}</button></div></div>
    <div className={`story-grid ratio-${screenRatio.replace(':','-')}`}><div className="shot-list" ref={shotListRef} aria-keyshortcuts="ArrowUp ArrowDown">{shots.map((shot: Shot) => <button key={shot.id} data-shot-id={shot.id} className={`shot-row ${selected?.id === shot.id ? "selected" : ""}`} onClick={() => setSelectedId(shot.id)}>
      <div className="thumb">{shot.video ? <video src={shot.video} muted playsInline aria-label="Generated scene clip"/> : shot.image ? <img src={shot.image} alt="Generated shot"/> : null}<i className="shot-index-badge" aria-label={`Shot ${shot.index + 1}`}>{String(shot.index + 1).padStart(2,'0')}</i>{shot.video ? <i className="clip-badge">CLIP</i> : mixedMode && shot.videoRecommended ? <i className="video-pick-badge">VIDEO PICK</i> : null}</div><div className="shot-summary"><div><span className={`tag type-${shot.type.toLowerCase()}`}>{shot.type}</span><span className="time">{formatTime(shot.start)}—{formatTime(shot.end)}</span></div><p>{shot.narration}</p><small>{shot.duration.toFixed(1)}s · {shot.motion}</small></div><span className={`state state-${shot.videoStatus === "generating" ? "generating" : shot.status}`}>{shot.locked ? "Locked" : shot.videoStatus === "generating" ? longScenes ? "generating" : "animating" : shot.video ? "clip ready" : mixedMode && shot.videoRecommended ? "video selected" : longScenes ? "planned" : shot.status}</span></button>)}</div>
      {selected && <div className={`inspector ${screenRatio === "16:9" ? "layout-landscape" : ""}`}><div className="shot-preview-column"><div className={`phone-frame ratio-${screenRatio.replace(':','-')}`}><div className="phone-canvas" style={{ aspectRatio:screenRatio.replace(':',' / ') }}>{selected.video ? <video src={selected.video} autoPlay loop muted playsInline aria-label="Generated shot video preview"/> : selected.image ? <img src={selected.image} alt="Selected shot preview" className={motionPreviewClass(selected.motion, selected.index)} style={{ animationDuration:`${Math.max(.6, Number(selected.duration) || 2)}s` }}/> : <div className="empty-visual"><span>{String(selected.index + 1).padStart(2,'0')}</span><b>{longScenes ? "Awaiting video" : "Awaiting image"}</b></div>}<SubtitleOverlay shot={selected} subtitleStyle={subtitleStyle}/></div></div>
        <div className={`shot-audio-preview ${audioData ? "" : "unavailable"}`}><audio ref={shotAudioRef} src={audioData || undefined} preload="metadata" autoPlay onPlay={() => setShotAudioPlaying(true)} onPause={() => setShotAudioPlaying(false)} onLoadedMetadata={(event) => { const audio = event.currentTarget; audio.currentTime = Math.min(shotAudioStart, audio.duration || shotAudioStart); if (audioData && shotAudioDuration) void audio.play().catch(() => setShotAudioPlaying(false)); }} onTimeUpdate={(event) => { const audio = event.currentTarget; const elapsed = Math.max(0, Math.min(shotAudioDuration, audio.currentTime - shotAudioStart)); setShotAudioElapsed(elapsed); if (audio.currentTime >= shotAudioEnd - .02) resetShotAudio(audio); }} onEnded={(event) => resetShotAudio(event.currentTarget)}/><button type="button" onClick={() => void toggleShotAudio()} disabled={!audioData || !shotAudioDuration} aria-label={`${shotAudioPlaying ? "Pause" : "Play"} narration for shot ${selected.index + 1}`}>{shotAudioPlaying ? "❚❚" : "▶"}</button><div><span>Shot narration</span><progress max={shotAudioDuration || 1} value={shotAudioElapsed}/></div><time>{formatTime(shotAudioElapsed)} / {formatTime(shotAudioDuration)}</time></div></div>
        <div className="inspector-form"><div className="inspector-title"><div><span className="eyebrow">{longScenes ? "SCENE" : "SHOT"} {String(selected.index + 1).padStart(2,'0')}</span><h2>{selected.type} visual</h2></div><button className={`lock ${selected.locked ? "locked" : ""}`} onClick={() => updateShot(selected.id,{locked:!selected.locked})}>{selected.locked ? "Locked" : "Lock"}</button></div>
          <div className="current-script" aria-live="polite"><div><span>Script in this {longScenes ? "scene" : "shot"}</span><time>{formatTime(selected.start)}—{formatTime(selected.end)}</time></div><p>{currentScript || "No spoken script in this time range."}</p></div>
          {!longScenes && <label className="field"><span>Image prompt</span><textarea rows={7} value={selected.prompt} onChange={(e) => updateShot(selected.id,{prompt:e.target.value,status:'planned',video:'',videoStatus:'idle',videoError:'',videoProvider:''})}/></label>}
          <label className="field"><span>{longScenes ? "Text-to-video prompt" : "Video prompt"}</span><textarea rows={7} value={selected.videoPrompt || ""} onChange={(e) => updateShot(selected.id,{videoPrompt:e.target.value,video:'',videoStatus:'idle',videoError:'',videoProvider:''})}/><small>{longScenes ? "Describes the full scene directly; no reference image is sent to the video model." : "Created during AI analysis; describes subject action, environmental movement, and continuity from the generated first frame."}</small></label>
          {mixedMode && <label className="mixed-video-toggle"><input type="checkbox" checked={Boolean(selected.videoRecommended)} onChange={(e) => updateShot(selected.id,{videoRecommended:e.target.checked})}/><span><b>Selected for batch video</b><small>Recommended clips are generated by the mixed-mode batch action. Existing clips remain in use if you later uncheck this.</small></span></label>}
          <div className="three-fields"><label className="field"><span>Duration</span><input type="number" min={longScenes ? "6" : "0.6"} max={longScenes ? "12" : "8"} step="0.1" value={selected.duration} onChange={(e) => updateShot(selected.id,{duration:Number(e.target.value)})}/></label><label className="field"><span>Motion</span><select value={selected.motion} onChange={(e) => updateShot(selected.id,{motion:e.target.value,video:'',videoStatus:'idle',videoError:'',videoProvider:''})}>{SHOT_MOTIONS.map((motion) => <option key={motion}>{motion}</option>)}</select></label><label className="field"><span>Status</span><select value={selected.status} onChange={(e) => updateShot(selected.id,{status:e.target.value})}><option>planned</option><option>approved</option><option>generated</option></select></label></div>
          <div className={`shot-generation-actions ${longScenes ? "single" : ""}`}>{!longScenes && <button className="ghost full" onClick={() => generateOne(selected)} disabled={selected.locked || selected.status === "generating" || selected.videoStatus === "generating" || otherWorkBusy || manualImageSlotFull}>{selected.status === "generating" ? "Generating…" : selected.image ? "Create another image" : "Generate image"}</button>}<button className="primary full" onClick={() => generateOneVideo(selected)} disabled={selected.locked || (!longScenes && !selected.image) || selected.videoStatus === "generating" || otherWorkBusy || manualVideoSlotFull}>{selected.videoStatus === "generating" ? "Generating…" : selected.video ? "Regenerate Volcengine clip" : longScenes ? "Generate long clip" : "Animate with Volcengine"}</button></div><GenerationTaskManager productionMode={productionMode} shot={selected} generateOne={generateOne} generateOneVideo={generateOneVideo} busy={busy} activeManualImageCount={activeManualImageCount} activeManualVideoCount={activeManualVideoCount} imageConcurrency={imageConcurrency} videoConcurrency={videoConcurrency}/></div></div>}
    </div><SubtitleStyleControls subtitleStyle={subtitleStyle} setSubtitleStyle={setSubtitleStyle}/></div>;
}

function taskStatusLabel(status:string) {
  return status === "generated" ? "Completed" : status === "generating" ? "Generating" : status === "queued" ? "Queued" : status === "failed" ? "Failed" : "Not started";
}

function GenerationTaskManager({ productionMode, shot, generateOne, generateOneVideo, busy, activeManualImageCount, activeManualVideoCount, imageConcurrency, videoConcurrency }:any) {
  const imageLimit = Math.max(1, Math.min(6, Math.floor(Number(imageConcurrency)) || 3));
  const videoLimit = Math.max(1, Math.min(4, Math.floor(Number(videoConcurrency)) || 2));
  const longScenes = productionMode === "long-scenes";
  const tasks = [
    ...(!longScenes ? [{ key:`${shot.id}-image`, shot, kind:"Image", status:shot.imageStatus || (shot.status === "generating" ? "generating" : shot.image ? "generated" : "idle"), error:shot.imageError, provider:shot.provider, retry:() => generateOne(shot), disabled:Boolean(busy) || shot.locked || shot.status === "generating" || activeManualImageCount >= imageLimit }] : []),
    { key:`${shot.id}-video`, shot, kind:longScenes ? "Text → video" : "Video", status:shot.videoStatus || (shot.video ? "generated" : "idle"), error:shot.videoError, provider:shot.videoProvider, retry:() => generateOneVideo(shot), disabled:Boolean(busy) || shot.locked || (!longScenes && !shot.image) || shot.videoStatus === "generating" || activeManualVideoCount >= videoLimit },
  ];
  const active = tasks.filter((task:any) => task.status === "queued" || task.status === "generating").length;
  const failed = tasks.filter((task:any) => task.status === "failed").length;
  const completed = tasks.filter((task:any) => task.status === "generated").length;
  const summary = failed ? `${failed} failed` : active ? `${active} active` : `${completed}/${tasks.length} ready`;
  return <section className="generation-manager compact-generation-manager" aria-labelledby="generation-manager-title"><div className="compact-task-head"><div><span className="eyebrow">GENERATION TASKS</span><b id="generation-manager-title">{longScenes ? "Scene" : "Shot"} {String(shot.index + 1).padStart(2,"0")}</b></div><span className={failed ? "has-failures" : ""}>{summary}</span></div>
    <div className="compact-task-list" role="list" aria-label={`${longScenes ? "Scene" : "Shot"} ${shot.index + 1} generation tasks`}>{tasks.map((task:any) => { const detail = task.status === "failed" ? task.error || "The provider did not return a reason." : task.status === "queued" ? "Waiting for a slot" : task.status === "generating" ? "Provider request in progress" : task.status === "generated" ? task.provider || "Saved locally" : task.kind === "Video" && !task.shot.image ? "Needs an image first" : "Ready"; return <div className={`compact-task-row task-${task.status}`} role="listitem" key={task.key}><b>{task.kind}</b><i className={`task-status status-${task.status}`}>{task.status === "generating" && <span className="spinner"/>}{taskStatusLabel(task.status)}</i><span className="compact-task-detail" title={task.error || ""}>{detail}</span>{task.status === "failed" && <button className="ghost task-retry" onClick={task.retry} disabled={task.disabled}>Retry</button>}</div>; })}</div>
  </section>;
}

function Captions({ script, shots, updateShot, translateAll, audioName, audioData, transcription, denoiseNarration, setDenoiseNarration, bgm, selectBgm, bgmVolume, setBgmVolume }: any) {
  const bgmPreviewRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (bgmPreviewRef.current) bgmPreviewRef.current.volume = Math.max(0, Math.min(.2, bgmVolume / 100));
  }, [bgm, bgmVolume]);
  return <div className="panel"><div className="section-head"><div><span className="eyebrow">SOUND & LANGUAGE</span><h1>Audio and captions</h1><p>Edit English and Chinese lines while subtitle appearance is controlled from Storyboard.</p></div><button className="primary" onClick={translateAll}>Translate all lines</button></div>
    <div className="audio-grid"><div className="audio-card"><h3>Narration</h3><div className="narration-source"><b>{audioName || "No spoken audio attached"}</b><span>{script.trim() ? `${script.trim().split(/\s+/).length} script words reused from Episode` : "Add the narration script in Episode"}</span>{transcription && <small>Local timing ready · {transcription.segments.length} segments</small>}{audioData && <audio controls preload="metadata" src={audioData}/>}</div>
      <label className="denoise-option"><input type="checkbox" checked={denoiseNarration} onChange={(event) => setDenoiseNarration(event.target.checked)}/><span><b>De-noise narration</b><small>Apply light local background-noise reduction during export.</small></span></label><h3>Background music</h3><p className="helper-copy">Choose a built-in track. It will be looped and trimmed beneath narration.</p><div className="bgm-options">{BGM_TRACKS.map((track) => <button type="button" key={track.id} className={bgm === track.path ? "chosen" : ""} onClick={() => selectBgm(track.path)}><b>{track.label}</b><span>{track.artist}</span></button>)}</div>{bgm && <><label className="bgm-volume"><span><b>Music volume</b><output>{bgmVolume}%</output></span><input type="range" min="0" max="20" step="1" value={bgmVolume} onChange={(event) => setBgmVolume(Number(event.target.value))}/></label><audio className="bgm-preview" controls preload="metadata" src={bgm} ref={bgmPreviewRef} onVolumeChange={(event) => { const ceiling = Math.max(0, Math.min(.2, bgmVolume / 100)); if (event.currentTarget.volume > ceiling) event.currentTarget.volume = ceiling; }}/></>}</div>
      <div className="caption-list">{shots.length ? shots.map((shot: Shot) => <div className="caption-row" key={shot.id}><span>{formatTime(shot.start)}</span><div><textarea value={shot.narration} aria-label={`English caption ${shot.index + 1}`} onChange={(e)=>updateShot(shot.id,{narration:e.target.value})}/><textarea className="chinese" value={shot.chinese} aria-label={`Chinese caption ${shot.index + 1}`} onChange={(e)=>updateShot(shot.id,{chinese:e.target.value})}/></div><i>{shot.duration.toFixed(1)}s</i></div>) : <div className="empty-state small"><h2>No captions yet</h2><p>AI-generated bilingual lines appear after script analysis.</p></div>}</div></div></div>;
}

function ExportPanel({ title, productionMode, shots, approved, duration, audioName, bgm, build, previewUrl, downloadUrl, downloadResolution, setDownloadResolution, screenRatio, busy }: any) {
  const longScenes = productionMode === "long-scenes";
  const coverage = visualCoverage(shots);
  const ready = Boolean(coverage.complete && audioName);
  const selected = videoResolution(downloadResolution, screenRatio);
  const videoUrl = previewUrl || downloadUrl;
  const hasEnglish = shots.some((shot:Shot) => shot.narration.trim());
  const hasChinese = shots.some((shot:Shot) => shot.chinese.trim());
  const previewRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = previewRef.current;
    if (!videoUrl || !video) return;
    video.currentTime = 0;
    video.muted = false;
    void video.play().catch(() => {
      video.muted = true;
      void video.play().catch(() => {});
    });
  }, [videoUrl]);
  return <div className="panel export-panel"><div className="section-head export-head"><div><span className="eyebrow">FINAL ASSEMBLY</span><h1>Build &amp; Preview</h1><p>Uses the global screen ratio selected in Storyboard. Choose a resolution, build once, then preview or download that exact video.</p></div><label className="output-select"><span>Resolution</span><select value={downloadResolution} onChange={(event)=>setDownloadResolution(event.target.value)}>{Object.entries(VIDEO_RESOLUTIONS).map(([value, preset]) => { const dimensions = videoResolution(value, screenRatio); return <option key={value} value={value}>{preset.label} · {dimensions.width} × {dimensions.height}</option>; })}</select></label></div><div className="export-grid">
    <div className="preview-card"><div className="preview-card-head"><div><span className="eyebrow">CURRENT VIDEO</span><h2>Review the final cut</h2></div><span>{selected.width} × {selected.height} · {screenRatio}</span></div><div className="build-video-stage"><div className={`phone-frame ratio-${screenRatio.replace(':','-')}`}><div className="phone-canvas" style={{ aspectRatio:screenRatio.replace(':',' / ') }}>{videoUrl ? <video key={videoUrl} ref={previewRef} controls autoPlay playsInline src={videoUrl} aria-label={`${selected.label} video preview`}/> : <div className="empty-visual"><span>▶</span><b>Video not built</b></div>}</div></div></div><div className="build-actions"><button className="primary large" onClick={build} disabled={!!busy || !ready}>{busy || "Build"}</button>{videoUrl ? <a className="ghost large" href={videoUrl} download>Download</a> : <button className="ghost large" disabled>Download</button>}</div></div>
    <div className="export-side"><div className="export-card subtitle-export-card"><span className="eyebrow">YOUTUBE</span><h2>Add subtitles</h2><p>Reach a broader audience by adding subtitle files to your video. These SRT tracks use the timing from your reviewed captions.</p><div className="subtitle-downloads"><button className="ghost" type="button" disabled={!hasEnglish} onClick={() => downloadSubtitleFile(title, shots, "english")}><b>English</b><span>Download .srt</span></button><button className="ghost" type="button" disabled={!hasChinese} onClick={() => downloadSubtitleFile(title, shots, "chinese")}><b>简体中文</b><span>Download .srt</span></button><button className="ghost" type="button" disabled={!hasEnglish && !hasChinese} onClick={() => downloadSubtitleFile(title, shots, "bilingual")}><b>Bilingual</b><span>Download .srt</span></button></div><small>For selectable YouTube captions, upload English and Chinese as separate language tracks. Use Bilingual to show both together.</small></div><div className="export-card feature"><span className="eyebrow">OUTPUT</span><h2>Current build settings</h2><div className="specs"><span><b>{selected.width} × {selected.height}</b>Resolution</span><span><b>{screenRatio}</b>Storyboard ratio</span><span><b>{formatTime(duration)}</b>Duration</span><span><b>H.264</b>MP4 · 30 fps</span></div><p className="output-note">Change the screen ratio in Storyboard. Changing the resolution here clears the current build so preview and download stay in sync.</p></div><div className="checklist"><h3>Preflight</h3><div className={shots.length?'ok':'warn'}>{longScenes ? "Scene plan" : "Storyboard"} <b>{shots.length} {longScenes ? "scenes" : "shots"}</b></div><div className={coverage.complete?'ok':'warn'}>Visual coverage <b>{coverage.ready}/{coverage.total} ready</b></div><div className="optional">Images <b>{shots.filter((s:Shot)=>s.image).length}/{shots.length}</b></div><div className="optional">{productionMode === "mixed" ? "Selected videos" : longScenes ? "Long clips" : "Animated clips"} <b>{productionMode === "mixed" ? `${shots.filter((s:Shot)=>s.video).length}/${shots.filter((s:Shot)=>s.videoRecommended).length} recommended` : `${shots.filter((s:Shot)=>s.video).length}/${shots.length}`}</b></div><div className={audioName?'ok':'warn'}>Narration <b>{audioName || 'Required'}</b></div><div className={shots.length && shots.every((s:Shot)=>s.chinese)?'ok':'warn'}>Bilingual captions <b>{approved}/{shots.length} reviewed</b></div><div className="ok">Background music <b>{bgm}</b></div><small>Each segment needs either an image or a video. When both exist, the generated video is used.</small></div></div>
  </div></div>;
}

function Settings({ provider, setProvider, status, refreshStatus, close }: any) {
  const set = (patch:any) => setProvider((current:ProviderSettings)=>({...current,...patch}));
  const isPlanEndpoint = (endpoint:string) => endpoint.includes("/api/plan/v3");
  const imageProviderChoice = provider.kind === "volcengine" && isPlanEndpoint(provider.endpoint) ? "volcengine-plan" : provider.kind;
  const textProviderChoice = provider.textKind === "volcengine" && isPlanEndpoint(provider.textEndpoint) ? "volcengine-plan" : provider.textKind;
  const videoProviderChoice = isPlanEndpoint(provider.videoEndpoint) ? "plan" : "api";
  const chooseImageProvider = (choice:string) => set(choice === "volcengine-plan" ? { kind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/plan/v3", model:"doubao-seedream-5.0-lite", apiKey:"" } : choice === "volcengine" ? { kind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/v3/images/generations", model:"doubao-seedream-5-0-260128", apiKey:"" } : choice === "sdwebui" ? { kind:choice, endpoint:"http://127.0.0.1:7860", model:"Local checkpoint", apiKey:"" } : { kind:choice, endpoint:"https://api.openai.com/v1/images/generations", model:"gpt-image-1", apiKey:"" });
  const chooseVideoProvider = (choice:string) => set(choice === "plan" ? { videoEndpoint:"https://ark.cn-beijing.volces.com/api/plan/v3", videoModel:"doubao-seedance-2.0", videoApiKey:"" } : { videoEndpoint:"https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", videoModel:"doubao-seedance-2-0-260128", videoApiKey:"" });
  const chooseTextProvider = (choice:string) => set(choice === "volcengine-plan" ? { textKind:"volcengine", textEndpoint:"https://ark.cn-beijing.volces.com/api/plan/v3", textModel:"ark-code-latest", textApiKey:"" } : choice === "volcengine" ? { textKind:"volcengine", textEndpoint:"https://ark.cn-beijing.volces.com/api/v3/chat/completions", textModel:"doubao-seed-2-1-turbo-260628", textApiKey:"" } : { textKind:"openai", textEndpoint:"https://api.openai.com/v1/chat/completions", textModel:"gpt-4.1-mini", textApiKey:"" });
  const [testing, setTesting] = useState("");
  const [testResult, setTestResult] = useState("");
  async function testConnection(target:string) {
    setTesting(target); setTestResult("");
    try {
      const endpoint = target === "text" ? provider.textEndpoint : target === "video" ? provider.videoEndpoint : provider.endpoint;
      const model = target === "text" ? provider.textModel : target === "video" ? provider.videoModel : provider.model;
      const apiKey = target === "text" ? provider.textApiKey : target === "video" ? provider.videoApiKey : provider.apiKey;
      const response = await fetch(`${SERVICE}/providers/test`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ target, ...provider, endpoint, model, apiKey }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Connection failed");
      setTestResult(`${target === "image" ? "Image" : target === "video" ? "Video" : "Translation"} provider connected.`); await refreshStatus();
    } catch (error) { setTestResult(error instanceof Error ? error.message : "Connection failed"); }
    finally { setTesting(""); }
  }
  return <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)close();}}><div className="modal"><div className="modal-head"><div><span className="eyebrow">LOCAL CONFIGURATION</span><h2>AI providers</h2></div><button onClick={close} aria-label="Close settings">×</button></div><p>For durable setup, add keys to <code>.env.local</code> and restart the app. Fields below are optional session-only overrides.</p>
    <div className={`provider-status ${status.image.configured ? "connected" : ""}`}><span>{status.image.configured ? "●" : "○"}</span><div><b>Image generation</b><small>{status.image.configured ? `${status.image.model} · key loaded from .env.local` : "No environment key loaded"}</small></div></div>
    <label className="field"><span>Image provider</span><select value={imageProviderChoice} onChange={(e)=>chooseImageProvider(e.target.value)}><option value="openai">OpenAI-compatible images API</option><option value="volcengine">Volcengine Ark · Seedream · pay as you go</option><option value="volcengine-plan">Volcengine Agent Plan · Seedream</option><option value="sdwebui">Local Stable Diffusion WebUI</option></select></label><label className="field"><span>Endpoint or API base URL</span><input value={provider.endpoint} onChange={(e)=>set({endpoint:e.target.value})}/></label><div className="two-fields"><label className="field"><span>Model</span><input value={provider.model} placeholder={provider.kind === "volcengine" ? "Ark Seedream model name or ID" : "Model ID"} onChange={(e)=>set({model:e.target.value})}/></label><label className="field"><span>Session API key</span><input type="password" value={provider.apiKey} placeholder={status.image.configured ? "Loaded securely from .env.local" : "Optional session override"} onChange={(e)=>set({apiKey:e.target.value})}/></label></div><label className="field"><span>Parallel image jobs</span><input type="number" min="1" max="6" step="1" value={provider.imageConcurrency} onChange={(e)=>set({imageConcurrency:Math.max(1,Math.min(6,Number(e.target.value)||1))})}/><small>3 is recommended. Lower this if your provider reports rate limits.</small></label><button className="ghost test-button" onClick={()=>testConnection("image")} disabled={!!testing}>{testing === "image" ? "Testing…" : "Test image provider"}</button>
    <hr/><div className={`provider-status ${status.video?.configured ? "connected" : ""}`}><span>{status.video?.configured ? "●" : "○"}</span><div><b>Video generation · Volcengine Ark</b><small>{status.video?.configured ? `${status.video.model} · key loaded from .env.local` : "Required to turn storyboard images into video clips"}</small></div></div><label className="field"><span>Volcengine video access</span><select value={videoProviderChoice} onChange={(e)=>chooseVideoProvider(e.target.value)}><option value="api">Pay-as-you-go API</option><option value="plan">Agent Plan subscription</option></select></label><label className="field"><span>Video task endpoint or API base URL</span><input value={provider.videoEndpoint} onChange={(e)=>set({videoEndpoint:e.target.value})}/></label><div className="two-fields"><label className="field"><span>Seedance model / endpoint ID</span><input value={provider.videoModel} placeholder={videoProviderChoice === "plan" ? "doubao-seedance-2.0" : "doubao-seedance-2-0-260128"} onChange={(e)=>set({videoModel:e.target.value})}/></label><label className="field"><span>Session API key</span><input type="password" value={provider.videoApiKey} placeholder={status.video?.configured ? "Loaded securely from .env.local" : "Optional session override"} onChange={(e)=>set({videoApiKey:e.target.value})}/></label></div><label className="field"><span>Parallel video jobs</span><input type="number" min="1" max="4" step="1" value={provider.videoConcurrency} onChange={(e)=>set({videoConcurrency:Math.max(1,Math.min(4,Number(e.target.value)||1))})}/><small>2 is recommended. Ark video generation is asynchronous and may take several minutes per clip.</small></label><button className="ghost test-button" onClick={()=>testConnection("video")} disabled={!!testing}>{testing === "video" ? "Testing…" : "Test video provider"}</button>
    <hr/><div className="provider-status connected"><span>●</span><div><b>Local speech-to-text</b><small>Audio is sent only to the configured local service.</small></div></div><label className="field"><span>Transcription service URL</span><input value={provider.transcriptionEndpoint} placeholder="http://localhost:8000/v1/transcriptions" onChange={(e)=>set({transcriptionEndpoint:e.target.value})}/></label><label className="field"><span>Audio language</span><input value={provider.transcriptionLanguage} placeholder="en" onChange={(e)=>set({transcriptionLanguage:e.target.value})}/></label>
    <hr/><div className={`provider-status ${status.text.configured ? "connected" : ""}`}><span>{status.text.configured ? "●" : "○"}</span><div><b>Storyboard and translation provider</b><small>{status.text.configured ? `${status.text.model} · key loaded from .env.local` : "Required for AI planning and translation"}</small></div></div><label className="field"><span>Text provider</span><select value={textProviderChoice} onChange={(e)=>chooseTextProvider(e.target.value)}><option value="openai">OpenAI-compatible chat API</option><option value="volcengine">Volcengine Ark · Doubao · pay as you go</option><option value="volcengine-plan">Volcengine Agent Plan · OpenAI-compatible chat</option></select></label><label className="field"><span>Chat endpoint or API base URL</span><input value={provider.textEndpoint} onChange={(e)=>set({textEndpoint:e.target.value})}/></label><div className="two-fields"><label className="field"><span>Model / endpoint ID</span><input value={provider.textModel} placeholder={textProviderChoice === "volcengine-plan" ? "ark-code-latest" : provider.textKind === "volcengine" ? "Enter an activated Ark model or ep-… ID" : "Model ID"} onChange={(e)=>set({textModel:e.target.value})}/></label><label className="field"><span>Session API key</span><input type="password" value={provider.textApiKey} placeholder={status.text.configured ? "Loaded securely from .env.local" : "Optional session override"} onChange={(e)=>set({textApiKey:e.target.value})}/></label></div><button className="ghost test-button" onClick={()=>testConnection("text")} disabled={!!testing}>{testing === "text" ? "Testing…" : "Test storyboard provider"}</button>{testResult&&<div className="connection-result" role="status">{testResult}</div>}<button className="primary full" onClick={close}>Save session settings</button></div></div>;
}
