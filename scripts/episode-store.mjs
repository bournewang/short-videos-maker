import Database from "better-sqlite3";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MEDIA_DIRECTORIES = new Set(["audio", "images", "videos", "covers", "exports"]);

function safeEpisodeId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id)) throw new Error("A valid episode ID is required");
  return id;
}

function safeMediaName(value, fallback = "media") {
  return String(value || fallback)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;
}

export function slugifyEpisodeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "untitled-episode";
}

function dataUrlMedia(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(value || ""));
  if (!match) return null;
  return {
    mime:match[1] || "application/octet-stream",
    data:match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3])),
  };
}

function mediaExtension(mime, fallback = "") {
  const normalized = String(mime || "").toLowerCase();
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mpeg")) return ".mp3";
  if (normalized.includes("m4a")) return ".m4a";
  if (normalized.includes("aac")) return ".aac";
  if (normalized.includes("mp4") && normalized.startsWith("audio/")) return ".m4a";
  if (normalized.startsWith("video/") || normalized.includes("mp4")) return ".mp4";
  return [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".wav", ".mp3", ".m4a", ".aac"].includes(fallback.toLowerCase()) ? fallback.toLowerCase() : ".bin";
}

function fileContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".m4a" || extension === ".aac") return "audio/mp4";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function episodeSummary(project, slug) {
  const shots = Array.isArray(project.shots) ? project.shots : [];
  return {
    id:String(project.id || ""),
    title:String(project.title || "").trim() || "Untitled episode",
    slug,
    savedAt:Number(project.savedAt) || 0,
    shotCount:shots.length,
    duration:shots.reduce((total, shot) => total + (Number(shot?.duration) || 0), 0),
    hasNarration:Boolean(project.audioData || project.audioPath),
    stage:String(project.stage || "episode"),
  };
}

