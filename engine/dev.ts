import { stat } from "node:fs/promises";
import { watch } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const BUILD = join(import.meta.dir, "build.ts");
const PORT = Number(process.env.PORT ?? 3000);

const SKIP = /(?:^|\/)(?:\.git|\.github|\.obsidian|node_modules|dist|private|\.DS_Store)(?:\/|$)/;

let building = false;
let pending = false;
let lastBuildAt = 0;

async function runBuild(reason: string): Promise<void> {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  pending = false;
  const label = reason ? `[${reason}] ` : "";
  process.stdout.write(`engine: ${label}rebuilding…\n`);
  const proc = Bun.spawn({
    cmd: ["bun", BUILD],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  lastBuildAt = Date.now();
  building = false;
  if (pending) await runBuild("queued");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return MIME[path.slice(dot).toLowerCase()];
}

async function tryFile(req: Request, path: string): Promise<Response | undefined> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(path);
  } catch {
    return undefined;
  }
  if (!s.isFile()) return undefined;

  const lastModified = new Date(s.mtimeMs).toUTCString();
  const etag = `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
  const ifNoneMatch = req.headers.get("if-none-match");
  const ifModifiedSince = req.headers.get("if-modified-since");
  if (ifNoneMatch === etag || (!ifNoneMatch && ifModifiedSince === lastModified)) {
    return new Response(null, {
      status: 304,
      headers: { "cache-control": "no-cache", etag, "last-modified": lastModified },
    });
  }

  const headers: Record<string, string> = {
    "cache-control": "no-cache",
    etag,
    "last-modified": lastModified,
  };
  const mime = mimeFor(path);
  if (mime) headers["content-type"] = mime;
  return new Response(Bun.file(path), { headers });
}

async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.includes("..")) return new Response("400", { status: 400 });

  if (pathname.endsWith("/")) {
    const indexResponse = await tryFile(req, join(DIST, pathname, "index.html"));
    if (indexResponse) return indexResponse;
  }

  const direct = await tryFile(req, join(DIST, pathname));
  if (direct) return direct;

  if (!pathname.includes(".")) {
    const html = await tryFile(req, join(DIST, pathname + ".html"));
    if (html) return html;
  }

  return new Response("404 — file not found in dist/", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

await runBuild("initial");

Bun.serve({
  port: PORT,
  fetch: serveStatic,
});
console.log(`engine: serving dist/ on http://localhost:${PORT}`);
console.log(`engine: watching ${ROOT}`);

const watcher = watch(ROOT, { recursive: true });
let debounce: ReturnType<typeof setTimeout> | null = null;
let lastFile = "";
const mtimes = new Map<string, number>();

for await (const event of watcher) {
  const filename = event.filename ?? "";
  if (!filename) continue;
  if (SKIP.test(filename)) continue;
  if (filename.endsWith("~") || filename.endsWith(".swp")) continue;
  if (filename.startsWith("dist") || filename.startsWith("dist/")) continue;

  // Ignore events whose mtime hasn't advanced (e.g. atime touches from the build's own reads)
  const fullPath = join(ROOT, filename);
  let currentMtime: number;
  try {
    const s = await stat(fullPath);
    currentMtime = s.mtimeMs;
  } catch {
    continue; // file vanished between event and stat
  }
  const prev = mtimes.get(fullPath);
  if (prev === currentMtime) continue;
  mtimes.set(fullPath, currentMtime);

  lastFile = filename;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    runBuild(lastFile);
  }, 150);
}
