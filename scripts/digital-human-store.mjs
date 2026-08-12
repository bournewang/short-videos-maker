import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export class DigitalHumanStore {
  constructor({ storageRoot }) {
    this.root = path.join(storageRoot, "digital-humans");
  }

  async #ensureDir() {
    await mkdir(this.root, { recursive: true });
  }

  #humanPath(id) {
    return path.join(this.root, `${id}.json`);
  }

  async list() {
    await this.#ensureDir();
    const entries = await readdir(this.root).catch(() => []);
    const humans = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.root, entry), "utf8");
        const human = JSON.parse(raw);
        if (human.photoExt) {
          const photoPath = path.join(this.root, `${human.id}.${human.photoExt}`);
          try {
            const photoBuf = await readFile(photoPath);
            human.photo = `data:image/${human.photoExt};base64,${photoBuf.toString("base64")}`;
          } catch {
            human.photo = "";
          }
        }
        humans.push(human);
      } catch {
        // skip corrupt files
      }
    }
    humans.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return humans;
  }

  async get(id) {
    await this.#ensureDir();
    const raw = await readFile(this.#humanPath(id), "utf8");
    const human = JSON.parse(raw);
    if (human.photoExt) {
      const photoPath = path.join(this.root, `${human.id}.${human.photoExt}`);
      try {
        const photoBuf = await readFile(photoPath);
        human.photo = `data:image/${human.photoExt};base64,${photoBuf.toString("base64")}`;
      } catch {
        human.photo = "";
      }
    }
    return human;
  }

  async create({ name, photo, voice, voiceLabel }) {
    await this.#ensureDir();
    const id = randomUUID();
    const now = Date.now();
    let photoExt = "";
    let photoData = "";

    if (photo && /^data:image\/(\w+);base64,/.test(photo)) {
      const match = photo.match(/^data:image\/(\w+);base64,(.+)$/);
      photoExt = match[1] === "jpeg" ? "jpg" : match[1];
      photoData = match[2];
      await writeFile(path.join(this.root, `${id}.${photoExt}`), Buffer.from(photoData, "base64"));
    }

    const human = {
      id, name, voice, voiceLabel: voiceLabel || voice,
      photoExt, createdAt: now, updatedAt: now,
    };
    await writeFile(this.#humanPath(id), JSON.stringify(human, null, 2));
    if (photoExt) human.photo = photo;
    return human;
  }

  async update(id, { name, photo, voice, voiceLabel }) {
    await this.#ensureDir();
    const existing = await this.get(id);
    const now = Date.now();

    if (name !== undefined) existing.name = name;
    if (voice !== undefined) existing.voice = voice;
    if (voiceLabel !== undefined) existing.voiceLabel = voiceLabel;
    existing.updatedAt = now;

    if (photo !== undefined && /^data:image\/(\w+);base64,/.test(photo)) {
      // remove old photo
      if (existing.photoExt) {
        try { await unlink(path.join(this.root, `${id}.${existing.photoExt}`)); } catch {}
      }
      const match = photo.match(/^data:image\/(\w+);base64,(.+)$/);
      const photoExt = match[1] === "jpeg" ? "jpg" : match[1];
      const photoData = match[2];
      await writeFile(path.join(this.root, `${id}.${photoExt}`), Buffer.from(photoData, "base64"));
      existing.photoExt = photoExt;
      existing.photo = photo;
    } else if (photo === "") {
      if (existing.photoExt) {
        try { await unlink(path.join(this.root, `${id}.${existing.photoExt}`)); } catch {}
      }
      existing.photoExt = "";
      existing.photo = "";
    }

    await writeFile(this.#humanPath(id), JSON.stringify(existing, null, 2));
    return existing;
  }

  async delete(id) {
    await this.#ensureDir();
    const existing = await this.get(id).catch(() => null);
    if (existing?.photoExt) {
      try { await unlink(path.join(this.root, `${id}.${existing.photoExt}`)); } catch {}
    }
    await unlink(this.#humanPath(id));
  }
}