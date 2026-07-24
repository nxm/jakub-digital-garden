import { readdir, rm, mkdir, cp, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse, filePathToSlug, slugifySegment, slugifyPath, humanize } from "./markdown";
import { render, type ListingContext } from "./template";
import type { Menu, Page } from "./types";

const DEFAULT_PAGE_SIZE = 20;

const ROOT = join(import.meta.dir, "..");
const VAULT = join(ROOT, "docs");
const DIST = join(ROOT, "dist");
const STYLES_SRC = join(import.meta.dir, "styles");
const SCRIPTS_SRC = join(import.meta.dir, "scripts");
const PUBLIC_SRC = join(import.meta.dir, "public");
const MENU_PATH = join(VAULT, "system", "menu.json");
const DEFAULT_NEWSLETTER_ENDPOINT = "";

const SKIP_DIRS = new Set([
  ".git",
  ".github",
  ".obsidian",
  "engine",
  "dist",
  "node_modules",
  "private",
  "system",
]);

const SKIP_FILES = new Set([
  "package.json",
  "package-lock.json",
  "menu.json",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  ".DS_Store",
]);

async function collectMarkdown(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdown(full)));
    } else if (entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

async function collectAssets(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectAssets(full)));
    } else if (!entry.name.toLowerCase().endsWith(".md") && !SKIP_FILES.has(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function newestFirst(aDate?: string, bDate?: string): number {
  if (aDate && bDate) return bDate.localeCompare(aDate);
  if (aDate) return -1;
  if (bDate) return 1;
  return 0;
}

function sortPages(pages: Page[]): Page[] {
  return [...pages].sort((a, b) => {
    if (a.order !== undefined || b.order !== undefined) {
      if (a.order === undefined) return 1;
      if (b.order === undefined) return -1;
      if (a.order !== b.order) return a.order - b.order;
    }

    // Explicit frontmatter dates win over file mtime, so ordering is stable on a
    // fresh CI checkout (where every file shares the same checkout timestamp).
    const recencyCompare = newestFirst(
      a.updatedAt ?? a.date ?? a.fileUpdatedAt,
      b.updatedAt ?? b.date ?? b.fileUpdatedAt,
    );
    if (recencyCompare !== 0) return recencyCompare;

    return a.title.localeCompare(b.title);
  });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

async function writeFile(outPath: string, html: string): Promise<void> {
  await mkdir(join(outPath, ".."), { recursive: true });
  await Bun.write(outPath, html);
}

// Pretty-URL stub: a page emitted at `<slug>.html` is also reachable at
// `<slug>/` and `<slug>/index.html` via a tiny redirect, so hand-typed
// directory-style URLs (and Obsidian folder-note habits) don't 404.
function redirectHtml(targetHref: string): string {
  const t = targetHref.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0; url=${t}">`,
    `<link rel="canonical" href="${t}">`,
    '<meta name="robots" content="noindex">',
    "<title>Redirecting…</title></head>",
    `<body><a href="${t}">Continue →</a></body></html>`,
    "",
  ].join("\n");
}

async function writePublicEnvScript(): Promise<void> {
  const newsletterEndpoint = Bun.env.PUBLIC_NEWSLETTER_ENDPOINT?.trim() || DEFAULT_NEWSLETTER_ENDPOINT;
  const publicEnv = {
    NEWSLETTER_ENDPOINT: newsletterEndpoint,
  };

  await mkdir(join(DIST, "scripts"), { recursive: true });
  await Bun.write(
    join(DIST, "scripts", "env.js"),
    `window.JAKUB_ENV = ${JSON.stringify(publicEnv, null, 2)};\n`,
  );
}

async function getVersion(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (proc.exitCode === 0 && out) return out;
  } catch {
    // git not available (e.g. tarball build) — fall through
  }
  const sha = Bun.env.GITHUB_SHA?.trim();
  return sha ? sha.slice(0, 7) : "dev";
}

async function build() {
  const start = performance.now();

  const menu: Menu = await Bun.file(MENU_PATH).json();
  menu.version = await getVersion();

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(STYLES_SRC, join(DIST, "styles"), { recursive: true });
  try {
    await cp(SCRIPTS_SRC, join(DIST, "scripts"), { recursive: true });
  } catch {
    // scripts dir is optional
  }
  await writePublicEnvScript();
  // Copy everything in engine/public/ to dist/ root (favicons, robots.txt overrides, etc.)
  try {
    const entries = await readdir(PUBLIC_SRC, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "README.md") continue;
      await cp(join(PUBLIC_SRC, entry.name), join(DIST, entry.name), { recursive: true });
    }
  } catch {
    // public dir is optional
  }

  const files = await collectMarkdown(VAULT);
  const assetFiles = await collectAssets(VAULT);
  const fileUpdatedAtMap = new Map<string, string>();
  for (const file of files) {
    const stats = await stat(file);
    fileUpdatedAtMap.set(file, stats.mtime.toISOString());
  }

  // Basename → slug for Obsidian-style [[Name]] resolution.
  // Aliases are added in a second pass below so they don't shadow real basenames.
  const basenameMap = new Map<string, string>();
  for (const file of files) {
    const rel = relative(VAULT, file);
    const slug = filePathToSlug(rel);
    // Map keys are lowercased so wikilink lookups are case-insensitive,
    // while values keep the slug's original case for URL emission.
    const basename = (slug.split("/").pop() ?? slug).toLowerCase();
    if (!basenameMap.has(basename)) basenameMap.set(basename, slug);
  }

  // Basename → asset path for Obsidian-style ![[image.png]] resolution
  const assetMap = new Map<string, string>();
  for (const file of assetFiles) {
    const rel = relative(VAULT, file).replaceAll("\\", "/");
    const basename = (rel.split("/").pop() ?? rel).toLowerCase();
    if (!assetMap.has(basename)) assetMap.set(basename, rel);
  }

  // First pass: parse without basenameMap so we can collect aliases.
  let skipped = 0;
  const pages: Page[] = [];
  for (const file of files) {
    const raw = await Bun.file(file).text();
    const page = parse(relative(VAULT, file), raw, {
      basenameMap,
      assetMap,
      fileUpdatedAt: fileUpdatedAtMap.get(file),
    });
    if (page.published) {
      pages.push(page);
    } else {
      skipped++;
    }
  }

  // Add aliases to the basenameMap (only if they don't shadow a real note).
  for (const page of pages) {
    if (!page.aliases) continue;
    for (const alias of page.aliases) {
      const key = slugifySegment(alias).toLowerCase();
      if (!key) continue;
      if (!basenameMap.has(key)) basenameMap.set(key, page.slug);
    }
  }
  // Re-parse so aliased [[wikilinks]] resolve. Cheap; the alternative is
  // a two-phase pipeline that splits link rewriting from rendering.
  pages.length = 0;
  for (const file of files) {
    const raw = await Bun.file(file).text();
    const page = parse(relative(VAULT, file), raw, {
      basenameMap,
      assetMap,
      fileUpdatedAt: fileUpdatedAtMap.get(file),
    });
    if (page.published) pages.push(page);
  }

  const childrenMap = new Map<string, Page[]>();
  for (const page of pages) {
    if (page.unlisted) continue;
    const parts = page.slug.split("/");
    if (parts.length < 2) continue;
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const existing = childrenMap.get(parent) ?? [];
      existing.push(page);
      childrenMap.set(parent, existing);
    }
  }
  // Keep only direct children per parent, then sort
  for (const [parent, all] of childrenMap) {
    const depth = parent.split("/").length;
    const direct = all.filter((p) => p.slug.split("/").length === depth + 1);
    childrenMap.set(parent, sortPages(direct));
  }

  // Synthesize listing pages for parent slugs without an explicit .md file
  const slugSet = new Set(pages.map((p) => p.slug));
  for (const parent of childrenMap.keys()) {
    if (slugSet.has(parent)) continue;
    const title = humanize(parent.split("/").pop() ?? parent);
    pages.push({
      slug: parent,
      title,
      content: "",
      published: true,
      listing: true,
      raw: "",
    });
  }

  // Note graph → graph.json. Computed before rendering so each page knows
  // whether it has connections (and therefore whether to show the graph rail).
  const graphPages = pages.filter((p) => p.slug.toLowerCase() !== "graph");
  const nodeSlugs = new Set(graphPages.map((p) => p.slug));
  const edgeKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  const edgeMap = new Map<string, { source: string; target: string; kind: "link" | "tree" }>();
  for (const p of graphPages) {
    for (const target of p.links ?? []) {
      if (target === p.slug || !nodeSlugs.has(target)) continue;
      edgeMap.set(edgeKey(p.slug, target), { source: p.slug, target, kind: "link" });
    }
  }
  for (const p of graphPages) {
    const parts = p.slug.split("/");
    if (parts.length < 2) continue;
    const parent = parts.slice(0, -1).join("/");
    if (!nodeSlugs.has(parent)) continue;
    const key = edgeKey(parent, p.slug);
    if (!edgeMap.has(key)) edgeMap.set(key, { source: parent, target: p.slug, kind: "tree" });
  }
  const graphEdges = [...edgeMap.values()];
  const connectedSlugs = new Set<string>();
  for (const e of graphEdges) { connectedSlugs.add(e.source); connectedSlugs.add(e.target); }
  const graph = {
    nodes: graphPages.map((p) => ({
      id: p.slug,
      title: p.title,
      group: p.slug.split("/")[0],
      href: `/${p.slug}.html`,
    })),
    edges: graphEdges,
  };
  await Bun.write(join(DIST, "graph.json"), JSON.stringify(graph));

  let count = 0;
  let homeWritten = false;
  for (const page of pages) {
    const children = childrenMap.get(page.slug) ?? [];
    let html: string;
    let outSlug = page.slug;
    const hasRail = connectedSlugs.has(page.slug);

    const shouldList = page.listing !== false && children.length > 0;
    if (shouldList) {
      const pageSize = page.listingPageSize ?? DEFAULT_PAGE_SIZE;
      const chunks = chunkArray(children, pageSize);

      for (let i = 0; i < chunks.length; i++) {
        const pageNum = i + 1;
        const virtualSlug = pageNum === 1 ? page.slug : `${page.slug}/page/${pageNum}`;
        const listing: ListingContext = {
          children: chunks[i],
          currentPage: pageNum,
          totalPages: chunks.length,
          parentSlug: page.slug,
        };
        const listingHtml = render({ ...page, slug: virtualSlug }, menu, listing, hasRail);
        await writeFile(join(DIST, `${virtualSlug}.html`), listingHtml);
        count++;
      }
      continue;
    } else {
      html = render(page, menu, undefined, hasRail);
    }

    await writeFile(join(DIST, `${outSlug}.html`), html);
    count++;

    const homeSlug = menu.home ? slugifyPath(menu.home).toLowerCase() : undefined;
    if (homeSlug && homeSlug === page.slug.toLowerCase()) {
      await writeFile(join(DIST, "index.html"), html);
      homeWritten = true;
      count++;
    }
  }

  if (menu.home && !homeWritten) {
    console.warn(`engine: menu.home="${menu.home}" did not match any published page; no index.html emitted`);
  }

  // Pretty-URL redirect stubs: `<slug>/index.html` → `<slug>.html`.
  // Skip the home page (already served at root index.html).
  let redirectCount = 0;
  for (const page of pages) {
    if (page.slug === "index") continue;
    const last = page.slug.split("/").pop() ?? page.slug;
    await writeFile(join(DIST, page.slug, "index.html"), redirectHtml(`../${last}.html`));
    redirectCount++;
  }

  let assetCount = 0;
  for (const asset of assetFiles) {
    const rel = relative(VAULT, asset);
    const dest = join(DIST, rel);
    await mkdir(join(dest, ".."), { recursive: true });
    await cp(asset, dest);
    assetCount++;
  }

  await Bun.write(
    join(DIST, "robots.txt"),
    "User-agent: *\nDisallow: /\n",
  );

  if (assetCount > 0) console.log(`engine: copied ${assetCount} assets`);
  if (redirectCount > 0) console.log(`engine: wrote ${redirectCount} pretty-URL redirects`);

  const ms = (performance.now() - start).toFixed(0);
  const skippedMsg = skipped > 0 ? ` (${skipped} skipped)` : "";
  console.log(`engine: ${count} pages built${skippedMsg} in ${ms}ms → dist/`);
}

build();
