const SUBTITLE_LANGUAGES = new Set(["english", "chinese", "bilingual"])

function subtitleText(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
}

export function formatSrtTime(value) {
  const totalMilliseconds = Math.max(0, Math.round((Number(value) || 0) * 1000))
  const hours = Math.floor(totalMilliseconds / 3600000)
  const minutes = Math.floor(totalMilliseconds / 60000) % 60
  const seconds = Math.floor(totalMilliseconds / 1000) % 60
  const milliseconds = totalMilliseconds % 1000
  return `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")},${String(milliseconds).padStart(3,"0")}`
}

export function buildSrt(shots, language = "bilingual") {
  const track = SUBTITLE_LANGUAGES.has(language) ? language : "bilingual"
  const content = (Array.isArray(shots) ? shots : []).flatMap((shot) => {
    const start = Math.max(0, Number(shot.start) || 0)
    const requestedEnd = Number(shot.end)
    const duration = Math.max(.001, Number(shot.duration) || 1)
    const end = Number.isFinite(requestedEnd) && requestedEnd > start ? requestedEnd : start + duration
    const english = subtitleText(shot.narration)
    const chinese = subtitleText(shot.chinese)
    const lines = track === "english" ? [english] : track === "chinese" ? [chinese] : [english, chinese]
    const text = lines.filter(Boolean).join("\n")
    return text ? [{ start, end, text }] : []
  }).map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`).join("\n\n")
  return content ? `${content}\n` : ""
}

export function subtitleFileName(title, language = "bilingual") {
  const base = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "shortform-video"
  const suffix = language === "english" ? "en" : language === "chinese" ? "zh-cn" : "bilingual"
  return `${base}-${suffix}.srt`
}
