import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildSubtitleAss, completeText, generateImage, generateVideo, getProviderStatus, persistGeneratedImage, persistGeneratedVideo, planEpisode, prepareProviderImage, renderDimensions, renderEpisode, stillMotionFilter, synthesizeSpeech, testProviderConnection, transcribeAudio } from "../scripts/render-service.mjs";

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
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.25,Box,,0,0,0,,\{\\an7\\pos\(70,1185\)\\p1\}m 0 0 l 940 0 l 940 300 l 0 300\{\\p0\}/);
  assert.match(ass, /English （line）\\N\{\\c&HEFCDAB&\}中文/);
  assert.doesNotMatch(buildSubtitleAss([{ start:0, end:1, narration:"No box" }], 1080, 1920, { backgroundOpacity:0 }), /,Box,,/);
});

test("local renderer produces a playable vertical MP4", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-test-")); const output = path.join(dir, "episode.mp4");
  const result = await renderEpisode({ title:"Test", width:360, height:640, bgmPreset:"None", narrationData:narrationWav(), voicePreset:"documentary", subtitleStyle:{ fontScale:125, chineseColor:"#00ff00", backgroundOpacity:70, alignment:"right" }, shots:[
    { duration:.8, image:png, narration:"The prototype starts before dawn.", chinese:"原型机在黎明前启动。" },
    { duration:.8, image:png, narration:"The test finishes successfully.", chinese:"测试顺利完成。" },
  ] }, { id:`test-${Date.now()}`, output });
  const info = await stat(output); const duration = await probe(output);
  assert.ok(info.size > 5000); assert.ok(duration >= 1.5 && duration <= 1.8); assert.equal(result.duration, 1.6);
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
    IMAGE_PROVIDER:"volcengine", IMAGE_MODEL:"seedream-test",
    TEXT_PROVIDER:"openai", TEXT_MODEL:"openai-text-test",
    VIDEO_PROVIDER:"volcengine", VIDEO_MODEL:"seedance-test",
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
  assert.equal(request.headers.Authorization, "Bearer ark-test"); assert.equal(payload.size, "1440x2560"); assert.equal(payload.watermark, false);
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
  assert.equal(volcengineRequest.size, "2560x1440");
  assert.match(volcengineRequest.prompt, /16:9 screen ratio/);
  assert.equal(openaiRequest.size, "1024x1024");
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
  assert.deepEqual(pngDimensions(await prepareProviderImage(png, "16:9", { workDir:dir })), { width:1280, height:720 });
  assert.deepEqual(pngDimensions(await prepareProviderImage(png, "9:16", { workDir:dir })), { width:720, height:1280 });
  assert.deepEqual(pngDimensions(await prepareProviderImage(png, "1:1", { workDir:dir })), { width:960, height:960 });
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
  assert.equal(payload.content[1].role, "first_frame"); assert.deepEqual(pngDimensions(payload.content[1].image_url.url), { width:720, height:1280 });
  assert.match(payload.content[0].text, /Rain streams diagonally/);
  assert.match(payload.content[0].text, /Camera direction override: Slow push-in/);
  assert.doesNotMatch(payload.content[0].text, /--ratio|--dur|--resolution/);
  assert.equal(payload.duration, 3); assert.equal(payload.ratio, "9:16"); assert.equal(payload.resolution, "720p");
  assert.equal(payload.generate_audio, false); assert.equal(payload.watermark, false);
  assert.equal(requests[2].url, "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-test-123");
  assert.equal(result.videoUrl, "https://example.test/generated.mp4"); assert.equal(result.taskId, "cgt-test-123");
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
  assert.deepEqual(pngDimensions(payload.content[1].image_url.url), { width:960, height:960 });
  assert.match(payload.content[0].text, /Square 1:1 screen ratio/);
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
    assert.deepEqual(await probeVideoSize(result.path), { width:1280, height:720 });
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
  assert.equal(planningInput.minimumShotCount, 9);
  assert.equal(planningInput.targetShotCount, 14);
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
  assert.equal(planningInput.targetShotCount, 5);
  assert.equal(planningInput.targetAnimatedShotCount, 2);
  assert.match(providerPayload.messages[0].content, /roughly one in every four shots/i);
  assert.equal(shots.filter((shot) => shot.videoRecommended).length, 2);
  assert.equal(shots[0].videoRecommended, true);
  assert.equal(shots[4].videoRecommended, true);
});
