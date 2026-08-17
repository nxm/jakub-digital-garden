import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import matter from "gray-matter";
import { posix } from "node:path";
import { renderShortcodes } from "./shortcodes";
import type { Page, PageSeo } from "./types";

const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  }),
);

const PROTOCOL_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function asDateString(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return asString(value);
}

// Titles must be strings. YAML parses an unquoted `title: 2026-07-23` as a Date
// and a bare number as a number — coerce both so frontmatter (often written by
// an LLM) can't crash rendering downstream.
function asTitle(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return asString(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return asStringArray(value);
  if (typeof value !== "string") return undefined;
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function normalizeFilePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function slugifySegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function slugifyPath(value: string): string {
  return value
    .split("/")
    .map(slugifySegment)
    .filter(Boolean)
    .join("/");
}

export function humanize(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function fallbackTitleFromPath(filepath: string): string {
  const parts = filepath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length === 0) return "Untitled";
  const last = parts[parts.length - 1].replace(/\.md$/i, "");
  if (last.toLowerCase() === "index" && parts.length >= 2) {
    return humanize(parts[parts.length - 2]);
  }
  return last;
}

export function filePathToSlug(filepath: string): string {
  const normalized = normalizeFilePath(filepath)
    .replace(/\.md$/i, "")
    .replace(/\/index$/i, "")
    .replace(/^\/+/, "");
  const slugified = slugifyPath(normalized);
  return slugified || "index";
}

function headingToAnchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function defaultWikiLabel(rawTarget: string): string {
  const base = rawTarget.split("#")[0].trim();
  if (!base) return "section";
  const lastSegment = base
    .replace(/\.md$/i, "")
    .replace(/\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .pop();
  const normalized = (lastSegment ?? base).replace(/[-_]/g, " ").trim();
  return normalized || "link";
}

function resolveInternalLink(
  rawTarget: string,
  currentFilePath: string,
  currentSlug: string,
  basenameMap?: Map<string, string>,
  options: { relativeToCurrentFile?: boolean } = {},
): { slug: string; anchor?: string } | undefined {
  const target = rawTarget.trim();
  if (!target || PROTOCOL_RE.test(target)) return undefined;

  const currentFileWithoutExt = normalizeFilePath(currentFilePath).replace(/\.md$/i, "");
  const currentDir = posix.dirname(currentFileWithoutExt);

  const hashIndex = target.indexOf("#");
  const pathPart = (hashIndex === -1 ? target : target.slice(0, hashIndex)).trim();
  const rawAnchor = hashIndex === -1 ? "" : target.slice(hashIndex + 1).trim();
  const anchor = rawAnchor ? headingToAnchor(rawAnchor) : undefined;

  if (!pathPart) {
    return { slug: currentSlug, ...(anchor ? { anchor } : {}) };
  }

  // Obsidian-style basename lookup: [[Agent]] → concepts/Agent if unique
  if (basenameMap && !pathPart.includes("/") && !pathPart.includes(".")) {
    const hit = basenameMap.get(slugifySegment(pathPart).toLowerCase());
    if (hit) return { slug: hit, ...(anchor ? { anchor } : {}) };
  }

  let resolved = pathPart.replaceAll("\\", "/").trim();
  const isRootRelative = resolved.startsWith("/");
  if (isRootRelative) resolved = resolved.slice(1);
  if (
    !isRootRelative &&
    (options.relativeToCurrentFile || resolved.startsWith("./") || resolved.startsWith("../"))
  ) {
    resolved = posix.normalize(posix.join(currentDir, resolved));
  }

  resolved = resolved
    .replace(/\.md$/i, "")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "");
  resolved = slugifyPath(resolved);

  if (!resolved || resolved === ".") {
    return { slug: currentSlug, ...(anchor ? { anchor } : {}) };
  }
  if (resolved.startsWith("../")) return undefined;

  const slug = resolved.replace(/\/index$/i, "") || "index";
  return { slug, ...(anchor ? { anchor } : {}) };
}

function resolveAssetPath(rawTarget: string, currentFilePath: string): string | undefined {
  const target = rawTarget.trim();
  if (!target || PROTOCOL_RE.test(target)) return undefined;

  const currentFileWithoutExt = normalizeFilePath(currentFilePath).replace(/\.md$/i, "");
  const currentDir = posix.dirname(currentFileWithoutExt);

  let resolved = target.replaceAll("\\", "/").trim();
  if (resolved.startsWith("/")) resolved = resolved.slice(1);
  if (resolved.startsWith("./") || resolved.startsWith("../")) {
    resolved = posix.normalize(posix.join(currentDir, resolved));
  }
  resolved = resolved
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "");

  if (!resolved || resolved.startsWith("../")) return undefined;
  return resolved;
}

function buildRelativeAssetHref(currentSlug: string, assetPath: string): string {
  const fromDir = currentSlug === "index" ? "." : currentSlug.includes("/") ? posix.dirname(currentSlug) : ".";
  return posix.relative(fromDir, assetPath) || assetPath;
}

function buildRelativeHref(currentSlug: string, targetSlug: string, anchor?: string): string {
  if (currentSlug === targetSlug && anchor) return `#${anchor}`;
  if (currentSlug === targetSlug) return "#";

  const fromDir = currentSlug === "index" ? "." : posix.dirname(currentSlug);
  const targetFile = `${targetSlug}.html`;
  const relativeHref = posix.relative(fromDir, targetFile) || targetFile;
  return anchor ? `${relativeHref}#${anchor}` : relativeHref;
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function rewriteWikiLinks(
  content: string,
  currentFilePath: string,
  currentSlug: string,
  basenameMap?: Map<string, string>,
  assetMap?: Map<string, string>,
  links?: Set<string>,
): string {
  return content.replace(/(!)?\[\[([^[\]]+)\]\]/g, (match, embed: string | undefined, inner: string) => {
    const [targetRaw, aliasRaw] = inner.split("|");
    const target = (targetRaw ?? "").trim();
    if (!target) return match;
    const alias = (aliasRaw ?? "").trim();

    const isEmbed = embed === "!";
    if (isEmbed && IMAGE_EXT_RE.test(target.split("#")[0])) {
      // Obsidian resolves a bare ![[image.png]] by vault-wide basename lookup, not as a
      // path relative to the vault root, so the asset map has to win over a literal read.
      let assetPath = assetMap && !target.includes("/") ? assetMap.get(target.toLowerCase()) : undefined;
      assetPath ??= resolveAssetPath(target, currentFilePath);
      if (!assetPath) return match;
      const href = buildRelativeAssetHref(currentSlug, assetPath);
      const altText = alias || defaultWikiLabel(target);
      return `<img src="${escapeAttr(href)}" alt="${escapeAttr(altText)}">`;
    }

    const resolved = resolveInternalLink(target, currentFilePath, currentSlug, basenameMap);
    if (!resolved) return match;
    if (links && resolved.slug !== currentSlug) links.add(resolved.slug);

    const label = alias || defaultWikiLabel(target);
    const href = buildRelativeHref(currentSlug, resolved.slug, resolved.anchor);
    return `[${label}](${href})`;
  });
}

function rewriteMarkdownMdLinks(
  content: string,
  currentFilePath: string,
  currentSlug: string,
  links?: Set<string>,
): string {
  return content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, targetWithSuffix: string, offset: number, source: string) => {
    if (offset > 0 && source[offset - 1] === "!") return match;

    const trimmedTarget = targetWithSuffix.trim();
    const firstSpace = trimmedTarget.indexOf(" ");
    const target = firstSpace === -1 ? trimmedTarget : trimmedTarget.slice(0, firstSpace);
    const suffix = firstSpace === -1 ? "" : trimmedTarget.slice(firstSpace);

    if (
      !target ||
      PROTOCOL_RE.test(target) ||
      target.startsWith("#") ||
      !/\.md(?:#.*)?$/i.test(target)
    ) {
      return match;
    }

    const resolved = resolveInternalLink(
      target,
      currentFilePath,
      currentSlug,
      undefined,
      { relativeToCurrentFile: true },
    );
    if (!resolved) return match;
    if (links && resolved.slug !== currentSlug) links.add(resolved.slug);

    const href = buildRelativeHref(currentSlug, resolved.slug, resolved.anchor);
    return `[${label}](${href}${suffix})`;
  });
}

const MD_STRIP_REGEXES: Array<[RegExp, string]> = [
  [/^>\s?/gm, ""], // blockquote markers
  [/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, ""], // image embeds
  [/!\[([^\]]*)\]\([^)]+\)/g, ""], // standard images
  [/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m: string, t: string, alias?: string) => alias ?? t], // wikilinks
  [/\[([^\]]+)\]\([^)]+\)/g, "$1"], // standard links
  [/`([^`]+)`/g, "$1"], // inline code
  [/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1"], // bold/italic
  [/^#+\s+/gm, ""], // headings
];

function extractExcerpt(raw: string, maxLength = 160): string | undefined {
  if (!raw) return undefined;
  const lines = raw.split("\n");
  let inFence = false;
  const paragraphs: string[] = [];
  let buf: string[] = [];

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (buf.length > 0) {
        paragraphs.push(buf.join(" ").trim());
        buf = [];
      }
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") {
      if (buf.length > 0) {
        paragraphs.push(buf.join(" ").trim());
        buf = [];
      }
    } else {
      buf.push(line.trim());
    }
  }
  if (buf.length > 0) paragraphs.push(buf.join(" ").trim());

  for (const p of paragraphs) {
    if (!p || /^#{1,6}\s/.test(p)) continue;
    if (/^[-*+]\s/.test(p) || /^\d+\.\s/.test(p)) continue;
    if (/^!?\[/.test(p) && /\)$|\]\]$/.test(p) && p.length < 80) continue;
    let stripped = p;
    for (const [re, replacement] of MD_STRIP_REGEXES) {
      // biome-ignore lint/suspicious/noExplicitAny: regex replacer signature
      stripped = stripped.replace(re, replacement as any);
    }
    stripped = stripped.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (stripped.length < 12) continue;
    if (stripped.length <= maxLength) return stripped;
    const cut = stripped.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  }
  return undefined;
}

function parseSeo(data: Record<string, unknown>): PageSeo | undefined {
  const seo: PageSeo = {
    title: asString(data.seo_title),
    description: asString(data.seo_description),
    canonical: asString(data.seo_canonical),
    image: asString(data.seo_image),
    keywords: asStringList(data.seo_keywords) ?? asStringList(data.keywords),
    noindex: asBoolean(data.seo_noindex) ?? asBoolean(data.noindex),
  };

  if (
    seo.title === undefined &&
    seo.description === undefined &&
    seo.canonical === undefined &&
    seo.image === undefined &&
    seo.keywords === undefined &&
    seo.noindex === undefined
  ) {
    return undefined;
  }

  return seo;
}

export interface ParseOptions {
  basenameMap?: Map<string, string>;
  assetMap?: Map<string, string>;
  fileUpdatedAt?: string;
}

export function parse(filepath: string, raw: string, options: ParseOptions = {}): Page {
  const { data, content } = matter(raw);
  const metadata = data as Record<string, unknown>;
  const slug = filePathToSlug(filepath);
  const links = new Set<string>();
  const source = renderShortcodes(
    rewriteMarkdownMdLinks(
      rewriteWikiLinks(content, filepath, slug, options.basenameMap, options.assetMap, links),
      filepath,
      slug,
      links,
    ),
  );
  const publish = asBoolean(metadata.publish);
  const draft = asBoolean(metadata.draft) ?? false;
  const seo = parseSeo(metadata);

  return {
    slug,
    title: asTitle(data.title) ?? fallbackTitleFromPath(filepath),
    description: asString(data.description) ?? extractExcerpt(content),
    date: asDateString(metadata.date),
    updatedAt:
      asDateString(metadata.updated_at) ??
      asDateString(metadata.updatedAt) ??
      asDateString(metadata.updated),
    fileUpdatedAt: options.fileUpdatedAt,
    order: asNumber(metadata.order) ?? asNumber(metadata.sort_order),
    template: asString(data.template),
    seo,
    published: publish !== false && !draft,
    unlisted: asBoolean(metadata.unlisted),
    aliases: asStringList(metadata.aliases),
    tags: asStringList(metadata.tags),
    listing: asBoolean(metadata.listing),
    listingPageSize: asNumber(metadata.listing_page_size),
    links: [...links],
    content: marked.parse(source, { async: false }) as string,
    raw: content,
  };
}
