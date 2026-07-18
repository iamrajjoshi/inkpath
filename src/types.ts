export type Heading = {
  depth: 2 | 3;
  id: string;
  title: string;
};

export type Frontmatter = Record<string, unknown> & {
  title?: string;
  description?: string;
  summary?: string;
  slug?: string;
  order?: number;
  number?: string;
  duration?: string;
  difficulty?: string;
  tags?: string[];
  date?: string | Date;
  updated?: string | Date;
  draft?: boolean;
};

export type SiteSettings = {
  title?: string;
  description?: string;
  lang: string;
  basePath: string;
  url?: string;
  sourceUrl?: string;
  logo?: string;
};

export type ThemeSettings = {
  accent: string;
  interactive: string;
  subtle: string;
};

export type InkpathConfig = {
  projectRoot: string;
  contentDir: string;
  outputDir: string;
  publicDir: string;
  site: SiteSettings;
  theme: ThemeSettings;
};

export type PageKind = "home" | "section" | "page";

export type Page = {
  attributes: Frontmatter;
  body: string;
  children: Page[];
  depth: number;
  headings: Heading[];
  kind: PageKind;
  order: number;
  parent?: Page;
  readingMinutes: number;
  relativePath: string;
  rendered: string;
  route: string;
  slug: string;
  sourceDirectory: string;
  sourcePath: string;
  summary: string;
  title: string;
};

export type Site = {
  config: InkpathConfig;
  home: Page;
  pages: Page[];
  pageByRoute: Map<string, Page>;
  pageBySource: Map<string, Page>;
  sections: Page[];
};

export type BuildResult = {
  diagrams: number;
  elapsedMs: number;
  pages: number;
  site: Site;
};
