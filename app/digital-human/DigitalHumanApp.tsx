"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { COVER_TITLE_POSITIONS, coverPromptSuggestion, downloadCoverFile, safeFileStem } from "../lib/cover";
import { MINIMAX_TTS_MODELS, MINIMAX_VOICE_FALLBACK, LANG_LABELS, GENDER_LABELS, filterVoices } from "../lib/minimax-voices";

const SERVICE = "http://127.0.0.1:4317";

const LAST_PROJECT_KEY = "dh:last-open-project";

const KOKORO_VOICES = [
  { value: "af_heart", label: "Heart (American Female)" },
  { value: "af_bella", label: "Bella (American Female)" },
  { value: "af_nova", label: "Nova (American Female)" },
  { value: "af_sky", label: "Sky (American Female)" },
  { value: "am_adam", label: "Adam (American Male)" },
  { value: "am_echo", label: "Echo (American Male)" },
  { value: "bf_alice", label: "Alice (British Female)" },
  { value: "bf_emma", label: "Emma (British Female)" },
  { value: "bm_daniel", label: "Daniel (British Male)" },
  { value: "bm_george", label: "George (British Male)" },
  { value: "zf_xiaobei", label: "Xiaobei (Mandarin Female)" },
  { value: "zf_yunxi", label: "Yunxi (Mandarin Female)" },
  { value: "zm_yunxi", label: "Yunxi (Mandarin Male)" },
];

const LANGUAGES = [
  { value: "a", label: "American English" },
  { value: "b", label: "British English" },
  { value: "z", label: "Mandarin Chinese" },
  { value: "j", label: "Japanese" },
  { value: "e", label: "Spanish" },
  { value: "f", label: "French" },
];

type DigitalHuman = {
  id: string;
  name: string;
  photo: string;
  photoExt: string;
  voice: string;
  voiceLabel: string;
  createdAt: number;
  updatedAt: number;
};

type DHProject = {
  id: string;
  humanId: string;
  name: string;
  script: string;
  audioPath: string;
  audioUrl: string;
  audioProvider: string;
  audioVoice: string;
  audioModel: string;
  audioSpeed: number;
  audioLanguage: string;
  createdAt: number;
  updatedAt: number;
};

type DHVideo = {
  id: string;
  projectId: string;
  type: "preview" | "full";
  videoUrl: string;
  heygenTaskId: string;
  status: string;
  createdAt: number;
};

type DHAudioVersion = {
  id: string;
  projectId: string;
  audioPath: string;
  audioUrl: string;
  provider: string;
  voice: string;
  voiceLabel: string;
  model: string;
  speed: number;
  language: string;
  createdAt: number;
};

type StepState = "idle" | "loading" | "done" | "error";

type DHCover = {
  id: string;
  projectId: string;
  imageUrl: string;
  prompt: string;
  createdAt: number;
};

const COVER_RATIO = "9:16";

