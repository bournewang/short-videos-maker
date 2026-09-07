# Shortform Studio

A local-first production desk for vertical short videos. It turns an English script and generated or recorded narration into an inspectable shot plan, editable image prompts, bilingual subtitles, background music, and a rendered 9:16 MP4. Each episode can use its own content format, visual style, and creative direction; history is one optional format, not a hardcoded topic.

## Requirements

- Node.js 22.13 or newer
- FFmpeg and FFprobe available on `PATH`

## Start locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The command starts both the editor and its local rendering/provider bridge. The bridge is the durable source of truth: episode metadata is indexed in `.shortform/episodes.sqlite`, and every episode has a readable JSON backup plus its media under `.shortform/episodes/<episode-name>/`. Browser IndexedDB remains a fallback and is migrated into the server store automatically. Use **Episodes** to reopen or delete earlier episodes; creating a new episode keeps the existing history.

Each episode directory is organized as follows:

```text
.shortform/episodes/when-rome-fell/
├── episode.json
├── audio/
├── images/
├── videos/
├── covers/
└── exports/
```

Set `SHORTFORM_STORAGE_DIR` in `.env.local` to place the SQLite database and episode directories elsewhere. Deleting an episode moves its directory into `<storage>/.trash/episodes/` so its files remain recoverable.

Preview unused legacy assets and render scratch files with `npm run storage:cleanup`. To remove them after reference validation, run `npm run storage:cleanup -- --apply --purge`. The command preserves every file referenced by a stored episode and writes a cleanup report into the storage directory.

The local rendering bridge runs in Node watch mode during development. Changes to audio processing or server routes automatically restart port `4317`; after pulling older code or changing the startup script itself, restart `npm run dev` once.

## Local narration synthesis

