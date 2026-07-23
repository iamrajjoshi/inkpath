import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonSha256, sha256, type FileIdentity } from "../identity.js";

export const COMPARISON_TOOLS = ["inkpath", "hugo", "mkdocs", "docusaurus", "quartz"] as const;

export type ComparisonTool = (typeof COMPARISON_TOOLS)[number];

export type ComparisonCorpusOptions = {
  pages: number;
};

type ComparisonNoteKind = "home" | "note" | "section";

type ComparisonNote = {
  asset: boolean;
  id: string;
  index: number;
  kind: ComparisonNoteKind;
  linkTargetIds: readonly string[];
  marker: string;
  noteOrdinal?: number;
  route: string;
  routeSegments: readonly string[];
  title: string;
  typescript: boolean;
};

export type ComparisonCorpus = {
  mutationNoteId: string;
  notes: readonly ComparisonNote[];
  pages: number;
  sha256: string;
};

type ComparisonProjectMutation = {
  /** Complete pristine UTF-8 source, suitable for restoring the fixture atomically. */
  before: string;
  /** Complete mutated UTF-8 source, suitable for an atomic body-edit benchmark. */
  after: string;
  expectedMarker: string;
  forbiddenMarker: string;
  /** Project-relative source path. */
  path: string;
};

export type ComparisonExpectedPage = {
  assetFileName?: string;
  assetSha256?: string;
  linkTargetRoutes: readonly string[];
  marker: string;
  outputPath: string;
  route: string;
  sourcePath: string;
  typescript: boolean;
};

export type ComparisonProject = {
  configPath: string;
  contentDirectory: string;
  expectedMarkers: readonly string[];
  expectedPages: readonly ComparisonExpectedPage[];
  manifest: readonly FileIdentity[];
  manifestSha256: string;
  mutation: ComparisonProjectMutation;
  outputDirectory: string;
  pages: number;
  root: string;
  tool: ComparisonTool;
};

const MINIMUM_PAGES = 20;
const LINK_OFFSETS = [1, 5, 9, 13] as const;
const BODY_VARIANT_A = "comparisonBodyVariantA";
const BODY_VARIANT_B = "comparisonBodyVariantB";

const LANDING_PAGES: ReadonlyArray<{
  kind: "home" | "section";
  routeSegments: readonly string[];
  title: string;
}> = [
  { kind: "home", routeSegments: [], title: "Comparison knowledge base" },
  { kind: "section", routeSegments: ["guides"], title: "Guides" },
  {
    kind: "section",
    routeSegments: ["guides", "foundations"],
    title: "Guide foundations",
  },
  { kind: "section", routeSegments: ["reference"], title: "Reference" },
  {
    kind: "section",
    routeSegments: ["reference", "api"],
    title: "API reference",
  },
];

function pad(value: number): string {
  return String(value).padStart(6, "0");
}

