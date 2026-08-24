import { subtitleCues } from "./subtitles.js";

export function buildTimedChunks(shots, transcription = null) {
  return subtitleCues(shots, transcription).map((cue) => ({
    english: cue.chunk.english,
    chinese: cue.chunk.chinese,
    startTime: cue.start,
    endTime: cue.end,
    shotIndex: cue.shotIndex,
  }));
}

export function activeTimedChunkIndex(chunks, currentTime) {
  if (!Array.isArray(chunks) || !chunks.length) return -1;
  const time = Number(currentTime) || 0;
  const active = chunks.findIndex((chunk) => time >= chunk.startTime && time < chunk.endTime);
  if (active >= 0) return active;
  return time >= (chunks.at(-1)?.endTime || 0) ? chunks.length - 1 : -1;
}
