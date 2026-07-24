export interface MenuItem {
  label: string;
  path: string;
  visible?: boolean;
  children?: MenuItem[];
}

export interface Menu {
  title: string;
  base: string;
  home?: string;
  description?: string;
  image?: string;
  twitter?: string;
  noindex?: boolean;
  items: MenuItem[];
  /** Build stamp (git short hash), injected at build time. */
  version?: string;
}

export interface PageSeo {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  keywords?: string[];
  noindex?: boolean;
}

export interface Page {
  slug: string;
  title: string;
  content: string;
  description?: string;
  date?: string;
  updatedAt?: string;
  fileUpdatedAt?: string;
  order?: number;
  template?: string;
  seo?: PageSeo;
  published: boolean;
  unlisted?: boolean;
  aliases?: string[];
  tags?: string[];
  listing?: boolean;
  listingPageSize?: number;
  /** Resolved slugs this page links to (wikilinks + internal .md links). */
  links?: string[];
  raw: string;
}
