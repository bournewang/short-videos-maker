import { execFileSync } from "node:child_process";
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

function queryEpisodes(databasePath) {
  const json = execFileSync("sqlite3", ["-json", databasePath, "SELECT id, slug, project_json FROM episodes"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(json);
}

function localReferencePath(value, storageRoot, rowsById) {
  const text = String(value || "");
  if (!text) return "";
  let pathname = "";
  try { pathname = decodeURIComponent(new URL(text, "http://127.0.0.1:4317").pathname); } catch { /* absolute paths */ }
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

function jobIdsFromBuilds(project) {
  const builds = Array.isArray(project.videoBuilds) ? project.videoBuilds : [];
  return builds.map((b) => String(b?.id || "")).filter(Boolean);
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

function categorizeFile(filepath, storageRoot) {
  const rel = path.relative(storageRoot, filepath);
  if (rel.startsWith("jobs" + path.sep)) return "job";
  if (rel.startsWith("episodes" + path.sep)) {
    const parts = rel.split(path.sep);
    if (parts.length >= 3) {
      const sub = parts[2];
      if (sub === "exports") return "export";
      if (sub === "images") return "image";
      if (sub === "covers") return "cover";
      if (sub === "audio") return "audio";
      if (sub === "videos") return "video";
    }
    if (parts.length === 2 && rel.endsWith("episode.json")) return "manifest";
    return "episode-other";
  }
  if (rel.startsWith("assets" + path.sep)) return "asset";
  if (rel.startsWith("exports" + path.sep)) return "global-export";
  if (rel.startsWith("audio-previews" + path.sep)) return "audio-preview";
  return "other";
}

export async function collectStorageUsage(storageRoot) {
  const normalizedRoot = path.resolve(storageRoot);
  const databasePath = path.join(normalizedRoot, "episodes.sqlite");
  const rows = queryEpisodes(databasePath);

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const dbSlugs = new Set(rows.map((row) => row.slug));
  const kept = new Set();
  const activeJobIds = new Set();

  for (const row of rows) {
    const manifest = path.resolve(normalizedRoot, "episodes", row.slug, "episode.json");
    kept.add(manifest);
    const project = JSON.parse(row.project_json);
    for (const reference of projectReferences(project)) {
      const filename = localReferencePath(reference, normalizedRoot, rowsById);
      if (filename && filename.startsWith(`${normalizedRoot}${path.sep}`)) kept.add(filename);
    }
    for (const jobId of jobIdsFromBuilds(project)) activeJobIds.add(jobId);
  }

  // Link job directories to active exports: keep all files in a job directory
  // if the job ID matches an export still referenced in videoBuilds
  const jobRoot = path.join(normalizedRoot, "jobs");
  let jobEntries;
  try { jobEntries = await opendir(jobRoot); } catch { jobEntries = null; }
  if (jobEntries) {
    for await (const entry of jobEntries) {
      if (!entry.isDirectory()) continue;
      if (activeJobIds.has(entry.name)) {
        const jobDir = path.join(jobRoot, entry.name);
        const jobFiles = await walkFiles(jobDir);
        for (const f of jobFiles) kept.add(path.resolve(f));
      }
    }
  }

  const candidateRoots = ["assets", "exports", "jobs", "audio-previews", "episodes"].map((name) => path.join(normalizedRoot, name));
  const allFiles = (await Promise.all(candidateRoots.map(walkFiles))).flat();

  // Collect orphan episode directories (not in DB)
  const orphanEpisodeDirs = [];
  const episodesRoot = path.join(normalizedRoot, "episodes");
  let episodeEntries;
  try { episodeEntries = await opendir(episodesRoot); } catch { episodeEntries = null; }
  if (episodeEntries) {
    for await (const entry of episodeEntries) {
      if (entry.isDirectory() && !dbSlugs.has(entry.name)) {
        orphanEpisodeDirs.push(path.join(episodesRoot, entry.name));
      }
    }
  }

  // Get sizes for orphan episode dirs
  const orphanFileSet = new Set();
  for (const dir of orphanEpisodeDirs) {
    const dirFiles = await walkFiles(dir);
    for (const f of dirFiles) orphanFileSet.add(path.resolve(f));
  }

  const unused = [];
  let unusedBytes = 0;

  for (const filename of allFiles) {
    const abs = path.resolve(filename);
    if (kept.has(abs)) continue;
    const info = await stat(filename);
    const category = orphanFileSet.has(abs) ? "orphan-episode" : categorizeFile(abs, normalizedRoot);
    unused.push({ filename: abs, bytes: info.size, category });
    unusedBytes += info.size;
  }

  return { storageRoot: normalizedRoot, databasePath, episodeCount: rows.length, kept: [...kept].sort(), unused, unusedBytes, candidateRoots, activeJobIds, orphanEpisodeDirs };
}

export async function cleanupStorage(storageRoot, options = {}) {
  const usage = await collectStorageUsage(storageRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stagingRoot = path.join(usage.storageRoot, ".cleanup-staging", timestamp);
  const reportPath = path.join(usage.storageRoot, `cleanup-report-${timestamp}.json`);

  const categorySummary = {};
  for (const item of usage.unused) {
    const cat = item.category || "other";
    if (!categorySummary[cat]) categorySummary[cat] = { count: 0, bytes: 0 };
    categorySummary[cat].count++;
    categorySummary[cat].bytes += item.bytes;
  }

  const report = {
    createdAt: new Date().toISOString(),
    storageRoot: usage.storageRoot,
    episodeCount: usage.episodeCount,
    keptFiles: usage.kept.length,
    unusedFiles: usage.unused.length,
    unusedBytes: usage.unusedBytes,
    orphanEpisodeDirs: usage.orphanEpisodeDirs.map((d) => path.relative(usage.storageRoot, d)),
    categorySummary,
    applied: Boolean(options.apply),
    purged: false,
    files: usage.unused.map(({ filename, bytes, category }) => ({ path: path.relative(usage.storageRoot, filename), bytes, category })),
  };

  if (!options.apply) {
    return { ...report, reportPath: "", stagingRoot: "" };
  }

  for (const item of usage.unused) {
    const relative = path.relative(usage.storageRoot, item.filename);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe cleanup target: ${item.filename}`);
    const target = path.join(stagingRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(item.filename, target);
  }

  for (const root of usage.candidateRoots) await removeEmptyDirectories(root);

  for (const dir of usage.orphanEpisodeDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  for (const filename of usage.kept) await access(filename);

  if (options.purge) {
    await rm(stagingRoot, { recursive: true, force: true });
    report.purged = true;
  }

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, reportPath, stagingRoot: report.purged ? "" : stagingRoot };
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await loadEnvironmentFile(".env.local");
  await loadEnvironmentFile(".env");
  const storageRoot = path.resolve(process.env.SHORTFORM_STORAGE_DIR || path.join(projectRoot, ".shortform"));
  const apply = process.argv.includes("--apply");
  const purge = process.argv.includes("--purge");
  if (purge && !apply) throw new Error("--purge requires --apply");

  const result = await cleanupStorage(storageRoot, { apply, purge });

  if (!apply) {
    console.log(`\n=== DRY RUN (use --apply to execute) ===\n`);
    console.log(`Storage: ${result.storageRoot}`);
    console.log(`Episodes in DB: ${result.episodeCount}`);
    console.log(`Files to keep: ${result.keptFiles}`);
    console.log(`Files to remove: ${result.unusedFiles}`);
    console.log(`Space to free: ${formatBytes(result.unusedBytes)}`);
    if (result.orphanEpisodeDirs.length > 0) {
      console.log(`\nOrphan episode directories (not in DB):`);
      for (const d of result.orphanEpisodeDirs) console.log(`  ${d}`);
    }
    console.log(`\nBy category:`);
    for (const [cat, summary] of Object.entries(result.categorySummary).sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.log(`  ${cat}: ${summary.count} files, ${formatBytes(summary.bytes)}`);
    }
    if (result.unusedFiles > 0) {
      console.log(`\nSample files that would be removed:`);
      const samples = result.files.slice(0, 30);
      for (const f of samples) console.log(`  ${f.path} (${formatBytes(f.bytes)}) [${f.category}]`);
      if (result.files.length > 30) console.log(`  ... and ${result.files.length - 30} more`);
    }
    console.log(`\nRun with --apply to move files to staging, --apply --purge to permanently delete.`);
  } else {
    console.log(JSON.stringify({
      storageRoot: result.storageRoot,
      episodeCount: result.episodeCount,
      keptFiles: result.keptFiles,
      unusedFiles: result.unusedFiles,
      unusedBytes: result.unusedBytes,
      applied: result.applied,
      purged: result.purged,
      stagingRoot: result.stagingRoot,
      reportPath: result.reportPath,
      categorySummary: result.categorySummary,
    }, null, 2));
  }
}