export default function DigitalHumanApp() {
  const [tab, setTab] = useState<"manage" | "projects">("projects");
  const [humans, setHumans] = useState<DigitalHuman[]>([]);
  const [loading, setLoading] = useState(true);

  /* Manage tab state */
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formPhoto, setFormPhoto] = useState("");
  const [formVoice, setFormVoice] = useState("af_heart");
  const [formCustomVoiceId, setFormCustomVoiceId] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const photoInputRef = useRef<HTMLInputElement>(null);

  /* Projects tab state */
  const [projects, setProjects] = useState<DHProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectVideos, setProjectVideos] = useState<DHVideo[]>([]);
  const [projectSaving, setProjectSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const lastSavedRef = useRef("");
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredProjectRef = useRef(false);

  /* Workspace state (loaded from selected project) */
  const [projectName, setProjectName] = useState("");
  const [script, setScript] = useState("");
  const [selectedHumanId, setSelectedHumanId] = useState("");
  const [ttsProvider, setTtsProvider] = useState<"mlx" | "minimax">("minimax");
  const [ttsVoice, setTtsVoice] = useState("af_heart");
  const [ttsCustomVoiceId, setTtsCustomVoiceId] = useState("");
  const [ttsMiniMaxModel, setTtsMiniMaxModel] = useState("speech-2.8-hd");
  const [ttsLanguage, setTtsLanguage] = useState("z");
  const [ttsSpeed, setTtsSpeed] = useState(1);
  const [miniMaxVoices, setMiniMaxVoices] = useState<Array<{ voice_id: string; name: string; type: string; language: string }>>([]);
  const [miniMaxVoicesLoaded, setMiniMaxVoicesLoaded] = useState(false);
  const [voiceFilterLang, setVoiceFilterLang] = useState("all");
  const [voiceFilterGender, setVoiceFilterGender] = useState("all");

  /* Step 1: TTS */
  const [ttsStep, setTtsStep] = useState<StepState>("idle");
  const [ttsError, setTtsError] = useState("");
  const [ttsAudio, setTtsAudio] = useState("");
  const [ttsAudioUrl, setTtsAudioUrl] = useState("");

  /* Multi-version audio */
  const [audioVersions, setAudioVersions] = useState<DHAudioVersion[]>([]);
  const [selectedAudioVersionId, setSelectedAudioVersionId] = useState("");

  /* Step 2: 15s Preview */
  const [previewStep, setPreviewStep] = useState<StepState>("idle");
  const [previewTaskId, setPreviewTaskId] = useState("");
  const [previewStatus, setPreviewStatus] = useState("");
  const [previewVideoUrl, setPreviewVideoUrl] = useState("");
  const [previewError, setPreviewError] = useState("");
  const previewPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Step 3: Full Video */
  const [fullStep, setFullStep] = useState<StepState>("idle");
  const [fullTaskId, setFullTaskId] = useState("");
  const [fullStatus, setFullStatus] = useState("");
  const [fullVideoUrl, setFullVideoUrl] = useState("");
  const [fullError, setFullError] = useState("");
  const fullPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Step 4: Cover artwork */
  const [covers, setCovers] = useState<DHCover[]>([]);
  const [coverPrompt, setCoverPrompt] = useState("");
  const [coverHeadline, setCoverHeadline] = useState("");
  const [coverTitlePosition, setCoverTitlePosition] = useState("bottom-left");
  const [coverTitleVertical, setCoverTitleVertical] = useState(90);
  const [coverTitleScale, setCoverTitleScale] = useState(100);
  const [coverTitleWidth, setCoverTitleWidth] = useState(84);
  const [coverStep, setCoverStep] = useState<StepState>("idle");
  const [coverError, setCoverError] = useState("");

  /* ---- load digital humans on mount ---- */
  const loadHumans = useCallback(async () => {
    try {
      const res = await fetch(`${SERVICE}/digital-humans`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      setHumans(data.humans || []);
    } catch (err) {
      console.error("Failed to load digital humans:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadHumans(); }, [loadHumans]);

  /* ---- load projects ---- */
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch(`${SERVICE}/digital-human/projects`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  /* ---- load project videos when selected project changes ---- */
  useEffect(() => {
    if (!selectedProjectId) { setProjectVideos([]); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load() {
      try {
        const res = await fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}/videos`);
        const data = await res.json();
        if (cancelled) return;
        const videos = data.videos || [];
        setProjectVideos(videos);
        // Keep polling while any video is still being generated
        if (videos.some((v: DHVideo) => v.status !== "completed" && v.status !== "failed")) {
          timer = setTimeout(load, 5000);
        }
      } catch {
        if (!cancelled) setProjectVideos([]);
      }
    }
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [selectedProjectId]);

  /* ---- fetch MiniMax voices on mount ---- */
  useEffect(() => {
    fetch(`${SERVICE}/digital-human/voices?provider=minimax`)
      .then((res) => res.json())
      .then((data) => {
        const voices = data.voices || [];
        if (voices.length > 0) {
          setMiniMaxVoices(voices);
        } else {
          setMiniMaxVoices(MINIMAX_VOICE_FALLBACK);
        }
        if (miniMaxVoices.length === 0 && voices.length > 0) {
          setTtsVoice(voices[0].voice_id);
          setFormVoice(voices[0].voice_id);
        }
        setMiniMaxVoicesLoaded(true);
      })
      .catch(() => {
        setMiniMaxVoices(MINIMAX_VOICE_FALLBACK);
        setMiniMaxVoicesLoaded(true);
      });
  }, []);

  /* ---- sync ttsVoice when switching to minimax ---- */
  useEffect(() => {
    if (ttsProvider === "minimax" && miniMaxVoices.length > 0) {
      if (!miniMaxVoices.some((v) => v.voice_id === ttsVoice)) {
        setTtsVoice(miniMaxVoices[0].voice_id);
      }
    }
  }, [ttsProvider, miniMaxVoices]);

  /* ---- cleanup polling on unmount ---- */
  useEffect(() => {
    return () => {
      if (previewPollRef.current) clearInterval(previewPollRef.current);
      if (fullPollRef.current) clearInterval(fullPollRef.current);
    };
  }, []);

  /* ---- Manage tab: form handlers ---- */
  function openCreateForm() {
    setEditingId(null);
    setFormName("");
    setFormPhoto("");
    setFormVoice("af_heart");
    setFormCustomVoiceId("");
    setFormError("");
    setShowForm(true);
  }

  function openEditForm(human: DigitalHuman) {
    setEditingId(human.id);
    setFormName(human.name);
    setFormPhoto(human.photo || "");
    setFormVoice(human.voice || "af_heart");
    setFormCustomVoiceId("");
    setFormError("");
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setFormError("");
  }

  function handlePhotoFile(file: File) {
    if (file.size > 4 * 1024 * 1024) {
      setFormError("Photo must be under 4 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFormPhoto(String(reader.result));
      setFormError("");
    };
    reader.onerror = () => setFormError("Failed to read photo file");
    reader.readAsDataURL(file);
  }

  async function saveHuman() {
    if (!formName.trim()) { setFormError("Name is required"); return; }
    setFormSaving(true);
    setFormError("");
    try {
      const voiceLabel = formVoice === "custom" ? formCustomVoiceId : (
          miniMaxVoices.find((v) => v.voice_id === formVoice)?.name
            || KOKORO_VOICES.find((v) => v.value === formVoice)?.label
            || formVoice
        );
      const body = {
        name: formName.trim(),
        photo: formPhoto,
        voice: formVoice === "custom" ? formCustomVoiceId : formVoice,
        voiceLabel,
      };
      if (editingId) {
        const res = await fetch(`${SERVICE}/digital-humans/${editingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
      } else {
        const res = await fetch(`${SERVICE}/digital-humans`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
      }
      await loadHumans();
      setShowForm(false);
      setEditingId(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setFormSaving(false);
    }
  }

  async function deleteHuman(id: string) {
    if (!confirm("Delete this digital human? This cannot be undone.")) return;
    try {
      const res = await fetch(`${SERVICE}/digital-humans/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      await loadHumans();
      if (selectedHumanId === id) setSelectedHumanId("");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  /* ---- Projects tab: project handlers ---- */
  function resetWorkspace() {
    setProjectName(""); setScript(""); setSelectedHumanId(""); setTtsStep("idle"); setTtsError(""); setTtsAudio(""); setTtsAudioUrl("");
    lastSavedRef.current = "";
    setSaveState("idle");
    setAudioVersions([]); setSelectedAudioVersionId("");
    setPreviewStep("idle"); setPreviewTaskId(""); setPreviewStatus(""); setPreviewVideoUrl(""); setPreviewError("");
    setFullStep("idle"); setFullTaskId(""); setFullStatus(""); setFullVideoUrl(""); setFullError("");
    setCovers([]); setCoverPrompt(""); setCoverHeadline(""); setCoverStep("idle"); setCoverError("");
    if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
    if (fullPollRef.current) { clearInterval(fullPollRef.current); fullPollRef.current = null; }
  }

  async function loadProjectIntoWorkspace(project: DHProject & { audioVersions?: DHAudioVersion[]; covers?: DHCover[] }) {
    resetWorkspace();
    setSelectedProjectId(project.id);
    setProjectName(project.name || "");
    setSelectedHumanId(project.humanId || "");
    setScript(project.script || "");
    setCovers(Array.isArray(project.covers) ? project.covers : []);
    lastSavedRef.current = JSON.stringify({
      name: project.name || "",
      script: project.script || "",
      humanId: project.humanId || "",
    });
    setSaveState("saved");
    const versions = project.audioVersions;
    if (versions && versions.length > 0) {
      setAudioVersions(versions);
      setSelectedAudioVersionId(versions[0].id);
      setTtsAudioUrl(`${versions[0].audioUrl}?t=${Date.now()}`);
      setTtsAudio(`${versions[0].audioUrl}?t=${Date.now()}`);
      setTtsStep("done");
      if (versions[0].voice) setTtsVoice(versions[0].voice);
      if (versions[0].provider) setTtsProvider(versions[0].provider as "mlx" | "minimax");
      if (versions[0].model) setTtsMiniMaxModel(versions[0].model);
      if (versions[0].speed) setTtsSpeed(versions[0].speed);
      if (versions[0].language) setTtsLanguage(versions[0].language);
    } else if (project.audioUrl) {
      setTtsAudioUrl(`${project.audioUrl}?t=${project.updatedAt}`);
      setTtsAudio(`${project.audioUrl}?t=${project.updatedAt}`);
      setTtsStep("done");
      if (project.audioVoice) setTtsVoice(project.audioVoice);
      if (project.audioProvider) setTtsProvider(project.audioProvider as "mlx" | "minimax");
      if (project.audioModel) setTtsMiniMaxModel(project.audioModel);
      if (project.audioSpeed) setTtsSpeed(project.audioSpeed);
      if (project.audioLanguage) setTtsLanguage(project.audioLanguage);
    }
  }

  async function selectProject(project: DHProject) {
    try {
      const res = await fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(project.id)}`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const full = await res.json();
      loadProjectIntoWorkspace(full);
      localStorage.setItem(LAST_PROJECT_KEY, project.id);
    } catch (err) {
      console.error("Failed to load project:", err);
    }
  }

  /* ---- restore the last opened project after a page reload ---- */
  useEffect(() => {
    if (restoredProjectRef.current || projects.length === 0) return;
    restoredProjectRef.current = true;
    const lastId = localStorage.getItem(LAST_PROJECT_KEY);
    if (!lastId) return;
    if (!projects.some((p) => p.id === lastId)) {
      localStorage.removeItem(LAST_PROJECT_KEY);
      return;
    }
    let cancelled = false;
    fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(lastId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.json();
      })
      .then((full) => { if (!cancelled) loadProjectIntoWorkspace(full); })
      .catch((err) => console.error("Failed to restore project:", err));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  async function createProject() {
    setProjectSaving(true);
    try {
      const res = await fetch(`${SERVICE}/digital-human/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Project", script: "", humanId: "" }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const project = await res.json();
      await loadProjects();
      loadProjectIntoWorkspace(project);
      localStorage.setItem(LAST_PROJECT_KEY, project.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setProjectSaving(false);
    }
  }

  function workspaceSnapshot() {
    return JSON.stringify({ name: projectName, script, humanId: selectedHumanId });
  }

  async function persistProject({ keepalive = false }: { keepalive?: boolean } = {}) {
    if (!selectedProjectId) return;
    const snapshot = workspaceSnapshot();
    if (snapshot === lastSavedRef.current) return;
    const payload = {
      name: projectName.trim() || script.trim().slice(0, 50) || "Untitled Project",
      script,
      humanId: selectedHumanId,
    };
    setSaveState("saving");
    try {
      const res = await fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive,
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      lastSavedRef.current = snapshot;
      setSaveState("saved");
      setProjects((prev) => prev.map((p) => (p.id === selectedProjectId ? { ...p, name: payload.name } : p)));
    } catch (err) {
      setSaveState("error");
      console.error("Failed to save project:", err);
    }
  }

  async function saveProject() {
    if (!selectedProjectId) return;
    setProjectSaving(true);
    try {
      await persistProject();
      await loadProjects();
    } finally {
      setProjectSaving(false);
    }
  }

  /* ---- autosave workspace (title / script / human) with debounce ---- */
  useEffect(() => {
    if (!selectedProjectId) return;
    if (workspaceSnapshot() === lastSavedRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      persistProject();
    }, 800);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, projectName, script, selectedHumanId]);

  /* ---- flush any pending save when the page unloads ---- */
  useEffect(() => {
    function flush() {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      persistProject({ keepalive: true });
    }
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, projectName, script, selectedHumanId]);

  async function deleteProject(id: string) {
    if (!confirm("Delete this project and all its videos? This cannot be undone.")) return;
    try {
      const res = await fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      await loadProjects();
      if (selectedProjectId === id) {
        setSelectedProjectId("");
        resetWorkspace();
        localStorage.removeItem(LAST_PROJECT_KEY);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete project");
    }
  }

  async function deleteVideo(videoId: string) {
    if (!confirm("Delete this video?")) return;
    try {
      const res = await fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}/videos/${encodeURIComponent(videoId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setProjectVideos((prev) => prev.filter((v) => v.id !== videoId));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete video");
    }
  }

  /* ---- Step 1: TTS ---- */
  async function generateSpeech() {
    if (!script.trim()) return;
    setTtsStep("loading");
    setTtsError("");
    try {
      const voice = ttsProvider === "minimax"
        ? (ttsVoice === "custom" ? ttsCustomVoiceId : ttsVoice)
        : ttsVoice;
      const voiceLabel = ttsProvider === "minimax"
        ? (miniMaxVoices.find((v) => v.voice_id === ttsVoice)?.name || ttsVoice)
        : (KOKORO_VOICES.find((v) => v.value === ttsVoice)?.label || ttsVoice);
      const res = await fetch(`${SERVICE}/digital-human/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: script.trim(),
          provider: ttsProvider,
          voice,
          voiceLabel,
          language: ttsLanguage,
          speed: ttsSpeed,
          model: ttsProvider === "minimax" ? ttsMiniMaxModel : undefined,
          projectId: selectedProjectId || undefined,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned ${res.status}`);
      }
      const data = await res.json();
      setTtsAudio(data.audioData);
      setTtsAudioUrl(data.audioData);
      setTtsStep("done");
      setPreviewStep("idle"); setPreviewVideoUrl(""); setPreviewError("");
      setFullStep("idle"); setFullVideoUrl(""); setFullError("");
      // Refresh audio versions list (don't let this clobber ttsStep)
      if (selectedProjectId) {
        fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}/audio-versions`)
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            if (data?.versions?.length) {
              setAudioVersions(data.versions);
              setSelectedAudioVersionId(data.versions[0].id);
              setTtsAudioUrl(`${data.versions[0].audioUrl}?t=${Date.now()}`);
              setTtsAudio(`${data.versions[0].audioUrl}?t=${Date.now()}`);
            }
          })
          .catch(() => {});
        loadProjects();
      }
    } catch (err) {
      setTtsStep("error");
      setTtsError(err instanceof Error ? err.message : "TTS generation failed");
    }
  }

  /* ---- Step 2: 15s Preview ---- */
  async function getSelectedAudioAsBase64(): Promise<string> {
    if (!ttsAudio) throw new Error("No audio selected");
    if (ttsAudio.startsWith("data:audio/")) return ttsAudio;
    const res = await fetch(ttsAudio);
    if (!res.ok) throw new Error("Failed to fetch audio");
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Failed to read audio blob"));
      reader.readAsDataURL(blob);
    });
  }

  async function generatePreview() {
    const human = humans.find((h) => h.id === selectedHumanId);
    if (!human || !ttsAudio) return;
    setPreviewStep("loading");
    setPreviewError("");
    let audioForGen: string;
    try {
      audioForGen = await getSelectedAudioAsBase64();
    } catch (err) {
      setPreviewStep("error");
      setPreviewError("Failed to load selected audio for generation");
      return;
    }
    try {
      const res = await fetch(`${SERVICE}/digital-human/video/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photo: human.photo,
          audio: audioForGen,
          duration: 15,
          videoName: `${human.name} - Preview`,
          projectId: selectedProjectId || undefined,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned ${res.status}`);
      }
      const data = await res.json();
      setPreviewTaskId(data.taskId);
      pollPreviewStatus(data.taskId);
    } catch (err) {
      setPreviewStep("error");
      setPreviewError(err instanceof Error ? err.message : "Preview generation failed");
    }
  }

  function pollPreviewStatus(taskId: string) {
    if (previewPollRef.current) clearInterval(previewPollRef.current);
    previewPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${SERVICE}/digital-human/video/status/${taskId}`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();
        setPreviewStatus(data.status);
        if (data.status === "completed") {
          setPreviewVideoUrl(data.videoUrl);
          setPreviewStep("done");
          if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
          refreshVideos();
        } else if (data.status === "failed") {
          setPreviewStep("error");
          setPreviewError(data.error || "HeyGen preview generation failed");
          if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
          refreshVideos();
        }
      } catch (err) {
        setPreviewStep("error");
        setPreviewError(err instanceof Error ? err.message : "Status check failed");
        if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
      }
    }, 3000);
  }

  /* ---- Step 3: Full Video ---- */
  async function generateFullVideo() {
    const human = humans.find((h) => h.id === selectedHumanId);
    if (!human || !ttsAudio) return;
    setFullStep("loading");
    setFullError("");
    let audioForGen: string;
    try {
      audioForGen = await getSelectedAudioAsBase64();
    } catch (err) {
      setFullStep("error");
      setFullError("Failed to load selected audio for generation");
      return;
    }
    try {
      const res = await fetch(`${SERVICE}/digital-human/video/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photo: human.photo,
          audio: audioForGen,
          duration: 0,
          videoName: `${human.name} - Full`,
          projectId: selectedProjectId || undefined,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned ${res.status}`);
      }
      const data = await res.json();
      setFullTaskId(data.taskId);
      pollFullStatus(data.taskId);
    } catch (err) {
      setFullStep("error");
      setFullError(err instanceof Error ? err.message : "Full video generation failed");
    }
  }

  function pollFullStatus(taskId: string) {
    if (fullPollRef.current) clearInterval(fullPollRef.current);
    fullPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${SERVICE}/digital-human/video/status/${taskId}`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();
        setFullStatus(data.status);
        if (data.status === "completed") {
          setFullVideoUrl(data.videoUrl);
          setFullStep("done");
          if (fullPollRef.current) { clearInterval(fullPollRef.current); fullPollRef.current = null; }
          refreshVideos();
        } else if (data.status === "failed") {
          setFullStep("error");
          setFullError(data.error || "HeyGen full video generation failed");
          if (fullPollRef.current) { clearInterval(fullPollRef.current); fullPollRef.current = null; }
          refreshVideos();
        }
      } catch (err) {
        setFullStep("error");
        setFullError(err instanceof Error ? err.message : "Status check failed");
        if (fullPollRef.current) { clearInterval(fullPollRef.current); fullPollRef.current = null; }
      }
    }, 3000);
  }

  function refreshVideos() {
    if (!selectedProjectId) return;
    fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}/videos`)
      .then((res) => res.json())
      .then((data) => setProjectVideos(data.videos || []))
      .catch(() => {});
  }

  /* ---- Step 4: Cover artwork ---- */
  const suggestedCoverPrompt = coverPromptSuggestion(projectName, script, "Talking-head video", "Photorealistic", "");

  async function generateCover() {
    if (!selectedProjectId) return;
    const prompt = coverPrompt.trim() || suggestedCoverPrompt;
    setCoverPrompt(prompt);
    setCoverStep("loading");
    setCoverError("");
    try {
      const res = await fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}/covers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, screenRatio: COVER_RATIO }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      setCovers((prev) => [data as DHCover, ...prev]);
      setCoverStep("done");
    } catch (err) {
      setCoverStep("error");
      setCoverError(err instanceof Error ? `${err.message}. Start the local render service with “npm run render-service”.` : "Cover generation failed");
    }
  }

  async function deleteCover(coverId: string) {
    if (!confirm("Delete this cover?")) return;
    try {
      const res = await fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}/covers/${encodeURIComponent(coverId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setCovers((prev) => prev.filter((cover) => cover.id !== coverId));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete cover");
    }
  }

  async function downloadCover(cover: DHCover) {
    try {
      const headline = coverHeadline.trim() || projectName.trim() || "Watch this story";
      await downloadCoverFile(cover.imageUrl, `${safeFileStem(projectName)}-cover-9x16.png`, headline, coverTitlePosition, COVER_RATIO, coverTitleScale, coverTitleWidth, coverTitleVertical);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Cover download failed");
    }
  }

  const selectedHuman = humans.find((h) => h.id === selectedHumanId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  function formatTime(ts: number) {
    return new Date(ts).toLocaleString();
  }

  const videoTypeLabel: Record<string, string> = { preview: "15s Preview", full: "Full Video" };

  return (
    <div className="dh-shell">
      {/* top bar */}
      <div className="dh-topbar">
        <div className="dh-topbar-left">
          <a href="/" className="dh-back">← Studio</a>
          <span className="dh-title">Digital Human</span>
        </div>
      </div>

      {/* tabs */}
      <div className="dh-panel">
        <div className="dh-tabs">
          <button className={`dh-tab${tab === "projects" ? " active" : ""}`} onClick={() => setTab("projects")}>Projects</button>
          <button className={`dh-tab${tab === "manage" ? " active" : ""}`} onClick={() => setTab("manage")}>Manage</button>
        </div>

        {/* ---- Manage Tab ---- */}
        {tab === "manage" && (
          <div>
            <div className="section-head compact">
              <h1>Digital Humans</h1>
              <button className="primary" onClick={openCreateForm} disabled={showForm}>+ New Digital Human</button>
            </div>

            {showForm && (
              <div className="dh-form">
                <h2>{editingId ? "Edit Digital Human" : "New Digital Human"}</h2>
                <div className="dh-form-row">
                  <label className="field">
                    <span>Name</span>
                    <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="My Digital Human" />
                  </label>
                  <label className="field">
                    <span>Voice</span>
                    <div className="dh-filter-row">
                      <select value={voiceFilterLang} onChange={(e) => setVoiceFilterLang(e.target.value)} className="dh-filter-select">
                        <option value="all">All languages</option>
                        {Object.entries(LANG_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <select value={voiceFilterGender} onChange={(e) => setVoiceFilterGender(e.target.value)} className="dh-filter-select">
                        <option value="all">All genders</option>
                        {Object.entries(GENDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </div>
                    <select value={formVoice} onChange={(e) => setFormVoice(e.target.value)}>
                      {filterVoices(miniMaxVoices, voiceFilterLang, voiceFilterGender).map((v) => (
                        <option key={v.voice_id} value={v.voice_id}>{v.name}{v.language ? ` (${v.language})` : ""}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {formVoice === "custom" && (
                  <label className="field">
                    <span>Custom voice_id</span>
                    <input type="text" value={formCustomVoiceId} onChange={(e) => setFormCustomVoiceId(e.target.value)} placeholder="Paste your MiniMax voice_id…" />
                  </label>
                )}
                <div>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#68645e", display: "block", marginBottom: 7 }}>Photo</span>
                  {formPhoto ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      <img src={formPhoto} alt="Preview" className="dh-photo-preview" />
                      <button className="ghost" onClick={() => { setFormPhoto(""); if (photoInputRef.current) photoInputRef.current.value = ""; }} style={{ justifySelf: "start" }}>Remove photo</button>
                    </div>
                  ) : (
                    <label className="dh-photo-upload">
                      <input ref={photoInputRef} type="file" accept="image/png,image/jpeg,image/jpg" onChange={(e) => { const file = e.target.files?.[0]; if (file) handlePhotoFile(file); }} />
                      <b>Upload photo</b>
                      <span>PNG or JPEG, front-facing, mouth visible</span>
                    </label>
                  )}
                </div>
                {formError && <p style={{ color: "#914d43", fontSize: 11, margin: 0 }}>{formError}</p>}
                <div className="dh-form-actions">
                  <button className="ghost" onClick={cancelForm}>Cancel</button>
                  <button className="primary" onClick={saveHuman} disabled={formSaving}>{formSaving ? "Saving…" : "Save"}</button>
                </div>
              </div>
            )}

            {loading && (
              <div className="dh-empty">
                <span>Loading…</span>
              </div>
            )}

            {!loading && humans.length === 0 && !showForm && (
              <div className="dh-empty">
                <em>1</em>
                <h2>No digital humans yet</h2>
                <p>Create your first digital human to get started with video generation.</p>
              </div>
            )}

            {!loading && humans.length > 0 && (
              <div className="dh-grid">
                {humans.map((human) => (
                  <div key={human.id} className="dh-card">
                    {human.photo ? (
                      <img src={human.photo} alt={human.name} className="dh-card-photo" />
                    ) : (
                      <div className="dh-card-photo" style={{ display: "grid", placeItems: "center", color: "#ded0b5", font: "600 20px Georgia,serif" }}>?</div>
                    )}
                    <div className="dh-card-body">
                      <b>{human.name}</b>
                      <span>{human.voiceLabel || human.voice}</span>
                      <div className="dh-card-actions">
                        <button onClick={() => openEditForm(human)}>Edit</button>
                        <button className="danger" onClick={() => deleteHuman(human.id)}>Delete</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---- Projects Tab ---- */}
        {tab === "projects" && (
          <div className="dh-projects-layout">
            {/* Main workspace */}
            <div className="dh-workspace">
              {!selectedProjectId ? (
                <div className="dh-empty">
                  <em>+</em>
                  <h2>Select or create a project</h2>
                  <p>Choose a project from the right panel or create a new one to get started.</p>
                </div>
              ) : (
                <>
                  <div className="section-head compact">
                    <input
                      className="dh-project-title"
                      type="text"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      placeholder="Project title…"
                    />
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {saveState === "saving" && <span className="dh-save-state">Saving…</span>}
                      {saveState === "saved" && <span className="dh-save-state">Saved</span>}
                      {saveState === "error" && <span className="dh-save-state error">Save failed</span>}
                      <button className="primary" onClick={saveProject} disabled={projectSaving}>
                        {projectSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>

                  <label className="field">
                    <span>Digital Human</span>
                    <select value={selectedHumanId} onChange={async (e) => {
                      setSelectedHumanId(e.target.value);
                      if (selectedProjectId) {
                        await fetch(`${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ humanId: e.target.value }),
                        });
                        await loadProjects();
                      }
                    }}>
                      <option value="">Select a digital human…</option>
                      {humans.map((h) => (
                        <option key={h.id} value={h.id}>{h.name} ({h.voiceLabel || h.voice})</option>
                      ))}
                    </select>
                  </label>

                  <label className="field dh-script-area">
                    <span>Script</span>
                    <textarea
                      value={script}
                      onChange={(e) => setScript(e.target.value)}
                      placeholder="Paste your script here…"
                    />
                    <small>{script.length} chars</small>
                  </label>

                  {/* Step 1: TTS */}
                  <div className="dh-step">
                    <div className="dh-step-head">
                      <span className={`dh-step-num${ttsStep === "done" ? " done" : ttsStep === "loading" ? " active" : ""}`}>1</span>
                      <b>TTS — Script to Speech</b>
                      {ttsStep === "done" && <small>Ready</small>}
                    </div>
                    <div className="dh-step-body">
                      <div className="dh-form-row">
                        <label className="field">
                          <span>TTS Provider</span>
                          <select value={ttsProvider} onChange={(e) => { setTtsProvider(e.target.value as "mlx" | "minimax"); setTtsStep("idle"); setTtsAudio(""); setTtsAudioUrl(""); }}>
                            <option value="mlx">MLX Audio (Kokoro)</option>
                            <option value="minimax">MiniMax</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>Voice</span>
                          {ttsProvider === "minimax" ? (
                            <div>
                              <div className="dh-filter-row">
                                <select value={voiceFilterLang} onChange={(e) => setVoiceFilterLang(e.target.value)} className="dh-filter-select">
                                  <option value="all">All languages</option>
                                  {Object.entries(LANG_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                                <select value={voiceFilterGender} onChange={(e) => setVoiceFilterGender(e.target.value)} className="dh-filter-select">
                                  <option value="all">All genders</option>
                                  {Object.entries(GENDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                              </div>
                              <select value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)}>
                                {filterVoices(miniMaxVoices, voiceFilterLang, voiceFilterGender).map((v) => (
                                  <option key={v.voice_id} value={v.voice_id}>{v.name}{v.language ? ` (${v.language})` : ""}</option>
                                ))}
                              </select>
                            </div>
                          ) : (
                            <select value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)}>
                              {KOKORO_VOICES.map((v) => (
                                <option key={v.value} value={v.value}>{v.label}</option>
                              ))}
                            </select>
                          )}
                        </label>
                      </div>
                      {ttsProvider === "minimax" && ttsVoice === "custom" && (
                        <label className="field">
                          <span>Custom voice_id</span>
                          <input type="text" value={ttsCustomVoiceId} onChange={(e) => setTtsCustomVoiceId(e.target.value)} placeholder="Paste your MiniMax voice_id…" />
                        </label>
                      )}
                      {ttsProvider === "minimax" && (
                        <label className="field">
                          <span>Model</span>
                          <select value={ttsMiniMaxModel} onChange={(e) => setTtsMiniMaxModel(e.target.value)}>
                            {MINIMAX_TTS_MODELS.map((m) => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      {ttsProvider === "mlx" && (
                        <label className="field">
                          <span>Language</span>
                          <select value={ttsLanguage} onChange={(e) => setTtsLanguage(e.target.value)}>
                            {LANGUAGES.map((l) => (
                              <option key={l.value} value={l.value}>{l.label}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label className="field speech-speed">
                        <span>Speed</span>
                        <div>
                          <input type="range" min="0.5" max="2" step="0.05" value={ttsSpeed} onChange={(e) => setTtsSpeed(Number(e.target.value))} />
                          <output>{ttsSpeed.toFixed(2)}×</output>
                        </div>
                      </label>
                      <button className="primary" onClick={generateSpeech} disabled={ttsStep === "loading" || !script.trim() || !selectedHumanId}>
                        {ttsStep === "loading" ? "Generating…" : ttsStep === "done" ? "Re-generate Speech" : "Generate Speech"}
                      </button>
                      {ttsStep === "error" && <p className="dh-status-error">{ttsError}</p>}
                      {audioVersions.length > 0 && (
                        <div className="dh-audio-versions">
                          <div className="dh-audio-preview-head"><span>Audio Versions ({audioVersions.length})</span></div>
                          <div className="dh-audio-version-list">
                            {audioVersions.map((ver) => {
                              const isSelected = selectedAudioVersionId === ver.id;
                              const voiceName = ver.voiceLabel || ver.voice;
                              return (
                                <div
                                  key={ver.id}
                                  className={`dh-audio-version-item${isSelected ? " selected" : ""}`}
                                >
                                  <label className="dh-audio-version-radio">
                                    <input
                                      type="radio"
                                      name="audioVersion"
                                      checked={isSelected}
                                      onChange={() => {
                                        setSelectedAudioVersionId(ver.id);
                                        setTtsAudioUrl(`${ver.audioUrl}?t=${Date.now()}`);
                                        setTtsAudio(`${ver.audioUrl}?t=${Date.now()}`);
                                      }}
                                    />
                                  </label>
                                  <div className="dh-audio-version-player">
                                    <audio controls src={`${ver.audioUrl}?t=${ver.createdAt}`} />
                                  </div>
                                  <div className="dh-audio-version-info">
                                    <span className="dh-audio-version-voice">{voiceName}</span>
                                    <span className="dh-audio-version-meta">
                                      {ver.provider} / {ver.model || "default"} / {ver.speed}x
                                    </span>
                                  </div>
                                  <button
                                    className="danger dh-audio-version-delete"
                                    onClick={async () => {
                                      if (!confirm("Delete this audio version?")) return;
                                      try {
                                        await fetch(
                                          `${SERVICE}/digital-human/projects/${encodeURIComponent(selectedProjectId)}/audio-versions/${encodeURIComponent(ver.id)}`,
                                          { method: "DELETE" }
                                        );
                                        setAudioVersions((prev) => {
                                          const next = prev.filter((v) => v.id !== ver.id);
                                          if (isSelected && next.length > 0) {
                                            setSelectedAudioVersionId(next[0].id);
                                            setTtsAudioUrl(`${next[0].audioUrl}?t=${Date.now()}`);
                                            setTtsAudio(`${next[0].audioUrl}?t=${Date.now()}`);
                                          } else if (next.length === 0) {
                                            setSelectedAudioVersionId("");
                                            setTtsAudioUrl("");
                                            setTtsAudio("");
                                            setTtsStep("idle");
                                          }
                                          return next;
                                        });
                                      } catch {
                                        alert("Failed to delete audio version");
                                      }
                                    }}
                                    title="Delete this version"
                                  >
                                    Delete
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Step 2: 15s Preview */}
                  <div className="dh-step">
                    <div className="dh-step-head">
                      <span className={`dh-step-num${previewStep === "done" ? " done" : previewStep === "loading" ? " active" : ""}`}>2</span>
                      <b>15s Preview — HeyGen</b>
                      <small>Optional</small>
                      {previewStep === "done" && <small>Confirmed</small>}
                    </div>
                    <div className="dh-step-body">
                      <p style={{ margin: 0, color: "var(--muted)", fontSize: 11, lineHeight: 1.5 }}>
                        Optionally generate a 15-second preview to check voice, lip-sync, facial stability, and composition before committing to the full video. You can skip this and go straight to the full video.
                      </p>
                      <button className="primary" onClick={generatePreview} disabled={previewStep === "loading" || ttsStep !== "done"}>
                        {previewStep === "loading" ? "Generating Preview…" : previewStep === "done" ? "Re-generate Preview" : "Generate 15s Preview"}
                      </button>
                      {previewStep === "loading" && (
                        <div className="dh-status-row">
                          <span className="dh-status-badge processing">{previewStatus || "pending"}</span>
                        </div>
                      )}
                      {previewStep === "error" && <p className="dh-status-error">{previewError}</p>}
                      {previewVideoUrl && (
                        <div className="dh-video-preview">
                          <video controls src={previewVideoUrl} />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Step 3: Full Video */}
                  <div className="dh-step">
                    <div className="dh-step-head">
                      <span className={`dh-step-num${fullStep === "done" ? " done" : fullStep === "loading" ? " active" : ""}`}>3</span>
                      <b>Full Video — HeyGen</b>
                      {fullStep === "done" && <small>Complete</small>}
                    </div>
                    <div className="dh-step-body">
                      <p style={{ margin: 0, color: "var(--muted)", fontSize: 11, lineHeight: 1.5 }}>
                        Generate the full video with the complete audio. No preview required — skip step 2 if you are confident in the setup.
                      </p>
                      <button className="primary large" onClick={generateFullVideo} disabled={fullStep === "loading" || ttsStep !== "done"}>
                        {fullStep === "loading" ? "Generating Full Video…" : fullStep === "done" ? "Re-generate Full Video" : "Generate Full Video"}
                      </button>
                      {fullStep === "loading" && (
                        <div className="dh-status-row">
                          <span className="dh-status-badge processing">{fullStatus || "pending"}</span>
                        </div>
                      )}
                      {fullStep === "error" && <p className="dh-status-error">{fullError}</p>}
                      {fullVideoUrl && (
                        <div className="dh-video-preview">
                          <video controls src={fullVideoUrl} />
                          <p style={{ marginTop: 8 }}>
                            <a href={fullVideoUrl} download className="primary" style={{ display: "inline-block", textDecoration: "none" }}>Download Video</a>
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Step 4: Cover artwork */}
                  <div className="dh-step">
                    <div className="dh-step-head">
                      <span className={`dh-step-num${covers.length ? " done" : coverStep === "loading" ? " active" : ""}`}>4</span>
                      <b>Cover Artwork</b>
                      <small>Optional</small>
                      {covers.length > 0 && <small>{covers.length} saved</small>}
                    </div>
                    <div className="dh-step-body">
                      <DHCoverStudio
                        projectName={projectName}
                        humanPhoto={selectedHuman?.photo || ""}
                        covers={covers}
                        coverPrompt={coverPrompt}
                        setCoverPrompt={setCoverPrompt}
                        suggestedCoverPrompt={suggestedCoverPrompt}
                        coverHeadline={coverHeadline}
                        setCoverHeadline={setCoverHeadline}
                        coverTitlePosition={coverTitlePosition}
                        setCoverTitlePosition={setCoverTitlePosition}
                        coverTitleVertical={coverTitleVertical}
                        setCoverTitleVertical={setCoverTitleVertical}
                        coverTitleScale={coverTitleScale}
                        setCoverTitleScale={setCoverTitleScale}
                        coverTitleWidth={coverTitleWidth}
                        setCoverTitleWidth={setCoverTitleWidth}
                        coverStep={coverStep}
                        coverError={coverError}
                        generateCover={generateCover}
                        downloadCover={downloadCover}
                        deleteCover={deleteCover}
                      />
                    </div>
                  </div>

                  {/* Video History Strip */}
                  {projectVideos.length > 0 && (
                    <div className="dh-video-strip-section">
                      <h3>Generated Videos</h3>
                      <div className="dh-video-strip">
                        {projectVideos.map((video) => (
                          <div key={video.id} className={`dh-video-card${video.status === "completed" ? "" : " pending"}`}>
                            <div className="dh-video-card-type">
                              <span className={`dh-video-badge ${video.type}`}>{videoTypeLabel[video.type] || video.type}</span>
                              <span className={`dh-video-status ${video.status}`}>{video.status}</span>
                            </div>
                            {video.status === "completed" && video.videoUrl ? (
                              <video controls src={video.videoUrl} className="dh-video-card-player" />
                            ) : (
                              <div className="dh-video-card-placeholder">
                                {video.status === "processing" ? "Processing…" : video.status}
                              </div>
                            )}
                            <div className="dh-video-card-footer">
                              <small>{formatTime(video.createdAt)}</small>
                              <button className="danger" onClick={() => deleteVideo(video.id)} title="Delete video">✕</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Right panel: Projects list */}
            <div className="dh-projects-panel">
              <div className="dh-projects-panel-head">
                <h3>Projects</h3>
                <button className="primary" onClick={createProject} disabled={projectSaving}>+ New</button>
              </div>
              {projects.length === 0 ? (
                <div className="dh-projects-empty">
                  <p>No projects yet. Create one to start.</p>
                </div>
              ) : (
                <div className="dh-projects-list">
                  {projects.map((project) => {
                    const human = humans.find((h) => h.id === project.humanId);
                    return (
                      <div
                        key={project.id}
                        className={`dh-project-item${selectedProjectId === project.id ? " active" : ""}`}
                        onClick={() => selectProject(project)}
                      >
                        <div className="dh-project-item-info">
                          <b>{project.name || "Untitled Project"}</b>
                          <span>{human ? human.name : "No human selected"}</span>
                          <small>{formatTime(project.updatedAt)}</small>
                        </div>
                        <button
                          className="danger"
                          onClick={(e) => { e.stopPropagation(); deleteProject(project.id); }}
                          title="Delete project"
                        >✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type DHCoverStudioProps = {
  projectName: string;
  humanPhoto: string;
  covers: DHCover[];
  coverPrompt: string;
  setCoverPrompt: (value: string) => void;
  suggestedCoverPrompt: string;
  coverHeadline: string;
  setCoverHeadline: (value: string) => void;
  coverTitlePosition: string;
  setCoverTitlePosition: (value: string) => void;
  coverTitleVertical: number;
  setCoverTitleVertical: (value: number) => void;
  coverTitleScale: number;
  setCoverTitleScale: (value: number) => void;
  coverTitleWidth: number;
  setCoverTitleWidth: (value: number) => void;
  coverStep: StepState;
  coverError: string;
  generateCover: () => void;
  downloadCover: (cover: DHCover) => Promise<void>;
  deleteCover: (coverId: string) => Promise<void>;
};

function DHCoverStudio({ projectName, humanPhoto, covers, coverPrompt, setCoverPrompt, suggestedCoverPrompt, coverHeadline, setCoverHeadline, coverTitlePosition, setCoverTitlePosition, coverTitleVertical, setCoverTitleVertical, coverTitleScale, setCoverTitleScale, coverTitleWidth, setCoverTitleWidth, coverStep, coverError, generateCover, downloadCover, deleteCover }: DHCoverStudioProps) {
  const photoCover: DHCover | undefined = humanPhoto ? { id:"human-photo", projectId:"", imageUrl:humanPhoto, prompt:"", createdAt:0 } : undefined;
  const currentCover = covers[0] ?? photoCover;
  const headline = coverHeadline.trim() || projectName.trim() || "Watch this story";
  const titleWidthPercent = coverTitleWidth / 100;
  const titleInset = `${((1 - titleWidthPercent) / 2 * 100).toFixed(1)}%`;
  const busy = coverStep === "loading";
  return (
    <section className="cover-studio ratio-9-16">
      <div className="build-library-head">
        <div><span className="eyebrow">VIDEO COVER</span><h2>{currentCover ? "Place the cover title" : "Generate cover artwork"}</h2></div>
        <span>Vertical · {COVER_RATIO}</span>
      </div>
      <div className="cover-studio-grid">
        <div className={`cover-preview ${currentCover ? `has-cover title-${coverTitlePosition}` : ""}`} style={{ aspectRatio:"9 / 16" }}>
          {currentCover ? (
            <>
              <img src={currentCover.imageUrl} alt="Generated video cover" />
              <div className="cover-preview-shade" style={{ background:`linear-gradient(180deg, transparent ${Math.max(0, coverTitleVertical - 35)}%, rgba(0,0,0,.18) ${Math.max(0, coverTitleVertical - 18)}%, rgba(0,0,0,.76) ${coverTitleVertical}%, rgba(0,0,0,.18) ${Math.min(100, coverTitleVertical + 18)}%, transparent)` }} />
              <div className="cover-preview-copy" style={{ left:titleInset, right:titleInset, top:`${coverTitleVertical}%`, bottom:"auto", transform:"translateY(-50%)" }}><i /><strong style={{ fontSize:`calc(8.5cqw * ${coverTitleScale / 100})` }}>{headline}</strong></div>
            </>
          ) : (
            <div className="empty-visual"><span>✦</span><b>Generate the artwork first</b><small>Then place the title while seeing the real image.</small></div>
          )}
        </div>
        <div className="cover-controls">
          <p>{covers.length ? "Now choose a headline and position that avoids the subject. Your choice is baked into the downloaded PNG." : photoCover ? "Using the digital human photo as the background. Choose a headline and position, or generate custom artwork to replace it." : "Create the clean artwork first. Title editing and placement controls will appear after the image is ready."}</p>
          <label className="field">
            <span>Artwork direction</span>
            <textarea rows={currentCover ? 3 : 5} value={coverPrompt} placeholder={suggestedCoverPrompt} onChange={(event) => setCoverPrompt(event.target.value)} />
            <small>The image model creates artwork without unreliable generated lettering.</small>
          </label>
          {currentCover && (
            <div className="cover-title-editor">
              <label className="field cover-headline-field">
                <span>Cover headline</span>
                <input maxLength={90} value={coverHeadline} placeholder={projectName || "Add an attention-grabbing headline"} onChange={(event) => setCoverHeadline(event.target.value)} />
                <small>Keep it short and specific. The project title is used when this field is empty.</small>
              </label>
              <fieldset className="cover-position-field">
                <legend>Title position</legend>
                <div>{COVER_TITLE_POSITIONS.map((option) => <button type="button" key={option.id} className={coverTitlePosition === option.id ? "chosen" : ""} title={option.label} aria-label={option.label} aria-pressed={coverTitlePosition === option.id} onClick={() => setCoverTitlePosition(option.id)}><i /></button>)}</div>
                <small>Choose a clear area that does not cover the main subject.</small>
              </fieldset>
              <label className="field cover-title-scale-field">
                <span>Vertical position</span>
                <div><input aria-label="Cover title vertical position" type="range" min="2" max="92" step="1" value={coverTitleVertical} onChange={(e) => setCoverTitleVertical(Number(e.target.value))} /><output>{coverTitleVertical}%</output></div>
                <small>Fine-tune the title distance from the top.</small>
              </label>
              <label className="field cover-title-scale-field">
                <span>Title size</span>
                <div><input aria-label="Cover title font size scale" type="range" min="50" max="200" step="5" value={coverTitleScale} onChange={(e) => setCoverTitleScale(Number(e.target.value))} /><output>{coverTitleScale}%</output></div>
                <small>Adjust the title text size independent of position.</small>
              </label>
              <label className="field cover-title-width-field">
                <span>Text width</span>
                <div><input aria-label="Cover title text width" type="range" min="50" max="95" step="1" value={coverTitleWidth} onChange={(e) => setCoverTitleWidth(Number(e.target.value))} /><output>{coverTitleWidth}%</output></div>
                <small>Narrower text stays clear of the subject.</small>
              </label>
            </div>
          )}
          <div className="cover-actions">
            <button type="button" className="ghost" onClick={() => setCoverPrompt(suggestedCoverPrompt)}>Use suggested artwork</button>
            <button type="button" className="primary" onClick={generateCover} disabled={busy}>{busy ? "Generating…" : covers.length ? "Generate another" : "Generate cover"}</button>
            {currentCover && <button type="button" className="ghost" onClick={() => void downloadCover(currentCover)}>Download with text</button>}
          </div>
          {coverStep === "error" && <p className="dh-status-error">{coverError}</p>}
        </div>
      </div>
      {covers.length > 0 && (
        <div className="cover-history">
          <h3>Saved covers</h3>
          <div>
            {covers.map((cover: DHCover) => (
              <article key={cover.id}>
                <div className={`cover-history-image title-${coverTitlePosition}`} style={{ aspectRatio:"9 / 16" }}>
                  <img src={cover.imageUrl} alt={`Cover generated ${cover.createdAt ? new Date(cover.createdAt).toLocaleString() : ""}`} />
                  <strong style={{ fontSize:`calc(8.5cqw * ${coverTitleScale / 100})`, top:`${coverTitleVertical}%`, bottom:"auto", transform:"translateY(-50%)" }}>{headline}</strong>
                </div>
                <span><b>{COVER_RATIO}</b><time>{cover.createdAt ? new Date(cover.createdAt).toLocaleString([], { dateStyle:"medium", timeStyle:"short" }) : "Earlier cover"}</time></span>
                <button type="button" className="ghost" onClick={() => void downloadCover(cover)}>Download with text</button>
                <button type="button" className="ghost" onClick={() => void deleteCover(cover.id)}>Delete</button>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}