const SUBTITLE_LANGUAGES = new Set(["english", "chinese", "bilingual"])

function subtitleText(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
}

function transcriptionWords(transcription) {
  if (!Array.isArray(transcription?.segments)) return [];
  return transcription.segments.flatMap((segment) => {
    if (Array.isArray(segment?.words) && segment.words.length) {
      return segment.words.map((word) => ({ start: Number(word?.start), end: Number(word?.end), text: String(word?.word || "").trim() }));
    }
    const parts = String(segment?.text || "").trim().split(/\s+/).filter(Boolean);
    const segStart = Number(segment?.start), segEnd = Number(segment?.end);
    if (!parts.length || !Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) return [];
    return parts.map((text, i) => ({ start: segStart + (segEnd - segStart) * i / parts.length, end: segStart + (segEnd - segStart) * (i + 1) / parts.length, text }));
  }).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
}

// Trims a transcription to the words covered by the given shots' narration, so
// word-position timing for a subset of shots (e.g. a two-shot sample build) maps
// onto the matching slice of the recording instead of the whole word list.
export function transcriptionForShots(transcription, shots) {
  const words = transcriptionWords(transcription);
  if (words.length < 2) return transcription;
  const narrationWords = (Array.isArray(shots) ? shots : []).reduce((sum, shot) => sum + Math.max(1, String(shot?.narration || "").trim().split(/\s+/).filter(Boolean).length), 0);
  if (!narrationWords || words.length <= narrationWords) return transcription;
  const trimmed = words.slice(0, narrationWords);
  return { ...transcription, duration: trimmed.at(-1).end, segments: [{ start: trimmed[0].start, end: trimmed.at(-1).end, words: trimmed.map((word) => ({ start: word.start, end: word.end, word: word.text })) }] };
}

// Builds cue objects with absolute start/end times.
// With transcription: for multiple shots, maps each shot's narration to its proportional slice of the
// transcription word list by word count — this gives correct timestamps even when shot.end is wrong
// (e.g. the opening hook is pinned to 5s but the speech takes 20s). For a single shot, falls back to
// the time-range approach. Without transcription, uses proportional word-count timing within shot.end.
export function subtitleCues(shots, transcription = null) {
  const words = transcriptionWords(transcription);
  const shotsArr = Array.isArray(shots) ? shots : [];

  // Multi-shot word-position mapping: ignore planned shot.end, use actual transcription timestamps
  const useWordPosition = words.length >= 2 && shotsArr.length > 1;
  const narrationWordCounts = useWordPosition
    ? shotsArr.map((s) => Math.max(1, String(s.narration || "").trim().split(/\s+/).filter(Boolean).length))
    : null;
  const totalNarrationWords = narrationWordCounts ? narrationWordCounts.reduce((s, c) => s + c, 0) : 0;

  let wordOffset = 0;

  return shotsArr.flatMap((shot, shotIdx) => {
    const start = Math.max(0, Number(shot.start) || 0);
    const shotDuration = Math.max(0.6, Number(shot.duration) || 2);
    const end = Number.isFinite(Number(shot.end)) && Number(shot.end) > start ? Number(shot.end) : start + shotDuration;
    const realDuration = end - start;

    const aligned = alignBilingualChunks(String(shot.narration || ""), String(shot.chinese || ""));
    const wordCount = narrationWordCounts ? narrationWordCounts[shotIdx] : 0;

    if (!aligned.length) {
      if (useWordPosition) wordOffset += wordCount;
      return [];
    }

    const weights = aligned.map((c) => Math.max(1, c.english.split(/\s+/).filter(Boolean).length || c.chinese.length));
    const totalWeight = weights.reduce((s, w) => s + w, 0);

    let shotWords;
    if (useWordPosition) {
      // Map this shot's words to a proportional slice of the transcription by narration word count.
      // This is accurate even when shot.end is much shorter than the actual speech duration.
      const wStart = Math.round(words.length * wordOffset / totalNarrationWords);
      const wEnd = Math.min(words.length, Math.round(words.length * (wordOffset + wordCount) / totalNarrationWords));
      shotWords = words.slice(wStart, wEnd);
      wordOffset += wordCount;
    } else if (words.length >= 2) {
      // Single shot: expand the search window beyond shot.end using a ~100 wpm duration estimate
      // so a short planned shot.end doesn't cut off the transcription words.
      const narrationWordCount = Math.max(1, String(shot.narration || "").trim().split(/\s+/).filter(Boolean).length);
      const estimatedEnd = start + narrationWordCount * 0.6;
      shotWords = words.filter((w) => w.start >= start - 0.1 && w.start < Math.max(end, estimatedEnd) + 1);
    } else {
      shotWords = [];
    }

    const cueTimeStart = shotWords.length > 0 ? shotWords[0].start : start;
    let cueStart = cueTimeStart;

    return aligned.map((chunk, i) => {
      let cueEnd;
      if (i === aligned.length - 1) {
        cueEnd = shotWords.length > 0 ? shotWords[shotWords.length - 1].end : end;
      } else if (shotWords.length >= 2) {
        const wordsConsumed = weights.slice(0, i + 1).reduce((s, w) => s + w, 0);
        const wordIdx = Math.min(shotWords.length - 1, Math.max(1, Math.round(shotWords.length * wordsConsumed / totalWeight)));
        const midpoint = (shotWords[wordIdx - 1].end + shotWords[wordIdx].start) / 2;
        cueEnd = Math.max(cueStart + 0.5, midpoint);
      } else {
        cueEnd = Math.min(end, cueStart + Math.max(0.5, realDuration * weights[i] / totalWeight));
      }
      const cue = { start: cueStart, end: cueEnd, chunk, shotIndex: shotIdx };
      cueStart = cueEnd;
      return cue;
    });
  });
}

