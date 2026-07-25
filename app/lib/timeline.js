export function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const totalTenths = Math.round(value * 10);
  const mins = Math.floor(totalTenths / 600);
  const secs = Math.floor(totalTenths / 10) % 60;
  const tenths = totalTenths % 10;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

const allowedTypes = new Set(["Opening", "Narrative", "Climax", "Map", "Timeline", "Emotion"]);

const historicalFormat = /\b(?:history|historical)\b/i;
const historicalAccuracy = "Match the exact historical era in the narration: use a period-accurate background, architecture, clothing, objects, and technology; no anachronisms or mixed eras.";

export const SHOT_MOTIONS = ["Slow push-in", "Slow pull-out", "Slow drift", "Slow rise", "Slow sink", "Diagonal drift", "Push to subject", "Static"];
const motionRotation = ["Slow push-in", "Slow drift", "Slow pull-out", "Slow rise", "Slow sink", "Diagonal drift"];

export function shotMotion(value, index = 0) {
  return SHOT_MOTIONS.includes(value) ? value : motionRotation[index % motionRotation.length];
}

export function defaultVideoPrompt(shot = {}, index = 0) {
  const narration = String(shot?.narration || shot?.text || shot?.voiceover || "the planned action").trim();
  const motion = shotMotion(shot?.motion, index);
  return `${motion}. Animate the visible subject naturally to express: ${narration}. Add restrained environmental motion and realistic parallax. Preserve identity, anatomy, composition, lighting, and scene continuity in one continuous shot; no cuts, new subjects, text, logos, flicker, warping, or morphing.`;
}

function defaultLongVideoPrompt(shot = {}, index = 0, options = {}) {
  const narration = String(shot?.narration || shot?.text || shot?.voiceover || "the planned action").trim();
  const motion = shotMotion(shot?.motion, index);
  const contentFormat = String(options.contentFormat || "short-form video");
  const visualStyle = String(options.visualStyle || "photorealistic");
  const creativeDirection = String(options.creativeDirection || "").trim();
  return `${visualStyle} ${contentFormat} scene illustrating the complete narration: ${narration}. ${creativeDirection ? `Creative direction: ${creativeDirection}. ` : ""}Stage the action as a coherent sequence of visual beats in one continuous scene. ${motion} camera movement, natural subject and environmental motion, stable identity and anatomy, consistent setting and lighting; no cuts, text, logos, flicker, warping, morphing, or unrelated subjects.`;
}

function transcriptionWords(transcription) {
  if (!Array.isArray(transcription?.segments)) return [];
  return transcription.segments.flatMap((segment) => {
    if (Array.isArray(segment?.words) && segment.words.length) {
      return segment.words.map((word) => ({ start:Number(word?.start), end:Number(word?.end), text:String(word?.word || "").trim() }));
    }
    const parts = String(segment?.text || "").trim().split(/\s+/).filter(Boolean);
    const start = Number(segment?.start); const end = Number(segment?.end);
    if (!parts.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return parts.map((text, index) => ({ start:start + (end - start) * index / parts.length, end:start + (end - start) * (index + 1) / parts.length, text }));
  }).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start);
}

