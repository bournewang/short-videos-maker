# Shortform Studio — Agent Guide

This file is written for AI coding agents who need to work on the Shortform Studio codebase. It assumes no prior knowledge of the project.

## Project overview

Shortform Studio is a **local-first production desk for vertical short videos**. A creator pastes an English script, uploads a recorded narration, and the app helps plan an AI-assisted storyboard, generate images, optionally animate those images into video clips, edit bilingual subtitles, add background music, and export a finished 9:16 H.264 MP4.

The editor is a React web app. Heavy media work (FFmpeg rendering, AI-provider proxies, local speech-to-text transcription) is delegated to a local Node.js bridge. The local bridge stores authoritative episode records in `.shortform/episodes.sqlite` and organizes JSON backups, narration, generated assets, covers, and exports under `.shortform/episodes/<episode-slug>/`. Browser IndexedDB is retained as a fallback and migration source.

## Technology stack

| Layer | Technology |
|-------|-------------|
| Frontend framework | Next.js 16.2.6 (App Router) + React 19.2.6 |
| Language | TypeScript 5.9.3 (`strict: true`) |
| Styling | Tailwind CSS 4.2.1 (`@import "tailwindcss"` in `app/globals.css`) |
| Bundler / dev server | Vite 8.0.13 + Vinext 0.0.50 |
| Server runtime | Cloudflare Workers (via `worker/index.ts`) |
| Cloudflare integration | `@cloudflare/vite-plugin`, Wrangler 4.92.0 |
| Database (optional) | Cloudflare D1 (Drizzle ORM 0.45.2) |
| ORM tooling | Drizzle Kit 0.31.10 |
| Media processing | FFmpeg / FFprobe on `PATH` |
| AI providers | OpenAI-compatible APIs, Volcengine Ark (Seedream / Seedance / Doubao), local Stable Diffusion WebUI |
| Test runner | Node.js built-in `node --test` |
| Linting | ESLint 9 with `eslint-config-next` |

> **Note:** This project uses **Vinext**, not the standard Next.js CLI. The app is built and served through `vinext` commands, which compile the React Server Components / SSR graph into `dist/server/` and the client bundle into `dist/client/`.

## Project structure

```
.
├── app/                        # Next.js App Router
│   ├── StudioApp.tsx           # Main client editor UI (single-page app)
│   ├── page.tsx                # Root page that renders StudioApp
│   ├── layout.tsx              # HTML shell + metadata
│   ├── globals.css             # Tailwind import + custom CSS design system
│   ├── chatgpt-auth.ts         # OpenAI/ChatGPT auth header helpers (template artifact)
│   └── lib/                    # Browser + server shared utilities
│       ├── concurrency.js      # Parallel job pool for image/video generation
│       ├── timeline.js         # Shot timing normalization, prompt fallbacks, formatting
│       ├── audio.js            # Voice presets and FFmpeg cleanup filter chains
│       ├── video.js            # Export resolution presets
│       ├── project-cache.js    # IndexedDB fallback and migration source
│       └── server-projects.js  # Browser client for bridge-backed episode storage
├── scripts/                    # Local development helpers
│   ├── dev-all.mjs             # Spawns render bridge + web dev server
│   └── render-service.mjs        # Local Node HTTP bridge for AI + FFmpeg
├── worker/                     # Cloudflare Worker entry point
│   └── index.ts                # Routes requests to Vinext SSR + image optimization
├── build/                      # Custom Vite plugins
│   └── sites-vite-plugin.ts    # Copies hosting.json and drizzle migrations into dist
├── db/                         # Drizzle setup
│   ├── index.ts                # getDb() helper for D1
│   └── schema.ts               # Empty by default; opt-in for D1 tables
├── drizzle/                    # Drizzle migrations output
├── examples/d1/                # Optional D1 example (notes table + API route)
├── tests/                      # Node built-in test suite
├── .openai/hosting.json        # Cloudflare binding config (D1/R2 names)
└── .env.example                # Provider configuration template
```

## Code organization and architecture

### Editor (`app/StudioApp.tsx`)

A single `"use client"` component implements the entire editor. It holds four main screens internally:

1. **Episode** — script input, narration upload, and local transcription.
2. **Storyboard** — shot list, inspector, image/video generation, AI shot planning.
3. **Audio & captions** — bilingual subtitle editing, BGM selection, narration de-noise toggle.
4. **Export** — final MP4 render, preview, and download.

