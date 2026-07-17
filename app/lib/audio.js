export const VOICE_PRESETS = Object.freeze({
  original: Object.freeze({
    id:"original",
    label:"Original voice",
    description:"Use the uploaded narration without voice processing.",
    pitchSemitones:0,
    noiseReduction:0,
  }),
  denoise: Object.freeze({
    id:"denoise",
    label:"Denoise only",
    description:"Remove light background noise without changing pitch, tone, dynamics, or loudness.",
    pitchSemitones:0,
    noiseReduction:3,
  }),
});

export function voicePreset(value) {
  return VOICE_PRESETS[value] || VOICE_PRESETS.denoise;
}

export function cleanupFilters(value = "denoise") {
  const preset = voicePreset(value);
  if (preset.id === "original") return [];
  return [
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono",
    `afftdn=nr=${preset.noiseReduction}:nf=-52:gs=10`,
    "aresample=48000",
  ];
}

export function narrationFilters(value = "denoise") {
  return cleanupFilters(value);
}

export function voicePresetSummaries() {
  return Object.values(VOICE_PRESETS).map(({ id, label, description, pitchSemitones }) => ({ id, label, description, pitchSemitones }));
}
