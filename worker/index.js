/**
 * Admin API for Song Bird Publishing.
 *
 * Cloudflare Access gates the whole /admin* route at the edge, so every
 * request that reaches this Worker already passed the email-code login.
 * This still independently re-verifies the signed Access token on every
 * write — same defense-in-depth reasoning as any other Access-protected
 * API: the edge gate can be misconfigured or removed without this code
 * noticing, so it checks for itself rather than trusting that Access ran.
 *
 * On a verified request it reads/writes content straight to GitHub via the
 * Contents API using a repo-scoped token, so a save here is a real commit
 * to `main` — the existing Workers Build pipeline then rebuilds and
 * redeploys automatically, exactly as it does for a normal push.
 */

// ---------------------------------------------------------------- Access JWT

let certCache = { keys: null, fetchedAt: 0 };
const CERT_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(input) {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function b64urlToJson(input) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input)));
}

async function getCerts(teamDomain) {
  const now = Date.now();
  if (certCache.keys && now - certCache.fetchedAt < CERT_TTL_MS) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Could not fetch Access certificates");
  const data = await res.json();
  certCache = { keys: data.keys || [], fetchedAt: now };
  return certCache.keys;
}

async function verifyAccessToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("Token expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) throw new Error("Token not yet valid");

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error("Token audience mismatch");
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new Error("Token issuer mismatch");

  const keys = await getCerts(env.ACCESS_TEAM_DOMAIN);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Signing key not found");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    b64urlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error("Bad signature");

  return payload;
}

function originIsTrusted(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deny(message, status = 403) {
  return json({ error: message }, status);
}

async function requireAccess(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAIL) {
    throw new HttpError("Admin access is not configured yet.", 500);
  }
  if (request.method !== "GET" && !originIsTrusted(request)) {
    throw new HttpError("That request didn't come from this site.", 403);
  }

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    (request.headers.get("Cookie") || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("CF_Authorization="))
      ?.slice("CF_Authorization=".length);

  if (!token) throw new HttpError("Not signed in.", 401);

  let payload;
  try {
    payload = await verifyAccessToken(token, env);
  } catch {
    throw new HttpError("Sign-in could not be verified.", 401);
  }

  const allowed = env.ADMIN_EMAIL.split(",").map((e) => e.trim().toLowerCase());
  const email = (payload.email || "").toLowerCase();
  if (!allowed.includes(email)) throw new HttpError("This account is not allowed in.", 403);

  return email;
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// -------------------------------------------------------------- GitHub API

async function gh(env, method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "songbird-admin-worker",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(`GitHub API error (${res.status}): ${text.slice(0, 300)}`, 502);
  }
  return res.json();
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function getFile(env, path) {
  const data = await gh(env, "GET", `/contents/${path}?ref=${env.GITHUB_BRANCH}`);
  if (!data || Array.isArray(data)) return null;
  return { content: base64ToUtf8(data.content), sha: data.sha };
}

async function listDir(env, path) {
  const data = await gh(env, "GET", `/contents/${path}?ref=${env.GITHUB_BRANCH}`);
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

async function putFile(env, path, contentStr, sha, message) {
  return gh(env, "PUT", `/contents/${path}`, {
    message,
    content: utf8ToBase64(contentStr),
    branch: env.GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  });
}

async function deleteFile(env, path, sha, message) {
  return gh(env, "DELETE", `/contents/${path}`, { message, sha, branch: env.GITHUB_BRANCH });
}

// ------------------------------------------------------------ Frontmatter

function yamlScalar(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const s = String(v ?? "");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw.trim() };
  const [, fmBlock, body] = match;
  const data = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    let val = rawVal.trim();
    if (/^".*"$/.test(val)) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (/^-?\d+$/.test(val)) {
      val = parseInt(val, 10);
    }
    data[key] = val;
  }
  return { data, body: body.trim() };
}