State is persisted through `app/lib/project-cache.js` using browser IndexedDB. The cache normalizes saved shots on load so interrupted generation jobs are reset to safe states.

### Shared libraries (`app/lib/`)

These modules run in both the browser and the local Node bridge (the bridge imports `../app/lib/*.js` from `scripts/render-service.mjs`). Keep them free of browser-only or Node-only APIs unless guarded.

- `concurrency.js` — bounded parallel worker pool (`mapWithConcurrency`) and slot check (`canStartConcurrentJob`).
- `timeline.js` — `normalizePlannedShots()` stretches AI-planned shots across narration duration, derives word-timestamp boundaries from transcription data, and fills fallback image/video prompts from episode-level creative direction.
- `audio.js` — voice presets (`original`, `denoise`) and FFmpeg cleanup filter chains.
- `video.js` — vertical resolution presets (`480p`, `720p`, `1080p`).
- `project-cache.js` — IndexedDB read/write/clear for the active episode.

### Local render bridge (`scripts/render-service.mjs`)

This is a plain Node.js HTTP server listening on `127.0.0.1:4317` by default. It is spawned in `--watch` mode by `npm run dev`. It is the only process that touches:

- FFmpeg / FFprobe for rendering, audio cleanup, and probing.
- Provider API keys (read from `.env.local` / `.env`).
- Local speech-to-text transcription endpoints.

The bridge exposes JSON/REST endpoints such as `/episodes`, `/render`, `/image/generate`, `/video/generate`, `/text/plan`, `/text/translate`, `/audio/transcribe`, `/audio/process`, `/config/status`, and `/providers/test`. `scripts/episode-store.mjs` maintains the SQLite catalog, JSON backups, browser-cache migration, and per-episode media layout. Legacy global `/assets/` and `/renders/` paths remain readable for existing projects.

### Cloudflare Worker (`worker/index.ts`)

The Worker is the production entry point. It routes image optimization requests (`/_vinext/image`) through `vinext/server/image-optimization` and everything else through the Vinext Next.js App Router handler. It expects D1/R2 bindings named as configured in `.openai/hosting.json`. Currently the database schema is intentionally empty; the `examples/d1/` folder shows how to opt into D1 tables.

### Build pipeline (`vite.config.ts`)

- Vite loads the `vinext()` plugin, a custom `sites()` plugin, and the `@cloudflare/vite-plugin` configured for RSC + SSR environments.
- The `cloudflare()` plugin points to `worker/index.ts` and declares D1/R2 bindings from `.openai/hosting.json`.
- The `sites()` plugin (in `build/sites-vite-plugin.ts`) copies `.openai/hosting.json` and `drizzle/` migrations into `dist/.openai/` after a production build.

## Build and test commands

All commands are run from the project root.

```bash
# Install dependencies
npm install

# Start the full local development stack
# - web app on http://localhost:3000
# - render bridge on http://127.0.0.1:4317 (watch mode)
npm run dev

# Start only the web app (already requires the bridge to be running separately)
npm run dev:web

# Start only the render bridge
npm run render-service

# Production build (output in dist/)
npm run build

# Start the production build locally
npm start

# Run the full test suite (builds first, then runs Node tests with real FFmpeg)
npm test

# Run ESLint
npm run lint

# Generate Drizzle migrations
npm run db:generate
```

### Testing strategy

- Tests use Node's built-in `node:test` runner and live in `tests/*.test.mjs`.
- `npm test` first builds the app, then runs all tests.
- `tests/rendered-html.test.mjs` imports the built Worker from `dist/server/index.js` and asserts the SSR shell renders.
- `tests/render-service.test.mjs` exercises the local bridge with mocked HTTP responses and real FFmpeg subprocesses (requires FFmpeg/FFprobe on PATH).
- `tests/audio.test.mjs`, `tests/video.test.mjs`, `tests/timeline.test.mjs`, `tests/concurrency.test.mjs`, and `tests/project-cache.test.mjs` test the pure utility modules.
- Some tests are marked with `{ timeout: 120000 }` because they invoke FFmpeg.

## Code style guidelines

