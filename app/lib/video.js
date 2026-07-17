export const VIDEO_RESOLUTIONS = {
  "480": { label:"480p", width:480, height:854 },
  "720": { label:"720p", width:720, height:1280 },
  "1080": { label:"1080p", width:1080, height:1920 },
};

export function videoResolution(value) {
  return VIDEO_RESOLUTIONS[String(value)] || VIDEO_RESOLUTIONS["1080"];
}
