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