function routeFromSegments(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

function noteId(index: number): string {
  return `page-${pad(index + 1)}`;
}

/** Create compact, immutable metadata for an exact-size neutral comparison corpus. */
export function generateComparisonCorpus(options: ComparisonCorpusOptions): ComparisonCorpus {
  if (!Number.isInteger(options.pages) || options.pages < MINIMUM_PAGES) {
    throw new Error(`comparison pages must be an integer of at least ${MINIMUM_PAGES}`);
  }

  const notes: ComparisonNote[] = Array.from({ length: options.pages }, (_, index) => {
    const landing = LANDING_PAGES[index];
    const ordinal = index - LANDING_PAGES.length + 1;
    const number = pad(Math.max(ordinal, 1));
    const routeSegments = landing
      ? landing.routeSegments
      : [
          ...(ordinal % 2 === 1 ? ["guides", "foundations"] : ["reference", "api"]),
          `note-${number}`,
        ];
    const kind = landing?.kind ?? "note";
    return {
      asset: kind === "note" && ordinal % 13 === 0,
      id: noteId(index),
      index,
      kind,
      linkTargetIds: LINK_OFFSETS.map((offset) => noteId((index + offset) % options.pages)),
      marker: `comparison-marker-${noteId(index)}`,
      ...(kind === "note" ? { noteOrdinal: ordinal } : {}),
      route: routeFromSegments(routeSegments),
      routeSegments,
      title: landing?.title ?? `Comparison note ${number}`,
      typescript: kind === "note" && ordinal % 10 === 0,
    };
  });
  const mutationNote = notes[LANDING_PAGES.length];
  if (!mutationNote) throw new Error("comparison corpus has no mutation note");
  const identity = {
    mutationNoteId: mutationNote.id,
    notes,
    pages: options.pages,
  };
  return { ...identity, sha256: canonicalJsonSha256(identity) };
}

function relativeNoteLink(
  source: ComparisonNote,
  target: ComparisonNote,
  tool: ComparisonTool,
): string {
  const sourcePath = pageSourcePath(source, tool);
  const targetPath = pageSourcePath(target, tool);
  return `${path.posix.relative(path.posix.dirname(sourcePath), targetPath)}#details`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function assetFileName(note: ComparisonNote): string {
  if (!note.asset || note.noteOrdinal === undefined) {
    throw new Error(`comparison note has no local asset: ${note.id}`);
  }
  return `benchmark-asset-${pad(note.noteOrdinal)}.txt`;
}

function assetContents(note: ComparisonNote): string {
  return `Deterministic local text asset for ${note.id}.\n`;
}

function frontmatter(note: ComparisonNote, tool: ComparisonTool): string {
  const lines = ["---", `title: ${yamlString(note.title)}`];
  if (tool === "inkpath") {
    lines.push(
      `description: ${yamlString("A deterministic page in the neutral comparison corpus.")}`,
      `order: ${note.index + 1}`,
    );
  } else if (tool === "hugo") {
    lines.push(`weight: ${note.index + 1}`);
  } else if (tool === "docusaurus") {
    lines.push(`slug: ${yamlString(note.route)}`, `sidebar_position: ${note.index + 1}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function renderNote(
  note: ComparisonNote,
  notesById: ReadonlyMap<string, ComparisonNote>,
  tool: ComparisonTool,
  bodyVariant: "a" | "b",
): string {
  const links = note.linkTargetIds.map((targetId) => {
    const target = notesById.get(targetId);
    if (!target) throw new Error(`comparison link target does not exist: ${targetId}`);
    return `[${target.title}](${relativeNoteLink(note, target, tool)})`;
  });
  const lines = [
    frontmatter(note, tool).trimEnd(),
    "",
    `# ${note.title}`,
    "",
    `Unique fixture marker: ${note.marker}.`,
    "",
    "This ordinary prose represents a practical documentation note with stable vocabulary and predictable structure.",
    "",
  ];
  if (note.id === noteId(LANDING_PAGES.length)) {
    lines.push(
      `Body mutation marker: ${bodyVariant === "a" ? BODY_VARIANT_A : BODY_VARIANT_B}.`,
      "",
    );
  }
  lines.push(
    "## Overview",
    "",
    "The overview gives each generator the same headings, paragraphs, and navigation workload.",
    "",
    `Related notes: ${links.join(", ")}.`,
    "",
    "## Details",
    "",
    "The details section provides the stable anchor used by every one of the four relative note links.",
    "",
  );
  if (note.typescript) {
    lines.push(
      "```ts",
      `export const comparisonValue = ${note.noteOrdinal ?? note.index + 1};`,
      "```",
      "",
    );
  }
  if (note.asset) {
    lines.push(`Local asset: [deterministic text](${assetFileName(note)}).`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function contentRootName(tool: ComparisonTool): string {
  if (tool === "mkdocs" || tool === "docusaurus") return "docs";
  return "content";
}

function pageSourcePath(note: ComparisonNote, tool: ComparisonTool): string {
  const contentRoot = contentRootName(tool);
  if (note.kind === "note" && !(tool === "hugo" && note.asset)) {
    const fileName = `${note.routeSegments.at(-1)}.md`;
    return path.posix.join(contentRoot, ...note.routeSegments.slice(0, -1), fileName);
  }

  const directory = path.posix.join(contentRoot, ...note.routeSegments);
  let fileName = "index.md";
  if (tool === "inkpath") fileName = "INDEX.md";
  else if (tool === "hugo" && note.kind !== "note") fileName = "_index.md";
  return path.posix.join(directory, fileName);
}

function pageOutputPath(note: ComparisonNote, tool: ComparisonTool): string {
  if (tool === "quartz" && note.kind === "note") {
    return `${path.posix.join(...note.routeSegments)}.html`;
  }
  return note.routeSegments.length === 0
    ? "index.html"
    : path.posix.join(...note.routeSegments, "index.html");
}

function pagePublicRoute(note: ComparisonNote, tool: ComparisonTool): string {
  if (tool === "quartz" && note.kind === "note") return note.route.replace(/\/$/, "");
  return note.route;
}

type ToolScaffold = {
  configPath: string;
  files: ReadonlyArray<readonly [path: string, content: string]>;
  outputDirectory: string;
};

function toolScaffold(tool: ComparisonTool): ToolScaffold {
  if (tool === "inkpath") {
    return {
      configPath: "inkpath.yaml",
      files: [
        [
          "inkpath.yaml",
          `content: content
output: site
public: public
site:
  title: Neutral static-site comparison
  description: A deterministic cross-generator comparison corpus.
  url: https://comparison.example
  logo: favicon.svg
`,
        ],
        [
          "public/favicon.svg",
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#334155" d="M2 2h12v12H2z"/></svg>\n',
        ],
      ],
      outputDirectory: "site",
    };
  }
  if (tool === "hugo") {
    return {
      configPath: "hugo.toml",
      files: [
        [
          "hugo.toml",
          `baseURL = 'https://comparison.example/'
title = 'Neutral static-site comparison'
disableKinds = ['taxonomy', 'term', 'RSS', 'sitemap', 'robotsTXT', '404']

[markup]
  [markup.goldmark]
    [markup.goldmark.renderer]
      unsafe = false
    [markup.goldmark.renderHooks.link]
      useEmbedded = 'fallback'
`,
        ],
        [
          "layouts/_default/baseof.html",
          `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{ .Title }}</title></head>
  <body>{{ block "main" . }}{{ end }}</body>
</html>
`,
        ],
        [
          "layouts/_default/single.html",
          `{{ define "main" }}<main>{{ .Content }}</main>{{ end }}
`,
        ],
        [
          "layouts/_default/list.html",
          `{{ define "main" }}<main>{{ .Content }}</main>{{ end }}
`,
        ],
        [
          "layouts/index.html",
          `{{ define "main" }}<main>{{ .Content }}</main>{{ end }}
`,
        ],
      ],
      outputDirectory: "public",
    };
  }
  if (tool === "mkdocs") {
    return {
      configPath: "mkdocs.yml",
      files: [
        [
          "mkdocs.yml",
          `site_name: Neutral static-site comparison
site_url: https://comparison.example/
docs_dir: docs
site_dir: site
use_directory_urls: true
theme:
  name: mkdocs
plugins: []
markdown_extensions:
  - meta
`,
        ],
      ],
      outputDirectory: "site",
    };
  }
  if (tool === "docusaurus") {
    return {
      configPath: "docusaurus.config.mjs",
      files: [
        [
          "docusaurus.config.mjs",
          `import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default {
  title: "Neutral static-site comparison",
  url: "https://comparison.example",
  baseUrl: "/",
  trailingSlash: true,
  onBrokenLinks: "throw",
  presets: [["classic", {
    blog: false,
    docs: { routeBasePath: "/", sidebarPath: "./sidebars.mjs" },
    theme: { customCss: "./src/css/custom.css" },
  }]],
  plugins: [function comparisonCacheIsolation() {
    return {
      name: "comparison-cache-isolation",
      configureWebpack() {
        return {
          cache: {
            type: "filesystem",
            cacheDirectory: path.join(projectRoot, ".cache", "webpack"),
          },
        };
      },
    };
  }],
};
`,
        ],
        [
          "sidebars.mjs",
          `export default { comparisonSidebar: [{ type: "autogenerated", dirName: "." }] };
`,
        ],
        [
          "src/css/custom.css",
          `:root { --ifm-color-primary: #334155; }
main { max-width: 72rem; }
`,
        ],
        [
          "package.json",
          `${JSON.stringify(
            {
              name: "neutral-docusaurus-comparison",
              private: true,
              scripts: { build: "docusaurus build --out-dir build" },
            },
            undefined,
            2,
          )}\n`,
        ],
      ],
      outputDirectory: "build",
    };
  }
  return {
    configPath: "quartz.config.yaml",
    files: [
      [
        "quartz.config.yaml",
        `# yaml-language-server: $schema=./quartz/plugins/quartz-plugins.schema.json
configuration:
  pageTitle: Neutral static-site comparison
  pageTitleSuffix: ""
  enableSPA: false
  enablePopovers: false
  analytics: null
  locale: en-US
  baseUrl: comparison.example
  ignorePatterns:
    - private
    - templates
    - .obsidian
  defaultDateType: modified
  theme:
    fontOrigin: local
    cdnCaching: false
    typography:
      header: Schibsted Grotesk
      body: Source Sans Pro
      code: IBM Plex Mono
    colors:
      lightMode:
        light: "#fafafa"
        lightgray: "#e5e7eb"
        gray: "#64748b"
        darkgray: "#334155"
        dark: "#0f172a"
        secondary: "#2563eb"
        tertiary: "#7c3aed"
        highlight: rgba(37, 99, 235, 0.15)
        textHighlight: "#fde68a88"
      darkMode:
        light: "#0f172a"
        lightgray: "#334155"
        gray: "#94a3b8"
        darkgray: "#e2e8f0"
        dark: "#f8fafc"
        secondary: "#60a5fa"
        tertiary: "#a78bfa"
        highlight: rgba(96, 165, 250, 0.15)
        textHighlight: "#854d0e88"
plugins:
  - source: github:quartz-community/note-properties
    enabled: true
    options:
      includeAll: false
      includedProperties:
        - description
        - tags
        - aliases
      excludedProperties: []
      hidePropertiesView: true
      delimiters: "---"
      language: yaml
    order: 5
  - source: github:quartz-community/syntax-highlighting
    enabled: true
    options:
      theme:
        light: github-light
        dark: github-dark
      keepBackground: false
    order: 20
  - source: github:quartz-community/github-flavored-markdown
    enabled: true
    order: 40
  - source: github:quartz-community/crawl-links
    enabled: true
    options:
      markdownLinkResolution: relative
    order: 60
  - source: github:quartz-community/description
    enabled: true
    order: 70
  - source: github:quartz-community/remove-draft
    enabled: true
  - source: github:quartz-community/content-page
    enabled: true
  - source: github:quartz-community/folder-page
    enabled: true
  - source: github:quartz-community/footer
    enabled: true
    options:
      links: {}
layout:
  byPageType:
    "404":
      positions:
        beforeBody: []
        left: []
        right: []
    content: {}
    folder: {}
`,
      ],
    ],
    outputDirectory: "public",
  };
}

/** Materialize one tool-specific project. The destination must be empty. */
export async function projectComparisonCorpus(
  corpus: ComparisonCorpus,
  tool: ComparisonTool,
  root: string,
): Promise<ComparisonProject> {
  if (!COMPARISON_TOOLS.includes(tool)) throw new Error(`unsupported comparison tool: ${tool}`);
  if (corpus.notes.length !== corpus.pages || corpus.pages < MINIMUM_PAGES) {
    throw new Error("comparison corpus metadata is incomplete");
  }
  const expectedCorpusHash = canonicalJsonSha256({
    mutationNoteId: corpus.mutationNoteId,
    notes: corpus.notes,
    pages: corpus.pages,
  });
  if (expectedCorpusHash !== corpus.sha256)
    throw new Error("comparison corpus identity is invalid");

  const projectRoot = path.resolve(root);
  await mkdir(projectRoot, { recursive: true });
  if ((await readdir(projectRoot)).length !== 0) {
    throw new Error(`comparison project directory must be empty: ${projectRoot}`);
  }

  const scaffold = toolScaffold(tool);
  const manifest: FileIdentity[] = [];
  const createdDirectories = new Set<string>();
  const sourcePaths = new Set<string>();
  const addFile = async (relativePath: string, content: string): Promise<void> => {
    const normalized = relativePath.split(path.sep).join("/");
    if (path.posix.isAbsolute(normalized) || normalized.startsWith("../")) {
      throw new Error(`comparison file must stay inside its project: ${relativePath}`);
    }
    if (sourcePaths.has(normalized)) throw new Error(`duplicate comparison file: ${normalized}`);
    sourcePaths.add(normalized);
    const destination = path.join(projectRoot, ...normalized.split("/"));
    const directory = path.dirname(destination);
    if (!createdDirectories.has(directory)) {
      await mkdir(directory, { recursive: true });
      createdDirectories.add(directory);
    }
    await writeFile(destination, content, "utf8");
    manifest.push({ bytes: Buffer.byteLength(content), path: normalized, sha256: sha256(content) });
  };

  for (const [relativePath, content] of scaffold.files) await addFile(relativePath, content);

  const notesById = new Map(corpus.notes.map((note) => [note.id, note]));
  const expectedPages: ComparisonExpectedPage[] = corpus.notes.map((note) => ({
    ...(note.asset
      ? { assetFileName: assetFileName(note), assetSha256: sha256(assetContents(note)) }
      : {}),
    linkTargetRoutes: note.linkTargetIds.map((targetId) => {
      const target = notesById.get(targetId);
      if (!target) throw new Error(`comparison link target does not exist: ${targetId}`);
      return pagePublicRoute(target, tool);
    }),
    marker: note.marker,
    outputPath: pageOutputPath(note, tool),
    route: pagePublicRoute(note, tool),
    sourcePath: pageSourcePath(note, tool),
    typescript: note.typescript,
  }));
  let mutation: ComparisonProjectMutation | undefined;
  for (const note of corpus.notes) {
    const sourcePath = pageSourcePath(note, tool);
    const pristine = renderNote(note, notesById, tool, "a");
    await addFile(sourcePath, pristine);
    if (note.id === corpus.mutationNoteId) {
      mutation = {
        after: renderNote(note, notesById, tool, "b"),
        before: pristine,
        expectedMarker: BODY_VARIANT_B,
        forbiddenMarker: BODY_VARIANT_A,
        path: sourcePath,
      };
    }
    if (note.asset) {
      const fileName = assetFileName(note);
      const assetPath = path.posix.join(path.posix.dirname(sourcePath), fileName);
      await addFile(assetPath, assetContents(note));
    }
  }
  if (!mutation) throw new Error("comparison mutation note was not projected");

  manifest.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifestSha256 = sha256(
    manifest.map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`).join(""),
  );
  return {
    configPath: path.join(projectRoot, scaffold.configPath),
    contentDirectory: path.join(projectRoot, contentRootName(tool)),
    expectedMarkers: corpus.notes.map((note) => note.marker),
    expectedPages,
    manifest,
    manifestSha256,
    mutation,
    outputDirectory: path.join(projectRoot, scaffold.outputDirectory),
    pages: corpus.pages,
    root: projectRoot,
    tool,
  };
}
