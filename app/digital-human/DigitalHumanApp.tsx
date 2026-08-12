"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SERVICE = "http://127.0.0.1:4317";

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

function inferGender(voiceId: string, name?: string): "male" | "female" | "other" {
  // Replace underscores so \b works on snake_case ids
  const id = voiceId.toLowerCase().replace(/_/g, " ");
  const label = (name || "").toLowerCase();
  const maleEn = /\b(?:male|boy|man|didi|nanyou|xuedi|xiongzhang|shaoye|elder|santa|grinch|rudolph|arnold|bloke|gentleman)\b/.test(id);
  const femaleEn = /\b(?:female|girl|woman|lady|miss|jie|mei|xuemei|xuejie|xiaoling|antie|bestie|elf|women|auntie|sweet|charming|graceful|serene|attractive|whispering|cute)\b/.test(id);
  if (maleEn && !femaleEn) return "male";
  if (femaleEn && !maleEn) return "female";
  if (/[男弟兄爷叔汉童兵丁犬]|男友|学长|少爷|青年|男声|男童|弟弟/.test(label)) return "male";
  if (/[女姐妹妈婆媳娘奶玲姊妇妞丫]|少女|御姐|学妹|学姐|女声|女童|妹妹|闺蜜|空姐|大婶|女孩|甜心|萌妹|妇女/.test(label)) return "female";
  if (maleEn) return "male";
  if (femaleEn) return "female";
  return "other";
}

const LANG_LABELS: Record<string, string> = { zh: "普通话", yue: "粤语", en: "English" };
const GENDER_LABELS: Record<string, string> = { male: "男", female: "女", other: "其他" };

