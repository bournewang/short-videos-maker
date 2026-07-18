import { defaultVideoPrompt } from "./timeline.js";

const DATABASE_NAME = "shortform-studio-cache";
const STORE_NAME = "projects";
const ACTIVE_PROJECT_KEY = "active-episode";

export function normalizeCachedProject(value) {
  if (!value || typeof value !== "object") return null;
  const shots = Array.isArray(value.shots) ? value.shots.map((shot, index) => ({
    ...shot,
    videoPrompt:String(shot?.videoPrompt || defaultVideoPrompt(shot, index)).trim(),
    image:String(shot?.image || ""),
    variants:Array.isArray(shot?.variants) ? shot.variants : [],
    video:String(shot?.video || ""),
    videoStatus:shot?.videoStatus === "generating" || (shot?.videoStatus === "generated" && !shot?.video) ? "idle" : (shot?.videoStatus || (shot?.video ? "generated" : "idle")),
    videoProvider:String(shot?.videoProvider || ""),
    status:shot?.status === "generating" || (shot?.status === "generated" && !shot?.image) ? "planned" : (shot?.status || "planned"),
  })) : [];
  return { ...value, shots };
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

export async function readProjectCache() {
  const database = await openDatabase();
  try {
    const value = await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(ACTIVE_PROJECT_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read the episode cache"));
    });
    return normalizeCachedProject(value);
  } finally { database.close(); }
}

export async function writeProjectCache(value) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ ...value, cacheVersion:2, savedAt:Date.now() }, ACTIVE_PROJECT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not save the episode cache"));
      transaction.onabort = () => reject(transaction.error || new Error("Episode caching was aborted"));
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
