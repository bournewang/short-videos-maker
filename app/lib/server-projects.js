async function request(service, pathname, options = {}) {
  const response = await fetch(`${String(service).replace(/\/+$/, "")}${pathname}`, {
    ...options,
    headers:{ "Content-Type":"application/json", ...(options.headers || {}) },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Episode storage returned ${response.status}`);
  return result;
}

export async function listServerProjects(service) {
  return (await request(service, "/episodes")).episodes || [];
}

export async function readServerProject(service, id = "") {
  const pathname = id ? `/episodes/${encodeURIComponent(id)}` : "/episodes/active";
  return (await request(service, pathname)).episode || null;
}

export async function writeServerProject(service, project) {
  const id = String(project?.id || "").trim();
  if (!id) throw new Error("A saved episode requires an ID");
  return await request(service, `/episodes/${encodeURIComponent(id)}`, {
    method:"PUT",
    body:JSON.stringify({ project }),
  });
}

export async function activateServerProject(service, id) {
  return await request(service, `/episodes/${encodeURIComponent(id)}/activate`, { method:"POST", body:"{}" });
}

export async function deleteServerProject(service, id) {
  return await request(service, `/episodes/${encodeURIComponent(id)}`, { method:"DELETE" });
}

export async function importServerProjects(service, episodes, activeEpisodeId = "") {
  return await request(service, "/episodes/import", {
    method:"POST",
    body:JSON.stringify({ episodes, activeEpisodeId }),
  });
}
