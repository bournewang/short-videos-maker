# Shortform Studio

A local-first production desk for vertical short videos. It turns an English script and recorded narration into an inspectable shot plan, editable image prompts, bilingual subtitles, background music, and a rendered 9:16 MP4. Each episode can use its own content format, visual style, and creative direction; history is one optional format, not a hardcoded topic.

## Requirements

- Node.js 22.13 or newer
- FFmpeg and FFprobe available on `PATH`

## Start locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The command starts both the editor and its local rendering/provider bridge. Episode data and inspectable intermediate state are saved in browser storage. Generated provider images are copied into `.shortform/assets/`, and completed exports are written under `.shortform/exports/`.

The local rendering bridge runs in Node watch mode during development. Changes to audio processing or server routes automatically restart port `4317`; after pulling older code or changing the startup script itself, restart `npm run dev` once.

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

That shared key powers the default image-generation and translation endpoints. To use separate services or models, copy the optional settings from `.env.example` and configure `IMAGE_API_KEY`, `IMAGE_API_ENDPOINT`, `IMAGE_MODEL`, `TEXT_API_KEY`, `TEXT_API_ENDPOINT`, and `TEXT_MODEL`.

Open **Provider settings** in the editor to see whether environment keys were loaded and test each connection. You can also enter a session-only override there. The editor never returns environment keys to the browser, and `.env.local` is ignored by Git.

### Volcengine Ark

Select **Volcengine Ark · Seedream** for images and **Volcengine Ark · Doubao** for storyboard planning and translation. Both use the same `VOLCENGINE_API_KEY`. The default image adapter targets Ark's `/api/v3/images/generations` endpoint with a vertical Seedream request. Text uses `/api/v3/chat/completions` with `doubao-seed-2-1-turbo-260628`, explicitly disables thinking mode, and times out after 120 seconds. Override the model or timeout with `TEXT_MODEL` and `TEXT_REQUEST_TIMEOUT_MS`.

## Workflow

1. In **Episode**, paste a script and upload narration. The app transcribes the audio locally, then uses those timings when the configured AI provider plans the storyboard.
2. In **Storyboard**, review AI-generated timing, bilingual lines, and prompts, then generate the real images.
3. In **Audio & captions**, edit English and Chinese lines and optionally upload a licensed BGM track.
4. In **Export**, render the finished H.264 MP4 locally.

Provider settings supports OpenAI-compatible images, Volcengine Ark Seedream, and local Stable Diffusion WebUI. Storyboard planning and translation support OpenAI-compatible chat APIs and Volcengine Ark Doubao. Session keys remain in memory; environment keys stay inside the local provider bridge. Export requires recorded narration and a generated image for every shot.

## Verification

```bash
npm test
npm run lint
```

The test suite builds the application, validates shot planning and server-rendered markup, and uses the installed FFmpeg to create and probe a real vertical MP4.
