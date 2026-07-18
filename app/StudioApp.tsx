"use client";
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect, react-hooks/exhaustive-deps, @next/next/no-img-element */

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { canStartConcurrentJob, mapWithConcurrency } from "./lib/concurrency";
import { clearProjectCache, normalizeCachedProject, readProjectCache, writeProjectCache } from "./lib/project-cache";
import { formatTime } from "./lib/timeline";
import { VIDEO_RESOLUTIONS, videoResolution } from "./lib/video";

type Shot = {
  id: string; index: number; start: number; end: number; duration: number;
  type: string; narration: string; chinese: string; prompt: string; videoPrompt: string; status: string;
  locked: boolean; image: string; variants: string[]; provider: string; seed: string; motion: string;
  video: string; videoStatus: string; videoProvider: string;
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

export default function StudioApp() {
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
  const [mode, setMode] = useState("Review then batch");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("Ready");
  const [previewUrl, setPreviewUrl] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadResolution, setDownloadResolution] = useState("1080");
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
  const activeManualVideoIds = useRef(new Set<string>());
  const [activeManualVideoCount, setActiveManualVideoCount] = useState(0);

  function projectSnapshot(overrides:Record<string, unknown> = {}) {
    return { stage, title, script, contentFormat, visualStyle, creativeDirection, shots, selectedId, audioName, audioData, audioDuration, transcription, denoiseNarration, bgm, bgmVolume, mode, previewUrl, downloadUrl, downloadResolution, ...overrides };
  }

  function persistProject(snapshot = projectSnapshot()) {
    const epoch = cacheEpoch.current;
    try {
      const safeShots = (snapshot.shots as Shot[] || []).map((shot) => ({ ...shot, image:"", variants:[], video:"", videoStatus:"idle", status:shot.status === "generated" ? "planned" : shot.status }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...snapshot, audioData:"", previewUrl:"", downloadUrl:"", shots:safeShots }));
    } catch { /* IndexedDB remains the primary local cache */ }
    void writeProjectCache(snapshot).then(() => { if (epoch !== cacheEpoch.current) void clearProjectCache().catch(() => {}); }).catch(() => { /* lightweight localStorage fallback is already saved */ });
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
        allowSave.current = true;
        setTitle(parsed.title || ""); setScript(parsed.script || "");
        setContentFormat(parsed.contentFormat || contentFormat); setVisualStyle(parsed.visualStyle || visualStyle);
        setCreativeDirection(parsed.creativeDirection || ""); setShots(parsed.shots || []); setSelectedId(parsed.selectedId || parsed.shots?.[0]?.id || "");
        setAudioName(parsed.audioData ? (parsed.audioName || "") : ""); setAudioData(parsed.audioData || ""); setAudioDuration(Number(parsed.audioDuration) || 0); setTranscription(parsed.transcription || null);
        const savedBgmVolume = Number(parsed.bgmVolume);
        setBgm(BGM_TRACKS.some((track) => track.path === parsed.bgm) ? parsed.bgm : ""); setBgmVolume(Number.isFinite(savedBgmVolume) ? Math.max(0, Math.min(20, savedBgmVolume)) : 8); setMode(parsed.mode || mode); setDenoiseNarration(parsed.denoiseNarration ?? parsed.voicePresetId !== "original");
        setPreviewUrl(parsed.previewUrl || ""); setDownloadUrl(parsed.downloadUrl || ""); setDownloadResolution(String(parsed.downloadResolution || "1080"));
        setStage(["episode","storyboard","captions","export"].includes(parsed.stage) ? parsed.stage : (parsed.shots?.length ? "storyboard" : "episode"));
        setMessage(`Recovered locally saved episode · ${parsed.shots?.length || 0} shots.`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!initialized.current || !allowSave.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persistProject(), 250);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [stage, title, script, contentFormat, visualStyle, creativeDirection, shots, selectedId, audioName, audioData, audioDuration, transcription, denoiseNarration, bgm, bgmVolume, mode, previewUrl, downloadUrl, downloadResolution]);

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

  function newEpisode() {
    cacheEpoch.current += 1;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    localStorage.removeItem("chronicle-studio-project"); localStorage.removeItem("chronicle-studio-project-v2"); localStorage.removeItem("chronicle-studio-project-v3"); localStorage.removeItem(STORAGE_KEY);
    void clearProjectCache().catch(() => {});
    allowSave.current = false; setTitle(""); setScript(""); setContentFormat("Documentary"); setVisualStyle("Photorealistic"); setCreativeDirection(""); setShots([]); setSelectedId("");
    setAudioName(""); setAudioData(""); setAudioDuration(0); setDenoiseNarration(true); setTranscription(null); setBgm(""); setBgmVolume(8); setPreviewUrl(""); setDownloadUrl("");
    setMode("Review then batch"); setStage("episode"); setMessage("New empty episode created.");
  }

  async function analyze() {
    touchProject();
    if (!script.trim()) { setMessage("Add the episode script before planning shots."); return; }
    if (audioName && !transcription) { setMessage("Wait for local transcription to finish before planning shots. Its word timestamps are the master timeline."); return; }
    if (!provider.textApiKey && !providerStatus.text.configured) { setMessage("Configure a text AI provider before analyzing the script."); setSettingsOpen(true); return; }
    setBusy("AI is planning the episode");
    try {
      const response = await fetch(`${SERVICE}/text/plan`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ textKind:provider.textKind, endpoint:provider.textEndpoint, model:provider.textModel, apiKey:provider.textApiKey, script, contentFormat, visualStyle, creativeDirection, audioDuration, transcription }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Planning failed");
      const planned:Shot[] = data.shots.map((shot:Partial<Shot>, index:number) => ({ ...shot, id:`shot-${Date.now()}-${index}`, index, status:"planned", locked:false, image:"", variants:[], provider:"", seed:"", video:"", videoStatus:"idle", videoProvider:"" })) as Shot[];
      persistProject(projectSnapshot({ shots:planned, selectedId:planned[0]?.id || "", stage:"storyboard", previewUrl:"", downloadUrl:"" }));
      setPreviewUrl(""); setDownloadUrl("");
      setShots(planned); setSelectedId(planned[0]?.id || ""); setStage("storyboard");
      setMessage(`${planned.length} production shots planned${audioDuration ? " and fitted to the narration duration" : ""}.`);
      if (mode === "Fully automatic") {
        if (provider.kind !== "sdwebui" && !provider.apiKey && !providerStatus.image.configured) {
          setMessage("Storyboard planned. Configure the image provider to continue automatic generation."); setSettingsOpen(true);
        } else await generatePlannedShots(planned);
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

  function imageProviderReady() {
    if (provider.kind === "sdwebui" || provider.apiKey || providerStatus.image.configured) return true;
    setMessage("Configure an image AI provider before generating shots."); setSettingsOpen(true); return false;
  }

  async function requestShotImage(shot: Shot) {
    updateShot(shot.id, { status:"generating" });
    try {
      const response = await fetch(`${SERVICE}/image/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...provider, prompt: shot.prompt }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Generation failed"); const image = data.image;
      updateShot(shot.id, { image, variants: [...shot.variants, image], status:"generated", provider:provider.model, video:"", videoStatus:"idle", videoProvider:"" });
      return { ok:true, shot };
    } catch (error) {
      updateShot(shot.id, { status:"planned" });
      return { ok:false, shot, error:error instanceof Error ? error.message : "Generation failed" };
    }
  }

  async function generateOne(shot: Shot) {
    if (shot.locked || busy || !imageProviderReady()) return;
    setBusy(`Generating shot ${shot.index + 1}`);
    try {
      const result = await requestShotImage(shot);
      setMessage(result.ok ? `Shot ${shot.index + 1} generated.` : result.error || "Generation failed");
    } finally { setBusy(""); }
  }

  async function generateBatch(source: Shot[], successMessage: string) {
    if (!imageProviderReady()) return;
    const pending = source.filter((shot) => !shot.locked && !shot.image && shot.status !== "generating");
    if (!pending.length) { setMessage("No unlocked shots are waiting for image generation."); return; }
    touchProject();
    const concurrency = Math.max(1, Math.min(6, Math.floor(provider.imageConcurrency) || 3));
    const workerCount = Math.min(concurrency, pending.length);
    const failures: string[] = [];
    setBusy(`Generating images · 0/${pending.length} · ${workerCount} parallel`);
    try {
      await mapWithConcurrency(pending, concurrency, async (shot:Shot) => {
        const result = await requestShotImage(shot);
        if (!result.ok) failures.push(`Shot ${shot.index + 1}: ${result.error}`);
        return result;
      }, ({ completed }: { completed:number }) => setBusy(`Generating images · ${completed}/${pending.length} · ${workerCount} parallel`));
      const completed = pending.length - failures.length;
      setMessage(failures.length ? `${completed}/${pending.length} images generated. ${failures.length} failed and can be retried.` : successMessage);
    } finally { setBusy(""); }
  }

  async function generateAll() {
    await generateBatch(shots, "All unlocked shots are ready for review.");
  }

  async function generatePlannedShots(planned:Shot[]) {
    await generateBatch(planned, "AI planning and image generation completed.");
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
    if (!shot.image) return { ok:false, shot, error:"Generate the storyboard image first" };
    updateShot(shot.id, { videoStatus:"generating" });
    try {
      const response = await fetch(`${SERVICE}/video/generate`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ videoKind:provider.videoKind, endpoint:provider.videoEndpoint, model:provider.videoModel, apiKey:provider.videoApiKey, videoPrompt:shot.videoPrompt, image:shot.image, motion:shot.motion, duration:shot.duration }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Video generation failed");
      updateShot(shot.id, { video:data.video, videoStatus:"generated", videoProvider:provider.videoModel });
      return { ok:true, shot };
    } catch (error) {
      updateShot(shot.id, { videoStatus:"idle" });
      return { ok:false, shot, error:error instanceof Error ? error.message : "Video generation failed" };
    }
  }

  async function generateOneVideo(shot:Shot) {
    if (shot.locked || shot.videoStatus === "generating") return;
    if (!shot.image) { setMessage(`Generate the image for shot ${shot.index + 1} before animating it.`); return; }
    if (busy) return;
    if (!await videoProviderReady()) return;
    const concurrency = Math.max(1, Math.min(4, Math.floor(provider.videoConcurrency) || 2));
    if (!canStartConcurrentJob(activeManualVideoIds.current, shot.id, concurrency)) {
      setMessage(activeManualVideoIds.current.has(shot.id) ? `Shot ${shot.index + 1} is already animating.` : `All ${concurrency} parallel video slots are currently in use.`);
      return;
    }
    activeManualVideoIds.current.add(shot.id);
    setActiveManualVideoCount(activeManualVideoIds.current.size);
    setMessage(`Animating shot ${shot.index + 1} with Volcengine · ${activeManualVideoIds.current.size}/${concurrency} slots active.`);
    try {
      const result = await requestShotVideo(shot);
      setMessage(result.ok ? `Shot ${shot.index + 1} video clip generated and cached locally.` : result.error || "Video generation failed");
    } finally {
      activeManualVideoIds.current.delete(shot.id);
      const remaining = activeManualVideoIds.current.size;
      setActiveManualVideoCount(remaining);
    }
  }

  async function generateAllVideos() {
    if (!await videoProviderReady()) return;
    const pending = shots.filter((shot) => !shot.locked && shot.image && !shot.video && shot.videoStatus !== "generating");
    if (!pending.length) { setMessage("No unlocked storyboard images are waiting for animation."); return; }
    touchProject();
    const concurrency = Math.max(1, Math.min(4, Math.floor(provider.videoConcurrency) || 2));
    const failures:string[] = [];
    setBusy(`Animating clips · 0/${pending.length} · Volcengine may take several minutes`);
    try {
      await mapWithConcurrency(pending, concurrency, async (shot:Shot) => {
        const result = await requestShotVideo(shot);
        if (!result.ok) failures.push(`Shot ${shot.index + 1}: ${result.error}`);
        return result;
      }, ({ completed }:{ completed:number }) => setBusy(`Animating clips · ${completed}/${pending.length} · ${Math.min(concurrency, pending.length)} parallel`));
      const completed = pending.length - failures.length;
      setMessage(failures.length ? `${completed}/${pending.length} clips generated. ${failures.length} failed and can be retried.` : "All unlocked shots now have locally cached video clips.");
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

  async function renderVideo(target:"preview" | "download", resolution:string) {
    if (!audioData) { setMessage("Upload the recorded narration before building the video."); setStage("episode"); return; }
    if (!shots.length) { setMessage("Analyze the script before building the video."); setStage("episode"); return; }
    if (shots.some((shot) => !shot.image && !shot.video)) { setMessage("Generate a visual asset for every storyboard shot before building the video."); setStage("storyboard"); return; }
    const preset = videoResolution(resolution);
    if (target === "preview") setPreviewUrl(""); else setDownloadUrl("");
    setBusy(`Rendering ${preset.label} ${target}`);
    try {
      const response = await fetch(`${SERVICE}/render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, shots, narrationData: audioData, voicePreset:denoiseNarration ? "denoise" : "original", bgmPath:bgm, bgmVolume:bgmVolume / 100, width:preset.width, height:preset.height }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Render failed");
      const url = `${SERVICE}${data.url}`;
      if (target === "preview") setPreviewUrl(url); else setDownloadUrl(url);
      setMessage(`${preset.label} ${target} ready in ${data.seconds.toFixed(1)} seconds.`);
    } catch (error) { setMessage(error instanceof Error ? `${error.message}. Start the local render service with “npm run render-service”.` : "Render failed"); }
    finally { setBusy(""); }
  }

  async function prepareDownload() {
    if (downloadResolution === "720" && previewUrl) {
      setDownloadUrl(previewUrl); setMessage("The 720p preview is ready to download."); return;
    }
    await renderVideo("download", downloadResolution);
  }

  const manualVideoLimit = Math.max(1, Math.min(4, Math.floor(provider.videoConcurrency) || 2));
  const activityLabel = busy || (activeManualVideoCount ? `Animating clips · ${activeManualVideoCount}/${manualVideoLimit} manual jobs active` : "");

  return (
    <main className="studio-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">S</div><div><strong>Shortform</strong><span>STUDIO</span></div></div>
        <nav aria-label="Production stages">
          {[['episode','01','Episode'],['storyboard','02','Storyboard'],['captions','03','Audio & captions'],['export','04','Build & Preview']].map(([id, n, label]) => (
            <button key={id} onClick={() => setStage(id)} className={stage === id ? "nav-active" : ""}><span>{n}</span>{label}</button>
          ))}
        </nav>
        <div className="sidebar-foot"><span className="local-dot"/>Local workspace<div>Nothing leaves this device until a provider is called.</div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><span className="eyebrow">CURRENT EPISODE</span><input className="title-input" value={title} placeholder="Untitled episode" onChange={(e) => { touchProject(); setTitle(e.target.value); }} aria-label="Episode title" /></div>
          <div className="top-actions"><span className="save-state">● Saved locally</span><button className="ghost" onClick={newEpisode}>New episode</button><button className="ghost" onClick={() => setSettingsOpen(true)}>Provider settings</button><button className="primary" onClick={() => setStage("export")} disabled={!!busy}>Build & Preview</button></div>
        </header>

        {stage === "episode" && <EpisodePanel script={script} setScript={setScript} contentFormat={contentFormat} setContentFormat={setContentFormat} visualStyle={visualStyle} setVisualStyle={setVisualStyle} creativeDirection={creativeDirection} setCreativeDirection={setCreativeDirection} mode={mode} setMode={setMode} touchProject={touchProject} audioName={audioName} transcription={transcription} handleAudio={handleAudio} analyze={analyze} busy={busy} />}
        {stage === "storyboard" && <Storyboard shots={shots} selected={selected} setSelectedId={setSelectedId} updateShot={updateShot} generateOne={generateOne} generateAll={generateAll} generateOneVideo={generateOneVideo} generateAllVideos={generateAllVideos} totalDuration={totalDuration} busy={busy} activeManualVideoCount={activeManualVideoCount} videoConcurrency={provider.videoConcurrency} />}
        {stage === "captions" && <Captions script={script} shots={shots} updateShot={updateShot} translateAll={translateAll} audioName={audioName} audioData={audioData} transcription={transcription} denoiseNarration={denoiseNarration} setDenoiseNarration={(checked:boolean)=>{ touchProject(); setDenoiseNarration(checked); setPreviewUrl(""); setDownloadUrl(""); }} bgm={bgm} selectBgm={selectBgm} bgmVolume={bgmVolume} setBgmVolume={(value:number)=>{ touchProject(); setBgmVolume(value); setPreviewUrl(""); setDownloadUrl(""); }} />}
        {stage === "export" && <ExportPanel shots={shots} approved={approved} duration={totalDuration} audioName={audioName} bgm={BGM_TRACKS.find((track) => track.path === bgm)?.label || "None"} buildPreview={() => renderVideo("preview", "720")} prepareDownload={prepareDownload} previewUrl={previewUrl} downloadUrl={downloadUrl} downloadResolution={downloadResolution} setDownloadResolution={(value:string) => { setDownloadResolution(value); setDownloadUrl(""); }} busy={busy} />}
      </section>

      <div className="statusbar"><span>{activityLabel ? <><i className="spinner"/>{activityLabel}</> : message}</span><span>{shots.length} shots · {shots.filter((shot)=>shot.video).length} clips · {formatTime(totalDuration)} · 9:16</span></div>
      {settingsOpen && <Settings provider={provider} setProvider={setProvider} status={providerStatus} refreshStatus={refreshProviderStatus} close={() => setSettingsOpen(false)} />}
    </main>
  );
}

function EpisodePanel({ script, setScript, contentFormat, setContentFormat, visualStyle, setVisualStyle, creativeDirection, setCreativeDirection, mode, setMode, touchProject, audioName, transcription, handleAudio, analyze, busy }: any) {
  return <div className="panel intake-panel"><div className="section-head"><div><span className="eyebrow">SOURCE MATERIAL</span><h1>Create an episode</h1><p>Add the finished script and recorded narration. AI will build the timed bilingual storyboard.</p></div><button className="primary large" onClick={analyze} disabled={!!busy}>{busy || "Analyze with AI"}</button></div>
    <div className="intake-grid"><label className="field span-2"><span>English script</span><textarea value={script} placeholder="Paste the exact English narration script here…" onChange={(e) => { touchProject(); setScript(e.target.value); }} rows={13}/><small>{script.trim() ? script.trim().split(/\s+/).length : 0} words</small></label>
      <div className="stack"><label className="field"><span>Content format</span><select value={contentFormat} onChange={(e) => { touchProject(); setContentFormat(e.target.value); }}><option>Documentary</option><option>Educational explainer</option><option>Narrative story</option><option>News recap</option><option>Product story</option><option>History documentary</option><option>Other</option></select></label><label className="field"><span>Visual style</span><select value={visualStyle} onChange={(e) => { touchProject(); setVisualStyle(e.target.value); }}><option>Photorealistic</option><option>Cinematic illustration</option><option>Editorial collage</option><option>3D animation</option><option>Anime</option><option>Minimal graphic</option></select></label><label className="field"><span>Creative direction</span><input value={creativeDirection} placeholder="Audience, mood, setting, visual constraints…" onChange={(e) => { touchProject(); setCreativeDirection(e.target.value); }}/></label><label className="field"><span>Generation mode</span><select value={mode} onChange={(e) => { touchProject(); setMode(e.target.value); }}><option>Plan only</option><option>Review then batch</option><option>Fully automatic</option></select></label>
        <label className="upload-card"><input type="file" accept="audio/*" onChange={handleAudio}/><b>{audioName ? "Narration attached" : "Add recorded narration"}</b><span>{audioName || "MP3, WAV, M4A or AAC · transcribed locally"}</span></label>{audioName && <div className={`transcript-note ${transcription ? "ready" : ""}`}><b>{transcription ? "Local transcript ready" : "Waiting for local transcript"}</b><span>{transcription ? `${transcription.segments.length} timed segments · ${formatTime(transcription.duration)}` : "Check the speech-to-text URL in Provider settings."}</span></div>}</div></div></div>;
}

function Storyboard({ shots, selected, setSelectedId, updateShot, generateOne, generateAll, generateOneVideo, generateAllVideos, totalDuration, busy, activeManualVideoCount, videoConcurrency }: any) {
  if (!shots.length) return <div className="panel storyboard-panel"><div className="section-head compact"><div><span className="eyebrow">VISUAL PLAN</span><h1>Storyboard</h1><p>Your production shots will appear here after AI analysis.</p></div></div><div className="empty-state"><span>01</span><h2>No storyboard yet</h2><p>Open Episode, add your script and narration, then run AI analysis.</p></div></div>;
  const manualVideoLimit = Math.max(1, Math.min(4, Math.floor(Number(videoConcurrency)) || 2));
  const manualVideoSlotFull = activeManualVideoCount >= manualVideoLimit;
  const otherWorkBusy = Boolean(busy);
  const batchActionsBusy = otherWorkBusy || activeManualVideoCount > 0;
  return <div className="panel storyboard-panel"><div className="section-head compact"><div><span className="eyebrow">VISUAL PLAN</span><h1>Storyboard</h1><p>{shots.length} shots aligned across {formatTime(totalDuration)} · {shots.filter((shot:Shot)=>shot.video).length} animated</p></div><div className="story-actions"><button className="ghost" onClick={generateAll} disabled={batchActionsBusy}>{batchActionsBusy ? "Working…" : "Generate images"}</button><button className="primary" onClick={generateAllVideos} disabled={batchActionsBusy}>{batchActionsBusy ? "Working…" : "Animate all shots"}</button></div></div>
    <div className="story-grid"><div className="shot-list">{shots.map((shot: Shot) => <button key={shot.id} className={`shot-row ${selected?.id === shot.id ? "selected" : ""}`} onClick={() => setSelectedId(shot.id)}>
      <div className="thumb">{shot.image ? <img src={shot.image} alt="Generated shot"/> : <span>{String(shot.index + 1).padStart(2,'0')}</span>}{shot.video && <i className="clip-badge">CLIP</i>}</div><div className="shot-summary"><div><span className={`tag type-${shot.type.toLowerCase()}`}>{shot.type}</span><span className="time">{formatTime(shot.start)}—{formatTime(shot.end)}</span></div><p>{shot.narration}</p><small>{shot.duration.toFixed(1)}s · {shot.motion}</small></div><span className={`state state-${shot.videoStatus === "generating" ? "generating" : shot.status}`}>{shot.locked ? "Locked" : shot.videoStatus === "generating" ? "animating" : shot.video ? "clip ready" : shot.status}</span></button>)}</div>
      {selected && <div className="inspector"><div className="phone-frame"><div className="phone-canvas">{selected.video ? <video src={selected.video} autoPlay loop muted playsInline aria-label="Generated shot video preview"/> : selected.image ? <img src={selected.image} alt="Selected shot preview"/> : <div className="empty-visual"><span>{String(selected.index + 1).padStart(2,'0')}</span><b>Awaiting image</b></div>}<div className="preview-captions"><b>{selected.narration}</b><span>{selected.chinese}</span></div></div></div>
        <div className="inspector-form"><div className="inspector-title"><div><span className="eyebrow">SHOT {String(selected.index + 1).padStart(2,'0')}</span><h2>{selected.type} visual</h2></div><button className={`lock ${selected.locked ? "locked" : ""}`} onClick={() => updateShot(selected.id,{locked:!selected.locked})}>{selected.locked ? "Locked" : "Lock"}</button></div>
          <label className="field"><span>Image prompt</span><textarea rows={7} value={selected.prompt} onChange={(e) => updateShot(selected.id,{prompt:e.target.value,status:'planned',video:'',videoStatus:'idle',videoProvider:''})}/></label>
          <label className="field"><span>Video prompt</span><textarea rows={5} value={selected.videoPrompt || ""} onChange={(e) => updateShot(selected.id,{videoPrompt:e.target.value,video:'',videoStatus:'idle',videoProvider:''})}/><small>Created during AI analysis; describes subject action, environmental movement, and continuity from the generated first frame.</small></label>
          <div className="three-fields"><label className="field"><span>Duration</span><input type="number" min="0.6" max="8" step="0.1" value={selected.duration} onChange={(e) => updateShot(selected.id,{duration:Number(e.target.value)})}/></label><label className="field"><span>Motion</span><select value={selected.motion} onChange={(e) => updateShot(selected.id,{motion:e.target.value,video:'',videoStatus:'idle',videoProvider:''})}><option>Slow push-in</option><option>Slow drift</option><option>Static</option></select></label><label className="field"><span>Status</span><select value={selected.status} onChange={(e) => updateShot(selected.id,{status:e.target.value})}><option>planned</option><option>approved</option><option>generated</option></select></label></div>
          <div className="shot-generation-actions"><button className="ghost full" onClick={() => generateOne(selected)} disabled={selected.locked || !!busy || selected.videoStatus === "generating"}>{selected.image ? "Create another image" : "Generate image"}</button><button className="primary full" onClick={() => generateOneVideo(selected)} disabled={selected.locked || !selected.image || selected.videoStatus === "generating" || otherWorkBusy || manualVideoSlotFull}>{selected.videoStatus === "generating" ? "Animating…" : selected.video ? "Regenerate Volcengine clip" : "Animate with Volcengine"}</button></div></div></div>}
    </div></div>;
}

function Captions({ script, shots, updateShot, translateAll, audioName, audioData, transcription, denoiseNarration, setDenoiseNarration, bgm, selectBgm, bgmVolume, setBgmVolume }: any) {
  const bgmPreviewRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (bgmPreviewRef.current) bgmPreviewRef.current.volume = Math.max(0, Math.min(.2, bgmVolume / 100));
  }, [bgm, bgmVolume]);
  return <div className="panel"><div className="section-head"><div><span className="eyebrow">SOUND & LANGUAGE</span><h1>Audio and captions</h1><p>English narration with editable Chinese subtitle drafts.</p></div><button className="primary" onClick={translateAll}>Translate all lines</button></div>
    <div className="audio-grid"><div className="audio-card"><h3>Narration</h3><div className="narration-source"><b>{audioName || "No spoken audio attached"}</b><span>{script.trim() ? `${script.trim().split(/\s+/).length} script words reused from Episode` : "Add the narration script in Episode"}</span>{transcription && <small>Local timing ready · {transcription.segments.length} segments</small>}{audioData && <audio controls preload="metadata" src={audioData}/>}</div>
      <label className="denoise-option"><input type="checkbox" checked={denoiseNarration} onChange={(event) => setDenoiseNarration(event.target.checked)}/><span><b>De-noise narration</b><small>Apply light local background-noise reduction during export.</small></span></label><h3>Background music</h3><p className="helper-copy">Choose a built-in track. It will be looped and trimmed beneath narration.</p><div className="bgm-options">{BGM_TRACKS.map((track) => <button type="button" key={track.id} className={bgm === track.path ? "chosen" : ""} onClick={() => selectBgm(track.path)}><b>{track.label}</b><span>{track.artist}</span></button>)}</div>{bgm && <><label className="bgm-volume"><span><b>Music volume</b><output>{bgmVolume}%</output></span><input type="range" min="0" max="20" step="1" value={bgmVolume} onChange={(event) => setBgmVolume(Number(event.target.value))}/></label><audio className="bgm-preview" controls preload="metadata" src={bgm} ref={bgmPreviewRef} onVolumeChange={(event) => { const ceiling = Math.max(0, Math.min(.2, bgmVolume / 100)); if (event.currentTarget.volume > ceiling) event.currentTarget.volume = ceiling; }}/></>}</div>
      <div className="caption-list">{shots.length ? shots.map((shot: Shot) => <div className="caption-row" key={shot.id}><span>{formatTime(shot.start)}</span><div><textarea value={shot.narration} onChange={(e)=>updateShot(shot.id,{narration:e.target.value})}/><textarea className="chinese" value={shot.chinese} onChange={(e)=>updateShot(shot.id,{chinese:e.target.value})}/></div><i>{shot.duration.toFixed(1)}s</i></div>) : <div className="empty-state small"><h2>No captions yet</h2><p>AI-generated bilingual lines appear after script analysis.</p></div>}</div></div></div>;
}

