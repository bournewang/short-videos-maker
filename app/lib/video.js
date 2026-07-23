export const VIDEO_RESOLUTIONS = {
  "480": { label:"480p", width:480, height:854 },
  "720": { label:"720p", width:720, height:1280 },
  "1080": { label:"1080p", width:1080, height:1920 },
};

export const SCREEN_RATIOS = {
  "9:16": { label:"Vertical" },
  "16:9": { label:"Landscape" },
  "1:1": { label:"Square" },
};

export function normalizeScreenRatio(value) {
  return Object.hasOwn(SCREEN_RATIOS, String(value)) ? String(value) : "9:16";
}

export function promptForScreenRatio(value, screenRatio = "9:16") {
  const ratio = normalizeScreenRatio(screenRatio);
  const orientation = ratio === "16:9" ? "landscape" : ratio === "1:1" ? "square" : "vertical";
  const ratioPattern = /(?:9\s*:\s*16|16\s*:\s*9|1\s*:\s*1)/g;
  const combinedFramingPattern = /\b(?:vertical|portrait|landscape|horizontal|square)\s+(?:9\s*:\s*16|16\s*:\s*9|1\s*:\s*1)\s+(frame|framing|composition)\b/gi;
  const framingPattern = /\b(?:vertical|portrait|landscape|horizontal|square)\s+(frame|framing|composition)\b/gi;
  const suffixPattern = /\s*Final framing:\s*(?:vertical|landscape|square)\s+(?:9\s*:\s*16|16\s*:\s*9|1\s*:\s*1)\s+screen ratio\.?/gi;
  const prompt = String(value || "").replace(suffixPattern, "").replace(combinedFramingPattern, `${orientation} ${ratio} $1`).replace(ratioPattern, ratio).replace(framingPattern, `${orientation} $1`).trim();
  return `${prompt}${prompt ? " " : ""}Final framing: ${orientation[0].toUpperCase()}${orientation.slice(1)} ${ratio} screen ratio.`;
}

export function videoResolution(value, screenRatio = "9:16") {
  const preset = VIDEO_RESOLUTIONS[String(value)] || VIDEO_RESOLUTIONS["1080"];
  const ratio = normalizeScreenRatio(screenRatio);
  if (ratio === "16:9") return { ...preset, width:preset.height, height:preset.width };
  if (ratio === "1:1") return { ...preset, height:preset.width };
  return preset;
}

export function visualCoverage(shots = []) {
  const total = Array.isArray(shots) ? shots.length : 0;
  const ready = total ? shots.filter((shot) => Boolean(shot?.video || shot?.image)).length : 0;
  return { total, ready, complete:Boolean(total && ready === total) };
}
