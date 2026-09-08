import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildSubtitleAss, completeText, generateDocumentaryScript, generateImage, generateImageGroup, generateStoryScript, generateVideo, getProviderStatus, persistGeneratedImage, persistGeneratedVideo, planEpisode, prepareProviderImage, renderDimensions, renderEpisode, stillMotionFilter, streamImageGroup, supportsImageGroups, synthesizeSpeech, testProviderConnection, transcribeAudio } from "../scripts/render-service.mjs";

const ppmBytes = Buffer.concat([Buffer.from("P6\n2 2\n255\n"), Buffer.from([92,54,36, 170,116,66, 42,55,53, 206,176,119])]);
const png = `data:image/x-portable-pixmap;base64,${ppmBytes.toString("base64")}`;

function narrationWav(seconds = 1.7, sampleRate = 48000) {
  const samples = Math.floor(seconds * sampleRate); const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 140 * index / sampleRate) * 6000), index * 2);
  const header = Buffer.alloc(44); header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8); header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return `data:audio/wav;base64,${Buffer.concat([header, data]).toString("base64")}`;
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    let stdout = ""; let stderr = ""; child.stdout.on("data", (d) => stdout += d); child.stderr.on("data", (d) => stderr += d);
    child.on("close", (code) => code === 0 ? resolve(Number(stdout.trim())) : reject(new Error(stderr)));
  });
}

function probeVideoSize(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", file]);
    let stdout = ""; let stderr = ""; child.stdout.on("data", (d) => stdout += d); child.stderr.on("data", (d) => stderr += d);
    child.on("close", (code) => { const [width, height] = stdout.trim().split("x").map(Number); if (code !== 0) { reject(new Error(stderr)); return; } resolve({ width, height }); });
  });
}

async function generatedClipDataUrl(dir, name = "clip", color = "0x38566b") {
  const output = path.join(dir, `${name}.mp4`);
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=180x320:r=30`, "-t", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", output]);
    let stderr = ""; child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  return `data:video/mp4;base64,${(await readFile(output)).toString("base64")}`;
}

async function generatedJpegDataUrl(dir, name = "still", color = "0xc06020") {
  const output = path.join(dir, `${name}.jpg`);
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=180x320`, "-frames:v", "1", "-update", "1", output]);
    let stderr = ""; child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  return `data:image/jpeg;base64,${(await readFile(output)).toString("base64")}`;
}

async function generatedClipWithToneDataUrl(dir, name = "toned", color = "0x38566b") {
  const output = path.join(dir, `${name}.mp4`);
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=180x320:r=30`, "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", output]);
    let stderr = ""; child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  return `data:video/mp4;base64,${(await readFile(output)).toString("base64")}`;
}

function probeMaxVolume(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "info", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
    let stderr = ""; child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(stderr)); return; }
      const match = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
      resolve(match ? Number(match[1]) : -Infinity);
    });
  });
}

function samplePixel(file, at) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", file, "-ss", String(at), "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const chunks = []; let stderr = "";
    child.stdout.on("data", (data) => chunks.push(data)); child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => code === 0 ? resolve([...Buffer.concat(chunks).subarray(0, 3)]) : reject(new Error(stderr)));
  });
}

function pngDimensions(value) {
  const data = Buffer.from(String(value).split(",")[1], "base64");
  assert.equal(data.subarray(1, 4).toString(), "PNG");
  return { width:data.readUInt32BE(16), height:data.readUInt32BE(20) };
}

test("subtitle ASS uses the editable episode style", () => {
  const ass = buildSubtitleAss([{ start:0, end:1.25, narration:"English {line}", chinese:"中文" }], 1080, 1920, {
    fontFamily:"Georgia", fontScale:150, englishColor:"#112233", chineseColor:"#abcdef", backgroundColor:"#123456",
    backgroundOpacity:80, position:25, alignment:"left", bold:false, outline:3.5,
  });
  assert.match(ass, /Style: Main,Georgia,81,&H00332211,&H000000FF,&H00563412,&HFF000000,0,0,0,0,100,100,0,0,1,3\.5,0,1,70,70,480,1/);
  assert.match(ass, /Style: Box,Arial,1,&H33563412,&H33563412,&H33563412,&H33563412/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.25,Box,,0,0,0,,\{\\an7\\pos\(70,1202\)\\p1\}m 0 0 l 940 0 l 940 266 l 0 266\{\\p0\}/);
  assert.match(ass, /English （line）\\N\{\\c&HEFCDAB&\}中文/);
  assert.doesNotMatch(buildSubtitleAss([{ start:0, end:1, narration:"No box" }], 1080, 1920, { backgroundOpacity:0 }), /,Box,,/);
});

test("landscape subtitle sizing increases 260 percent text to 180 pixels", () => {
  const ass = buildSubtitleAss([{ start:0, end:1, narration:"Landscape caption" }], 1920, 1080, {
    fontScale:260, position:5,
  });
  assert.match(ass, /Style: Main,Arial,180,/);
  assert.match(ass, /,125,125,54,1\n/);
});

test("subtitle ASS cues follow transcription word timestamps, not planned shot times", () => {
  // Planned shot times diverge from the speech: the opening is pinned to 5s on
  // the timeline, but its narration actually runs 0–16s in the recording.
  const shots = [
    { index:0, start:0, end:5, duration:5, narration:"Welcome back to history.", chinese:"欢迎回到历史。" },
    { index:1, start:5, end:10, duration:5, narration:"Today we explore Rome.", chinese:"今天我们探索罗马。" },
  ];
  const transcription = { duration:32, segments:[{ start:0, end:32, words:[
    { start:0, end:4, word:"Welcome" }, { start:4, end:8, word:"back" },
    { start:8, end:12, word:"to" }, { start:12, end:16, word:"history." },
    { start:16, end:20, word:"Today" }, { start:20, end:24, word:"we" },
    { start:24, end:28, word:"explore" }, { start:28, end:32, word:"Rome." },
  ] }] };
  const ass = buildSubtitleAss(shots, 1080, 1920, {}, false, "", 4, transcription);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:16\.00,Main,,0,0,0,,Welcome back to history\./);
  assert.match(ass, /Dialogue: 1,0:00:16\.00,0:00:32\.00,Main,,0,0,0,,Today we explore Rome\./);
  // Without a transcription, cues fall back to the planned shot timing.
  const planned = buildSubtitleAss(shots, 1080, 1920, {}, false, "", 4);
  assert.match(planned, /Dialogue: 1,0:00:00\.00,0:00:05\.00,Main,,0,0,0,,Welcome back to history\./);
  assert.match(planned, /Dialogue: 1,0:00:05\.00,0:00:10\.00,Main,,0,0,0,,Today we explore Rome\./);
});

test("documentary script generation asks for a climax-first video hook", async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ title:"The Fall of a City", script:"The gates break at dawn. What happened next changed the kingdom." }) } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateDocumentaryScript({ endpoint:"https://openai.example.test/chat/completions", model:"test-model", apiKey:"test-key", topic:"The fall of Constantinople", duration:3 }, { fetchImpl });
  const system = request.messages[0].content;
  assert.match(system, /first two spoken sentences as a cold open for a video hook/);
  assert.match(system, /Sentence 1 must begin inside the story's most vivid, verified climax/);
  assert.match(system, /Keep these two sentences concise and visually arresting/);
  assert.deepEqual(result, { title:"The Fall of a City", script:"The gates break at dawn. What happened next changed the kingdom." });
});

test("template script generation includes the selected editorial direction", async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ title:"Why Bridges Stand", script:"A bridge carries its load through a carefully balanced structure." }) } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  await generateDocumentaryScript({ endpoint:"https://openai.example.test/chat/completions", model:"test-model", apiKey:"test-key", genre:"engineering-explained", topic:"Why bridges do not fall", duration:3 }, { fetchImpl });
  assert.match(request.messages[0].content, /SELECTED CONTENT TEMPLATE: Engineering explained/);
  assert.match(request.messages[0].content, /reveal forces, constraints, and the design solution/);
});

test("Chinese templates generate Chinese knowledge scripts instead of history stories", async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ title:"大桥为什么不会倒", script:"桥梁把重量分散到结构和地基上。" }) } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  await generateStoryScript({ endpoint:"https://openai.example.test/chat/completions", model:"test-model", apiKey:"test-key", genre:"engineering-explained", topic:"为什么桥不会倒", duration:3 }, { fetchImpl });
  assert.match(request.messages[0].content, /中文短视频知识类解说编剧/);
  assert.match(request.messages[0].content, /工程揭秘/);
  assert.match(request.messages[0].content, /forces, constraints, and the design solution/);
});

test("local renderer produces a playable vertical MP4", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-test-")); const output = path.join(dir, "episode.mp4");
  const result = await renderEpisode({ title:"Test", width:360, height:640, bgmPreset:"None", narrationData:narrationWav(), voicePreset:"documentary", subtitleStyle:{ fontScale:125, chineseColor:"#00ff00", backgroundOpacity:70, alignment:"right" }, shots:[
    { duration:.8, image:png, narration:"The prototype starts before dawn.", chinese:"原型机在黎明前启动。" },
    { duration:.8, image:png, narration:"The test finishes successfully.", chinese:"测试顺利完成。" },
  ] }, { id:`test-${Date.now()}`, output });
  const info = await stat(output); const duration = await probe(output);
  assert.ok(info.size > 5000); assert.ok(duration >= 1.5 && duration <= 1.8); assert.equal(result.duration, 1.7);
  assert.equal(result.subtitleStyle.fontScale, 125); assert.equal(result.subtitleStyle.chineseColor, "#00ff00"); assert.equal(result.subtitleStyle.backgroundOpacity, 70); assert.equal(result.subtitleStyle.alignment, "right");
});

test("local renderer preserves a landscape output canvas", { timeout:120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-landscape-test-")); const output = path.join(dir, "episode.mp4");
  await renderEpisode({ width:640, height:360, narrationData:narrationWav(.8), voicePreset:"original", shots:[
    { duration:.7, image:png, narration:"A landscape frame.", chinese:"横屏画面。" },
  ] }, { id:`landscape-${Date.now()}`, output });
  assert.deepEqual(await probeVideoSize(output), { width:640, height:360 });
});

test("local renderer mixes a selected built-in BGM", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-bgm-test-")); const output = path.join(dir, "episode.mp4");
  await renderEpisode({ title:"BGM Test", width:360, height:640, bgmPath:"/bgm/monume-documentary-documentary-music-547923.mp3", narrationData:narrationWav(), voicePreset:"natural", shots:[
    { duration:1.6, image:png, narration:"Music plays beneath this line.", chinese:"音乐在旁白下播放。" },
  ] }, { id:`bgm-test-${Date.now()}`, output });
  const info = await stat(output); const duration = await probe(output);
  assert.ok(info.size > 5000); assert.ok(duration >= 1.5 && duration <= 1.8);
});

test("local renderer normalizes and concatenates generated video clips", { timeout:120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-clip-test-")); const output = path.join(dir, "episode.mp4");
  const video = await generatedClipDataUrl(dir);
  const result = await renderEpisode({ width:360, height:640, narrationData:narrationWav(1.2), voicePreset:"original", shots:[
    { duration:1.1, video, image:png, narration:"A real generated clip moves.", chinese:"真实生成的片段开始运动。" },
  ] }, { id:`clip-test-${Date.now()}`, output });
  const info = await stat(output); const duration = await probe(output);
  assert.ok(info.size > 5000); assert.ok(duration >= 1 && duration <= 1.3); assert.equal(result.clipsUsed, 1);
});

test("local renderer keeps generated clip audio in the final export", { timeout:120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-clip-audio-test-")); const output = path.join(dir, "episode.mp4");
  const video = await generatedClipWithToneDataUrl(dir);
  await renderEpisode({ width:360, height:640, shots:[
    { duration:1.1, video, image:png, narration:"Clip audio should survive.", chinese:"片段音频应保留。" },
  ] }, { id:`clip-audio-test-${Date.now()}`, output });
  const maxVolume = await probeMaxVolume(output);
  assert.ok(maxVolume > -30, `Expected the export to keep the clip's audio track, max_volume=${maxVolume} dB`);
});