function ExportPanel({ shots, approved, duration, audioName, bgm, buildPreview, prepareDownload, previewUrl, downloadUrl, downloadResolution, setDownloadResolution, busy }: any) {
  const ready = Boolean(shots.length && audioName && shots.every((shot:Shot) => shot.image || shot.video));
  const selected = videoResolution(downloadResolution);
  return <div className="panel export-panel"><div className="section-head"><div><span className="eyebrow">FINAL ASSEMBLY</span><h1>Build &amp; Preview</h1><p>Build a 720p review copy, inspect the finished video, then choose the download resolution.</p></div></div><div className="export-grid">
    <div className="preview-card"><div className="preview-card-head"><div><span className="eyebrow">720P PREVIEW</span><h2>Review the final cut</h2></div><span>720 × 1280</span></div><div className={`video-preview ${previewUrl ? "ready" : ""}`}>{previewUrl ? <video controls playsInline src={previewUrl} aria-label="720p video preview"/> : <div><b>Preview not built</b><span>Check timing, subtitles, framing, motion, narration, and BGM before downloading.</span></div>}</div><button className="primary large full" onClick={buildPreview} disabled={!!busy || !ready}>{busy || (previewUrl ? "Rebuild 720p preview" : "Build 720p preview")}</button></div>
    <div className="export-side"><div className="export-card feature"><span className="eyebrow">DOWNLOAD</span><h2>Choose output quality</h2><label className="field"><span>Resolution</span><select value={downloadResolution} onChange={(event)=>setDownloadResolution(event.target.value)}>{Object.entries(VIDEO_RESOLUTIONS).map(([value, preset]) => <option key={value} value={value}>{preset.label} · {preset.width} × {preset.height}</option>)}</select></label><div className="specs"><span><b>{selected.width} × {selected.height}</b>Resolution</span><span><b>30 fps</b>Frame rate</span><span><b>{formatTime(duration)}</b>Duration</span><span><b>H.264</b>MP4 video</span></div><button className="primary large full" onClick={prepareDownload} disabled={!!busy || !ready}>{busy || `Prepare ${selected.label} download`}</button>{downloadUrl && <a className="download" href={downloadUrl} download>Download {selected.label} MP4</a>}</div><div className="checklist"><h3>Preflight</h3><div className={shots.length?'ok':'warn'}>Storyboard <b>{shots.length} shots</b></div><div className={shots.length && shots.every((s:Shot)=>s.image)?'ok':'warn'}>Images <b>{shots.filter((s:Shot)=>s.image).length}/{shots.length} generated</b></div><div className={shots.some((s:Shot)=>s.video)?'ok':'warn'}>Animated clips <b>{shots.filter((s:Shot)=>s.video).length}/{shots.length} generated</b></div><div className={audioName?'ok':'warn'}>Narration <b>{audioName || 'Required'}</b></div><div className={shots.length && shots.every((s:Shot)=>s.chinese)?'ok':'warn'}>Bilingual captions <b>{approved}/{shots.length} reviewed</b></div><div className="ok">Background music <b>{bgm}</b></div><small>Generated clips are concatenated in storyboard order; unfinished shots retain the subtle still-image motion fallback.</small></div></div>
  </div></div>;
}

