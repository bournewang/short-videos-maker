const SUBTITLE_LANGUAGES = new Set(["english", "chinese", "bilingual"])

function subtitleText(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
}

export function splitSentences(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  return raw.split(/(?<=[.!?;。！？；，])\s*/).filter(Boolean);
}

export function splitLongSentence(text, maxWords = 15) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [text];
  const partCount = Math.ceil(words.length / maxWords);
  const wordsPerPart = Math.ceil(words.length / partCount);
  const parts = [];
  for (let i = 0; i < words.length; i += wordsPerPart) {
    parts.push(words.slice(i, i + wordsPerPart).join(" "));
  }
  return parts;
}

export function alignBilingualChunks(englishText, chineseText) {
  const enChunks = splitSentences(englishText).flatMap((s) => splitLongSentence(s));
  const zhChunks = splitSentences(chineseText).flatMap((s) => splitLongSentence(s));
  const enCount = enChunks.length || 1;
  const zhCount = zhChunks.length || 1;
  if (enCount === zhCount) return enChunks.map((en, i) => ({ english: en, chinese: zhChunks[i] }));
  if (enCount > zhCount) {
    return enChunks.map((en, i) => ({ english: en, chinese: zhChunks[Math.min(i, zhCount - 1)] }));
  }
  const merged = [];
  const extra = zhCount - enCount;
  const mergeFrom = enCount - extra;
  for (let i = 0; i < enCount; i++) {
    if (i < mergeFrom) {
      merged.push({ english: enChunks[i], chinese: zhChunks[i] });
    } else {
      const start = mergeFrom + (i - mergeFrom);
      const end = i === enCount - 1 ? zhCount : start + 1 + Math.floor((zhCount - mergeFrom - (enCount - mergeFrom)) / (enCount - mergeFrom));
      merged.push({ english: enChunks[i], chinese: zhChunks.slice(start, end).join("") });
    }
  }
  return merged;
}

export function formatSrtTime(value) {
  const totalMilliseconds = Math.max(0, Math.round((Number(value) || 0) * 1000))
  const hours = Math.floor(totalMilliseconds / 3600000)
  const minutes = Math.floor(totalMilliseconds / 60000) % 60
  const seconds = Math.floor(totalMilliseconds / 1000) % 60
  const milliseconds = totalMilliseconds % 1000
  return `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")},${String(milliseconds).padStart(3,"0")}`
}

export function buildSrt(shots, language = "bilingual") {
  const track = SUBTITLE_LANGUAGES.has(language) ? language : "bilingual"
  const content = (Array.isArray(shots) ? shots : []).flatMap((shot) => {
    const start = Math.max(0, Number(shot.start) || 0)
    const requestedEnd = Number(shot.end)
    const duration = Math.max(.001, Number(shot.duration) || 1)
    const end = Number.isFinite(requestedEnd) && requestedEnd > start ? requestedEnd : start + duration
    const shotDuration = end - start

    const chunks = alignBilingualChunks(shot.narration, shot.chinese);
    const weights = chunks.map((c) => Math.max(1, c.english.split(/\s+/).filter(Boolean).length || c.chinese.length));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    let cueStart = start;
    return chunks.map((chunk, i) => {
      const cueDuration = Math.max(.5, shotDuration * weights[i] / totalWeight);
      const cueEnd = i === chunks.length - 1 ? end : Math.min(end, cueStart + cueDuration);
      const english = subtitleText(chunk.english);
      const chinese = subtitleText(chunk.chinese);
      const lines = track === "english" ? [english] : track === "chinese" ? [chinese] : [english, chinese];
      const text = lines.filter(Boolean).join("\n");
      const cue = text ? { start: cueStart, end: cueEnd, text } : null;
      cueStart = cueEnd;
      return cue;
    }).filter(Boolean);
  }).map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`).join("\n\n")
  return content ? `${content}\n` : ""
}

export function subtitleFileName(title, language = "bilingual") {
  const base = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "shortform-video"
  const suffix = language === "english" ? "en" : language === "chinese" ? "zh-cn" : "bilingual"
  return `${base}-${suffix}.srt`
}