test("local renderer mixes generated clip audio with narration", { timeout:120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-clip-mix-test-")); const output = path.join(dir, "episode.mp4");
  const video = await generatedClipWithToneDataUrl(dir);
  await renderEpisode({ width:360, height:640, narrationData:narrationWav(1.2), voicePreset:"original", shots:[
    { duration:1.1, video, image:png, narration:"Clip audio mixes under narration.", chinese:"片段音频与旁白混合。" },
  ] }, { id:`clip-mix-test-${Date.now()}`, output });
  const maxVolume = await probeMaxVolume(output);
  assert.ok(maxVolume > -30, `Expected audible audio in the mixed export, max_volume=${maxVolume} dB`);
});

test("local renderer keeps image shots visible after generated clips", { timeout:120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-mixed-test-")); const output = path.join(dir, "episode.mp4");
  const blueClip = await generatedClipDataUrl(dir, "blue", "0x204060");
  const greenClip = await generatedClipDataUrl(dir, "green", "0x206040");
  const orangeStill = await generatedJpegDataUrl(dir);
  const result = await renderEpisode({ width:360, height:640, narrationData:narrationWav(4), voicePreset:"original", shots:[
    { duration:1, video:blueClip, image:orangeStill, narration:"Blue clip.", chinese:"蓝色视频。" },
    { duration:1, image:orangeStill, narration:"Still image.", chinese:"静态图片。" },
    { duration:1, video:greenClip, image:orangeStill, narration:"Green clip.", chinese:"绿色视频。" },
    { duration:1, image:orangeStill, narration:"Final still image.", chinese:"最后一张图片。" },
  ] }, { id:`mixed-test-${Date.now()}`, output });
  const duration = await probe(output);
  const greenPixel = await samplePixel(output, 2.5);
  const finalPixel = await samplePixel(output, 3.8);
  assert.ok(duration >= 3.9 && duration <= 4.1); assert.equal(result.clipsUsed, 2);
  assert.ok(Math.abs(finalPixel[0] - greenPixel[0]) + Math.abs(finalPixel[1] - greenPixel[1]) + Math.abs(finalPixel[2] - greenPixel[2]) > 25, `Expected final still to replace the preceding clip; green=${greenPixel}, final=${finalPixel}`);
});

test("local renderer stretches old storyboard timing to the narration duration", { timeout:120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-narration-clock-test-")); const output = path.join(dir, "episode.mp4");
  const result = await renderEpisode({ width:360, height:640, narrationData:narrationWav(4), voicePreset:"original", shots:[
    { duration:1, image:png, narration:"First narrated section.", chinese:"第一段解说。" },
    { duration:1, image:png, narration:"Second narrated section.", chinese:"第二段解说。" },
  ] }, { id:`narration-clock-${Date.now()}`, output });
  assert.ok(Math.abs(result.duration - 4) < .02);
  assert.ok(Math.abs((await probe(output)) - 4) < .1);
});

test("local renderer reports staged progress events", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-progress-test-")); const output = path.join(dir, "episode.mp4");
  const events = [];
  await renderEpisode({ width:360, height:640, narrationData:narrationWav(), voicePreset:"original", shots:[
    { duration:.8, image:png, narration:"First shot.", chinese:"第一个镜头。" },
    { duration:.8, image:png, narration:"Second shot.", chinese:"第二个镜头。" },
  ] }, { id:`progress-${Date.now()}`, output, onProgress:(event) => events.push(event) });
  assert.equal(events[0].stage, "Preparing sources");
  assert.deepEqual(events.filter((event) => event.stage.startsWith("Encoding shot")).map((event) => event.stage), ["Encoding shot 1/2", "Encoding shot 2/2"]);
  assert.deepEqual(events.map((event) => event.totalShots), events.map(() => 2));
  assert.ok(events.some((event) => event.stage === "Processing narration"));
  assert.ok(events.some((event) => event.stage === "Writing subtitles"));
  assert.equal(events.at(-1).stage, "Final assembly");
  const percents = events.map((event) => event.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
  assert.ok(percents.at(-1) < 100);
});

