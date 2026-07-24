import { join, posix } from "node:path";
import { slugifyPath } from "./markdown";
import type { Menu, Page } from "./types";

export interface ListingContext {
  children: Page[];
  currentPage: number;
  totalPages: number;
  parentSlug: string;
}

const TEMPLATES_DIR = join(import.meta.dir, "templates");
const layout = await Bun.file(join(TEMPLATES_DIR, "layout.html")).text();

function relativePrefix(slug: string): string {
  const depth = slug.split("/").length - 1;
  return depth > 0 ? "../".repeat(depth) : "./";
}

function slugToRelativeHref(fromSlug: string, toSlug: string): string {
  const fromDir = fromSlug.includes("/") ? posix.dirname(fromSlug) : ".";
  return posix.relative(fromDir, `${toSlug}.html`) || `${toSlug}.html`;
}

function renderListingItems(children: Page[], fromSlug: string): string {
  return children
    .map((child) => {
      const href = slugToRelativeHref(fromSlug, child.slug);
      const titleHtml = `<span class="listing-title">${escapeHtml(child.title)}</span>`;
      const descHtml = child.description
        ? `<span class="listing-desc">${escapeHtml(child.description)}</span>`
        : "";
      const metaParts: string[] = [];
      const displayDate = child.date ?? child.updatedAt;
      if (displayDate) {
        metaParts.push(`<time class="listing-date">${escapeHtml(displayDate)}</time>`);
      }
      if (child.tags && child.tags.length > 0) {
        const tagHtml = child.tags
          .slice(0, 4)
          .map((t) => `<span class="listing-tag">${escapeHtml(t)}</span>`)
          .join("");
        metaParts.push(`<span class="listing-tags">${tagHtml}</span>`);
      }
      const metaHtml = metaParts.length > 0
        ? `<span class="listing-meta">${metaParts.join("")}</span>`
        : "";
      return [
        `<a class="listing-item" href="${href}">`,
        '<span class="listing-body">',
        titleHtml,
        descHtml,
        metaHtml,
        "</span>",
        '<span class="listing-arrow" aria-hidden="true">→</span>',
        "</a>",
      ].join("");
    })
    .join("\n");
}

function renderPagination(
  currentPage: number,
  totalPages: number,
  fromSlug: string,
  parentSlug: string,
): string {
  const pageSlug = (n: number) =>
    n === 1 ? parentSlug : `${parentSlug}/page/${n}`;

  const prev =
    currentPage > 1
      ? `<a href="${slugToRelativeHref(fromSlug, pageSlug(currentPage - 1))}" class="pagination-prev">← Newer</a>`
      : '<span class="pagination-placeholder"></span>';

  const next =
    currentPage < totalPages
      ? `<a href="${slugToRelativeHref(fromSlug, pageSlug(currentPage + 1))}" class="pagination-next">Older →</a>`
      : '<span class="pagination-placeholder"></span>';

  return [
    '<nav class="pagination">',
    prev,
    `<span class="pagination-info">${currentPage} / ${totalPages}</span>`,
    next,
    "</nav>",
  ].join("\n");
}

function injectListing(content: string, listing: ListingContext, slug: string): string {
  const items = renderListingItems(listing.children, slug);
  const pagination =
    listing.totalPages > 1
      ? renderPagination(listing.currentPage, listing.totalPages, slug, listing.parentSlug)
      : "";
  return `${content}\n<section class="listing">\n${items}\n</section>\n${pagination}`;
}

