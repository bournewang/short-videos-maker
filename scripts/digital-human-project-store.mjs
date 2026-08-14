import Database from "better-sqlite3";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MEDIA_EXTENSIONS = {
  "audio/wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
};

function mediaExtension(mime) {
  return MEDIA_EXTENSIONS[mime] || ".bin";
}

function dataUrlParts(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(value || ""));
  if (!match) return null;
  return {
    mime: match[1] || "application/octet-stream",
    data: match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3])),
  };
}

async function atomicWrite(filename, data) {
  await mkdir(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, filename);
}

export class DigitalHumanProjectStore {
  constructor(options = {}) {
    this.storageRoot = path.resolve(options.storageRoot || ".shortform");
    this.databasePath = path.join(this.storageRoot, "episodes.sqlite");
    this.projectsRoot = path.join(this.storageRoot, "dh-projects");
    this.publicBaseUrl = String(options.publicBaseUrl || "http://127.0.0.1:4317").replace(/\/+$/, "");
    this.database = null;
  }

  async initialize() {
    if (this.database) return this;
    await mkdir(this.projectsRoot, { recursive: true });
    this.database = new Database(this.databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS dh_projects (
        id TEXT PRIMARY KEY,
        human_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        script TEXT NOT NULL DEFAULT '',
        audio_path TEXT NOT NULL DEFAULT '',
        audio_provider TEXT NOT NULL DEFAULT 'minimax',
        audio_voice TEXT NOT NULL DEFAULT '',
        audio_model TEXT NOT NULL DEFAULT '',
        audio_speed REAL NOT NULL DEFAULT 1.0,
        audio_language TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dh_videos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('preview', 'full')),
        video_url TEXT NOT NULL DEFAULT '',
        heygen_task_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES dh_projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS dh_audio_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        audio_path TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT 'minimax',
        voice TEXT NOT NULL DEFAULT '',
        voice_label TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        speed REAL NOT NULL DEFAULT 1.0,
        language TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES dh_projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS dh_covers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        image_path TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES dh_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS dh_projects_updated_at_idx ON dh_projects(updated_at DESC);
      CREATE INDEX IF NOT EXISTS dh_videos_project_id_idx ON dh_videos(project_id);
      CREATE INDEX IF NOT EXISTS dh_audio_versions_project_id_idx ON dh_audio_versions(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS dh_covers_project_id_idx ON dh_covers(project_id, created_at DESC);
    `);
    return this;
  }

  close() {
    this.database?.close();
    this.database = null;
  }

  projectDir(id) {
    return path.join(this.projectsRoot, id);
  }

  audioDir(id) {
    return path.join(this.projectDir(id), "audio");
  }

  coversDir(id) {
    return path.join(this.projectDir(id), "covers");
  }

  hydrateProject(row) {
    const project = { ...row };
    project.human_id = undefined;
    project.created_at = undefined;
    project.updated_at = undefined;
    project.audio_path = undefined;
    project.audio_provider = undefined;
    project.audio_voice = undefined;
    project.audio_model = undefined;
    project.audio_speed = undefined;
    project.audio_language = undefined;
    project.humanId = row.human_id;
    project.audioProvider = row.audio_provider;
    project.audioVoice = row.audio_voice;
    project.audioModel = row.audio_model;
    project.audioSpeed = row.audio_speed;
    project.audioLanguage = row.audio_language;
    project.createdAt = row.created_at;
    project.updatedAt = row.updated_at;
    if (row.audio_path) {
      project.audioPath = row.audio_path;
      project.audioUrl = `${this.publicBaseUrl}/dh-projects/${encodeURIComponent(project.id)}/audio`;
    }
    return project;
  }

  hydrateVideo(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      videoUrl: row.video_url,
      heygenTaskId: row.heygen_task_id,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  hydrateAudioVersion(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      audioPath: row.audio_path,
      audioUrl: row.audio_path
        ? `${this.publicBaseUrl}/dh-projects/${encodeURIComponent(row.project_id)}/audio/${encodeURIComponent(row.id)}`
        : undefined,
      provider: row.provider,
      voice: row.voice,
      voiceLabel: row.voice_label,
      model: row.model,
      speed: row.speed,
      language: row.language,
      createdAt: row.created_at,
    };
  }

  async listAudioVersions(projectId) {
    await this.initialize();
    const rows = this.database.prepare(
      "SELECT * FROM dh_audio_versions WHERE project_id = ? ORDER BY created_at DESC"
    ).all(projectId);
    return rows.map((r) => this.hydrateAudioVersion(r));
  }

  async getAudioVersion(projectId, versionId) {
    await this.initialize();
    const row = this.database.prepare(
      "SELECT * FROM dh_audio_versions WHERE id = ? AND project_id = ?"
    ).get(versionId, projectId);
    if (!row) return null;
    return this.hydrateAudioVersion(row);
  }

  async deleteAudioVersion(projectId, versionId) {
    await this.initialize();
    const version = this.database.prepare(
      "SELECT * FROM dh_audio_versions WHERE id = ? AND project_id = ?"
    ).get(versionId, projectId);
    if (!version) return false;

    try { await rm(version.audio_path, { force: true }); } catch {}

    this.database.prepare("DELETE FROM dh_audio_versions WHERE id = ?").run(versionId);

    const project = this.database.prepare("SELECT * FROM dh_projects WHERE id = ?").get(projectId);
    if (project && project.audio_path === version.audio_path) {
      const latest = this.database.prepare(
        "SELECT * FROM dh_audio_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(projectId);
      this.database.prepare("UPDATE dh_projects SET audio_path = ?, updated_at = ? WHERE id = ?")
        .run(latest ? latest.audio_path : "", Date.now(), projectId);
    }

    return true;
  }

  async list() {
    await this.initialize();
    const rows = this.database.prepare(
      "SELECT * FROM dh_projects ORDER BY updated_at DESC"
    ).all();
    return rows.map((r) => this.hydrateProject(r));
  }

  async get(id) {
    await this.initialize();
    const row = this.database.prepare("SELECT * FROM dh_projects WHERE id = ?").get(id);
    if (!row) return null;
    return this.hydrateProject(row);
  }

  async create({ humanId, name, script }) {
    await this.initialize();
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO dh_projects (id, human_id, name, script, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, humanId || "", name || "Untitled Project", script || "", now, now);
    return this.get(id);
  }

  async update(id, data) {
    await this.initialize();
    const existing = this.database.prepare("SELECT * FROM dh_projects WHERE id = ?").get(id);
    if (!existing) throw new Error("Project not found");

    const updates = {};
    if (data.humanId !== undefined) updates.human_id = data.humanId;
    if (data.name !== undefined) updates.name = data.name;
    if (data.script !== undefined) updates.script = data.script;
    if (data.audioProvider !== undefined) updates.audio_provider = data.audioProvider;
    if (data.audioVoice !== undefined) updates.audio_voice = data.audioVoice;
    if (data.audioModel !== undefined) updates.audio_model = data.audioModel;
    if (data.audioSpeed !== undefined) updates.audio_speed = data.audioSpeed;
    if (data.audioLanguage !== undefined) updates.audio_language = data.audioLanguage;

    // Handle audio data persistence (versioned)
    if (data.audioData) {
      const parts = dataUrlParts(data.audioData);
      if (parts) {
        const versionId = randomUUID();
        const dir = this.audioDir(id);
        await mkdir(dir, { recursive: true });
        const ext = mediaExtension(parts.mime);
        const filename = path.join(dir, `${versionId}${ext}`);
        await atomicWrite(filename, parts.data);
        updates.audio_path = filename;

        this.database.prepare(`
          INSERT INTO dh_audio_versions (id, project_id, audio_path, provider, voice, voice_label, model, speed, language, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          versionId, id, filename,
          data.audioProvider || "minimax",
          data.audioVoice || "",
          data.voiceLabel || data.audioVoice || "",
          data.audioModel || "",
          data.audioSpeed ?? 1,
          data.audioLanguage || "",
          Date.now()
        );
      }
    }

    if (Object.keys(updates).length === 0) return this.get(id);

    updates.updated_at = Date.now();
    const sets = Object.keys(updates).map((k) => `${k} = @${k}`).join(", ");
    this.database.prepare(`UPDATE dh_projects SET ${sets} WHERE id = @id`).run({ ...updates, id });
    return this.get(id);
  }

