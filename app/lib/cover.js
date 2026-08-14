import { normalizeScreenRatio } from "./video.js";

export const COVER_TITLE_POSITIONS = [
  { id:"top-left", label:"Top left" }, { id:"top-center", label:"Top center" }, { id:"top-right", label:"Top right" },
  { id:"middle-left", label:"Middle left" }, { id:"middle-center", label:"Center" }, { id:"middle-right", label:"Middle right" },
  { id:"bottom-left", label:"Bottom left" }, { id:"bottom-center", label:"Bottom center" }, { id:"bottom-right", label:"Bottom right" },
];

export function normalizeCoverTitlePosition(value) {
  const position = String(value || "");
  return COVER_TITLE_POSITIONS.some((option) => option.id === position) ? position : "bottom-left";
}

export function coverPromptSuggestion(title, script, contentFormat, visualStyle, creativeDirection) {
  const story = String(script || "").trim().replace(/\s+/g, " ").slice(0, 320);
  return [
    `High-impact video cover artwork for a ${String(contentFormat || "").toLowerCase()} titled “${String(title || "").trim() || "Untitled episode"}”.`,
    `${visualStyle} visual style.`,
    String(creativeDirection || "").trim(),
    story ? `Visually summarize this story: ${story}` : "",
    "One unmistakable focal subject, bold cinematic composition, strong contrast, emotional clarity, and a clean title-safe area. Readable at thumbnail size. No text, letters, logos, borders, or watermark.",
  ].filter(Boolean).join(" ");
}

export function safeFileStem(value) {
  return String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "shortform-video";
}

function wrapCoverText(context, value, maxWidth) {
  const text = value.trim().replace(/\s+/g, " ");
  const spaced = /\s/.test(text);
  const tokens = spaced ? text.split(/\s+/) : Array.from(text);
  const separator = spaced ? " " : "";
  const lines = [];
  let line = "";
  for (const token of tokens) {
    const candidate = line ? `${line}${separator}${token}` : token;
    if (!line || context.measureText(candidate).width <= maxWidth) line = candidate;
    else { lines.push(line); line = token; }
  }
  if (line) lines.push(line);
  return lines;
}

export async function downloadCoverFile(url, filename, headline, titlePosition, screenRatio, titleScale = 100, titleWidth = 84, titleVertical = 90) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const sourceUrl = URL.createObjectURL(await response.blob());
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not prepare the cover image"));
    image.src = sourceUrl;
  });
  const canvas = document.createElement("canvas");
  const ratio = normalizeScreenRatio(screenRatio);
  const dimensions = ratio === "16:9" ? { width:1280, height:720 } : ratio === "1:1" ? { width:1080, height:1080 } : { width:1080, height:1920 };
  canvas.width = dimensions.width; canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) { URL.revokeObjectURL(sourceUrl); throw new Error("Cover text rendering is unavailable"); }
  const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const sourceWidth = canvas.width / scale; const sourceHeight = canvas.height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2; const sourceY = (image.naturalHeight - sourceHeight) / 2;
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  const text = headline.trim();
  if (text) {
    const width = canvas.width; const height = canvas.height;
    const horizontal = normalizeCoverTitlePosition(titlePosition).split("-")[1];
    const v = titleVertical / 100;
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(Math.max(0, v - .35), "rgba(0,0,0,0)");
    gradient.addColorStop(Math.max(0, v - .18), "rgba(0,0,0,.18)");
    gradient.addColorStop(v, "rgba(0,0,0,.76)");
    gradient.addColorStop(Math.min(1, v + .18), "rgba(0,0,0,.18)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    const maxWidth = width * (titleWidth / 100);
    let fontSize = Math.round(width * .085 * titleScale / 100);
    let lines = [];
    do {
      context.font = `800 ${fontSize}px Arial, sans-serif`;
      lines = wrapCoverText(context, text, maxWidth);
      if (lines.length <= 3) break;
      fontSize -= Math.max(2, Math.round(width * .004));
    } while (fontSize > width * .045);
    lines = lines.slice(0, 3);
    const lineHeight = fontSize * 1.06;
    const marginX = (1 - titleWidth / 100) / 2;
    const x = horizontal === "center" ? width * .5 : horizontal === "right" ? width * (1 - marginX) : width * marginX;
    const firstBaseline = height * v - lineHeight * (lines.length - 1) * .5 + fontSize * .35;
    const accentWidth = width * .13;
    const accentX = horizontal === "center" ? x - accentWidth * .5 : horizontal === "right" ? x - accentWidth : x;
    const strokeWidth = Math.max(5, fontSize * .12);
    const textAscent = Math.max(fontSize * .82, context.measureText(lines[0] || text).actualBoundingBoxAscent || 0);
    const accentHeight = Math.max(6, width * .008);
    const accentGap = Math.max(8, fontSize * .18);
    const accentY = Math.max(height * .025, firstBaseline - textAscent - strokeWidth * .5 - accentGap - accentHeight);
    context.fillStyle = "#d7a552";
    context.fillRect(accentX, accentY, accentWidth, accentHeight);
    context.textBaseline = "alphabetic";
    context.textAlign = horizontal === "center" ? "center" : horizontal === "right" ? "right" : "left";
    context.lineJoin = "round";
    context.strokeStyle = "rgba(0,0,0,.82)";
    context.lineWidth = strokeWidth;
    context.fillStyle = "#fffdf7";
    lines.forEach((line, index) => {
      const y = firstBaseline + index * lineHeight;
      context.strokeText(line, x, y, maxWidth);
      context.fillText(line, x, y, maxWidth);
    });
  }
  URL.revokeObjectURL(sourceUrl);
  const result = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not create the cover download")), "image/png"));
  const objectUrl = URL.createObjectURL(result);
  const link = document.createElement("a");
  link.href = objectUrl; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
