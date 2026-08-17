const STYLE_CACHE_KEY = "shortform-style-options-v1";

function readAll() {
  if (typeof localStorage === "undefined") return {};
  try {
    const value = JSON.parse(localStorage.getItem(STYLE_CACHE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function readStyleCache(episodeId) {
  const id = String(episodeId || "").trim();
  const cached = readAll();
  const isGlobal = cached.cacheScope === "global" || ["subtitleStyle", "headlineStyle", "livestreamRatio", "bgMode", "videoPosition", "visibleCount", "prompterVisibleCount"].some((key) => Object.prototype.hasOwnProperty.call(cached, key));
  const value = isGlobal ? cached : cached[id];
  return value && typeof value === "object" ? value : null;
}

export function writeStyleCache(_episodeId, value) {
  if (typeof localStorage === "undefined" || !value || typeof value !== "object") return;
  try {
    localStorage.setItem(STYLE_CACHE_KEY, JSON.stringify({ ...readAll(), ...value, cacheScope: "global" }));
  } catch {
  }
}