  async delete(id) {
    await this.initialize();
    const existing = this.database.prepare("SELECT * FROM dh_projects WHERE id = ?").get(id);
    if (!existing) return false;
    // Delete project directory with all media
    const dir = this.projectDir(id);
    try { await rm(dir, { recursive: true, force: true }); } catch {}
    this.database.prepare("DELETE FROM dh_projects WHERE id = ?").run(id);
    return true;
  }

  async listVideos(projectId) {
    await this.initialize();
    const rows = this.database.prepare(
      "SELECT * FROM dh_videos WHERE project_id = ? ORDER BY created_at DESC"
    ).all(projectId);
    return rows.map((r) => this.hydrateVideo(r));
  }

  async addVideo(projectId, { type, videoUrl, heygenTaskId, status }) {
    await this.initialize();
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO dh_videos (id, project_id, type, video_url, heygen_task_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, type, videoUrl || "", heygenTaskId || "", status || "pending", now);
    return this.hydrateVideo(
      this.database.prepare("SELECT * FROM dh_videos WHERE id = ?").get(id)
    );
  }

  async updateVideo(id, data) {
    await this.initialize();
    const existing = this.database.prepare("SELECT * FROM dh_videos WHERE id = ?").get(id);
    if (!existing) throw new Error("Video not found");

    const updates = {};
    if (data.videoUrl !== undefined) updates.video_url = data.videoUrl;
    if (data.heygenTaskId !== undefined) updates.heygen_task_id = data.heygenTaskId;
    if (data.status !== undefined) updates.status = data.status;

    if (Object.keys(updates).length === 0) return this.hydrateVideo(existing);

    const sets = Object.keys(updates).map((k) => `${k} = @${k}`).join(", ");
    this.database.prepare(`UPDATE dh_videos SET ${sets} WHERE id = @id`).run({ ...updates, id });
    return this.hydrateVideo(
      this.database.prepare("SELECT * FROM dh_videos WHERE id = ?").get(id)
    );
  }

