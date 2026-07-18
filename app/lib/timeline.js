export function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const totalTenths = Math.round(value * 10);
  const mins = Math.floor(totalTenths / 600);
  const secs = Math.floor(totalTenths / 10) % 60;
  const tenths = totalTenths % 10;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

const allowedTypes = new Set(["Opening", "Narrative", "Climax", "Map", "Timeline", "Emotion"]);

export function defaultVideoPrompt(shot = {}, index = 0) {
  const narration = String(shot?.narration || shot?.text || shot?.voiceover || "the planned action").trim();
  const motion = ["Slow push-in", "Slow drift", "Static"].includes(shot?.motion) ? shot.motion : (index % 2 ? "Slow drift" : "Slow push-in");
  return `${motion}. Animate the visible subject naturally to express: ${narration}. Add restrained environmental motion and realistic parallax. Preserve identity, anatomy, composition, lighting, and scene continuity in one continuous shot; no cuts, new subjects, text, logos, flicker, warping, or morphing.`;
}

function transcriptionWords(transcription) {
  if (!Array.isArray(transcription?.segments)) return [];
  return transcription.segments.flatMap((segment) => {
    if (Array.isArray(segment?.words) && segment.words.length) {
      return segment.words.map((word) => ({ start:Number(word?.start), end:Number(word?.end) }));
    }
    const parts = String(segment?.text || "").trim().split(/\s+/).filter(Boolean);
    const start = Number(segment?.start); const end = Number(segment?.end);
    if (!parts.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return parts.map((_, index) => ({ start:start + (end - start) * index / parts.length, end:start + (end - start) * (index + 1) / parts.length }));
  }).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start);
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
    const fallbackPrompt = `${visualStyle} ${contentFormat} scene depicting: ${narration}. ${creativeDirection ? `Creative direction: ${creativeDirection}. ` : ""}Strong mobile composition, coherent subjects and setting, vertical 9:16 frame, subtitle-safe lower area, no text, no watermark.`;
    const motion = ["Slow push-in", "Slow drift", "Static"].includes(item?.motion) ? item.motion : (index % 2 ? "Slow drift" : "Slow push-in");
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