test("still motion filter maps shot motion to a non-resetting zoompan", () => {
  const push = stillMotionFilter("Slow push-in", 1080, 1920, 3, 0);
  assert.ok(push.includes("zoompan=z='1+0.14*on/90'"));
  assert.ok(!push.includes("mod("));
  assert.ok(push.includes("scale=3240:5760"));
  const drift = stillMotionFilter("Slow drift", 1080, 1920, 3, 1);
  assert.ok(drift.includes("z='1.12'"));
  assert.ok(drift.includes("x='(iw-iw/zoom)*(1-on/90)'"));
  const pull = stillMotionFilter("Slow pull-out", 1080, 1920, 3, 0);
  assert.ok(pull.includes("z='1.14-0.14*on/90'"));
  const rise = stillMotionFilter("Slow rise", 1080, 1920, 3, 0);
  assert.ok(rise.includes("y='(ih-ih/zoom)*on/90'"));
  const sink = stillMotionFilter("Slow sink", 1080, 1920, 3, 0);
  assert.ok(sink.includes("y='(ih-ih/zoom)*(1-on/90)'"));
  const diagonal = stillMotionFilter("Diagonal drift", 1080, 1920, 3, 0);
  assert.ok(diagonal.includes("x='(iw-iw/zoom)*on/90'") && diagonal.includes("y='(ih-ih/zoom)*on/90'"));
  const subject = stillMotionFilter("Push to subject", 1080, 1920, 3, 0);
  assert.ok(subject.includes("z='1+0.16*on/90'") && subject.includes("y='(ih-ih/zoom)/3'"));
  const subtle = stillMotionFilter("Static", 1080, 1920, 3, 0);
  assert.ok(subtle.includes("z='1+0.04*on/90'"));
  const fallback = stillMotionFilter(undefined, 1080, 1920, 3, 2);
  assert.ok(fallback.includes("z='1.14-0.14*on/90'"));
});

test("render dimensions preserve landscape, square, and portrait export ratios", () => {
  assert.deepEqual(renderDimensions({ width:1920, height:1080 }), { width:1920, height:1080 });
  assert.deepEqual(renderDimensions({ width:1080, height:1080 }), { width:1080, height:1080 });
  assert.deepEqual(renderDimensions({ width:1080, height:1920 }), { width:1080, height:1920 });
  assert.deepEqual(renderDimensions({ width:640, height:360 }), { width:640, height:360 });
  assert.deepEqual(renderDimensions({ width:480, height:480 }), { width:480, height:480 });
});