export function scriptSectionForDuration(script, transcription, start, end, totalDuration = 0) {
  const scriptWords = String(script || "").trim().split(/\s+/).filter(Boolean);
  const rangeStart = Math.max(0, Number(start) || 0);
  const rangeEnd = Math.max(rangeStart, Number(end) || 0);
  const timedWords = transcriptionWords(transcription);
  if (timedWords.length) {
    const first = timedWords.findIndex((word) => (word.start + word.end) / 2 >= rangeStart && (word.start + word.end) / 2 < rangeEnd);
    if (first < 0) return "";
    let last = first;
    while (last + 1 < timedWords.length && (timedWords[last + 1].start + timedWords[last + 1].end) / 2 < rangeEnd) last += 1;
    if (!scriptWords.length) return timedWords.slice(first, last + 1).map((word) => word.text).filter(Boolean).join(" ");
    const scriptStart = Math.floor(first * scriptWords.length / timedWords.length);
    const scriptEnd = Math.max(scriptStart + 1, Math.ceil((last + 1) * scriptWords.length / timedWords.length));
    return scriptWords.slice(scriptStart, scriptEnd).join(" ");
  }
  if (!scriptWords.length) return "";
  const duration = Math.max(rangeEnd, Number(totalDuration) || 0);
  if (!duration) return scriptWords.join(" ");
  const scriptStart = Math.min(scriptWords.length, Math.floor(rangeStart / duration * scriptWords.length));
  const scriptEnd = Math.min(scriptWords.length, Math.max(scriptStart + 1, Math.ceil(rangeEnd / duration * scriptWords.length)));
  return scriptWords.slice(scriptStart, scriptEnd).join(" ");
}

function timestampBoundaries(shots, transcription, target, options = {}) {
  const words = transcriptionWords(transcription);
  if (words.length < 2 || shots.length < 2 || target < shots.length * .6) return null;
  const counts = shots.map((shot) => Math.max(1, shot.narration.split(/\s+/).filter(Boolean).length));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const boundaries = [0]; let consumed = 0;
  for (let index = 1; index < shots.length; index += 1) {
    consumed += counts[index - 1];
    const wordIndex = Math.max(1, Math.min(words.length - 1, Math.round(words.length * consumed / total)));
    const candidate = (words[wordIndex - 1].end + words[wordIndex].start) / 2;
    const remainingShots = shots.length - index;
    const minimumDuration = Math.max(.6, Number(options.minimumDuration) || .6);
    const maximumDuration = Math.max(minimumDuration, Number(options.maximumDuration) || target);
    const minimum = Math.max(boundaries.at(-1) + minimumDuration, target - remainingShots * maximumDuration);
    const maximum = Math.min(boundaries.at(-1) + maximumDuration, target - remainingShots * minimumDuration);
    boundaries.push(Math.max(minimum, Math.min(maximum, candidate)));
  }
  boundaries.push(target);
  return boundaries;
}

function mixedVideoIndexes(shots) {
  const limit = Math.min(shots.length, Math.max(1, Math.ceil(shots.length / 4)));
  const requested = shots.map((shot, index) => shot.videoRecommended ? index : -1).filter((index) => index >= 0);
  const evenlySample = (values, count) => count === 1
    ? [values[Math.floor(values.length / 2)]]
    : Array.from({ length:count }, (_, index) => values[Math.round(index * (values.length - 1) / (count - 1))]);
  if (requested.length >= limit) return new Set(evenlySample(requested, limit));
  const selected = new Set(requested);
  const anchors = limit === 1 ? [0] : Array.from({ length:limit }, (_, index) => Math.round(index * (shots.length - 1) / (limit - 1)));
  for (const anchor of anchors) {
    if (selected.size >= limit) break;
    const candidate = shots.map((shot, index) => ({
      index,
      score:Math.abs(index - anchor) - (shot.type === "Climax" ? 1.5 : shot.type === "Opening" ? 1 : shot.type === "Emotion" ? .5 : 0),
    })).filter((item) => !selected.has(item.index)).sort((left, right) => left.score - right.score || left.index - right.index)[0];
    if (candidate) selected.add(candidate.index);
  }
  return selected;
}

