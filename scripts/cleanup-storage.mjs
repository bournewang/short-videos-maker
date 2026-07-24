import Database from "better-sqlite3";
import { access, mkdir, opendir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadEnvironmentFile(filename) {
  try {
    const source = await readFile(path.join(projectRoot, filename), "utf8");
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function localReferencePath(value, storageRoot, rowsById) {
  const text = String(value || "");
  if (!text) return "";
  let pathname = "";
  try { pathname = decodeURIComponent(new URL(text, "http://127.0.0.1:4317").pathname); } catch { /* absolute paths are handled below */ }
  const episodeMatch = /^\/episodes\/([^/]+)\/files\/(.+)$/.exec(pathname);
  if (episodeMatch) {
    const row = rowsById.get(decodeURIComponent(episodeMatch[1]));
    if (!row) return "";
    const relative = episodeMatch[2].split("/").map(decodeURIComponent).join(path.sep);
    return path.resolve(storageRoot, "episodes", row.slug, relative);
  }
  if (pathname.startsWith("/assets/")) return path.resolve(storageRoot, "assets", path.basename(pathname));
  if (pathname.startsWith("/renders/")) return path.resolve(storageRoot, "exports", path.basename(pathname));
  if (path.isAbsolute(text) && text.startsWith(`${storageRoot}${path.sep}`)) return path.resolve(text);
  return "";
}

function projectReferences(project) {
  const references = [project.audioPath, project.audioData, project.previewUrl, project.downloadUrl];
  for (const shot of Array.isArray(project.shots) ? project.shots : []) references.push(shot?.image, shot?.video, ...(Array.isArray(shot?.variants) ? shot.variants : []));
  for (const cover of Array.isArray(project.covers) ? project.covers : []) references.push(cover?.path, cover?.url);
  for (const build of Array.isArray(project.videoBuilds) ? project.videoBuilds : []) references.push(build?.path, build?.url);
  return references.filter(Boolean);
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try { entries = await opendir(directory); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for await (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await visit(root);
  return files;
}

async function removeEmptyDirectories(root, keepRoot = true) {
  let entries;
  try { entries = await opendir(root); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const directories = [];
  for await (const entry of entries) if (entry.isDirectory()) directories.push(path.join(root, entry.name));
  for (const directory of directories) await removeEmptyDirectories(directory, false);
  if (!keepRoot) await rmdir(root).catch((error) => { if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error; });
}

export async function collectStorageUsage(storageRoot) {
  const normalizedRoot = path.resolve(storageRoot);
  const databasePath = path.join(normalizedRoot, "episodes.sqlite");
  const database = new Database(databasePath, { readonly:true, fileMustExist:true });
  let rows;
  try { rows = database.prepare("SELECT id, slug, project_json FROM episodes").all(); }
  finally { database.close(); }
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const kept = new Set();
  for (const row of rows) {
    const manifest = path.resolve(normalizedRoot, "episodes", row.slug, "episode.json");
    kept.add(manifest);
    const project = JSON.parse(row.project_json);
    for (const reference of projectReferences(project)) {
      const filename = localReferencePath(reference, normalizedRoot, rowsById);
      if (filename && filename.startsWith(`${normalizedRoot}${path.sep}`)) kept.add(filename);
    }
  }
  const candidateRoots = ["assets", "exports", "jobs", "audio-previews", "episodes"].map((name) => path.join(normalizedRoot, name));
  const allFiles = (await Promise.all(candidateRoots.map(walkFiles))).flat();
  const unused = [];
  let unusedBytes = 0;
  for (const filename of allFiles) {
    if (kept.has(path.resolve(filename))) continue;
    const info = await stat(filename);
    unused.push({ filename:path.resolve(filename), bytes:info.size });
    unusedBytes += info.size;
  }
  return { storageRoot:normalizedRoot, databasePath, episodeCount:rows.length, kept:[...kept].sort(), unused, unusedBytes, candidateRoots };
}

export async function cleanupStorage(storageRoot, options = {}) {
  const usage = await collectStorageUsage(storageRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stagingRoot = path.join(usage.storageRoot, ".cleanup-staging", timestamp);
  const reportPath = path.join(usage.storageRoot, `cleanup-report-${timestamp}.json`);
  const report = {
    createdAt:new Date().toISOString(),
    storageRoot:usage.storageRoot,
    episodeCount:usage.episodeCount,
    keptFiles:usage.kept.length,
    unusedFiles:usage.unused.length,
    unusedBytes:usage.unusedBytes,
    applied:Boolean(options.apply),
    purged:false,
    files:usage.unused.map(({ filename, bytes }) => ({ path:path.relative(usage.storageRoot, filename), bytes })),
  };
  if (!options.apply) return { ...report, reportPath:"", stagingRoot:"" };
  for (const item of usage.unused) {
    const relative = path.relative(usage.storageRoot, item.filename);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe cleanup target: ${item.filename}`);
    const target = path.join(stagingRoot, relative);
    await mkdir(path.dirname(target), { recursive:true });
    await rename(item.filename, target);
  }
  for (const root of usage.candidateRoots) await removeEmptyDirectories(root);
  for (const filename of usage.kept) await access(filename);
  if (options.purge) {
    await rm(stagingRoot, { recursive:true, force:true });
    report.purged = true;
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, reportPath, stagingRoot:report.purged ? "" : stagingRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await loadEnvironmentFile(".env.local");
  await loadEnvironmentFile(".env");
  const storageRoot = path.resolve(process.env.SHORTFORM_STORAGE_DIR || path.join(projectRoot, ".shortform"));
  const apply = process.argv.includes("--apply");
  const purge = process.argv.includes("--purge");
  if (purge && !apply) throw new Error("--purge requires --apply");
  const result = await cleanupStorage(storageRoot, { apply, purge });
  console.log(JSON.stringify({
    storageRoot:result.storageRoot,
    episodeCount:result.episodeCount,
    keptFiles:result.keptFiles,
    unusedFiles:result.unusedFiles,
    unusedBytes:result.unusedBytes,
    applied:result.applied,
    purged:result.purged,
    stagingRoot:result.stagingRoot,
    reportPath:result.reportPath,
    sample:result.files.slice(0, 20),
  }, null, 2));
}
