export function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const totalTenths = Math.round(value * 10);
  const mins = Math.floor(totalTenths / 600);
  const secs = Math.floor(totalTenths / 10) % 60;
  const tenths = totalTenths % 10;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

const allowedTypes = new Set(["Opening", "Narrative", "Climax", "Map", "Timeline", "Emotion"]);

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

function timestampBoundaries(shots, transcription, target) {
  const words = transcriptionWords(transcription);
  if (words.length < 2 || shots.length < 2 || target < shots.length * .6) return null;
  const counts = shots.map((shot) => Math.max(1, shot.narration.split(/\s+/).filter(Boolean).length));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const boundaries = [0]; let consumed = 0;
  for (let index = 1; index < shots.length; index += 1) {
    consumed += counts[index - 1];
    const wordIndex = Math.max(1, Math.min(words.length - 1, Math.round(words.length * consumed / total)));
    const candidate = (words[wordIndex - 1].end + words[wordIndex].start) / 2;
    const minimum = boundaries.at(-1) + .6;
    const maximum = target - (shots.length - index) * .6;
    boundaries.push(Math.max(minimum, Math.min(maximum, candidate)));
  }
  boundaries.push(target);
  return boundaries;
}

export function normalizePlannedShots(input, audioDuration = 0, options = {}) {
  if (!Array.isArray(input) || !input.length) throw new Error("The planning provider returned no shots");
  const usable = input.slice(0, 80).filter((item) => String(item?.narration || item?.text || item?.voiceover || "").trim());
  if (!usable.length) throw new Error("The planning provider returned no usable narrated shots");
  const source = usable.map((item, index) => {
    const narration = String(item?.narration || item?.text || item?.voiceover || "").trim();
    const type = allowedTypes.has(item?.type) ? item.type : (index === 0 ? "Opening" : "Narrative");
    const duration = Math.max(.6, Math.min(8, Number(item?.duration) || 2.5));
    const contentFormat = String(options.contentFormat || "short-form video");
    const visualStyle = String(options.visualStyle || "photorealistic");
    const creativeDirection = String(options.creativeDirection || "").trim();
    const screenRatio = String(options.screenRatio || "9:16");
    const fallbackPrompt = `${visualStyle} ${contentFormat} scene depicting: ${narration}. ${creativeDirection ? `Creative direction: ${creativeDirection}. ` : ""}Strong composition for a ${screenRatio} frame, coherent subjects and setting, subtitle-safe lower area, no text, no watermark.`;
    const motion = shotMotion(item?.motion, index);
    return {
      type,
      duration,
      narration,
      chinese: String(item?.chinese || "").trim(),
      prompt: String(item?.prompt || fallbackPrompt).trim(),
      videoPrompt: String(item?.videoPrompt || defaultVideoPrompt({ ...item, narration, motion }, index)).trim(),
      motion,
    };
  });
  const rawTotal = source.reduce((sum, shot) => sum + shot.duration, 0);
  const transcriptionDuration = Number(options.transcription?.duration);
  const target = Math.max(Number(audioDuration) || transcriptionDuration || rawTotal, source.length * .6);
  const boundaries = timestampBoundaries(source, options.transcription, target);
  if (boundaries) return source.map((shot, index) => {
    const start = Number(boundaries[index].toFixed(2));
    const end = Number(boundaries[index + 1].toFixed(2));
    return { ...shot, index, start, end, duration:Number((end - start).toFixed(2)) };
  });
  const remaining = target - source.length * .6;
  const allocated = source.map((shot) => .6 + remaining * (shot.duration / rawTotal));
  let cursor = 0;
  return source.map((shot, index) => {
    const start = Number(cursor.toFixed(2));
    const end = index === source.length - 1 ? Number(target.toFixed(2)) : Number((cursor + allocated[index]).toFixed(2));
    const result = { ...shot, index, start, end, duration:Number((end - start).toFixed(2)) };
    cursor = end;
    return result;
  });
}