export function normalizePlannedShots(input, audioDuration = 0, options = {}) {
  if (!Array.isArray(input) || !input.length) throw new Error("The planning provider returned no shots");
  const usable = input.slice(0, 80).filter((item) => String(item?.narration || item?.text || item?.voiceover || "").trim());
  if (!usable.length) throw new Error("The planning provider returned no usable narrated shots");
  const longScenes = options.productionMode === "long-scenes";
  const mixedMode = options.productionMode === "mixed";
  const targetClipDuration = Math.max(6, Math.min(12, Math.round(Number(options.targetClipDuration) || 10)));
  const shortClipDuration = Math.max(5, Math.min(10, Math.round(Number(options.shortClipDuration) || 6)));
  let source = usable.map((item, index) => {
    const narration = String(item?.narration || item?.text || item?.voiceover || "").trim();
    const type = allowedTypes.has(item?.type) ? item.type : (index === 0 ? "Opening" : "Narrative");
    const duration = Math.max(.6, Math.min(longScenes ? 12 : 10, Number(item?.duration) || (longScenes ? targetClipDuration : shortClipDuration)));
    const contentFormat = String(options.contentFormat || "short-form video");
    const visualStyle = String(options.visualStyle || "photorealistic");
    const creativeDirection = String(options.creativeDirection || "").trim();
    const screenRatio = String(options.screenRatio || "9:16");
    const fallbackPrompt = `${visualStyle} ${contentFormat} scene depicting: ${narration}. ${creativeDirection ? `Creative direction: ${creativeDirection}. ` : ""}Strong composition for a ${screenRatio} frame, coherent subjects and setting, no text, no watermark.`;
    const prompt = sanitizeImagePrompt(item?.prompt || fallbackPrompt);
    const needsHistoricalAccuracy = historicalFormat.test(`${contentFormat} ${creativeDirection}`) && !/\b(?:no anachronisms?|period[- ]accurate|historically accurate)\b/i.test(prompt);
    const motion = shotMotion(item?.motion, index);
    return {
      type,
      duration,
      narration,
      chinese: String(item?.chinese || "").trim(),
      prompt: needsHistoricalAccuracy ? `${prompt.replace(/[.\s]+$/, "")}. ${historicalAccuracy}` : prompt,
      videoPrompt: String(item?.videoPrompt || (longScenes ? defaultLongVideoPrompt({ ...item, narration, motion }, index, options) : defaultVideoPrompt({ ...item, narration, motion }, index))).trim(),
      videoRecommended:Boolean(item?.videoRecommended),
      motion,
    };
  });
  if (mixedMode) {
    const selectedVideos = mixedVideoIndexes(source);
    source = source.map((shot, index) => ({ ...shot, videoRecommended:selectedVideos.has(index) }));
  }
  const rawTotal = source.reduce((sum, shot) => sum + shot.duration, 0);
  const transcriptionDuration = Number(options.transcription?.duration);
  const target = Math.max(Number(audioDuration) || transcriptionDuration || rawTotal, source.length * .6);
  if (longScenes && target > source.length * 12 + .01) throw new Error("The planning provider returned too few long scenes to stay within the 12-second video limit");
  const longMinimumDuration = longScenes && target >= source.length * 6 ? 6 : .6;
  const boundaries = timestampBoundaries(source, options.transcription, target, longScenes ? { minimumDuration:longMinimumDuration, maximumDuration:12 } : {});
  if (boundaries) return source.map((shot, index) => {
    const start = Number(boundaries[index].toFixed(2));
    const end = Number(boundaries[index + 1].toFixed(2));
    return { ...shot, index, start, end, duration:Number((end - start).toFixed(2)) };
  });
  const remaining = target - source.length * .6;
  let allocated = source.map((shot) => .6 + remaining * (shot.duration / rawTotal));
  if (longScenes && allocated.some((duration) => duration < longMinimumDuration || duration > 12)) allocated = source.map(() => target / source.length);
  let cursor = 0;
  return source.map((shot, index) => {
    const start = Number(cursor.toFixed(2));
    const end = index === source.length - 1 ? Number(target.toFixed(2)) : Number((cursor + allocated[index]).toFixed(2));
    const result = { ...shot, index, start, end, duration:Number((end - start).toFixed(2)) };
    cursor = end;
    return result;
  });
}

export function sanitizeImagePrompt(value) {
  return String(value || "")
    .replace(/\bsubtitle[-\s]?safe\s+lower(?:\s+(?:area|third|zone))?\b/gi, "")
    .replace(/,\s*,/g, ",")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
