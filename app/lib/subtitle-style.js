export const SUBTITLE_FONTS = Object.freeze([
  { value:"Arial", label:"Clean sans" },
  { value:"Georgia", label:"Editorial serif" },
  { value:"Courier New", label:"Monospace" },
]);

export const DEFAULT_SUBTITLE_STYLE = Object.freeze({
  fontFamily:"Arial",
  fontScale:100,
  englishColor:"#ffffff",
  chineseColor:"#f2d79f",
  backgroundColor:"#000000",
  backgroundOpacity:45,
  position:8,
  alignment:"center",
  bold:true,
  outline:2,
});

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function normalizeColor(value, fallback) {
  const color = String(value || "").trim();
  if (/^#[\da-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(color)) return `#${color.slice(1).split("").map((part) => part + part).join("")}`.toLowerCase();
  return fallback;
}

export function normalizeSubtitleStyle(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    fontFamily:SUBTITLE_FONTS.some((font) => font.value === source.fontFamily) ? source.fontFamily : DEFAULT_SUBTITLE_STYLE.fontFamily,
    fontScale:Math.round(clamp(source.fontScale, 70, 160, DEFAULT_SUBTITLE_STYLE.fontScale)),
    englishColor:normalizeColor(source.englishColor, DEFAULT_SUBTITLE_STYLE.englishColor),
    chineseColor:normalizeColor(source.chineseColor, DEFAULT_SUBTITLE_STYLE.chineseColor),
    backgroundColor:normalizeColor(source.backgroundColor, DEFAULT_SUBTITLE_STYLE.backgroundColor),
    backgroundOpacity:Math.round(clamp(source.backgroundOpacity, 0, 100, DEFAULT_SUBTITLE_STYLE.backgroundOpacity)),
    position:Math.round(clamp(source.position, 3, 35, DEFAULT_SUBTITLE_STYLE.position)),
    alignment:["left","center","right"].includes(source.alignment) ? source.alignment : DEFAULT_SUBTITLE_STYLE.alignment,
    bold:typeof source.bold === "boolean" ? source.bold : DEFAULT_SUBTITLE_STYLE.bold,
    outline:Math.round(clamp(source.outline, 0, 5, DEFAULT_SUBTITLE_STYLE.outline) * 10) / 10,
  };
}

export function subtitleCssBackground(value) {
  const style = normalizeSubtitleStyle(value);
  const [red, green, blue] = [1, 3, 5].map((index) => Number.parseInt(style.backgroundColor.slice(index, index + 2), 16));
  return `rgba(${red}, ${green}, ${blue}, ${style.backgroundOpacity / 100})`;
}

export function subtitleAssColor(value, opacity = 100) {
  const color = normalizeColor(value, "#ffffff");
  const red = color.slice(1, 3); const green = color.slice(3, 5); const blue = color.slice(5, 7);
  const alpha = Math.round(255 - clamp(opacity, 0, 100, 100) * 2.55).toString(16).padStart(2, "0");
  return `&H${alpha}${blue}${green}${red}`.toUpperCase();
}

export function subtitleAssOverrideColor(value) {
  return `${subtitleAssColor(value).replace(/^&H00/, "&H")}&`;
}
