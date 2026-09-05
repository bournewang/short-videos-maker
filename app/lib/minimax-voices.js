// Shared MiniMax TTS voice catalog + gender/language filtering.
// The MiniMax voice-list API does not reliably return the full built-in system
// voice catalog across accounts, so both the episode editor (StudioApp.tsx) and
// the digital-human app fall back to this curated catalog and let the user
// narrow it by language and gender.
//
// Kept as a plain JS module so it can also be imported by the Node render
// bridge (scripts/render-service.mjs) without a build step.

export const MINIMAX_TTS_MODELS = [
  { value: "speech-2.8-hd", label: "speech-2.8-hd (Quality)" },
  { value: "speech-2.8-turbo", label: "speech-2.8-turbo (Speed)" },
];

export const LANG_LABELS = { zh: "普通话", yue: "粤语", en: "English" };
export const GENDER_LABELS = { male: "男", female: "女", other: "其他" };

// Infer a voice's gender from its voice_id and display name. Best effort:
// MiniMax does not expose a gender field, so we match known keywords.
export function inferGender(voiceId, name) {
  const id = String(voiceId || "").toLowerCase().replace(/_/g, " ");
  const label = String(name || "").toLowerCase();
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

export const MINIMAX_VOICE_FALLBACK = [
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

// Filter a voice catalog by language and gender. The "custom" entry is always
// kept so the user can paste an arbitrary MiniMax voice_id.
export function filterVoices(voices, lang, gender) {
  return (voices || []).filter((v) => {
    if (v.type === "custom") return true;
    if (lang !== "all" && v.language !== lang) return false;
    if (gender !== "all" && inferGender(v.voice_id, v.name) !== gender) return false;
    return true;
  });
}
