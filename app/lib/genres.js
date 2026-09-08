// Genre 配置层：把「英语纪录片解说」与「中文人物故事」两种视频模式的
// 全部差异声明式地打包在一起，供流水线各环节（脚本 / 分镜 / 生图视频 /
// 字幕 / 配音 / BGM / 封面）按需读取。流水线控制流不变，只按 genre 注入参数。

export const GENRES = Object.freeze({
  documentary: Object.freeze({
    id: "documentary",
    label: "Documentary",
    labelZh: "纪录片 · 英语历史解说",
    description: "English narration with bilingual Chinese subtitles.",
    // 语言方向
    primaryLanguage: "en",
    bilingual: true,
    scriptLabel: "English script",
    scriptPlaceholder: "Paste a script or generate one from a topic…",
    // 分镜 / 视觉默认值
    defaultContentFormat: "Documentary",
    defaultVisualStyle: "Photorealistic",
    visualTone: "documentary realism",
    planningStyle: "concise English documentary narration",
    // TTS（provider 与对应参数）
    tts: Object.freeze({
      provider: "minimax",
      voice: "English_Trustworthy_Man",
      model: "speech-2.8-hd",
      speed: 1,
    }),
    // 字幕
    subtitleFont: "Arial",
    // 封面
    coverStyle: "documentary",
  }),

  story: Object.freeze({
    id: "story",
    label: "Story",
    labelZh: "人物故事 · 中文历史解说",
    description: "中文单语人物故事，悬疑叙事，对标「原点档案」调性。",
    primaryLanguage: "zh",
    bilingual: false,
    scriptLabel: "中文文案",
    scriptPlaceholder: "粘贴或生成中文人物故事文案…",
    defaultContentFormat: "Narrative story",
    defaultVisualStyle: "Photorealistic",
    visualTone: "realistic historical reconstruction with dark cinematic lighting",
    planningStyle: "third-person storytelling with suspense hooks and layered reveals",
    tts: Object.freeze({
      provider: "doubao",
      voice: "zh_male_xuanyijieshuo_uranus_bigtts", // 悬疑解说 2.0
      model: "seed-tts-2.0",
      speed: 0.9,
      speechRate: -10, // 豆包 speech_rate（-50~100，负值为慢速）
    }),
    subtitleFont: "KaiTi",
    coverStyle: "story-dark",
  }),

  "micro-learning": Object.freeze({
    id: "micro-learning",
    label: "Micro learning",
    labelZh: "微专业知识",
    description: "Everyday questions explained through one memorable mechanism.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "Why are airplane windows round?",
    defaultContentFormat: "Educational explainer", defaultVisualStyle: "Photorealistic",
    visualTone: "clear everyday objects, satisfying close-ups, and simple explanatory cutaways",
    planningStyle: "fast, concrete explanation: question, surprising mechanism, everyday payoff",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "career-inside": Object.freeze({
    id: "career-inside",
    label: "Career inside",
    labelZh: "职业揭秘",
    description: "Inside a job most viewers never get to see.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "A Day Inside a Nuclear Power Plant",
    defaultContentFormat: "Career explainer", defaultVisualStyle: "Photorealistic",
    visualTone: "authentic workplace procedures, tools, uniforms, and operational scale",
    planningStyle: "immersive day-in-the-life progression with accurate process and safety context",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "civilization-comparison": Object.freeze({
    id: "civilization-comparison",
    label: "Civilization comparison",
    labelZh: "文明比较",
    description: "Compare institutions, geography, and choices across civilizations.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "Why Europe never developed the imperial examination?",
    defaultContentFormat: "Comparative explainer", defaultVisualStyle: "Cinematic illustration",
    visualTone: "period-accurate parallel worlds, maps, institutions, and material culture",
    planningStyle: "fair side-by-side comparison built around one precise question; avoid simplistic winners",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "engineering-explained": Object.freeze({
    id: "engineering-explained",
    label: "Engineering explained",
    labelZh: "工程揭秘",
    description: "Reveal the constraints and mechanisms inside engineered systems.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "Why don't bridges fall down?",
    defaultContentFormat: "Engineering explainer", defaultVisualStyle: "Technical 3D illustration",
    visualTone: "industrial realism, clean cutaways, structural details, and scale references",
    planningStyle: "begin with the visible puzzle, then reveal forces, constraints, and the design solution",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "map-story": Object.freeze({
    id: "map-story",
    label: "Map story",
    labelZh: "地图故事",
    description: "Use geography and maps to explain a surprising world fact.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "Why is Chile so long?",
    defaultContentFormat: "Geographic explainer", defaultVisualStyle: "Editorial collage",
    visualTone: "crisp maps, satellite geography, routes, borders, and real landscapes",
    planningStyle: "make the map the protagonist: reveal a geographic surprise, then explain its cause and consequence",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "time-travel": Object.freeze({
    id: "time-travel",
    label: "Time travel",
    labelZh: "时间旅行",
    description: "A second-person, immersive visit to another time and place.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "You wake up in 1898 Paris",
    defaultContentFormat: "Immersive POV story", defaultVisualStyle: "Cinematic illustration",
    visualTone: "first-person cinematic immersion with period-accurate sensory detail",
    planningStyle: "second-person POV: place the viewer in a specific moment, then guide discoveries in chronological real time",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "world-systems": Object.freeze({
    id: "world-systems",
    label: "World systems",
    labelZh: "世界运行机制",
    description: "Explain the invisible systems that keep the modern world running.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "Why doesn't the internet break?",
    defaultContentFormat: "Systems explainer", defaultVisualStyle: "Photorealistic",
    visualTone: "global infrastructure, networks, control rooms, routes, and real-world scale",
    planningStyle: "trace one familiar outcome backward through the hidden global system that enables it",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "why-everything": Object.freeze({
    id: "why-everything",
    label: "Why everything",
    labelZh: "一切都有原因",
    description: "Answer the hidden reason behind an ordinary design choice.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "Why do supermarkets hide milk?",
    defaultContentFormat: "Why explainer", defaultVisualStyle: "Photorealistic",
    visualTone: "recognizable everyday spaces, products, and behavioral details",
    planningStyle: "lead with an everyday mystery, expose the incentive or constraint, and close with a new way to notice it",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "failure-case": Object.freeze({
    id: "failure-case",
    label: "Failure case",
    labelZh: "失败案例",
    description: "Explain a notable failure through decisions, constraints, and consequences.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "Why did Concorde disappear?",
    defaultContentFormat: "Case study", defaultVisualStyle: "Photorealistic",
    visualTone: "real archival context, pivotal decisions, product details, and consequential moments",
    planningStyle: "open at the irreversible failure, reconstruct the chain of causes, and end with the lesson without hindsight smugness",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),

  "rules-explained": Object.freeze({
    id: "rules-explained",
    label: "Rules explained",
    labelZh: "规则",
    description: "Reveal why a country, industry, or public system has a rule.",
    primaryLanguage: "zh", bilingual: false,
    scriptLabel: "中文文案", scriptPlaceholder: "Why does Britain drive on the left?",
    defaultContentFormat: "Rules explainer", defaultVisualStyle: "Photorealistic",
    visualTone: "real public spaces, signage, people following systems, and geographic context",
    planningStyle: "state the surprising rule, show the problem it solves, then explain its historical and practical tradeoffs",
    tts: Object.freeze({ provider:"minimax", voice:"English_Trustworthy_Man", model:"speech-2.8-hd", speed:1 }),
    subtitleFont: "Arial", coverStyle: "documentary",
  }),
});

// 规范化的 genre id：未知值回落到 documentary，保证向下兼容。
export function genreId(value) {
  return GENRES[value] ? value : "documentary";
}

// 读取一份完整 genre 配置，缺省回落 documentary。
export function getGenre(value) {
  return GENRES[genreId(value)];
}

// 供 UI 下拉 / 模板选择使用。
export const GENRE_LIST = Object.freeze(Object.values(GENRES));
