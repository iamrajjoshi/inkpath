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
  identifier?: string;
  duration?: string;
  difficulty?: string;
  tags?: string[];
  date?: string | Date;
  updated?: string | Date;
  draft?: boolean;
};

export type SiteSettings = {
  author?: string;
  title?: string;
  description?: string;
  lang: string;
  basePath: string;
  url?: string;
  logo?: string;
  image?: string;
};

export type MarkdownSettings = {
  math: boolean;
};

export type ThemeSettings = {
  accent: string;
  interactive: string;
  stylesheet?: string;
  subtle: string;
};

export type InkpathConfig = {
  projectRoot: string;
  contentDir: string;
  outputDir: string;
  publicDir: string;
  markdown: MarkdownSettings;
  site: SiteSettings;
  theme: ThemeSettings;
};

export type PageKind = "home" | "section" | "page";

export type Page = {
  attributes: Frontmatter;
  backlinks: Page[];
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
  math: number;
  orphans: number;
  pages: number;
  site: Site;
};