The **Episode** screen can generate narration from the English script through a separately running [MLX Audio](https://github.com/Blaizzy/mlx-audio) service. Start its OpenAI-compatible server on port `8010`:

```bash
mlx_audio.server --host 127.0.0.1 --port 8010
```

Shortform Studio sends `model`, `input`, `voice`, `speed`, `lang_code`, and an optional style instruction to `/v1/audio/speech`, requests WAV output, then attaches the response to the episode exactly like uploaded narration. The default model is `mlx-community/Kokoro-82M-bf16` with voice `af_heart` and American English language code `a`.

Configure the endpoint, model, voice, language, speed, and request timeout in `.env.local` with `SPEECH_ENDPOINT`, `SPEECH_MODEL`, `SPEECH_VOICE`, `SPEECH_LANGUAGE`, `SPEECH_SPEED`, and `SPEECH_REQUEST_TIMEOUT_MS`. The default is the complete endpoint `SPEECH_ENDPOINT=http://localhost:8010/v1/audio/speech`; a base URL is still accepted for convenience. The same fields can be overridden for the current session in **Provider settings**. The first request may take longer while MLX Audio downloads and loads the selected model.

## Local narration transcription

Narration audio is transcribed by a local speech-to-text service, not by OpenAI Whisper. The default endpoint is `http://localhost:8000/v1/transcriptions`. It receives multipart fields named `file`, `language`, and `word_timestamps`, matching the API in the provided example. Change the URL or language in **Provider settings**, or set `TRANSCRIPTION_ENDPOINT` and `TRANSCRIPTION_LANGUAGE` in `.env.local`.

The returned full text, segments, duration, and per-word timestamps are retained for the current episode. If the script is empty, the transcript fills it automatically. When a script is already present, the script remains the source of truth and local word timestamps determine storyboard shot boundaries.

## Local voice processing

The **Audio & captions** screen has a **De-noise narration** checkbox. When enabled, export applies light local FFmpeg noise reduction without changing pitch, tone, dynamics, or loudness. When disabled, the uploaded narration is used unchanged. The original browser upload is never replaced.

## Connect real AI providers

Add a provider key to `.env.local`, then restart `npm run dev`:

```dotenv
OPENAI_API_KEY=your_key_here
```

Each provider has one shared API key, a separate endpoint for every supported modality, and a model name scoped to the provider: `DASHSCOPE_VIDEO_MODEL`, `VOLCENGINE_IMAGE_MODEL`, and so on. Select the active provider per modality with `TEXT_PROVIDER`, `IMAGE_PROVIDER`, or `VIDEO_PROVIDER` — switching a provider never leaks another provider's model name into its requests. (The legacy un-prefixed `TEXT_MODEL` / `IMAGE_MODEL` / `VIDEO_MODEL` still work but only apply to the currently selected provider.) Copy the complete structure from `.env.example`.

Open **Provider settings** in the editor to see whether environment keys were loaded and test each connection. You can also enter a session-only override there. The editor never returns environment keys to the browser, and `.env.local` is ignored by Git.

### Volcengine Ark

Select **Volcengine Ark · Seedream** for images, **Volcengine Ark · Seedance** for image-to-video clips, and **Volcengine Ark · Doubao** for storyboard planning and translation. All three can reuse `VOLCENGINE_API_KEY`. The video adapter submits each generated storyboard frame to Ark's asynchronous `/api/v3/contents/generations/tasks` API, polls until completion, and immediately copies the temporary result into the current episode's `videos/` directory. It defaults to `doubao-seedance-2-0-260128`, vertical 9:16 output, 720p generation, no generated audio, and no watermark; narration and BGM are mixed during the local final render. Override the video model, endpoint, timeout, or polling interval with the settings shown in `.env.example`.

For a subscribed **Volcengine Agent Plan**, select the Agent Plan preset in Provider settings, or use its separate API key with the base URL `https://ark.cn-beijing.volces.com/api/plan/v3`. Agent Plan uses model names rather than dated online-inference model IDs: `ark-code-latest` for OpenAI-compatible text chat, `doubao-seedream-5.0-lite` for images, and `doubao-seedance-2.0` for video. The bridge accepts either the base URL or a complete modality endpoint and appends the correct API path automatically. Agent Plan text requests intentionally send only `model` and `messages`, matching the OpenAI client request shape; Ark-specific `thinking` and structured-output parameters remain limited to the pay-as-you-go endpoint.

## Workflow

1. In **Episode**, paste a script and generate narration with MLX Audio or upload a recording. The app transcribes the resulting audio locally, then uses those timings when the configured AI provider plans the storyboard.
2. In **Storyboard**, review AI-generated timing, bilingual lines, separate image and video prompts, generate the real images, then choose **Animate all shots** to create Volcengine video clips. The animation request uses the motion-specific prompt planned during **Analyze with AI**, with the generated image as its exact first frame.
3. In **Storyboard**, customize subtitle font, size, colors, alignment, position, background, and outline against the live shot preview. In **Audio & captions**, edit English and Chinese lines and optionally choose a licensed BGM track.
4. In **Export**, generate cover artwork cropped to the selected 9:16, 1:1, or 16:9 ratio, then add an editable high-contrast headline and place it in any of nine positions while viewing the real image. The preview container and downloaded PNG use that exact ratio. You can also download YouTube-ready English, Simplified Chinese, or bilingual SRT subtitle files and render the finished H.264 MP4 locally. Each cover is saved with the episode, while each completed video ratio and resolution is retained in build history with its local render path, preview, and download. Shots without a generated clip retain the subtle still-image motion fallback.

Provider settings supports MLX Audio speech synthesis, OpenAI-compatible images, Volcengine Ark Seedream and Seedance, and local Stable Diffusion WebUI. Storyboard planning and translation support OpenAI-compatible chat APIs and Volcengine Ark Doubao. Session keys remain in memory; environment keys stay inside the local provider bridge. Export requires narration and at least one generated visual asset for every shot.

## Batch generation & export (CLI)

For publishing pipelines (e.g. a daily slate of history-story or documentary episodes), two CLI scripts drive the same business logic the editor uses, end to end:

```
batch-generate.mjs →  scripts + narration + storyboard + images  → episode saved as "pending"
        ↓  (human review in the editor)
batch-export.mjs   →  optional video clips + FFmpeg MP4 + baked cover → episode updated with builds
```

Both scripts import the provider functions from `scripts/render-service.mjs` directly and reuse your `.env.local` provider config, so no bridge or `npm run dev` needs to be running. Run them with `node` (Node 22, the same runtime the project pins) from the project root.

### 1. Batch generate

Generates each topic into a full episode: script → genre-routed narration (Doubao for `story`, MiniMax for `documentary`) → character extraction + character-sheet library → storyboard (with `subject`/`characters` tags) → images. Each finished episode is stored with `reviewStatus: "pending"` for human review.

```bash
# Single topic
node scripts/batch-generate.mjs --topic "辛弃疾" --genre story --duration 3

# A batch from a topic list, with resume support
node scripts/batch-generate.mjs --input topics.json --batch-id 20260907 --concurrency 2 --resume

# Preview the topic list without doing any work
node scripts/batch-generate.mjs --input topics.json --dry-run
```

`topics.json` is an array of topic objects (any field can be overridden by a CLI flag):

```json
[
  { "topic": "辛弃疾", "genre": "story", "duration": 3, "screenRatio": "9:16" },
  { "topic": "The Battle of Hastings", "genre": "documentary", "duration": 4 }
]
```

| Flag | Meaning | Default |
|------|---------|---------|
| `--input <file>` | JSON file with the topic list (array, or `{ "topics": [...] }`) | — |
| `--topic <str>` | Single topic (used when `--input` is absent) | — |
| `--genre <id>` | `story` (中文人物故事) or `documentary` (English documentary) | — |
| `--duration <min>` | Target length in minutes (2–6) | `3` |
| `--production-mode <m>` | `short-shots` \| `mixed` \| `long-scenes` | `short-shots` |
| `--screen-ratio <r>` | `9:16` \| `16:9` \| `1:1` | `9:16` |
| `--content-format <s>` | Override the genre's default content format (see enumerated values below) | genre default |
| `--visual-style <s>` | Override the genre's default visual style (see enumerated values below) | genre default |
| `--creative-direction <s>` | Extra creative direction passed to scripting and planning (free text) | — |
| `--concurrency <n>` | Image/concurrent-request limit | `2` |
| `--image-mode <m>` | `group` (character library + segmented group images, anchors character consistency) or `single` (per-shot parallel, faster) | `group` |
| `--batch-id <id>` | Batch id used for the resume manifest | `batch-<timestamp>` |
| `--resume` | Skip topics already marked `success` in this batch's manifest | off |
| `--force` | Re-run topics even if they already succeeded | off |
| `--skip-images` | Generate script + narration + storyboard only, no images | off |
| `--dry-run` | Print the topic list and exit | off |

`--content-format` and `--visual-style` are free-text prompt fragments (the CLI does not hard-validate them — any string is passed through to the LLM unchanged), but the editor's dropdowns offer these presets:

- **Content format**: `Documentary` · `Educational explainer` · `Narrative story` · `News recap` · `Product story` · `History documentary` · `Other`
- **Visual style**: `Photorealistic` · `Cinematic illustration` · `Editorial collage` · `3D animation` · `Anime` · `Minimal graphic`

Genre defaults: `story` → `Narrative story`, `documentary` → `Documentary` (both default to `Photorealistic` visual style).

Image generation uses the **character-sheet + segmented group** strategy by default: core characters each get one "定妆图" (character sheet), character shots are grouped by the on-screen cast, and each group references the relevant sheets (`reference images + generated images ≤ 15`). Environment / text-card shots are generated individually in parallel. This keeps a protagonist consistent across an arbitrarily long episode. `--image-mode single` skips all of that and just generates every shot in parallel.

### 2. Review in the editor

Start the editor (`npm run dev`), open the **Episodes** library, and each episode shows a review badge. Click **通过 (approve)** or **驳回 (reject)**; the state (`draft` / `pending` / `approved` / `rejected`) is persisted to SQLite and the episode JSON. Only `approved` episodes are picked up by the default export path.

### 3. Batch export

Exports `approved` episodes (or an explicit set): optional image-to-video for selected shots → FFmpeg render to MP4 → cover image generation with the headline baked in server-side via sharp.

```bash
# Export all approved episodes as still-image videos
node scripts/batch-export.mjs

# Animate only the first shot of each episode, then render + cover
node scripts/batch-export.mjs --video-shots first --video-provider volcengine

# Export specific episodes by id (comma-separated)
node scripts/batch-export.mjs --ids episode-<id1>,episode-<id2>

# Preview which episodes would be exported
node scripts/batch-export.mjs --dry-run
```

| Flag | Meaning | Default |
|------|---------|---------|
| `--ids <ep1,ep2>` | Export only the given episode ids | — |
| `--all` | Export every episode, including non-approved | only `approved` |
| `--video-shots <spec>` | `none` (still images) \| `first` \| `all` \| `0,2,3` (explicit indexes) | `none` |
| `--video-provider <p>` | `pixstag` \| `volcengine` \| `dashscope` | `VIDEO_PROVIDER` from `.env.local` |
| `--resolution <r>` | Final render resolution `480` \| `720` \| `1080` | `1080` |
| `--video-resolution <r>` | Clip generation resolution `480p` \| `720p` \| `1080p` \| `2k` | `720p` |
| `--skip-cover` | Skip cover generation | off |
| `--dry-run` | Print the episodes that would be exported and exit | off |

`--video-resolution` is normalized per provider: `volcengine`/`dashscope` accept `480p`/`720p`/`1080p` (invalid → `1080p`; Seedance `-fast` variants auto-downgrade `1080p` → `720p` → `480p` when the API rejects a resolution). `pixstag` accepts `720P`/`768P`/`1080P`/`2K`; `480p`/`720p` map to `720P`, `2k` maps to `2K`, anything else to `1080P`.

### End-to-end example

```bash
cd /Users/wangxiaopei/work/short-videos-maker

# 1. Generate three history-story episodes (script + narration + storyboard + images)
node scripts/batch-generate.mjs --input topics.json --batch-id 20260907 --concurrency 2 --resume

# 2. Open the editor, review each "pending" episode, click 通过 for the ones you keep
npm run dev

# 3. Export all approved episodes: animate the first shot, render 1080p, bake covers
node scripts/batch-export.mjs --video-shots first --video-provider volcengine
```

### Notes & gotchas

- **FFmpeg/FFprobe path** — the scripts auto-prepend common Homebrew/MacPorts locations (`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`) to `PATH` on load, so a bare `node scripts/...` works even when your shell `PATH` is minimal.
- **Image-to-video provider** — `pixstag` requires a publicly reachable first-frame URL; the OSS presigned URL used for it has proven unreachable from the provider side in this environment. Use `volcengine` (Seedance) or `dashscope` (Wan), which accept a base64 first frame directly. Prefer `--video-provider volcengine`.
- **Group-image limit** — Seedream caps group generation at **15** images, and reference images count against that budget (`references + generated ≤ 15`). The segmented-group strategy already respects this.
- **Long batches** — image generation is slow (≈24–30s per image); run long batches in the background or use `--image-mode single` with a higher `--concurrency` for a faster (but less character-consistent) fallback. `--resume` lets a killed batch pick up where it left off.

## Verification

```bash
npm test
npm run lint
```

The test suite builds the application, validates shot planning and server-rendered markup, and uses the installed FFmpeg to create and probe a real vertical MP4.