  async deleteVideo(id) {
    await this.initialize();
    const existing = this.database.prepare("SELECT * FROM dh_videos WHERE id = ?").get(id);
    if (!existing) return false;
    this.database.prepare("DELETE FROM dh_videos WHERE id = ?").run(id);
    return true;
  }

  async findVideoByTaskId(heygenTaskId) {
    await this.initialize();
    const row = this.database.prepare(
      "SELECT * FROM dh_videos WHERE heygen_task_id = ?"
    ).get(heygenTaskId);
    return row ? this.hydrateVideo(row) : null;
  }

  hydrateCover(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      imagePath: row.image_path,
      imageUrl: row.image_path
        ? `${this.publicBaseUrl}/dh-projects/${encodeURIComponent(row.project_id)}/covers/${encodeURIComponent(path.basename(row.image_path))}`
        : "",
      prompt: row.prompt,
      createdAt: row.created_at,
    };
  }

  async listCovers(projectId) {
    await this.initialize();
    const rows = this.database.prepare(
      "SELECT * FROM dh_covers WHERE project_id = ? ORDER BY created_at DESC"
    ).all(projectId);
    return rows.map((r) => this.hydrateCover(r));
  }

  async getCover(projectId, coverId) {
    await this.initialize();
    const row = this.database.prepare(
      "SELECT * FROM dh_covers WHERE id = ? AND project_id = ?"
    ).get(coverId, projectId);
    return row ? this.hydrateCover(row) : null;
  }

  async addCover(projectId, { id, imagePath, prompt }) {
    await this.initialize();
    const coverId = id || randomUUID();
    this.database.prepare(`
      INSERT INTO dh_covers (id, project_id, image_path, prompt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(coverId, projectId, imagePath || "", prompt || "", Date.now());
    return this.getCover(projectId, coverId);
  }

  async deleteCover(projectId, coverId) {
    await this.initialize();
    const cover = this.database.prepare(
      "SELECT * FROM dh_covers WHERE id = ? AND project_id = ?"
    ).get(coverId, projectId);
    if (!cover) return false;
    try { await rm(cover.image_path, { force: true }); } catch {}
    this.database.prepare("DELETE FROM dh_covers WHERE id = ?").run(coverId);
    return true;
  }
}