function stringifyFrontmatter(data, body) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v : k === "date" ? v : yamlScalar(v)}`);
  return `---\n${lines.join("\n")}\n---\n${body || ""}\n`;
}

function slugify(s) {
  return (s || "untitled")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

async function uniqueSlug(env, dir, base) {
  let slug = base;
  let n = 2;
  while (await getFile(env, `${dir}/${slug}.md`)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

// -------------------------------------------------------------- Collections

const COLLECTIONS = {
  authors: {
    dir: "src/authors",
    fields: ["name", "genre", "photo", "book_cover", "order"],
    titleField: "name",
    body: "body",
  },
  posts: {
    dir: "src/posts",
    fields: ["title", "date", "standfirst"],
    titleField: "title",
    body: "body",
  },
};

async function listCollection(env, key) {
  const cfg = COLLECTIONS[key];
  const entries = await listDir(env, cfg.dir);
  const items = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const file = await getFile(env, entry.path);
    if (!file) continue;
    const { data, body } = parseFrontmatter(file.content);
    items.push({ slug: entry.name.replace(/\.md$/, ""), sha: file.sha, ...data, body });
  }
  return items;
}

async function saveCollectionItem(env, key, slug, fields, isNew) {
  const cfg = COLLECTIONS[key];
  const data = {};
  for (const f of cfg.fields) data[f] = fields[f];
  const body = fields.body || "";
  const content = stringifyFrontmatter(data, body);

  let finalSlug = slug;
  if (isNew) {
    finalSlug = await uniqueSlug(env, cfg.dir, slugify(fields[cfg.titleField]));
  }
  const path = `${cfg.dir}/${finalSlug}.md`;
  const message = `${isNew ? "Add" : "Update"} ${key.slice(0, -1)}: ${fields[cfg.titleField] || finalSlug}`;
  await putFile(env, path, content, isNew ? undefined : fields.sha, message);
  return finalSlug;
}

async function deleteCollectionItem(env, key, slug, sha) {
  const cfg = COLLECTIONS[key];
  await deleteFile(env, `${cfg.dir}/${slug}.md`, sha, `Delete ${key.slice(0, -1)}: ${slug}`);
}

// -------------------------------------------------------------------- Site

async function getSite(env) {
  const file = await getFile(env, "src/_data/site.json");
  if (!file) throw new HttpError("site.json not found", 500);
  return { data: JSON.parse(file.content), sha: file.sha };
}

async function putSite(env, data, sha) {
  const content = JSON.stringify(data, null, 2) + "\n";
  return putFile(env, "src/_data/site.json", content, sha, "Update page content");
}

// ------------------------------------------------------------------ Router

async function handleApi(request, env, url) {
  const email = await requireAccess(request, env);
  const parts = url.pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);

  if (parts.length === 0 && request.method === "GET") {
    return json({ email });
  }

  if (parts[0] === "site") {
    if (request.method === "GET") return json(await getSite(env));
    if (request.method === "PUT") {
      const body = await request.json();
      await putSite(env, body.data, body.sha);
      const fresh = await getSite(env);
      return json(fresh);
    }
  }

  if (parts[0] === "authors" || parts[0] === "posts") {
    const key = parts[0];
    if (parts.length === 1) {
      if (request.method === "GET") return json(await listCollection(env, key));
      if (request.method === "POST") {
        const body = await request.json();
        const slug = await saveCollectionItem(env, key, null, body, true);
        return json({ slug });
      }
    }
    if (parts.length === 2) {
      const slug = decodeURIComponent(parts[1]);
      if (request.method === "PUT") {
        const body = await request.json();
        await saveCollectionItem(env, key, slug, { ...body, slug }, false);
        return json({ slug });
      }
      if (request.method === "DELETE") {
        const body = await request.json();
        await deleteCollectionItem(env, key, slug, body.sha);
        return json({ ok: true });
      }
    }
  }

  if (parts[0] === "uploads" && request.method === "POST") {
    const body = await request.json();
    const safeName = (body.filename || "upload").replace(/[^a-zA-Z0-9._-]/g, "-");
    const unique = `${Date.now()}-${safeName}`;
    const path = `src/assets/uploads/${unique}`;
    // Binary upload: write the raw base64 the browser sent directly, no
    // text re-encoding (that's only for the UTF-8 markdown/JSON helpers).
    await gh(env, "PUT", `/contents/${path}`, {
      message: `Upload ${unique}`,
      content: body.base64,
      branch: env.GITHUB_BRANCH,
    });
    return json({ path: `/assets/uploads/${unique}` });
  }

  return deny("Not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/admin/")) {
      return new Response("Not found", { status: 404 });
    }
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return deny(err.message, err.status);
      return deny(`Unexpected error: ${err.message || err}`, 500);
    }
  },
};