function Settings({ provider, setProvider, status, refreshStatus, close }: any) {
  const set = (patch:any) => setProvider((current:ProviderSettings)=>({...current,...patch}));
  const chooseImageProvider = (kind:string) => set(kind === "volcengine" ? { kind, endpoint:"https://ark.cn-beijing.volces.com/api/v3/images/generations", model:"doubao-seedream-5-0-260128", apiKey:"" } : kind === "sdwebui" ? { kind, endpoint:"http://127.0.0.1:7860", model:"Local checkpoint", apiKey:"" } : { kind, endpoint:"https://api.openai.com/v1/images/generations", model:"gpt-image-1", apiKey:"" });
  const chooseTextProvider = (textKind:string) => set(textKind === "volcengine" ? { textKind, textEndpoint:"https://ark.cn-beijing.volces.com/api/v3/chat/completions", textModel:"doubao-seed-2-1-turbo-260628", textApiKey:"" } : { textKind, textEndpoint:"https://api.openai.com/v1/chat/completions", textModel:"gpt-4.1-mini", textApiKey:"" });
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
    <label className="field"><span>Image provider</span><select value={provider.kind} onChange={(e)=>chooseImageProvider(e.target.value)}><option value="openai">OpenAI-compatible images API</option><option value="volcengine">Volcengine Ark · Seedream</option><option value="sdwebui">Local Stable Diffusion WebUI</option></select></label><label className="field"><span>Endpoint</span><input value={provider.endpoint} onChange={(e)=>set({endpoint:e.target.value})}/></label><div className="two-fields"><label className="field"><span>Model</span><input value={provider.model} placeholder={provider.kind === "volcengine" ? "Ark Seedream model ID" : "Model ID"} onChange={(e)=>set({model:e.target.value})}/></label><label className="field"><span>Session API key</span><input type="password" value={provider.apiKey} placeholder={status.image.configured ? "Loaded securely from .env.local" : "Optional session override"} onChange={(e)=>set({apiKey:e.target.value})}/></label></div><label className="field"><span>Parallel image jobs</span><input type="number" min="1" max="6" step="1" value={provider.imageConcurrency} onChange={(e)=>set({imageConcurrency:Math.max(1,Math.min(6,Number(e.target.value)||1))})}/><small>3 is recommended. Lower this if your provider reports rate limits.</small></label><button className="ghost test-button" onClick={()=>testConnection("image")} disabled={!!testing}>{testing === "image" ? "Testing…" : "Test image provider"}</button>
    <hr/><div className={`provider-status ${status.video?.configured ? "connected" : ""}`}><span>{status.video?.configured ? "●" : "○"}</span><div><b>Video generation · Volcengine Ark</b><small>{status.video?.configured ? `${status.video.model} · key loaded from .env.local` : "Required to turn storyboard images into video clips"}</small></div></div><label className="field"><span>Video task endpoint</span><input value={provider.videoEndpoint} onChange={(e)=>set({videoEndpoint:e.target.value})}/></label><div className="two-fields"><label className="field"><span>Seedance model / endpoint ID</span><input value={provider.videoModel} placeholder="doubao-seedance-2-0-260128" onChange={(e)=>set({videoModel:e.target.value})}/></label><label className="field"><span>Session API key</span><input type="password" value={provider.videoApiKey} placeholder={status.video?.configured ? "Loaded securely from .env.local" : "Optional session override"} onChange={(e)=>set({videoApiKey:e.target.value})}/></label></div><label className="field"><span>Parallel video jobs</span><input type="number" min="1" max="4" step="1" value={provider.videoConcurrency} onChange={(e)=>set({videoConcurrency:Math.max(1,Math.min(4,Number(e.target.value)||1))})}/><small>2 is recommended. Ark video generation is asynchronous and may take several minutes per clip.</small></label><button className="ghost test-button" onClick={()=>testConnection("video")} disabled={!!testing}>{testing === "video" ? "Testing…" : "Test video provider"}</button>
    <hr/><div className="provider-status connected"><span>●</span><div><b>Local speech-to-text</b><small>Audio is sent only to the configured local service.</small></div></div><label className="field"><span>Transcription service URL</span><input value={provider.transcriptionEndpoint} placeholder="http://localhost:8000/v1/transcriptions" onChange={(e)=>set({transcriptionEndpoint:e.target.value})}/></label><label className="field"><span>Audio language</span><input value={provider.transcriptionLanguage} placeholder="en" onChange={(e)=>set({transcriptionLanguage:e.target.value})}/></label>
    <hr/><div className={`provider-status ${status.text.configured ? "connected" : ""}`}><span>{status.text.configured ? "●" : "○"}</span><div><b>Storyboard and translation provider</b><small>{status.text.configured ? `${status.text.model} · key loaded from .env.local` : "Required for AI planning and translation"}</small></div></div><label className="field"><span>Text provider</span><select value={provider.textKind} onChange={(e)=>chooseTextProvider(e.target.value)}><option value="openai">OpenAI-compatible chat API</option><option value="volcengine">Volcengine Ark · Doubao</option></select></label><label className="field"><span>Chat completions endpoint</span><input value={provider.textEndpoint} onChange={(e)=>set({textEndpoint:e.target.value})}/></label><div className="two-fields"><label className="field"><span>Model / endpoint ID</span><input value={provider.textModel} placeholder={provider.textKind === "volcengine" ? "Enter an activated Ark model or ep-… ID" : "Model ID"} onChange={(e)=>set({textModel:e.target.value})}/></label><label className="field"><span>Session API key</span><input type="password" value={provider.textApiKey} placeholder={status.text.configured ? "Loaded securely from .env.local" : "Optional session override"} onChange={(e)=>set({textApiKey:e.target.value})}/></label></div><button className="ghost test-button" onClick={()=>testConnection("text")} disabled={!!testing}>{testing === "text" ? "Testing…" : "Test storyboard provider"}</button>{testResult&&<div className="connection-result" role="status">{testResult}</div>}<button className="primary full" onClick={close}>Save session settings</button></div></div>;
}
