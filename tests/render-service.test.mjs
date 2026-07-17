import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { completeText, generateImage, getProviderStatus, persistGeneratedImage, planEpisode, renderEpisode, transcribeAudio } from "../scripts/render-service.mjs";

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

test("local renderer produces a playable vertical MP4", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-test-")); const output = path.join(dir, "episode.mp4");
  const result = await renderEpisode({ title:"Test", width:360, height:640, bgmPreset:"None", narrationData:narrationWav(), voicePreset:"documentary", shots:[
    { duration:.8, image:png, narration:"The prototype starts before dawn.", chinese:"原型机在黎明前启动。" },
    { duration:.8, image:png, narration:"The test finishes successfully.", chinese:"测试顺利完成。" },
  ] }, { id:`test-${Date.now()}`, output });
  const info = await stat(output); const duration = await probe(output);
  assert.ok(info.size > 5000); assert.ok(duration >= 1.5 && duration <= 1.8); assert.equal(result.duration, 1.6);
});

test("local renderer mixes a selected built-in BGM", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shortform-bgm-test-")); const output = path.join(dir, "episode.mp4");
  await renderEpisode({ title:"BGM Test", width:360, height:640, bgmPath:"/bgm/monume-documentary-documentary-music-547923.mp3", narrationData:narrationWav(), voicePreset:"natural", shots:[
    { duration:1.6, image:png, narration:"Music plays beneath this line.", chinese:"音乐在旁白下播放。" },
  ] }, { id:`bgm-test-${Date.now()}`, output });
  const info = await stat(output); const duration = await probe(output);
  assert.ok(info.size > 5000); assert.ok(duration >= 1.5 && duration <= 1.8);
});

test("provider status reports configuration without exposing secrets", () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-secret-that-must-not-leak";
  const status = getProviderStatus();
  assert.equal(status.image.configured, true);
  assert.equal(status.text.configured, true);
  assert.doesNotMatch(JSON.stringify(status), /test-secret/);
  if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
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
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:4317\/assets\/cache-test-\d+\.png$/);
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

test("storyboard planning uses the transcript as an 82-second master timeline", async () => {
  let providerPayload;
  const providerShots = Array.from({ length:21 }, (_, index) => ({
    narration:`Timed narration ${index + 1}.`, chinese:`定时旁白 ${index + 1}。`,
    type:index === 0 ? "Opening" : "Narrative", duration:3.9,
    prompt:`Photorealistic timed scene ${index + 1}, vertical 9:16, subtitle-safe lower area, no text, no watermark`, motion:"Slow drift",
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
  assert.equal(planningInput.minimumShotCount, 21);
  assert.equal(planningInput.targetShotCount, 25);
  assert.deepEqual(planningInput.localTranscriptionSegments, [{ start:.4, end:82, text:"The complete timed narration." }]);
  assert.equal(shots.at(-1).end, 82);
  assert.equal(Number(shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(2)), 82);
});