const MINIMAX_FALLBACK_VOICES = [
  { voice_id: "male-qn-qingse", name: "青涩青年音色", type: "system", language: "zh" },
  { voice_id: "male-qn-jingying", name: "精英青年音色", type: "system", language: "zh" },
  { voice_id: "male-qn-badao", name: "霸道青年音色", type: "system", language: "zh" },
  { voice_id: "male-qn-daxuesheng", name: "青年大学生音色", type: "system", language: "zh" },
  { voice_id: "female-shaonv", name: "少女音色", type: "system", language: "zh" },
  { voice_id: "female-yujie", name: "御姐音色", type: "system", language: "zh" },
  { voice_id: "female-chengshu", name: "成熟女性音色", type: "system", language: "zh" },
  { voice_id: "female-tianmei", name: "甜美女性音色", type: "system", language: "zh" },
  { voice_id: "male-qn-qingse-jingpin", name: "青涩青年音色-beta", type: "system", language: "zh" },
  { voice_id: "male-qn-jingying-jingpin", name: "精英青年音色-beta", type: "system", language: "zh" },
  { voice_id: "male-qn-badao-jingpin", name: "霸道青年音色-beta", type: "system", language: "zh" },
  { voice_id: "male-qn-daxuesheng-jingpin", name: "青年大学生音色-beta", type: "system", language: "zh" },
  { voice_id: "female-shaonv-jingpin", name: "少女音色-beta", type: "system", language: "zh" },
  { voice_id: "female-yujie-jingpin", name: "御姐音色-beta", type: "system", language: "zh" },
  { voice_id: "female-chengshu-jingpin", name: "成熟女性音色-beta", type: "system", language: "zh" },
  { voice_id: "female-tianmei-jingpin", name: "甜美女性音色-beta", type: "system", language: "zh" },
  { voice_id: "clever_boy", name: "聪明男童", type: "system", language: "zh" },
  { voice_id: "cute_boy", name: "可爱男童", type: "system", language: "zh" },
  { voice_id: "lovely_girl", name: "萌萌女童", type: "system", language: "zh" },
  { voice_id: "cartoon_pig", name: "卡通猪小琪", type: "system", language: "zh" },
  { voice_id: "bingjiao_didi", name: "病娇弟弟", type: "system", language: "zh" },
  { voice_id: "junlang_nanyou", name: "俊朗男友", type: "system", language: "zh" },
  { voice_id: "chunzhen_xuedi", name: "纯真学弟", type: "system", language: "zh" },
  { voice_id: "lengdan_xiongzhang", name: "冷淡学长", type: "system", language: "zh" },
  { voice_id: "badao_shaoye", name: "霸道少爷", type: "system", language: "zh" },
  { voice_id: "tianxin_xiaoling", name: "甜心小玲", type: "system", language: "zh" },
  { voice_id: "qiaopi_mengmei", name: "俏皮萌妹", type: "system", language: "zh" },
  { voice_id: "wumei_yujie", name: "妩媚御姐", type: "system", language: "zh" },
  { voice_id: "diadia_xuemei", name: "嗲嗲学妹", type: "system", language: "zh" },
  { voice_id: "danya_xuejie", name: "淡雅学姐", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Reliable_Executive", name: "沉稳高管", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_News_Anchor", name: "新闻女声", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Mature_Woman", name: "傲娇御姐", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Unrestrained_Young_Man", name: "不羁青年", type: "system", language: "zh" },
  { voice_id: "Arrogant_Miss", name: "嚣张小姐", type: "system", language: "zh" },
  { voice_id: "Robot_Armor", name: "机械战甲", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Kind-hearted_Antie", name: "热心大婶", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_HK_Flight_Attendant", name: "港普空姐", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Humorous_Elder", name: "搞笑大爷", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Gentleman", name: "温润男声", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Warm_Bestie", name: "温暖闺蜜", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Male_Announcer", name: "播报男声", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Sweet_Lady", name: "甜美女声", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Southern_Young_Man", name: "南方小哥", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Wise_Women", name: "阅历姐姐", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Gentle_Youth", name: "温润青年", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Warm_Girl", name: "温暖少女", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Kind-hearted_Elder", name: "花甲奶奶", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Cute_Spirit", name: "憨憨萌兽", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Radio_Host", name: "电台男主播", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Lyrical_Voice", name: "抒情男声", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Straightforward_Boy", name: "率真弟弟", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Sincere_Adult", name: "真诚青年", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Gentle_Senior", name: "温柔学姐", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Stubborn_Friend", name: "嘴硬竹马", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Crisp_Girl", name: "清脆少女", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Pure-hearted_Boy", name: "清澈邻家弟弟", type: "system", language: "zh" },
  { voice_id: "Chinese (Mandarin)_Soft_Girl", name: "柔和少女", type: "system", language: "zh" },
  { voice_id: "Cantonese_ProfessionalHost（F)", name: "专业女主持 (粤语)", type: "system", language: "yue" },
  { voice_id: "Cantonese_GentleLady", name: "温柔女声 (粤语)", type: "system", language: "yue" },
  { voice_id: "Cantonese_ProfessionalHost（M)", name: "专业男主持 (粤语)", type: "system", language: "yue" },
  { voice_id: "Cantonese_PlayfulMan", name: "活泼男声 (粤语)", type: "system", language: "yue" },
  { voice_id: "Cantonese_CuteGirl", name: "可爱女孩 (粤语)", type: "system", language: "yue" },
  { voice_id: "Cantonese_KindWoman", name: "善良女声 (粤语)", type: "system", language: "yue" },
  { voice_id: "Santa_Claus", name: "Santa Claus", type: "system", language: "en" },
  { voice_id: "Grinch", name: "Grinch", type: "system", language: "en" },
  { voice_id: "Rudolph", name: "Rudolph", type: "system", language: "en" },
  { voice_id: "Arnold", name: "Arnold", type: "system", language: "en" },
  { voice_id: "Charming_Santa", name: "Charming Santa", type: "system", language: "en" },
  { voice_id: "Charming_Lady", name: "Charming Lady", type: "system", language: "en" },
  { voice_id: "Sweet_Girl", name: "Sweet Girl", type: "system", language: "en" },
  { voice_id: "Cute_Elf", name: "Cute Elf", type: "system", language: "en" },
  { voice_id: "Attractive_Girl", name: "Attractive Girl", type: "system", language: "en" },
  { voice_id: "Serene_Woman", name: "Serene Woman", type: "system", language: "en" },
  { voice_id: "English_Trustworthy_Man", name: "Trustworthy Man", type: "system", language: "en" },
  { voice_id: "English_Graceful_Lady", name: "Graceful Lady", type: "system", language: "en" },
  { voice_id: "English_Aussie_Bloke", name: "Aussie Bloke", type: "system", language: "en" },
  { voice_id: "English_Whispering_girl", name: "Whispering girl", type: "system", language: "en" },
  { voice_id: "English_Diligent_Man", name: "Diligent Man", type: "system", language: "en" },
  { voice_id: "English_Gentle-voiced_man", name: "Gentle-voiced man", type: "system", language: "en" },
  { voice_id: "custom", name: "Custom voice_id…", type: "custom", language: "" },
];

const MINIMAX_MODELS = [
  { value: "speech-2.8-hd", label: "speech-2.8-hd (Quality)" },
  { value: "speech-2.8-turbo", label: "speech-2.8-turbo (Speed)" },
];

function filterVoices(voices: Array<{ voice_id: string; name: string; type: string; language: string }>, lang: string, gender: string) {
  return voices.filter((v) => {
    if (v.type === "custom") return true;
    if (lang !== "all" && v.language !== lang) return false;
    if (gender !== "all" && inferGender(v.voice_id, v.name) !== gender) return false;
    return true;
  });
}

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

type StepState = "idle" | "loading" | "done" | "error";

export default function DigitalHumanApp() {
  const [tab, setTab] = useState<"manage" | "generate">("manage");
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

  /* Generate tab state */
  const [selectedHumanId, setSelectedHumanId] = useState("");
  const [script, setScript] = useState("");
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

  /* ---- fetch MiniMax voices on mount ---- */
  useEffect(() => {
    fetch(`${SERVICE}/digital-human/voices?provider=minimax`)
      .then((res) => res.json())
      .then((data) => {
        const voices = data.voices || [];
        if (voices.length > 0) {
          setMiniMaxVoices(voices);
        } else {
          setMiniMaxVoices(MINIMAX_FALLBACK_VOICES);
        }
        if (miniMaxVoices.length === 0 && voices.length > 0) {
          setTtsVoice(voices[0].voice_id);
          setFormVoice(voices[0].voice_id);
        }
        setMiniMaxVoicesLoaded(true);
      })
      .catch(() => {
        setMiniMaxVoices(MINIMAX_FALLBACK_VOICES);
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

  /* ---- Generate tab: select human ---- */
  function selectHuman(id: string) {
    setSelectedHumanId(id);
    const human = humans.find((h) => h.id === id);
    if (human?.voice) setTtsVoice(human.voice);
    resetGenerate();
  }

  function resetGenerate() {
    setTtsStep("idle"); setTtsError(""); setTtsAudio(""); setTtsAudioUrl("");
    setPreviewStep("idle"); setPreviewTaskId(""); setPreviewStatus(""); setPreviewVideoUrl(""); setPreviewError("");
    setFullStep("idle"); setFullTaskId(""); setFullStatus(""); setFullVideoUrl(""); setFullError("");
    if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
    if (fullPollRef.current) { clearInterval(fullPollRef.current); fullPollRef.current = null; }
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
      const res = await fetch(`${SERVICE}/digital-human/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: script.trim(),
          provider: ttsProvider,
          voice,
          language: ttsLanguage,
          speed: ttsSpeed,
          model: ttsProvider === "minimax" ? ttsMiniMaxModel : undefined,
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
    } catch (err) {
      setTtsStep("error");
      setTtsError(err instanceof Error ? err.message : "TTS generation failed");
    }
  }

  /* ---- Step 2: 15s Preview ---- */
  async function generatePreview() {
    const human = humans.find((h) => h.id === selectedHumanId);
    if (!human || !ttsAudio) return;
    setPreviewStep("loading");
    setPreviewError("");
    try {
      const res = await fetch(`${SERVICE}/digital-human/video/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photo: human.photo,
          audio: ttsAudio,
          duration: 15,
          videoName: `${human.name} - Preview`,
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
        } else if (data.status === "failed") {
          setPreviewStep("error");
          setPreviewError(data.error || "HeyGen preview generation failed");
          if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
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
    try {
      const res = await fetch(`${SERVICE}/digital-human/video/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photo: human.photo,
          audio: ttsAudio,
          duration: 0,
          videoName: `${human.name} - Full`,
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
        } else if (data.status === "failed") {
          setFullStep("error");
          setFullError(data.error || "HeyGen full video generation failed");
          if (fullPollRef.current) { clearInterval(fullPollRef.current); fullPollRef.current = null; }
        }
      } catch (err) {
        setFullStep("error");
        setFullError(err instanceof Error ? err.message : "Status check failed");
        if (fullPollRef.current) { clearInterval(fullPollRef.current); fullPollRef.current = null; }
      }
    }, 3000);
  }

  const selectedHuman = humans.find((h) => h.id === selectedHumanId);

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
          <button className={`dh-tab${tab === "manage" ? " active" : ""}`} onClick={() => setTab("manage")}>Manage</button>
          <button className={`dh-tab${tab === "generate" ? " active" : ""}`} onClick={() => setTab("generate")}>Generate Video</button>
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

        {/* ---- Generate Tab ---- */}
        {tab === "generate" && (
          <div>
            <div className="section-head compact">
              <h1>Generate Video</h1>
            </div>

            {humans.length === 0 ? (
              <div className="dh-empty">
                <em>1</em>
                <h2>No digital humans available</h2>
                <p>Switch to the Manage tab and create a digital human first.</p>
              </div>
            ) : (
              <div className="dh-generate-layout">
                {/* left: script + steps */}
                <div className="dh-generate-main">
                  <label className="field">
                    <span>Digital Human</span>
                    <select value={selectedHumanId} onChange={(e) => selectHuman(e.target.value)}>
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
                      disabled={!selectedHumanId}
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
                            {MINIMAX_MODELS.map((m) => (
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
                      {ttsAudio && (
                        <div className="dh-audio-preview">
                          <div className="dh-audio-preview-head"><span>Generated Audio</span></div>
                          <audio controls src={ttsAudioUrl} />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Step 2: 15s Preview */}
                  <div className="dh-step">
                    <div className="dh-step-head">
                      <span className={`dh-step-num${previewStep === "done" ? " done" : previewStep === "loading" ? " active" : ""}`}>2</span>
                      <b>15s Preview — HeyGen</b>
                      {previewStep === "done" && <small>Confirmed</small>}
                    </div>
                    <div className="dh-step-body">
                      <p style={{ margin: 0, color: "var(--muted)", fontSize: 11, lineHeight: 1.5 }}>
                        Generate a 15-second preview first. Check voice, lip-sync, facial stability, and composition before committing to the full video.
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
                        After confirming the preview looks good, generate the full video with the complete audio.
                      </p>
                      <button className="primary large" onClick={generateFullVideo} disabled={fullStep === "loading" || previewStep !== "done"}>
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
                </div>

                {/* right: selected human preview */}
                <div className="dh-generate-side">
                  {selectedHuman ? (
                    <div className="dh-card" style={{ display: "block" }}>
                      {selectedHuman.photo ? (
                        <img src={selectedHuman.photo} alt={selectedHuman.name} style={{ width: "100%", aspectRatio: "9/10", objectFit: "cover" }} />
                      ) : (
                        <div style={{ width: "100%", aspectRatio: "9/10", background: "linear-gradient(145deg,#303531,#80725c)", display: "grid", placeItems: "center", color: "#ded0b5", font: "600 32px Georgia,serif" }}>No photo</div>
                      )}
                      <div style={{ padding: 14 }}>
                        <b style={{ font: "600 16px Georgia,serif" }}>{selectedHuman.name}</b>
                        <p style={{ color: "var(--muted)", fontSize: 11, margin: "4px 0 0" }}>{selectedHuman.voiceLabel || selectedHuman.voice}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="dh-empty" style={{ minHeight: 120 }}>
                      <p>Select a digital human to see preview</p>
                    </div>
                  )}

                  <div className="dh-status-panel">
                    <h3>Checklist</h3>
                    <div style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--muted)" }}>
                      <div className={selectedHuman?.photo ? "ok" : ""} style={{ paddingLeft: 18, position: "relative" }}>
                        <span style={{ position: "absolute", left: 2 }}>{selectedHuman?.photo ? "●" : "○"}</span>
                        Photo uploaded (front-facing, mouth visible)
                      </div>
                      <div className={script.trim() ? "ok" : ""} style={{ paddingLeft: 18, position: "relative" }}>
                        <span style={{ position: "absolute", left: 2 }}>{script.trim() ? "●" : "○"}</span>
                        Script ready
                      </div>
                      <div className={ttsStep === "done" ? "ok" : ""} style={{ paddingLeft: 18, position: "relative" }}>
                        <span style={{ position: "absolute", left: 2 }}>{ttsStep === "done" ? "●" : "○"}</span>
                        TTS audio generated
                      </div>
                      <div className={previewStep === "done" ? "ok" : ""} style={{ paddingLeft: 18, position: "relative" }}>
                        <span style={{ position: "absolute", left: 2 }}>{previewStep === "done" ? "●" : "○"}</span>
                        15s preview confirmed
                      </div>
                      <div className={fullStep === "done" ? "ok" : ""} style={{ paddingLeft: 18, position: "relative" }}>
                        <span style={{ position: "absolute", left: 2 }}>{fullStep === "done" ? "●" : "○"}</span>
                        Full video ready
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}