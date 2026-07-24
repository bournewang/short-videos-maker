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

Each provider has one shared API key and a separate endpoint for every supported modality. Select the active provider and model with `TEXT_PROVIDER` and `TEXT_MODEL`, `IMAGE_PROVIDER` and `IMAGE_MODEL`, or `VIDEO_PROVIDER` and `VIDEO_MODEL`. Copy the complete structure from `.env.example`.

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

## Verification

```bash
npm test
npm run lint
```

The test suite builds the application, validates shot planning and server-rendered markup, and uses the installed FFmpeg to create and probe a real vertical MP4.