function renderNav(menu: Menu, currentSlug: string): string {
  const prefix = relativePrefix(currentSlug);
  return menu.items
    .filter((item) => item.visible !== false)
    .map((item) => {
      const itemSlug = item.path === "/" ? "index" : slugifyPath(item.path.slice(1));
      const href = item.path === "/" ? `${prefix}index.html` : `${prefix}${itemSlug}.html`;
      const lcCurrent = currentSlug.toLowerCase();
      const lcItem = itemSlug.toLowerCase();
      const active = lcCurrent === lcItem || lcCurrent.startsWith(`${lcItem}/`);
      return [
        `<a class="nav-item${active ? " active" : ""}" href="${href}"${active ? ' aria-current="page"' : ""}>`,
        '<span class="nav-item-marker" aria-hidden="true"></span>',
        `<span class="nav-item-label">${item.label}</span>`,
        "</a>",
      ].join("");
    })
    .join("\n        ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSeoMeta(page: Page, menu: Menu): string {
  const seoTitle = page.seo?.title ?? page.title;
  const seoDescription = page.seo?.description ?? page.description ?? menu.description;
  const canonical = page.seo?.canonical;
  const image = page.seo?.image ?? menu.image;
  const keywords = page.seo?.keywords;
  const noindex = page.seo?.noindex ?? menu.noindex ?? true;
  const siteName = menu.title;
  const twitterSite = menu.twitter;

  return [
    seoDescription
      ? `<meta name="description" content="${escapeHtml(seoDescription)}">`
      : "",
    keywords && keywords.length > 0
      ? `<meta name="keywords" content="${escapeHtml(keywords.join(", "))}">`
      : "",
    noindex ? '<meta name="robots" content="noindex, nofollow">' : "",
    canonical
      ? `<link rel="canonical" href="${escapeHtml(canonical)}">`
      : "",
    `<meta property="og:site_name" content="${escapeHtml(siteName)}">`,
    `<meta property="og:title" content="${escapeHtml(seoTitle)}">`,
    seoDescription
      ? `<meta property="og:description" content="${escapeHtml(seoDescription)}">`
      : "",
    '<meta property="og:type" content="article">',
    canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : "",
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    twitterSite ? `<meta name="twitter:site" content="${escapeHtml(twitterSite)}">` : "",
    `<meta name="twitter:title" content="${escapeHtml(seoTitle)}">`,
    seoDescription
      ? `<meta name="twitter:description" content="${escapeHtml(seoDescription)}">`
      : "",
    image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : "",
    ...(page.tags ?? []).map(
      (tag) => `<meta property="article:tag" content="${escapeHtml(tag)}">`,
    ),
  ]
    .filter(Boolean)
    .join("\n  ");
}

export function render(page: Page, menu: Menu, listing?: ListingContext, hasRail = false): string {
  const prefix = relativePrefix(page.slug);
  const seoTitle = page.seo?.title ?? page.title;
  const isHome = menu.home && slugifyPath(menu.home).toLowerCase() === page.slug.toLowerCase();
  const documentTitle = isHome ? menu.title : `${seoTitle} | ${menu.title}`;
  const seoMeta = renderSeoMeta(page, menu);

  let content = page.content;
  if (listing && listing.children.length > 0) {
    content = injectListing(content, listing, page.slug);
  }

  // The graph rail is emitted only for notes that actually have connections.
  const rail = hasRail
    ? [
        '<aside class="graph-rail" aria-label="Related notes">',
        '<div class="rail-handle" data-rail-handle role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize graph panel (use arrow keys)"></div>',
        `<div id="graph-rail" class="note-graph note-graph--rail" data-graph-local data-slug="${escapeHtml(page.slug)}"></div>`,
        `<a class="graph-rail__full" href="${prefix}Graph.html">Open full graph →</a>`,
        "</aside>",
      ].join("\n    ")
    : "";

  return layout
    .replace("{{rail}}", rail)
    .replace("{{document_title}}", escapeHtml(documentTitle))
    .replace("{{seo_meta}}", seoMeta)
    .replace(/\{\{title\}\}/g, escapeHtml(page.title))
    .replace(/\{\{site_title\}\}/g, escapeHtml(menu.title))
    .replace(/\{\{site_description\}\}/g, escapeHtml(menu.description ?? ""))
    .replace(/\{\{version\}\}/g, escapeHtml(menu.version ?? "dev"))
    .replace(/\{\{page_slug\}\}/g, escapeHtml(page.slug))
    .replace(/\{\{base\}\}/g, prefix)
    .replace("{{css_path}}", `${prefix}styles/main.css`)
    .replace("{{js_path}}", `${prefix}scripts/app.js`)
    .replace("{{nav}}", renderNav(menu, page.slug))
    .replace("{{content}}", content);
}
