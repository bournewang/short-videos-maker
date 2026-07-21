import { defaultVideoPrompt, sanitizeImagePrompt } from "./timeline.js";
import { normalizeSubtitleStyle } from "./subtitle-style.js";

const DATABASE_NAME = "shortform-studio-cache";
const STORE_NAME = "projects";
const ACTIVE_PROJECT_KEY = "active-episode";
const EPISODE_KEY_PREFIX = "episode:";

export function createEpisodeId() {
  if (globalThis.crypto?.randomUUID) return `episode-${globalThis.crypto.randomUUID()}`;
  return `episode-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeCachedProject(value) {
  if (!value || typeof value !== "object") return null;
  const shots = Array.isArray(value.shots) ? value.shots.map((shot, index) => {
    const image = String(shot?.image || "");
    const video = String(shot?.video || "");
    const interruptedImage = shot?.imageStatus === "queued" || shot?.imageStatus === "generating" || (!shot?.imageStatus && shot?.status === "generating");
    const interruptedVideo = shot?.videoStatus === "queued" || shot?.videoStatus === "generating";
    const imageStatus = interruptedImage ? "failed" : shot?.imageStatus === "failed" ? "failed" : image ? "generated" : "idle";
    const videoStatus = interruptedVideo ? "failed" : shot?.videoStatus === "failed" ? "failed" : video ? "generated" : "idle";
    return {
      ...shot,
      prompt:sanitizeImagePrompt(shot?.prompt),
      videoPrompt:String(shot?.videoPrompt || defaultVideoPrompt(shot, index)).trim(),
      image,
      variants:Array.isArray(shot?.variants) ? shot.variants : [],
      imageStatus,
      imageError:imageStatus === "failed" ? String(shot?.imageError || (interruptedImage ? "Image generation was interrupted when the project closed." : "Image generation failed.")) : "",
      video,
      videoStatus,
      videoError:videoStatus === "failed" ? String(shot?.videoError || (interruptedVideo ? "Video generation was interrupted when the project closed." : "Video generation failed.")) : "",
      videoProvider:String(shot?.videoProvider || ""),
      status:shot?.status === "generating" || (shot?.status === "generated" && !image) ? "planned" : (shot?.status || "planned"),
    };
  }) : [];
  return { ...value, subtitleStyle:normalizeSubtitleStyle(value.subtitleStyle), shots };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("IndexedDB is unavailable")); return; }
    const request = globalThis.indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the episode cache"));
  });
}

function episodeKey(id) { return `${EPISODE_KEY_PREFIX}${id}`; }

function readStoreValue(store, key, message) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error(message));
  });
}

function readDatabaseValue(database, key, message) {
  return readStoreValue(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME), key, message);
}

export function episodeCacheSummary(value) {
  const project = normalizeCachedProject(value);
  if (!project) return null;
  return {
    id:String(project.id || ""),
    title:String(project.title || "").trim() || "Untitled episode",
    savedAt:Number(project.savedAt) || 0,
    shotCount:project.shots.length,
    duration:project.shots.reduce((total, shot) => total + (Number(shot?.duration) || 0), 0),
    hasNarration:Boolean(project.audioData),
    stage:String(project.stage || "episode"),
  };
}

export async function readProjectCache(id = "") {
  const database = await openDatabase();
  try {
    if (id) return normalizeCachedProject(await readDatabaseValue(database, episodeKey(id), "Could not read the saved episode"));
    const active = await readDatabaseValue(database, ACTIVE_PROJECT_KEY, "Could not read the active episode cache");
    const value = active?.activeEpisodeId
      ? await readDatabaseValue(database, episodeKey(active.activeEpisodeId), "Could not read the active episode")
      : active;
    return normalizeCachedProject(value);
  } finally { database.close(); }
}

export async function writeProjectCache(value) {
  const id = String(value?.id || "").trim();
  if (!id) throw new Error("A saved episode requires an ID");
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const record = { ...value, id, cacheVersion:4, savedAt:Date.now() };
      store.put(record, episodeKey(id));
      store.put({ activeEpisodeId:id }, ACTIVE_PROJECT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not save the episode cache"));
      transaction.onabort = () => reject(transaction.error || new Error("Episode caching was aborted"));
    });
  } finally { database.close(); }
}

export async function activateProjectCache(id) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ activeEpisodeId:String(id) }, ACTIVE_PROJECT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not activate the saved episode"));
    });
  } finally { database.close(); }
}

export async function listProjectCaches() {
  const database = await openDatabase();
  try {
    const store = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const [keys, values] = await Promise.all([
      new Promise((resolve, reject) => { const request = store.getAllKeys(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }),
      new Promise((resolve, reject) => { const request = store.getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }),
    ]);
    const episodes = keys.map((key, index) => String(key).startsWith(EPISODE_KEY_PREFIX) ? episodeCacheSummary(values[index]) : null).filter(Boolean);
    if (!episodes.length) {
      const legacyIndex = keys.findIndex((key, index) => key === ACTIVE_PROJECT_KEY && values[index]?.activeEpisodeId === undefined);
      if (legacyIndex >= 0) {
        const legacy = episodeCacheSummary({ ...values[legacyIndex], id:"legacy-active" });
        if (legacy) episodes.push(legacy);
      }
    }
    return episodes.sort((left, right) => right.savedAt - left.savedAt);
  } finally { database.close(); }
}

export async function deleteProjectCache(id) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(episodeKey(String(id)));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not delete the saved episode"));
    });
  } finally { database.close(); }
}

export async function clearProjectCache() {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(ACTIVE_PROJECT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not clear the episode cache"));
    });
  } finally { database.close(); }
}