test("provider status reports configuration without exposing secrets", () => {
  const environment = {
    IMAGE_PROVIDER:"volcengine", IMAGE_MODEL:"seedream-test", VOLCENGINE_IMAGE_MODEL:"seedream-test",
    TEXT_PROVIDER:"openai", TEXT_MODEL:"openai-text-test", OPENAI_TEXT_MODEL:"openai-text-test",
    VIDEO_PROVIDER:"volcengine", VIDEO_MODEL:"seedance-test", VOLCENGINE_VIDEO_MODEL:"seedance-test",
    VOLCENGINE_API_KEY:"volcengine-test-secret", OPENAI_API_KEY:"openai-test-secret",
    VOLCENGINE_IMAGE_ENDPOINT:"https://volcengine.test/images",
    VOLCENGINE_VIDEO_ENDPOINT:"https://volcengine.test/videos",
    OPENAI_TEXT_ENDPOINT:"https://openai.test/chat",
    SPEECH_ENDPOINT:"http://localhost:8010", SPEECH_MODEL:"mlx-community/Kokoro-test", SPEECH_VOICE:"af_test", SPEECH_VOICES:"af_test, bf_two ,cf_three", SPEECH_LANGUAGE:"a", SPEECH_SPEED:"1.1",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const status = getProviderStatus();
    assert.deepEqual(status.image, { configured:true, kind:"volcengine", endpoint:"https://volcengine.test/images", model:"seedream-test", source:"environment" });
    assert.deepEqual(status.video, { configured:true, kind:"volcengine", endpoint:"https://volcengine.test/videos", model:"seedance-test", source:"environment" });
    assert.deepEqual(status.text, { configured:true, kind:"openai", endpoint:"https://openai.test/chat", model:"openai-text-test", source:"environment" });
    assert.deepEqual(status.speech, { configured:true, endpoint:"http://localhost:8010", model:"mlx-community/Kokoro-test", voice:"af_test", voices:["af_test", "bf_two", "cf_three"], language:"a", speed:1.1, source:"environment" });
    assert.doesNotMatch(JSON.stringify(status), /test-secret/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("local transcription proxy sends audio and word timestamp options", async () => {
  let requestUrl = ""; let form;
  const fetchImpl = async (url, options) => {
    requestUrl = url; form = options.body;
    return new Response(JSON.stringify({ text:"Hello world.", language:"en", duration:2.4, duration_after_vad:1.8, segments:[{ id:1, start:.3, end:2.1, text:" Hello world.", words:[{ start:.3, end:.8, word:" Hello", probability:.98 }, { start:.9, end:2.1, word:" world.", probability:.99 }] }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await transcribeAudio({ endpoint:"http://localhost:8000/v1/transcriptions", language:"en", filename:"recording.mp3", audioData:"data:audio/mpeg;base64,SUQz" }, { fetchImpl });
  assert.equal(requestUrl, "http://localhost:8000/v1/transcriptions");
  assert.equal(form.get("language"), "en"); assert.equal(form.get("word_timestamps"), "true"); assert.equal(form.get("file").name, "recording.mp3");
  assert.equal(result.text, "Hello world."); assert.equal(result.duration, 2.4); assert.equal(result.segments[0].words.length, 2);
});

test("MLX Audio synthesis proxy requests WAV narration with voice controls", async () => {
  let requestUrl = ""; let request;
  const wav = Buffer.from("RIFF-test-wave");
  const fetchImpl = async (url, options) => {
    requestUrl = url; request = options;
    return new Response(wav, { status:200, headers:{ "Content-Type":"audio/wav" } });
  };
  const result = await synthesizeSpeech({
    speechEndpoint:"http://localhost:8010",
    speechModel:"mlx-community/Kokoro-82M-bf16",
    speechVoice:"af_heart",
    speechLanguage:"a",
    speechSpeed:1.15,
    speechInstruct:"Measured documentary narration",
    input:"This is the episode narration.",
  }, { fetchImpl });
  assert.equal(requestUrl, "http://localhost:8010/v1/audio/speech");
  assert.equal(request.method, "POST");
  assert.deepEqual(JSON.parse(request.body), {
    model:"mlx-community/Kokoro-82M-bf16",
    input:"This is the episode narration.",
    voice:"af_heart",
    speed:1.15,
    lang_code:"a",
    instruct:"Measured documentary narration",
    response_format:"wav",
    stream:false,
  });
  assert.equal(result.audioData, `data:audio/wav;base64,${wav.toString("base64")}`);
  assert.equal(result.filename, "mlx-af_heart.wav");
});

test("MLX Audio provider test uses the OpenAI-compatible model endpoint", async () => {
  let requestUrl = "";
  const result = await testProviderConnection({ target:"speech", speechEndpoint:"http://localhost:8010/v1/audio/speech", speechModel:"mlx-community/Kokoro-82M-bf16" }, {
    fetchImpl:async (url) => { requestUrl = url; return new Response(JSON.stringify({ object:"list", data:[] }), { status:200, headers:{ "Content-Type":"application/json" } }); },
  });
  assert.equal(requestUrl, "http://localhost:8010/v1/models");
  assert.equal(result.target, "speech");
  assert.equal(result.model, "mlx-community/Kokoro-82M-bf16");
});

test("Volcengine image adapter sends a vertical Seedream request", async () => {
  let requestUrl = ""; let request;
  const fetchImpl = async (url, options) => {
    requestUrl = url; request = options;
    return new Response(JSON.stringify({ data:[{ url:"https://example.test/seedream.png" }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const image = await generateImage({ kind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/v3/images/generations", model:"doubao-seedream-5-0-pro-260628", apiKey:"ark-test", prompt:"A vertical cinematic scene" }, { fetchImpl });
  const payload = JSON.parse(request.body);
  assert.equal(requestUrl, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
  assert.equal(request.headers.Authorization, "Bearer ark-test"); assert.equal(payload.size, "2k"); assert.equal(payload.watermark, false);
  assert.equal(image, "https://example.test/seedream.png");
});

test("image adapters use the selected screen ratio", async () => {
  let volcengineRequest; let openaiRequest;
  const volcengineFetch = async (_url, options) => {
    volcengineRequest = JSON.parse(options.body);
    return new Response(JSON.stringify({ data:[{ url:"https://example.test/landscape.png" }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const openaiFetch = async (_url, options) => {
    openaiRequest = JSON.parse(options.body);
    return new Response(JSON.stringify({ data:[{ b64_json:"AA==" }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  await generateImage({ kind:"volcengine", endpoint:"https://example.test", model:"seedream", apiKey:"key", prompt:"Scene", screenRatio:"16:9" }, { fetchImpl:volcengineFetch });
  await generateImage({ kind:"openai", endpoint:"https://example.test/images", model:"gpt-image", apiKey:"key", prompt:"Scene", screenRatio:"1:1" }, { fetchImpl:openaiFetch });
  assert.equal(volcengineRequest.size, "2k");
  assert.match(volcengineRequest.prompt, /16:9 screen ratio/);
  assert.equal(openaiRequest.size, "1024x1024");
});

test("Volcengine group image adapter sends up to ten sequential 2k storyboard scenes", async () => {
  let request;
  const images = await generateImageGroup({ kind:"volcengine", endpoint:"https://example.test", model:"doubao-seedream-5-0-lite", apiKey:"key", screenRatio:"9:16", shots:[{ id:"one", prompt:"A detective enters a station" }, { id:"two", prompt:"The detective examines a clue" }] }, { fetchImpl:async (_url, options) => {
    request = options;
    return new Response(JSON.stringify({ data:[{ url:"https://example.test/one.png" }, { url:"https://example.test/two.png" }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  } });
  const payload = JSON.parse(request.body);
  assert.equal(payload.size, "2k"); assert.equal(payload.sequential_image_generation, "auto"); assert.equal(payload.sequential_image_generation_options.max_images, 2); assert.equal(payload.stream, false);
  assert.match(payload.prompt, /Scene 1:/); assert.match(payload.prompt, /Scene 2:/);
  assert.deepEqual(images, ["https://example.test/one.png", "https://example.test/two.png"]);
});

test("only documented Seedream models use sequential image generation", () => {
  assert.equal(supportsImageGroups("doubao-seedream-5-0-lite"), true);
  assert.equal(supportsImageGroups("doubao-seedream-4-5-251128"), true);
  assert.equal(supportsImageGroups("doubao-seedream-4-0-250828"), true);
  assert.equal(supportsImageGroups("doubao-seedream-5-0-260128"), true);
  assert.equal(supportsImageGroups("doubao-seedream-5-0-pro-260628"), false);
  assert.equal(supportsImageGroups("doubao-seedream-5-0-260127"), false);
});

test("Volcengine group image adapter retries a transient Ark timeout once", async () => {
  let attempts = 0;
  const images = await generateImageGroup({ kind:"volcengine", endpoint:"https://example.test", model:"doubao-seedream-5-0-lite", apiKey:"key", shots:[{ id:"one", prompt:"A detective enters a station" }] }, { fetchImpl:async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new TypeError("fetch failed"), { cause:{ code:"UND_ERR_HEADERS_TIMEOUT" } });
    return new Response(JSON.stringify({ data:[{ url:"https://example.test/one.png" }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  }, sleepImpl:async () => {} });
  assert.equal(attempts, 2);
  assert.deepEqual(images, ["https://example.test/one.png"]);
});

test("Volcengine streamed group images emit each completed image in order", async () => {
  const received = [];
  await streamImageGroup({ kind:"volcengine", endpoint:"https://example.test", model:"doubao-seedream-5-0-260128", apiKey:"key", shots:[{ id:"one", prompt:"First scene" }, { id:"two", prompt:"Second scene" }] }, async (image, shot) => received.push({ image, id:shot.id }), { fetchImpl:async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    const encoder = new TextEncoder();
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('data: {"data":[{"url":"https://example.test/one.png"}]}\n'));
      controller.enqueue(encoder.encode('\ndata: {"data":[{"url":"https://example.test/two.png"}]}\n\n'));
      controller.close();
    } });
    return new Response(body, { status:200, headers:{ "Content-Type":"text/event-stream" } });
  } });
  assert.deepEqual(received, [{ image:"https://example.test/one.png", id:"one" }, { image:"https://example.test/two.png", id:"two" }]);
});

test("Volcengine single-shot repair includes adjacent reference images", async () => {
  let request;
  await generateImage({ kind:"volcengine", endpoint:"https://example.test", model:"doubao-seedream-4-0-250828", apiKey:"key", prompt:"Repair the scene", referenceImages:["https://example.test/previous.png", "https://example.test/next.png"] }, { fetchImpl:async (_url, options) => {
    request = options;
    return new Response(JSON.stringify({ data:[{ url:"https://example.test/repaired.png" }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  } });
  assert.deepEqual(JSON.parse(request.body).image, ["https://example.test/previous.png", "https://example.test/next.png"]);
});

test("Volcengine Agent Plan image adapter accepts the documented API base URL", async () => {
  let requestUrl = ""; let request;
  const fetchImpl = async (url, options) => {
    requestUrl = url; request = options;
    return new Response(JSON.stringify({ data:[{ url:"https://example.test/plan-image.png" }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  await generateImage({ kind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/plan/v3", model:"doubao-seedream-5.0-lite", apiKey:"plan-test", prompt:"A vertical cinematic scene" }, { fetchImpl });
  const payload = JSON.parse(request.body);
  assert.equal(requestUrl, "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations");
  assert.equal(payload.model, "doubao-seedream-5.0-lite");
});

test("video first frames are cropped to the selected screen ratio before submission", { timeout:120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-video-frame-test-"));
  assert.deepEqual(pngDimensions(await prepareProviderImage(png, "16:9", { workDir:dir })), { width:1920, height:1080 });
  assert.deepEqual(pngDimensions(await prepareProviderImage(png, "9:16", { workDir:dir })), { width:1080, height:1920 });
  assert.deepEqual(pngDimensions(await prepareProviderImage(png, "1:1", { workDir:dir })), { width:1080, height:1080 });
});

test("Volcengine video adapter creates and polls an image-to-video task", async () => {
  const requests = []; let poll = 0;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ id:"cgt-test-123" }), { status:200, headers:{ "Content-Type":"application/json" } });
    poll += 1;
    return new Response(JSON.stringify(poll === 1 ? { id:"cgt-test-123", status:"running" } : { id:"cgt-test-123", status:"succeeded", duration:"3", content:{ video_url:"https://example.test/generated.mp4" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateVideo({ videoKind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", model:"doubao-seedance-2-0-260128", apiKey:"ark-test", videoPrompt:"Rain streams diagonally across the window while the subject breathes naturally", image:png, motion:"Slow push-in", duration:2.4 }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].url, "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
  assert.equal(requests[0].options.headers.Authorization, "Bearer ark-test");
  assert.equal(payload.model, "doubao-seedance-2-0-260128");
  assert.equal(payload.content[1].role, "first_frame"); assert.deepEqual(pngDimensions(payload.content[1].image_url.url), { width:1080, height:1920 });
  assert.match(payload.content[0].text, /Rain streams diagonally/);
  assert.match(payload.content[0].text, /Camera direction override: Slow push-in/);
  assert.doesNotMatch(payload.content[0].text, /--ratio|--dur|--resolution/);
  assert.equal(payload.duration, 3); assert.equal(payload.ratio, "9:16"); assert.equal(payload.resolution, "1080p");
  assert.equal(payload.generate_audio, false); assert.equal(payload.watermark, false);
  assert.equal(requests[2].url, "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-test-123");
  assert.equal(result.videoUrl, "https://example.test/generated.mp4"); assert.equal(result.taskId, "cgt-test-123");
});

test("Volcengine video adapter retries with a lower resolution when the model rejects it", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") {
      const payload = JSON.parse(options.body);
      if (payload.resolution === "1080p") return new Response(JSON.stringify({ error:{ message:"the parameter resolution specified in the request is not valid for model doubao-seedance-2-0-fast in i2v" } }), { status:400, headers:{ "Content-Type":"application/json" } });
      return new Response(JSON.stringify({ id:"fast-task" }), { status:200, headers:{ "Content-Type":"application/json" } });
    }
    return new Response(JSON.stringify({ id:"fast-task", status:"succeeded", content:{ video_url:"https://example.test/fast.mp4" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateVideo({ videoKind:"volcengine", endpoint:"https://ark.example.test", model:"doubao-seedance-2-0-fast", apiKey:"key", image:png, duration:3 }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  assert.deepEqual(requests.filter((request) => request.options.method === "POST").map((request) => JSON.parse(request.options.body).resolution), ["1080p", "720p"]);
  assert.equal(result.videoUrl, "https://example.test/fast.mp4");
});

test("Volcengine video adapter creates a direct text-to-video long scene without an image", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ id:"text-video-task" }), { status:200, headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ id:"text-video-task", status:"succeeded", duration:"10", content:{ video_url:"https://example.test/long-scene.mp4" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateVideo({ videoKind:"volcengine", endpoint:"https://ark.example.test", model:"seedance", apiKey:"key", generationMode:"long-scenes", videoPrompt:"An engineer enters the laboratory, crosses to the prototype, and activates its blue control lights", motion:"Slow drift", duration:10, screenRatio:"9:16" }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.content.length, 1);
  assert.equal(payload.content[0].type, "text");
  assert.match(payload.content[0].text, /Generate the full scene directly/i);
  assert.doesNotMatch(payload.content[0].text, /supplied image|exact first frame/i);
  assert.equal(payload.duration, 10);
  assert.equal(result.videoUrl, "https://example.test/long-scene.mp4");
});

test("Volcengine Agent Plan video adapter accepts the documented base URL and model name", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ id:"plan-video-task" }), { status:200, headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ id:"plan-video-task", status:"succeeded", content:{ video_url:"https://example.test/plan-video.mp4" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  await generateVideo({ videoKind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/plan/v3", model:"doubao-seedance-2.0", apiKey:"plan-test", image:png, duration:5 }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].url, "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks");
  assert.equal(requests[1].url, "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks/plan-video-task");
  assert.equal(payload.model, "doubao-seedance-2.0");
  assert.equal(payload.duration, 5); assert.equal(payload.ratio, "9:16"); assert.equal(payload.generate_audio, false);
});

test("Volcengine video adapter uses the selected screen ratio", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ id:"square-task" }), { status:200, headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ id:"square-task", status:"succeeded", content:{ video_url:"https://example.test/square.mp4" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  await generateVideo({ videoKind:"volcengine", endpoint:"https://example.test", model:"seedance", apiKey:"key", image:png, screenRatio:"1:1" }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.ratio, "1:1");
  assert.deepEqual(pngDimensions(payload.content[1].image_url.url), { width:1080, height:1080 });
  assert.match(payload.content[0].text, /Square 1:1 screen ratio/);
});

test("DashScope video adapter creates and polls a Wan image-to-video task", async () => {
  const requests = []; let poll = 0;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ output:{ task_id:"ds-task-123", task_status:"PENDING" }, request_id:"req-1" }), { status:200, headers:{ "Content-Type":"application/json" } });
    poll += 1;
    return new Response(JSON.stringify(poll === 1 ? { output:{ task_id:"ds-task-123", task_status:"RUNNING" } } : { output:{ task_id:"ds-task-123", task_status:"SUCCEEDED", video_url:"https://example.test/wan.mp4" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateVideo({ videoKind:"dashscope", endpoint:"https://llm-workspace.cn-beijing.maas.aliyuncs.com", model:"wan3.0-video", apiKey:"sk-dashscope-test", videoPrompt:"Rain streams diagonally across the window while the subject breathes naturally", image:png, motion:"Slow push-in", duration:2.4, resolution:"1080p" }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  assert.equal(requests[0].url, "https://llm-workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis");
  assert.equal(requests[0].options.headers.Authorization, "Bearer sk-dashscope-test");
  assert.equal(requests[0].options.headers["X-DashScope-Async"], "enable");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.model, "wan3.0-video");
  assert.match(payload.input.prompt, /Rain streams diagonally/);
  assert.equal(payload.input.media[0].type, "first_frame");
  assert.deepEqual(pngDimensions(payload.input.media[0].url), { width:1080, height:1920 });
  assert.equal(payload.parameters.ratio, "9:16"); assert.equal(payload.parameters.duration, 5); assert.equal(payload.parameters.resolution, "1080P");
  assert.equal(payload.parameters.prompt_extend, false); assert.equal(payload.parameters.watermark, false);
  assert.equal(requests[1].url, "https://llm-workspace.cn-beijing.maas.aliyuncs.com/api/v1/tasks/ds-task-123");
  assert.equal(result.videoUrl, "https://example.test/wan.mp4"); assert.equal(result.taskId, "ds-task-123"); assert.equal(result.status, "succeeded");
});

test("DashScope video adapter creates a long-scene text-to-video task with a 10-second clip", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ output:{ task_id:"ds-long-task", task_status:"PENDING" } }), { status:200, headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ output:{ task_id:"ds-long-task", task_status:"SUCCEEDED", video_url:"https://example.test/wan-long.mp4", duration:10 } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateVideo({ videoKind:"dashscope", endpoint:"https://dashscope.aliyuncs.com/api/v1", model:"wan3.0-video", apiKey:"key", generationMode:"long-scenes", videoPrompt:"An engineer enters the laboratory and activates its blue control lights", motion:"Slow drift", duration:10 }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis");
  assert.equal(payload.input.media, undefined);
  assert.match(payload.input.prompt, /Generate the full scene directly/i);
  assert.equal(payload.parameters.duration, 10);
  assert.equal(result.videoUrl, "https://example.test/wan-long.mp4");
  assert.equal(result.duration, 10);
});

test("DashScope video adapter retries with a lower resolution when the model rejects it", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") {
      const payload = JSON.parse(options.body);
      if (payload.parameters.resolution === "1080P") return new Response(JSON.stringify({ code:"InvalidParameter", message:"resolution is not valid for this model" }), { status:400, headers:{ "Content-Type":"application/json" } });
      return new Response(JSON.stringify({ output:{ task_id:"ds-fallback", task_status:"PENDING" } }), { status:200, headers:{ "Content-Type":"application/json" } });
    }
    return new Response(JSON.stringify({ output:{ task_id:"ds-fallback", task_status:"SUCCEEDED", video_url:"https://example.test/wan-fallback.mp4" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateVideo({ videoKind:"dashscope", endpoint:"https://dashscope.aliyuncs.com", model:"wan3.0-video", apiKey:"key", image:png, resolution:"1080p" }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  assert.deepEqual(requests.filter((request) => request.options.method === "POST").map((request) => JSON.parse(request.options.body).parameters.resolution), ["1080P", "720P"]);
  assert.equal(result.videoUrl, "https://example.test/wan-fallback.mp4");
});

test("DashScope image adapter calls the Qwen-Image multimodal generation API", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ output:{ choices:[{ finish_reason:"stop", message:{ role:"assistant", content:[{ image:"https://dashscope-result.test/output.png" }] } }] }, usage:{ image_count:1 } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateImage({ kind:"dashscope", endpoint:"https://llm-workspace.cn-beijing.maas.aliyuncs.com", model:"qwen-image-3.0-pro", apiKey:"sk-dashscope-test", prompt:"A vertical cinematic scene", screenRatio:"9:16" }, { fetchImpl });
  assert.equal(requests[0].url, "https://llm-workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.model, "qwen-image-3.0-pro");
  assert.equal(payload.input.messages[0].role, "user");
  assert.match(payload.input.messages[0].content[0].text, /A vertical cinematic scene/);
  assert.equal(payload.parameters.size, "1152*2048"); assert.equal(payload.parameters.n, 1); assert.equal(payload.parameters.watermark, false);
  assert.equal(result, "https://dashscope-result.test/output.png");
});

test("DashScope connection probe treats an invalid API key as failure", async () => {
  const invalidKeyFetch = async () => new Response(JSON.stringify({ code:"InvalidApiKey", message:"Invalid API-key provided." }), { status:401, headers:{ "Content-Type":"application/json" } });
  await assert.rejects(testProviderConnection({ target:"video", videoKind:"dashscope", endpoint:"https://dashscope.aliyuncs.com", model:"wan3.0-video", apiKey:"sk-bad" }, { fetchImpl:invalidKeyFetch }), /Invalid API-key/);
  const notFoundFetch = async (url) => {
    assert.equal(url, "https://dashscope.aliyuncs.com/api/v1/tasks/connection-probe");
    return new Response(JSON.stringify({ code:"TaskNotFound", message:"task not found" }), { status:404, headers:{ "Content-Type":"application/json" } });
  };
  const result = await testProviderConnection({ target:"image", kind:"dashscope", endpoint:"https://dashscope.aliyuncs.com", model:"qwen-image-3.0-pro", apiKey:"sk-good" }, { fetchImpl:notFoundFetch });
  assert.equal(result.ok, true);
});

test("DashScope provider reads DASHSCOPE_HOST and shared DASHSCOPE_API_KEY from the environment", async () => {
  const environment = {
    VIDEO_PROVIDER:"dashscope",
    VIDEO_MODEL:"wan3.0-video",
    DASHSCOPE_API_KEY:"environment-dashscope-key",
    DASHSCOPE_HOST:"https://env-workspace.cn-beijing.maas.aliyuncs.com",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const status = getProviderStatus();
    assert.equal(status.video.kind, "dashscope");
    assert.equal(status.video.model, "wan3.0-video");
    assert.equal(status.video.endpoint, "https://env-workspace.cn-beijing.maas.aliyuncs.com");
    assert.equal(status.video.configured, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("per-provider model env beats the legacy global model name", async () => {
  const environment = {
    VIDEO_PROVIDER:"dashscope",
    VIDEO_MODEL:"legacy-global-model",
    DASHSCOPE_VIDEO_MODEL:"wan3.0-video",
    DASHSCOPE_API_KEY:"environment-dashscope-key",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const status = getProviderStatus();
    assert.equal(status.video.kind, "dashscope");
    assert.equal(status.video.model, "wan3.0-video");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("legacy global model name does not leak into a session-selected provider", async () => {
  const environment = {
    VIDEO_PROVIDER:"dashscope",
    VIDEO_MODEL:"legacy-global-model",
    PIXSTAG_VIDEO_MODEL:"MiniMax-H3",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === "POST") return new Response(JSON.stringify({ task_id:"px-isolation-task" }), { status:200, headers:{ "Content-Type":"application/json" } });
      return new Response(JSON.stringify({ task:{ id:"px-isolation-task", status:"succeeded", content:{ url:"https://example.test/pixstag-isolation.mp4" } } }), { status:200, headers:{ "Content-Type":"application/json" } });
    };
    const result = await generateVideo({ videoKind:"pixstag", endpoint:"https://pixstag.com", apiKey:"sk-pixstag-test", generationMode:"long-scenes", videoPrompt:"A lantern parade moves through the old city gates at dusk", motion:"Slow drift", duration:5 }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
    const payload = JSON.parse(requests[0].options.body);
    assert.equal(payload.model, "MiniMax-H3");
    assert.equal(result.videoUrl, "https://example.test/pixstag-isolation.mp4");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("PixStag video adapter creates and polls a MiniMax-H3 image-to-video task", async () => {
  const requests = []; let poll = 0;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ task_id:"px-task-42" }), { status:200, headers:{ "Content-Type":"application/json" } });
    poll += 1;
    return new Response(JSON.stringify(poll === 1 ? { task:{ id:"px-task-42", status:"queued" } } : { task:{ id:"px-task-42", status:"succeeded", content:{ url:"https://example.test/pixstag.mp4" }, duration:5, ratio:"9:16" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const publicFrame = "https://cdn.example.test/frames/storyboard-042.png";
  const result = await generateVideo({ videoKind:"pixstag", endpoint:"https://pixstag.com", model:"MiniMax-H3", apiKey:"sk-pixstag-test", videoPrompt:"Candlelight flickers across the manuscript while ink dries", image:publicFrame, motion:"Slow push-in", duration:5, screenRatio:"9:16" }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  assert.equal(requests[0].url, "https://pixstag.com/api/v2/video_generation");
  assert.equal(requests[0].options.headers.Authorization, "Bearer sk-pixstag-test");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.model, "MiniMax-H3");
  assert.match(payload.content[0].text, /Candlelight flickers/);
  assert.equal(payload.content[1].type, "image_url");
  assert.equal(payload.content[1].role, "first_frame");
  assert.equal(payload.content[1].image_url.url, publicFrame);
  assert.equal(payload.ratio, "9:16"); assert.equal(payload.duration, 5); assert.equal(payload.resolution, "1080P");
  assert.equal(requests[1].url, "https://pixstag.com/api/v2/query/video_generation/px-task-42");
  assert.equal(result.videoUrl, "https://example.test/pixstag.mp4"); assert.equal(result.taskId, "px-task-42"); assert.equal(result.status, "succeeded"); assert.equal(result.duration, 5);
});

test("PixStag image-to-video uploads local frames to OSS and passes the presigned URL", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ task_id:"px-oss-task" }), { status:200, headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ task:{ id:"px-oss-task", status:"succeeded", content:{ url:"https://example.test/pixstag-oss.mp4" } } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  let uploaded = null;
  const result = await generateVideo({ videoKind:"pixstag", endpoint:"https://pixstag.com", model:"MiniMax-H3", apiKey:"sk-pixstag-test", videoPrompt:"Candlelight flickers", image:png, motion:"Slow push-in", duration:5, screenRatio:"9:16" }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000, ossUpload:async (dataUrl) => { uploaded = dataUrl; return "https://oss.example.test/shortform/frame.png?sign=abc123"; } });
  assert.ok(String(uploaded || "").startsWith("data:image/"), "the local frame should be handed to the OSS uploader as a data URL");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.content[1].type, "image_url");
  assert.equal(payload.content[1].role, "first_frame");
  assert.equal(payload.content[1].image_url.url, "https://oss.example.test/shortform/frame.png?sign=abc123");
  assert.equal(result.videoUrl, "https://example.test/pixstag-oss.mp4");
});

test("PixStag image-to-video fails with an actionable message when OSS is unconfigured", async () => {
  const keys = ["OSS_REGION", "OSS_BUCKET", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    await assert.rejects(
      generateVideo({ videoKind:"pixstag", endpoint:"https://pixstag.com", model:"MiniMax-H3", apiKey:"sk-pixstag-test", videoPrompt:"Candlelight flickers", image:png, motion:"Slow push-in", duration:5, screenRatio:"9:16" }, { fetchImpl:async () => { throw new Error("should not call the provider"); }, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 }),
      /OSS is not configured/
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("PixStag plain-text provider errors surface the real message", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") return new Response("invalid params, Key: 'ReferenceAllDTO.Content[1].ImageUrl.Url' Error:Field validation for 'Url' failed on the 'max' tag", { status:400, headers:{ "Content-Type":"text/plain" } });
    return new Response("internal error: record not found", { status:404, headers:{ "Content-Type":"text/plain" } });
  };
  await assert.rejects(
    generateVideo({ videoKind:"pixstag", endpoint:"https://pixstag.com", model:"MiniMax-H3", apiKey:"key", generationMode:"long-scenes", videoPrompt:"A lantern parade", motion:"Slow drift", duration:5 }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 }),
    /invalid params, Key: 'ReferenceAllDTO/
  );
});

test("PixStag video adapter creates a text-to-video task and clamps duration to the 4-15 second range", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ task_id:"px-long-task" }), { status:200, headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ task:{ id:"px-long-task", status:"succeeded", content:{ url:"https://example.test/pixstag-long.mp4" }, duration:15 } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateVideo({ videoKind:"pixstag", endpoint:"https://pixstag.com/api/v2", model:"MiniMax-H3", apiKey:"key", generationMode:"long-scenes", videoPrompt:"A lantern parade moves through the old city gates at dusk", motion:"Slow drift", duration:2 }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  assert.equal(requests[0].url, "https://pixstag.com/api/v2/video_generation");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.content.length, 1);
  assert.match(payload.content[0].text, /Generate the full scene directly/i);
  assert.equal(payload.duration, 4);
  assert.equal(payload.resolution, "1080P");
  assert.equal(result.videoUrl, "https://example.test/pixstag-long.mp4");
  assert.equal(result.duration, 15);
});

test("PixStag video adapter maps the 480p budget tier to 720P and retries with a lower resolution on rejection", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") {
      const payload = JSON.parse(options.body);
      if (payload.resolution === "2K") return new Response(JSON.stringify({ error:{ code:"InvalidParameter", message:"resolution 2K is not available" } }), { status:400, headers:{ "Content-Type":"application/json" } });
      return new Response(JSON.stringify({ task_id:"px-fallback" }), { status:200, headers:{ "Content-Type":"application/json" } });
    }
    return new Response(JSON.stringify({ task:{ id:"px-fallback", status:"succeeded", content:{ url:"https://example.test/pixstag-fallback.mp4" } } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await generateVideo({ videoKind:"pixstag", endpoint:"https://pixstag.com", model:"MiniMax-H3", apiKey:"key", image:"https://cdn.example.test/frames/shot-042.png", resolution:"2k" }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  assert.deepEqual(requests.filter((request) => request.options.method === "POST").map((request) => JSON.parse(request.options.body).resolution), ["2K", "720P"]);
  assert.equal(result.videoUrl, "https://example.test/pixstag-fallback.mp4");
  const budget = await generateVideo({ videoKind:"pixstag", endpoint:"https://pixstag.com", model:"MiniMax-H3", apiKey:"key", generationMode:"long-scenes", resolution:"480p", videoPrompt:"Quiet harbour", motion:"Slow drift" }, { fetchImpl:async (url, options = {}) => {
    if (options.method === "POST") return new Response(JSON.stringify({ task_id:"px-budget" }), { status:200, headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ task:{ id:"px-budget", status:"succeeded", content:{ url:"https://example.test/pixstag-budget.mp4" } } }), { status:200, headers:{ "Content-Type":"application/json" } });
  }, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
  assert.equal(budget.videoUrl, "https://example.test/pixstag-budget.mp4");
});

test("PixStag connection probe rejects an invalid API key and accepts a valid one", async () => {
  const invalidKeyFetch = async (url) => {
    assert.equal(url, "https://pixstag.com/api/v2/query/video_generation/connection-probe");
    return new Response(JSON.stringify({ code:"1004", message:"login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)" }), { status:401, headers:{ "Content-Type":"application/json" } });
  };
  await assert.rejects(testProviderConnection({ target:"video", videoKind:"pixstag", endpoint:"https://pixstag.com", model:"MiniMax-H3", apiKey:"sk-bad" }, { fetchImpl:invalidKeyFetch }), /login fail/);
  const recordNotFoundFetch = async () => new Response(JSON.stringify({ message:"internal error: record not found" }), { status:500, headers:{ "Content-Type":"application/json" } });
  const result = await testProviderConnection({ target:"video", videoKind:"pixstag", endpoint:"https://pixstag.com", model:"MiniMax-H3", apiKey:"sk-good" }, { fetchImpl:recordNotFoundFetch });
  assert.equal(result.ok, true);
  assert.equal(result.model, "MiniMax-H3");
});

test("video provider connection test uses the task-list API for Agent Plan", async () => {
  let requestUrl = "";
  const fetchImpl = async (url) => {
    requestUrl = url;
    return new Response(JSON.stringify({ items:[], total:0 }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await testProviderConnection({ target:"video", videoKind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/plan/v3", model:"doubao-seedance-2.0", apiKey:"plan-test" }, { fetchImpl });
  assert.equal(requestUrl, "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks?page_num=1&page_size=1");
  assert.equal(result.ok, true);
});

test("session video model and endpoint are retained when the API key comes from the provider environment", async () => {
  const environment = {
    VIDEO_PROVIDER:"volcengine",
    VIDEO_MODEL:"environment-lite-model",
    VOLCENGINE_API_KEY:"environment-ark-key",
    VOLCENGINE_VIDEO_ENDPOINT:"https://environment.test/tasks",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify({ id:"session-model-task" }), { status:200, headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ id:"session-model-task", status:"succeeded", content:{ video_url:"https://example.test/session-model.mp4" } }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  try {
    await generateVideo({ videoKind:"volcengine", endpoint:"https://session.test/contents/generations/tasks", model:"session-pro-fast-model", apiKey:"", image:png, duration:3 }, { fetchImpl, sleepImpl:async () => {}, pollIntervalMs:250, timeoutMs:5000 });
    const payload = JSON.parse(requests[0].options.body);
    assert.equal(requests[0].url, "https://session.test/contents/generations/tasks");
    assert.equal(requests[0].options.headers.Authorization, "Bearer environment-ark-key");
    assert.equal(payload.model, "session-pro-fast-model");
    assert.equal(requests[1].url, "https://session.test/contents/generations/tasks/session-model-task");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("generated provider images are copied into the local intermediate asset store", async () => {
  const bytes = Buffer.from("stable-local-image");
  const fetchImpl = async (url) => {
    assert.equal(url, "https://example.test/temporary-provider-image.png");
    return new Response(bytes, { status:200, headers:{ "Content-Type":"image/png" } });
  };
  const result = await persistGeneratedImage("https://example.test/temporary-provider-image.png", { id:`cache-test-${Date.now()}`, fetchImpl });
  const info = await stat(result.path);
  assert.ok(info.size > 0);
  assert.match(result.path, /\.shortform\/assets\/cache-test-\d+\.png$/);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:4317\/assets\/cache-test-\d+\.png\?v=\d+$/);
});

test("generated provider images are cropped to the selected cover ratio before caching", async () => {
  const result = await persistGeneratedImage(png, { id:`ratio-cache-test-${Date.now()}`, screenRatio:"16:9" });
  try {
    assert.deepEqual(await probeVideoSize(result.path), { width:3840, height:2160 });
    assert.match(result.path, /-16x9\.png$/);
  } finally {
    await unlink(result.path).catch(() => {});
  }
});

test("generated provider videos are copied into the local intermediate asset store", async () => {
  const bytes = Buffer.from("stable-local-video");
  const fetchImpl = async (url) => {
    assert.equal(url, "https://example.test/temporary-provider-video.mp4");
    return new Response(bytes, { status:200, headers:{ "Content-Type":"video/mp4" } });
  };
  const result = await persistGeneratedVideo("https://example.test/temporary-provider-video.mp4", { id:`video-cache-test-${Date.now()}`, fetchImpl });
  const info = await stat(result.path);
  assert.ok(info.size > 0); assert.match(result.path, /\.shortform\/assets\/video-cache-test-\d+\.mp4$/); assert.match(result.url, /\/assets\/video-cache-test-\d+\.mp4\?v=\d+$/);
});

test("Volcengine text adapter uses Ark chat completions", async () => {
  let requestUrl = ""; let request;
  const fetchImpl = async (url, options) => {
    requestUrl = url; request = options;
    return new Response(JSON.stringify({ choices:[{ message:{ content:'{"ok":true}' } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const content = await completeText({ textKind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/v3/chat/completions", model:"doubao-seed-2-1-turbo-260628", apiKey:"ark-test" }, [{ role:"user", content:"Return JSON" }], { fetchImpl });
  const payload = JSON.parse(request.body);
  assert.equal(requestUrl, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer ark-test"); assert.equal(payload.response_format.type, "json_object");
  assert.deepEqual(payload.thinking, { type:"disabled" });
  assert.equal(payload.max_tokens, 8000);
  assert.equal(content, '{"ok":true}');
});

test("Volcengine Agent Plan text adapter accepts the documented API base URL", async () => {
  let requestUrl = ""; let request;
  const fetchImpl = async (url, options) => {
    requestUrl = url; request = options;
    return new Response(JSON.stringify({ choices:[{ message:{ content:'{"ok":true}' } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  await completeText({ textKind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/plan/v3", model:"ark-code-latest", apiKey:"plan-test" }, [{ role:"user", content:"Return JSON" }], { fetchImpl });
  const payload = JSON.parse(request.body);
  assert.equal(requestUrl, "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions");
  assert.equal(payload.model, "ark-code-latest");
  assert.deepEqual(Object.keys(payload).sort(), ["messages", "model"]);
});

test("Agent Plan text connection test calls chat completions instead of models", async () => {
  let requestUrl = ""; let request;
  const fetchImpl = async (url, options) => {
    requestUrl = url; request = options;
    return new Response(JSON.stringify({ choices:[{ message:{ content:"OK" } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const result = await testProviderConnection({ target:"text", textKind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/plan/v3", model:"ark-code-latest", apiKey:"plan-test" }, { fetchImpl });
  const payload = JSON.parse(request.body);
  assert.equal(requestUrl, "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions");
  assert.equal(request.method, "POST");
  assert.deepEqual(Object.keys(payload).sort(), ["messages", "model"]);
  assert.equal(result.ok, true);
});

test("Agent Plan storyboard planning repairs malformed JSON once", async () => {
  const requests = [];
  const repaired = { shots:[{
    narration:"A complete line.", chinese:"完整的一句。", type:"Opening", duration:3,
    prompt:"A cinematic vertical scene with no text or watermark",
    videoPrompt:"The subject moves naturally in one stable continuous shot",
    motion:"Slow drift",
  }] };
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body); requests.push(payload);
    const content = requests.length === 1
      ? '{"shots":[{"narration":"A complete line.","chinese":"完整的一句。","type":"Opening"'
      : JSON.stringify(repaired);
    return new Response(JSON.stringify({ choices:[{ message:{ content } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const shots = await planEpisode({
    textKind:"volcengine", endpoint:"https://ark.cn-beijing.volces.com/api/plan/v3",
    model:"ark-code-latest", apiKey:"plan-test", script:"A complete line.", audioDuration:3,
  }, { fetchImpl });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, 8000);
  assert.match(requests[1].messages[0].content, /Repair malformed or truncated JSON/);
  assert.equal(requests[1].max_tokens, 8000);
  assert.equal(shots[0].narration, "A complete line.");
  assert.equal(shots[0].end, 3);
});

test("storyboard planning uses the transcript as an 82-second master timeline", async () => {
  let providerPayload;
  const providerShots = Array.from({ length:21 }, (_, index) => ({
    narration:`Timed narration ${index + 1}.`, chinese:`定时旁白 ${index + 1}。`,
    type:index === 0 ? "Opening" : "Narrative", duration:3.9,
    prompt:`Photorealistic timed scene ${index + 1}, vertical 9:16, no text, no watermark`,
    videoPrompt:`The subject in timed scene ${index + 1} moves naturally while the camera drifts slowly`, motion:"Slow drift",
  }));
  const fetchImpl = async (_url, options) => {
    providerPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ shots:providerShots }) } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const timedWords = Array.from({ length:42 }, (_, index) => ({ start:.4 + index * 1.9, end:1.8 + index * 1.9, word:`word${index + 1}` }));
  const transcription = { duration:82, segments:[{ start:.4, end:82, text:"The complete timed narration.", words:timedWords }] };
  const shots = await planEpisode({ textKind:"volcengine", endpoint:"https://ark.example.test/chat/completions", model:"doubao-test", apiKey:"ark-test", script:"The complete timed narration.", audioDuration:82, transcription }, { fetchImpl });
  const planningInput = JSON.parse(providerPayload.messages[1].content);
  assert.equal(planningInput.narrationDurationSeconds, 82);
  assert.equal(planningInput.minimumShotCount, 5);
  assert.equal(planningInput.targetShotCount, 6);
  assert.match(providerPayload.messages[0].content, /videoPrompt/);
  assert.match(providerPayload.messages[0].content, /every image prompt must explicitly name the most accurate era or date and location/i);
  assert.match(providerPayload.messages[0].content, /period-accurate background/i);
  assert.match(providerPayload.messages[0].content, /Never mix eras or include anachronisms/i);
  assert.doesNotMatch(providerPayload.messages[0].content, /subtitle[- ]?safe|safe lower/i);
  assert.deepEqual(planningInput.localTranscriptionSegments, [{ start:.4, end:82, text:"The complete timed narration." }]);
  assert.match(shots[0].videoPrompt, /moves naturally/);
  assert.equal(shots.at(-1).end, 82);
  assert.equal(Number(shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(2)), 82);
});

test("short-shot planning forwards the selected target shot length to the model", async () => {
  let providerPayload;
  const providerShots = Array.from({ length:11 }, (_, index) => ({
    narration:`Short narration ${index + 1}.`, chinese:`短旁白 ${index + 1}。`, type:index === 0 ? "Opening" : "Narrative", duration:7.45,
    prompt:`Photorealistic short scene ${index + 1}, vertical 9:16, no text, no watermark`,
    videoPrompt:`The subject in short scene ${index + 1} moves naturally while the camera drifts slowly`, motion:"Slow drift",
  }));
  const fetchImpl = async (_url, options) => {
    providerPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ shots:providerShots }) } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  await planEpisode({ textKind:"volcengine", endpoint:"https://ark.example.test/chat/completions", model:"doubao-test", apiKey:"ark-test", script:"A complete 82-second narration.", audioDuration:82, shortClipDuration:8 }, { fetchImpl });
  const planningInput = JSON.parse(providerPayload.messages[1].content);
  assert.equal(planningInput.targetShotDurationSeconds, 8);
  assert.equal(planningInput.targetClipDurationSeconds, null);
  assert.equal(planningInput.targetShotCount, 11);
  assert.match(providerPayload.messages[0].content, /target shot length is 8 seconds/);
  assert.match(providerPayload.messages[0].content, /never longer than 12 seconds/);
  assert.doesNotMatch(providerPayload.messages[0].content, /each shot should be 10–20 seconds/);
});

test("long-scene planning uses the selected 6-12 second target and direct video prompts", async () => {
  let providerPayload;
  const providerScenes = Array.from({ length:8 }, (_, index) => ({
    narration:`Long narration section ${index + 1}.`, chinese:`长旁白片段 ${index + 1}。`, type:index === 0 ? "Opening" : "Narrative", duration:10.25,
    videoPrompt:`A detailed continuous text-to-video scene ${index + 1} with two sequential visual beats and stable subjects`, motion:"Slow drift",
  }));
  const fetchImpl = async (_url, options) => {
    providerPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ shots:providerScenes }) } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const shots = await planEpisode({ textKind:"volcengine", endpoint:"https://ark.example.test/chat/completions", model:"doubao-test", apiKey:"ark-test", script:"A complete 82-second narration.", audioDuration:82, productionMode:"long-scenes", longClipDuration:10 }, { fetchImpl });
  const planningInput = JSON.parse(providerPayload.messages[1].content);
  assert.equal(planningInput.productionMode, "long-scenes");
  assert.equal(planningInput.targetClipDurationSeconds, 10);
  assert.equal(planningInput.minimumShotCount, 7);
  assert.equal(planningInput.targetShotCount, 8);
  assert.equal(planningInput.maximumShotCount, 13);
  assert.match(providerPayload.messages[0].content, /direct text-to-video generation/i);
  assert.match(providerPayload.messages[0].content, /between 6 and 12 seconds/i);
  assert.match(providerPayload.messages[0].content, /Do not refer to a supplied image or first frame/i);
  assert.equal(shots.length, 8);
  assert.equal(shots.at(-1).end, 82);
});

test("mixed planning budgets a small set of image-to-video shots", async () => {
  let providerPayload;
  const providerShots = Array.from({ length:8 }, (_, index) => ({
    narration:`Mixed narration ${index + 1}.`, chinese:`混合旁白 ${index + 1}。`, type:index === 0 ? "Opening" : index === 4 ? "Climax" : "Narrative", duration:3.25,
    prompt:`Cinematic mixed storyboard image ${index + 1}, no text`, videoPrompt:`Natural motion for mixed shot ${index + 1}`, motion:"Slow drift", videoRecommended:index === 0 || index === 4,
  }));
  const fetchImpl = async (_url, options) => {
    providerPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ shots:providerShots }) } }] }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const shots = await planEpisode({ textKind:"volcengine", endpoint:"https://ark.example.test/chat/completions", model:"doubao-test", apiKey:"ark-test", script:"A complete mixed-mode narration.", audioDuration:26, productionMode:"mixed" }, { fetchImpl });
  const planningInput = JSON.parse(providerPayload.messages[1].content);
  assert.equal(planningInput.productionMode, "mixed");
  assert.equal(planningInput.targetShotCount, 2);
  assert.equal(planningInput.targetAnimatedShotCount, 1);
  assert.match(providerPayload.messages[0].content, /roughly one in every four shots/i);
  assert.equal(shots.filter((shot) => shot.videoRecommended).length, 2);
  assert.equal(shots[0].videoRecommended, true);
  assert.equal(shots[4].videoRecommended, true);
});