async function exists(filename) {
  try { await stat(filename); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function atomicWrite(filename, data) {
  await mkdir(path.dirname(filename), { recursive:true });
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, data);
  await rename(temporary, filename);
}

function relativeServerPath(id, relativePath) {
  return `/episodes/${encodeURIComponent(id)}/files/${String(relativePath).split(path.sep).map(encodeURIComponent).join("/")}`;
}

function hydratedUrl(baseUrl, value) {
  const text = String(value || "");
  return text.startsWith("/episodes/") ? `${baseUrl}${text}` : text;
}

function cloneProject(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

export class EpisodeStore {
  constructor(options = {}) {
    this.storageRoot = path.resolve(options.storageRoot || ".shortform");
    this.episodesRoot = path.join(this.storageRoot, "episodes");
    this.trashRoot = path.join(this.storageRoot, ".trash", "episodes");
    this.databasePath = path.join(this.storageRoot, "episodes.sqlite");
    this.assetRoot = path.resolve(options.assetRoot || path.join(this.storageRoot, "assets"));
    this.exportRoot = path.resolve(options.exportRoot || path.join(this.storageRoot, "exports"));
    this.publicBaseUrl = String(options.publicBaseUrl || "http://127.0.0.1:4317").replace(/\/+$/, "");
    this.database = null;
    this.writeQueue = Promise.resolve();
    this.mediaLocks = new Map();
  }

  async initialize() {
    if (this.database) return this;
    await Promise.all([
      mkdir(this.episodesRoot, { recursive:true }),
      mkdir(this.trashRoot, { recursive:true }),
      mkdir(this.assetRoot, { recursive:true }),
      mkdir(this.exportRoot, { recursive:true }),
    ]);
    this.database = new Database(this.databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        saved_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        stage TEXT NOT NULL,
        shot_count INTEGER NOT NULL,
        duration REAL NOT NULL,
        has_narration INTEGER NOT NULL,
        project_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS episodes_saved_at_idx ON episodes(saved_at DESC);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    return this;
  }

  close() {
    this.database?.close();
    this.database = null;
  }

  queueWrite(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  row(id) {
    return this.database.prepare("SELECT * FROM episodes WHERE id = ?").get(safeEpisodeId(id)) || null;
  }

  uniqueSlug(title, id) {
    const base = slugifyEpisodeName(title);
    const conflict = this.database.prepare("SELECT id FROM episodes WHERE slug = ? AND id <> ?").get(base, id);
    return conflict ? `${base}-${safeMediaName(id).slice(-8)}` : base;
  }

  async ensureEpisodeDirectory(project) {
    const id = safeEpisodeId(project.id);
    const existing = this.row(id);
    const slug = existing?.slug && this.mediaLocks.get(id) ? existing.slug : this.uniqueSlug(project.title, id);
    const directory = path.join(this.episodesRoot, slug);
    if (existing?.slug && existing.slug !== slug) {
      const previous = path.join(this.episodesRoot, existing.slug);
      if (await exists(previous) && !await exists(directory)) await rename(previous, directory);
    }
    await Promise.all([...MEDIA_DIRECTORIES].map((name) => mkdir(path.join(directory, name), { recursive:true })));
    return { id, slug, directory };
  }

  async resolveLocalSource(value) {
    const text = String(value || "");
    if (!text) return null;
    let url;
    try { url = new URL(text, this.publicBaseUrl); } catch { url = null; }
    if (url && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith("/assets/")) return path.join(this.assetRoot, path.basename(pathname));
      if (pathname.startsWith("/renders/")) return path.join(this.exportRoot, path.basename(pathname));
      const match = /^\/episodes\/([^/]+)\/files\/(.+)$/.exec(pathname);
      if (match) {
        const sourceRow = this.row(decodeURIComponent(match[1]));
        if (!sourceRow) return null;
        const relativePath = match[2].split("/").map(decodeURIComponent).join(path.sep);
        return this.safeEpisodeFile(sourceRow.slug, relativePath);
      }
    }
    if (path.isAbsolute(text) && text.startsWith(`${this.storageRoot}${path.sep}`)) return text;
    return null;
  }

  safeEpisodeFile(slug, relativePath) {
    const directory = path.join(this.episodesRoot, slug);
    const filename = path.resolve(directory, relativePath);
    const relative = path.relative(directory, filename);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid episode file path");
    return filename;
  }

  async persistMedia(value, context, mediaDirectory, name, fallbackExtension = "") {
    if (!value) return "";
    const text = String(value);
    if (text.startsWith(`/episodes/${encodeURIComponent(context.id)}/files/`) && (path.extname(text).toLowerCase() !== ".bin" || !fallbackExtension)) return text;
    try {
      const url = new URL(text);
      if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.pathname.startsWith(`/episodes/${encodeURIComponent(context.id)}/files/`) && (path.extname(url.pathname).toLowerCase() !== ".bin" || !fallbackExtension)) return url.pathname;
    } catch { /* data URLs and filesystem paths are handled below */ }
    const dataMedia = dataUrlMedia(text);
    const source = dataMedia ? null : await this.resolveLocalSource(text);
    if (!dataMedia && (!source || !await exists(source))) return text;
    const extension = dataMedia ? mediaExtension(dataMedia.mime, fallbackExtension) : mediaExtension("", fallbackExtension || path.extname(source));
    const relativePath = path.join(mediaDirectory, `${safeMediaName(name)}${extension}`);
    const target = path.join(context.directory, relativePath);
    if (!await exists(target)) {
      await mkdir(path.dirname(target), { recursive:true });
      if (dataMedia) await atomicWrite(target, dataMedia.data);
      else if (path.resolve(source) !== path.resolve(target)) {
        const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
        await copyFile(source, temporary);
        await rename(temporary, target);
      }
    }
    return relativeServerPath(context.id, relativePath);
  }

  async prepareProjectForStorage(input, context) {
    const project = cloneProject(input);
    project.id = context.id;
    project.title = String(project.title || "");
    project.savedAt = Number(project.savedAt) || Date.now();
    if (project.audioData) {
      project.audioPath = await this.persistMedia(project.audioData, context, "audio", "narration", path.extname(String(project.audioName || "")));
      delete project.audioData;
    }
    const shots = Array.isArray(project.shots) ? project.shots : [];
    for (let index = 0; index < shots.length; index += 1) {
      const shot = shots[index] || {};
      const shotName = safeMediaName(shot.id || `shot-${index + 1}`);
      shot.image = await this.persistMedia(shot.image, context, "images", `${shotName}-image`);
      if (Array.isArray(shot.variants)) {
        const variants = [];
        for (let variantIndex = 0; variantIndex < shot.variants.length; variantIndex += 1) {
          variants.push(await this.persistMedia(shot.variants[variantIndex], context, "images", `${shotName}-variant-${variantIndex + 1}`));
        }
        shot.variants = variants.filter(Boolean);
      }
      shot.video = await this.persistMedia(shot.video, context, "videos", `${shotName}-video`);
    }
    for (let index = 0; index < (Array.isArray(project.covers) ? project.covers.length : 0); index += 1) {
      const cover = project.covers[index];
      const stored = await this.persistMedia(cover.url || cover.path, context, "covers", cover.id || `cover-${index + 1}`);
      cover.path = stored;
      cover.url = stored;
    }
    for (let index = 0; index < (Array.isArray(project.videoBuilds) ? project.videoBuilds.length : 0); index += 1) {
      const build = project.videoBuilds[index];
      const stored = await this.persistMedia(build.url || build.path, context, "exports", build.id || `build-${index + 1}`);
      build.path = stored;
      build.url = stored;
    }
    if (project.previewUrl) project.previewUrl = await this.persistMedia(project.previewUrl, context, "exports", "latest-preview");
    if (project.downloadUrl) project.downloadUrl = await this.persistMedia(project.downloadUrl, context, "exports", "latest-download");
    return project;
  }

  hydrateProject(value) {
    const project = cloneProject(value);
    if (project.audioPath) project.audioData = hydratedUrl(this.publicBaseUrl, project.audioPath);
    for (const shot of Array.isArray(project.shots) ? project.shots : []) {
      shot.image = hydratedUrl(this.publicBaseUrl, shot.image);
      shot.video = hydratedUrl(this.publicBaseUrl, shot.video);
      shot.variants = Array.isArray(shot.variants) ? shot.variants.map((item) => hydratedUrl(this.publicBaseUrl, item)) : [];
    }
    for (const cover of Array.isArray(project.covers) ? project.covers : []) cover.url = hydratedUrl(this.publicBaseUrl, cover.url || cover.path);
    for (const build of Array.isArray(project.videoBuilds) ? project.videoBuilds : []) build.url = hydratedUrl(this.publicBaseUrl, build.url || build.path);
    project.previewUrl = hydratedUrl(this.publicBaseUrl, project.previewUrl);
    project.downloadUrl = hydratedUrl(this.publicBaseUrl, project.downloadUrl);
    return project;
  }

  async saveEpisode(input, options = {}) {
    return this.queueWrite(async () => {
      await this.initialize();
      const context = await this.ensureEpisodeDirectory(input);
      const project = await this.prepareProjectForStorage(input, context);
      const summary = episodeSummary(project, context.slug);
      const existing = this.row(context.id);
      const createdAt = Number(existing?.created_at) || Date.now();
      const projectJson = JSON.stringify(project);
      await atomicWrite(path.join(context.directory, "episode.json"), `${JSON.stringify(project, null, 2)}\n`);
      const transaction = this.database.transaction(() => {
        this.database.prepare(`
          INSERT INTO episodes (id, title, slug, saved_at, created_at, stage, shot_count, duration, has_narration, project_json)
          VALUES (@id, @title, @slug, @savedAt, @createdAt, @stage, @shotCount, @duration, @hasNarration, @projectJson)
          ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, slug=excluded.slug, saved_at=excluded.saved_at, stage=excluded.stage,
            shot_count=excluded.shot_count, duration=excluded.duration, has_narration=excluded.has_narration,
            project_json=excluded.project_json
        `).run({ ...summary, createdAt, hasNarration:summary.hasNarration ? 1 : 0, projectJson });
        if (options.setActive !== false) this.database.prepare("INSERT INTO settings (key, value) VALUES ('activeEpisodeId', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(context.id);
      });
      transaction();
      return { episode:this.hydrateProject(project), summary, directory:context.directory };
    });
  }

  async importEpisodes(episodes, activeEpisodeId = "") {
    await this.initialize();
    const imported = [];
    for (const episode of Array.isArray(episodes) ? episodes : []) {
      if (!episode?.id) continue;
      const existing = this.row(episode.id);
      if (existing && Number(existing.saved_at) > (Number(episode.savedAt) || 0)) continue;
      imported.push((await this.saveEpisode(episode, { setActive:false })).summary);
    }
    if (activeEpisodeId && this.row(activeEpisodeId)) this.activateEpisode(activeEpisodeId);
    return imported;
  }

  activateEpisode(id) {
    const normalizedId = safeEpisodeId(id);
    if (!this.row(normalizedId)) throw new Error("Episode was not found");
    this.database.prepare("INSERT INTO settings (key, value) VALUES ('activeEpisodeId', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(normalizedId);
  }

  listEpisodes() {
    const rows = this.database.prepare("SELECT id, title, slug, saved_at, stage, shot_count, duration, has_narration FROM episodes ORDER BY saved_at DESC").all();
    return rows.map((row) => ({
      id:row.id, title:row.title || "Untitled episode", slug:row.slug, savedAt:row.saved_at,
      stage:row.stage, shotCount:row.shot_count, duration:row.duration, hasNarration:Boolean(row.has_narration),
    }));
  }

  getEpisode(id) {
    const row = this.row(id);
    return row ? this.hydrateProject(JSON.parse(row.project_json)) : null;
  }

  getActiveEpisode() {
    const setting = this.database.prepare("SELECT value FROM settings WHERE key = 'activeEpisodeId'").get();
    return setting?.value ? this.getEpisode(setting.value) : null;
  }

  async deleteEpisode(id) {
    return this.queueWrite(async () => {
      await this.initialize();
      const row = this.row(id);
      if (!row) return false;
      const source = path.join(this.episodesRoot, row.slug);
      if (await exists(source)) {
        await mkdir(this.trashRoot, { recursive:true });
        await rename(source, path.join(this.trashRoot, `${row.slug}-${Date.now()}`));
      }
      const transaction = this.database.transaction(() => {
        this.database.prepare("DELETE FROM episodes WHERE id = ?").run(row.id);
        const active = this.database.prepare("SELECT value FROM settings WHERE key = 'activeEpisodeId'").get();
        if (active?.value === row.id) this.database.prepare("DELETE FROM settings WHERE key = 'activeEpisodeId'").run();
      });
      transaction();
      return true;
    });
  }

  async mediaTarget(id, title, mediaDirectory, name) {
    await this.initialize();
    if (!MEDIA_DIRECTORIES.has(mediaDirectory)) throw new Error("Invalid episode media directory");
    const context = await this.ensureEpisodeDirectory({ id, title });
    const directory = path.join(context.directory, mediaDirectory);
    await mkdir(directory, { recursive:true });
    return {
      directory,
      baseName:safeMediaName(name || "media"),
      urlPrefix:relativeServerPath(context.id, mediaDirectory).replace(/\/$/, ""),
    };
  }

  async withMediaTarget(id, title, mediaDirectory, name, operation) {
    const normalizedId = safeEpisodeId(id);
    const target = await this.queueWrite(async () => {
      this.mediaLocks.set(normalizedId, (this.mediaLocks.get(normalizedId) || 0) + 1);
      try { return await this.mediaTarget(normalizedId, title, mediaDirectory, name); }
      catch (error) {
        const remaining = (this.mediaLocks.get(normalizedId) || 1) - 1;
        if (remaining) this.mediaLocks.set(normalizedId, remaining); else this.mediaLocks.delete(normalizedId);
        throw error;
      }
    });
    try { return await operation(target); }
    finally {
      const remaining = (this.mediaLocks.get(normalizedId) || 1) - 1;
      if (remaining) this.mediaLocks.set(normalizedId, remaining); else this.mediaLocks.delete(normalizedId);
    }
  }

  async fileForRequest(id, relativePath) {
    await this.initialize();
    const row = this.row(id);
    if (!row) throw new Error("Episode was not found");
    const filename = this.safeEpisodeFile(row.slug, relativePath);
    await readFile(filename);
    return { filename, contentType:fileContentType(filename) };
  }
}