- **Modules:** ES modules everywhere. `package.json` has `"type": "module"`. Node `.mjs` scripts and browser `.js` libs share the same module syntax.
- **TypeScript:** Strict mode enabled. Prefer `*.ts` / `*.tsx` for React and config; plain `*.js` for shared libraries that the Node bridge also imports.
- **Formatting:** The codebase uses a compact, no-semicolon style. Follow the existing style in adjacent code rather than reformatting whole files.
- **Imports:** Use `node:` prefixes for Node built-ins (e.g., `node:fs/promises`, `node:child_process`).
- **CSS:** Tailwind CSS 4 is imported in `app/globals.css` via `@import "tailwindcss";`. The rest of the file is hand-written CSS using custom properties (`--ink`, `--paper`, `--gold`, etc.) and a mobile-responsive grid layout.
- **Paths:** The `tsconfig.json` alias `@/*` maps to `./*`. Both `import` and `require` styles are not used; use ES `import`.
- **React:** `StudioApp.tsx` is a client component. Prefer `useRef`, `useState`, `useEffect` for local UI state. Keep provider status / network calls inside the component; heavy media work is delegated to the render bridge.

## Configuration and environment

Copy `.env.example` to `.env.local` and add real keys. `.env.local` is ignored by Git.

Key environment variables:

- `OPENAI_API_KEY`, `VOLCENGINE_API_KEY` — provider API keys.
- `TEXT_PROVIDER`, `TEXT_MODEL` — active chat/planning provider.
- `IMAGE_PROVIDER`, `IMAGE_MODEL` — active image generation provider.
- `VIDEO_PROVIDER`, `VIDEO_MODEL` — active video generation provider (currently Volcengine only).
- `TRANSCRIPTION_ENDPOINT`, `TRANSCRIPTION_LANGUAGE` — local STT endpoint.
- `TEXT_REQUEST_TIMEOUT_MS`, `VIDEO_REQUEST_TIMEOUT_MS`, `VIDEO_POLL_INTERVAL_MS` — bridge timeouts.
- `SHORTFORM_PORT` — render bridge port (default `4317`).

Provider endpoints and model names can also be overridden per-session from the in-app **Provider settings** modal. The bridge never returns the actual API key values to the browser; it only returns `configured`, `kind`, `endpoint`, `model`, and `source`.

### Cloudflare bindings

`.openai/hosting.json` currently has `d1: null` and `r2: null`. To opt into D1, set `d1` to the binding name (e.g., `"DB"`) and add tables to `db/schema.ts`, then run `npm run db:generate`. See `examples/d1/` for a working pattern.

## Security considerations

- **API keys are server-side only.** They live in `.env.local` / `.env` and are read by `scripts/render-service.mjs`. The browser never sees them.
- **Environment files are ignored.** `.gitignore` excludes `.env*` except `.env.example`. Do not commit real keys.
- **Local asset storage.** Episode data is written under `.shortform/episodes/<episode-slug>/` (or `SHORTFORM_STORAGE_DIR`). These directories and the SQLite database are ignored by Git and are not protected by authentication in local development.
- **Input validation.** The bridge limits request body sizes (`160MB` max for media, smaller for JSON). FFmpeg arguments are constructed from validated numeric fields; durations, widths, and heights are clamped.
- **CORS.** The local bridge only allows `http://localhost:3000` in development.
- **Auth file.** `app/chatgpt-auth.ts` is a template artifact from the Vinext starter. It is not currently wired into the editor flow.

## Common agent tasks

- **Add a new image provider:** Update `configuredProvider()` / `resolveImageProvider()` / `generateImage()` in `scripts/render-service.mjs` and expose the new `kind` in `ProviderSettings` and `getProviderStatus()`.
- **Change shot timing logic:** Edit `app/lib/timeline.js` (`normalizePlannedShots`, `timestampBoundaries`). Add or update tests in `tests/timeline.test.mjs`.
- **Change export behavior:** Edit `renderEpisode()` in `scripts/render-service.mjs` and add tests in `tests/render-service.test.mjs`.
- **Add database tables:** Edit `db/schema.ts`, run `npm run db:generate`, and optionally reference `examples/d1/`.
- **Update UI state/persistence:** The authoritative client state lives in `StudioApp.tsx`; persistence is in `app/lib/project-cache.js`. Always normalize cached values on read.

## Useful references

- `README.md` — user-facing workflow and provider setup instructions.
- `.env.example` — complete provider configuration template.
- `vite.config.ts` — build orchestration and Cloudflare plugin configuration.
- `package.json` — full dependency list and scripts.