export function splitSentences(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  return raw.split(/(?<=[.!?;！？。])\s*/).filter(Boolean);
}

export function splitLongSentence(text, maxWords = 15) {
  const trimmed = text.trim();
  if (!trimmed) return [text];
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    if (words.length <= maxWords) return [text];
    const partCount = Math.ceil(words.length / maxWords);
    const wordsPerPart = Math.ceil(words.length / partCount);
    const parts = [];
    for (let i = 0; i < words.length; i += wordsPerPart) {
      parts.push(words.slice(i, i + wordsPerPart).join(" "));
    }
    return parts;
  }
  if (trimmed.length > 30) {
    const partCount = Math.ceil(trimmed.length / 30);
    const charsPerPart = Math.ceil(trimmed.length / partCount);
    const parts = [];
    for (let i = 0; i < trimmed.length; i += charsPerPart) {
      parts.push(trimmed.slice(i, i + charsPerPart).trim());
    }
    return parts.filter(Boolean);
  }
  return [text];
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

// Timing always comes from subtitleCues so exported SRT files follow the same
// word-timestamp sync as the live preview and the burned-in ASS subtitles.
// Without a transcription, subtitleCues falls back to proportional timing.
/**
 * @param {Array<object>} shots
 * @param {string} [language]
 * @param {{ segments?: Array<object> } | null} [transcription]
 */
export function buildSrt(shots, language = "bilingual", transcription = null) {
  const track = SUBTITLE_LANGUAGES.has(language) ? language : "bilingual"
  const content = subtitleCues(shots, transcription).map((cue) => {
    const english = subtitleText(cue.chunk.english);
    const chinese = subtitleText(cue.chunk.chinese);
    const lines = track === "english" ? [english] : track === "chinese" ? [chinese] : [english, chinese];
    const text = lines.filter(Boolean).join("\n");
    return text ? { start: cue.start, end: cue.end, text } : null;
  }).filter(Boolean).map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`).join("\n\n")
  return content ? `${content}\n` : ""
}

export function subtitleFileName(title, language = "bilingual") {
  const base = String(title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "shortform-video"
  const suffix = language === "english" ? "en" : language === "chinese" ? "zh-cn" : "bilingual"
  return `${base}-${suffix}.srt`
}