import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonSha256, sha256, type FileIdentity } from "./identity.js";
import type { ScenarioOracles } from "./scenarios.js";

export type BenchmarkProfile = "core" | "rich";

export type BenchmarkGeneratorOptions = {
  pages: number;
  /** Synthetic graph links per linkable note, excluding one dedicated mutation link. */
  linkFanout?: number;
  profile?: BenchmarkProfile;
};

type BenchmarkTextMutation = {
  after: string;
  before: string;
  path: string;
};

type BenchmarkMutationTargets = {
  addition: {
    content: string;
    path: string;
  };
  body: BenchmarkTextMutation;
  deletion: {
    path: string;
  };
  link: BenchmarkTextMutation;
  rename: {
    from: string;
    to: string;
  };
  route: BenchmarkTextMutation;
  title: BenchmarkTextMutation;
};

export type GeneratedBenchmarkSite = {
  linkFanout: number;
  manifest: FileIdentity[];
  manifestPath: string;
  manifestSha256: string;
  mutationTargetsSha256: string;
  mutationTargets: BenchmarkMutationTargets;
  notes: number;
  ordinaryPage: {
    path: string;
    route: string;
  };
  pages: number;
  profile: BenchmarkProfile;
  root: string;
  scenarioOracles: ScenarioOracles;
  sections: number;
  suiteSha256: string;
};

type Section = {
  index: number;
  order: number;
  parentIndex?: number;
  relativeDirectory: string;
  routeSegments: string[];
  slug: string;
  title: string;
};

type Note = {
  contentPath: string;
  fileName: string;
  index: number;
  projectPath: string;
  route: string;
  section: Section;
  slug: string;
  title: string;
};

const MINIMUM_PAGES = 20;
const RESERVED_NOTES = 3;
const TOP_LEVEL_SECTIONS = 10;
const SECTION_BRANCHING_FACTOR = 10;

function pad(value: number, width = 6): string {
  return String(value).padStart(width, "0");
}

function validateOptions(options: BenchmarkGeneratorOptions): Required<BenchmarkGeneratorOptions> {
  if (!Number.isInteger(options.pages) || options.pages < MINIMUM_PAGES) {
    throw new Error(`pages must be an integer of at least ${MINIMUM_PAGES}`);
  }
  const linkFanout = options.linkFanout ?? 4;
  if (!Number.isInteger(linkFanout) || linkFanout < 0) {
    throw new Error("linkFanout must be a non-negative integer");
  }
  const profile = options.profile ?? "core";
  if (profile !== "core" && profile !== "rich") {
    throw new Error('profile must be "core" or "rich"');
  }
  return { linkFanout, pages: options.pages, profile };
}

function sectionCountForPages(pages: number): number {
  const target = Math.max(11, Math.floor((pages - 1) / 100));
  return Math.min(target, pages - 1 - 8);
}

function createSections(count: number): Section[] {
  const sections: Section[] = [];
  for (let index = 0; index < count; index += 1) {
    const parentIndex =
      index < TOP_LEVEL_SECTIONS
        ? undefined
        : Math.floor((index - TOP_LEVEL_SECTIONS) / SECTION_BRANCHING_FACTOR);
    const order =
      index < TOP_LEVEL_SECTIONS
        ? index + 1
        : ((index - TOP_LEVEL_SECTIONS) % SECTION_BRANCHING_FACTOR) + 1;
    const slug = `section-${pad(index + 1)}`;
    const directoryName = `${pad(order, 2)}-${slug}`;
    const parent = parentIndex === undefined ? undefined : sections[parentIndex];
    if (parentIndex !== undefined && !parent) {
      throw new Error(`could not create parent section ${parentIndex}`);
    }
    sections.push({
      index,
      order,
      ...(parentIndex === undefined ? {} : { parentIndex }),
      relativeDirectory: parent
        ? path.posix.join(parent.relativeDirectory, directoryName)
        : directoryName,
      routeSegments: [...(parent?.routeSegments ?? []), slug],
      slug,
      title: `Benchmark section ${pad(index + 1)}`,
    });
  }
  return sections;
}

function leafSections(sections: Section[]): Section[] {
  const parents = new Set(
    sections.flatMap((section) => (section.parentIndex === undefined ? [] : [section.parentIndex])),
  );
  return sections.filter((section) => !parents.has(section.index));
}

function createNotes(count: number, sections: Section[]): Note[] {
  const leaves = leafSections(sections);
  return Array.from({ length: count }, (_, index) => {
    const section = leaves[index % leaves.length];
    if (!section) throw new Error("benchmark site needs at least one leaf section");
    const number = index + 1;
    const slug = `note-${pad(number)}`;
    const fileName = `${pad(number)}-${slug}.md`;
    const contentPath = path.posix.join(section.relativeDirectory, fileName);
    return {
      contentPath,
      fileName,
      index,
      projectPath: path.posix.join("content", contentPath),
      route: `/${[...section.routeSegments, slug].join("/")}/`,
      section,
      slug,
      title: `Benchmark note ${pad(number)}`,
    };
  });
}

function relativeMarkdownLink(source: Note, target: Note): string {
  const relative = path.posix.relative(path.posix.dirname(source.contentPath), target.contentPath);
  return relative || target.fileName;
}

function outputPathForRoute(route: string): string {
  return route === "/" ? "index.html" : `${route.replace(/^\//, "")}index.html`;
}

function renderSection(section: Section): string {
  return `---
title: ${section.title}
description: A deterministic collection of benchmark notes.
slug: ${section.slug}
order: ${section.order}
---

This section exercises nested navigation, collection listings, and deterministic ordering.

## Section scope

Its generated notes contain prose, headings, links, code, and local assets.
`;
}

function renderAddition(): string {
  return `---
title: Added benchmark note
description: A deterministic page used by the file-addition scenario.
order: 999999
---

This page is added by a benchmark mutation and is not part of the pristine fixture.

## Details

Its content is intentionally stable.
`;
}

function renderNote(
  note: Note,
  linkableNotes: Note[],
  options: Required<BenchmarkGeneratorOptions>,
  mutations: {
    bodyAfter: string;
    bodyBefore: string;
    linkAfter: string;
    linkBefore: string;
    linkSourceIndex: number;
    routeAfter: string;
    routeBefore: string;
    titleAfter: string;
    titleBefore: string;
  },
): string {
  const lines = [
    "---",
    `title: ${note.title}`,
    "description: Representative deterministic benchmark prose.",
    `order: ${note.index + 1}`,
  ];
  if (note.index === 2) lines.push(mutations.routeBefore);
  if (note.index % 97 === 0) {
    const day = String((note.index % 28) + 1).padStart(2, "0");
    lines.push(`date: 2026-01-${day}`);
  }
  lines.push("---", "");

  if (note.index === 0) lines.push(mutations.bodyBefore, "");
  else {
    lines.push(
      "This ordinary prose models a knowledge-base page with stable words and predictable structure.",
      "",
    );
  }
  lines.push(
    "A second paragraph adds enough text to exercise parsing, summaries, rendering, and output writing without relying on random input.",
    "",
    "## Overview",
    "",
    "The overview is deterministic and gives every page a heading used by the table-of-contents workload.",
    "",
    "### Nested detail",
    "",
    "Nested heading content exercises anchor generation and structured document rendering.",
    "",
    "## Details",
    "",
    `This stable anchor belongs to ${note.title}.`,
    "",
  );

  if (note.index < linkableNotes.length && options.linkFanout > 0) {
    const links = Array.from({ length: options.linkFanout }, (_, offset) => {
      const target = linkableNotes[(note.index + offset + 1) % linkableNotes.length];
      if (!target) throw new Error("could not create dense benchmark link");
      return `[${target.title}](${relativeMarkdownLink(note, target)}#details)`;
    });
    lines.push(`Dense links: ${links.join(", ")}.`, "");
  }

  if (note.index === mutations.linkSourceIndex) lines.push(mutations.linkBefore, "");
  if (note.index % 13 === 0) {
    lines.push("Local asset: [section data](benchmark-asset.txt).", "");
  }
  if (note.index % 10 === 0) {
    lines.push("```ts", `export const benchmarkValue = ${note.index + 1};`, "```", "");
  }

  if (options.profile === "rich") {
    const guaranteedMermaid = Math.min(10, linkableNotes.length - 1);
    const guaranteedMath = Math.min(11, linkableNotes.length - 2);
    if (note.index === guaranteedMermaid || (note.index > 0 && note.index % 257 === 0)) {
      lines.push(
        "```mermaid",
        "flowchart LR",
        `  accTitle: Benchmark diagram ${pad(note.index + 1)}`,
        "  accDescr: A source page connects deterministically to a rendered page.",
        `  source${note.index}[Source] --> page${note.index}[Page]`,
        "```",
        "",
      );
    }
    if (note.index === guaranteedMath || (note.index > 0 && note.index % 263 === 0)) {
      lines.push(
        `Inline benchmark math is rendered at build time: $x_{${note.index + 1}} + y = z$.`,
        "",
        "$$",
        `S_${note.index + 1} = \\sum_{i=1}^{n} i`,
        "$$",
        "",
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Generate a deterministic benchmark project in an existing empty directory.
 * The requested page count is exact and includes every INDEX.md section page.
 */
export async function generateBenchmarkSite(
  root: string,
  requestedOptions: BenchmarkGeneratorOptions,
): Promise<GeneratedBenchmarkSite> {
  const options = validateOptions(requestedOptions);
  const projectRoot = path.resolve(root);
  await mkdir(projectRoot, { recursive: true });
  if ((await readdir(projectRoot)).length > 0) {
    throw new Error(`benchmark output directory must be empty: ${projectRoot}`);
  }

  const sectionCount = sectionCountForPages(options.pages);
  const noteCount = options.pages - sectionCount - 1;
  const sections = createSections(sectionCount);
  const notes = createNotes(noteCount, sections);
  const linkableNotes = notes.slice(0, -RESERVED_NOTES);
  if (options.linkFanout >= linkableNotes.length) {
    throw new Error(
      `linkFanout must be less than the ${linkableNotes.length} linkable notes in this fixture`,
    );
  }

  const bodyNote = notes[0];
  const titleNote = notes[1];
  const routeNote = notes[2];
  const firstLinkTarget = notes[3];
  const secondLinkTarget = notes[4];
  const linkNote = notes.at(-3);
  const renameNote = notes.at(-2);
  const deletionNote = notes.at(-1);
  if (
    !bodyNote ||
    !titleNote ||
    !routeNote ||
    !linkNote ||
    !firstLinkTarget ||
    !secondLinkTarget ||
    !renameNote ||
    !deletionNote
  ) {
    throw new Error("benchmark fixture does not have enough notes for mutation targets");
  }

  const titleAfterValue = `Revised benchmark title ${pad(titleNote.index + 1)}`;
  const mutationText = {
    bodyAfter: "Benchmark body variant B is stable and intentionally easy to replace.",
    bodyBefore: "Benchmark body variant A is stable and intentionally easy to replace.",
    linkAfter: `Mutation link: [target B](${relativeMarkdownLink(linkNote, secondLinkTarget)}#details).`,
    linkBefore: `Mutation link: [target A](${relativeMarkdownLink(linkNote, firstLinkTarget)}#details).`,
    linkSourceIndex: linkNote.index,
    routeAfter: `slug: routed-${routeNote.slug}`,
    routeBefore: `slug: ${routeNote.slug}`,
    titleAfter: `title: ${titleAfterValue}`,
    titleBefore: `title: ${titleNote.title}`,
  };

  const manifest: FileIdentity[] = [];
  const sourcePaths = new Set<string>();
  const createdDirectories = new Set<string>();
  const addFile = async (relativePath: string, content: string): Promise<void> => {
    const normalized = relativePath.split(path.sep).join("/");
    if (path.posix.isAbsolute(normalized) || normalized.startsWith("../")) {
      throw new Error(`benchmark file must stay inside its project: ${relativePath}`);
    }
    if (sourcePaths.has(normalized)) throw new Error(`duplicate benchmark file: ${normalized}`);
    sourcePaths.add(normalized);
    const destination = path.join(projectRoot, ...normalized.split("/"));
    const destinationDirectory = path.dirname(destination);
    if (!createdDirectories.has(destinationDirectory)) {
      await mkdir(destinationDirectory, { recursive: true });
      createdDirectories.add(destinationDirectory);
    }
    await writeFile(destination, content, "utf8");
    manifest.push({
      bytes: Buffer.byteLength(content),
      path: normalized,
      sha256: sha256(content),
    });
  };

  await addFile(
    "inkpath.yaml",
    `content: content
output: site
public: public
site:
  title: Inkpath deterministic benchmark
  description: A generated site for reproducible Inkpath measurements.
  url: https://benchmark.example
  logo: favicon.svg
markdown:
  math: ${options.profile === "rich" ? "true" : "false"}
`,
  );
  await addFile(
    "content/INDEX.md",
    `---
title: Inkpath deterministic benchmark
description: A generated site for reproducible Inkpath measurements.
---

This fixed home page describes a deterministic large knowledge-base fixture.

## Workload

Generated collections contain representative prose, nested sections, links, anchors, code, and assets.
`,
  );
  await addFile(
    "public/favicon.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#0f766e" d="M2 2h12v12H2z"/></svg>\n',
  );

  for (const section of sections) {
    await addFile(
      path.posix.join("content", section.relativeDirectory, "INDEX.md"),
      renderSection(section),
    );
  }
  for (const section of leafSections(sections)) {
    await addFile(
      path.posix.join("content", section.relativeDirectory, "benchmark-asset.txt"),
      `Deterministic local asset for ${section.slug}.\n`,
    );
  }
  for (const note of notes) {
    await addFile(note.projectPath, renderNote(note, linkableNotes, options, mutationText));
  }

  manifest.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifestSha256 = sha256(
    manifest.map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`).join(""),
  );
  const additionSection = routeNote.section;
  const additionPath = path.posix.join(
    "content",
    additionSection.relativeDirectory,
    "benchmark-added-note.md",
  );
  const renameTo = path.posix.join(
    path.posix.dirname(renameNote.projectPath),
    `${pad(renameNote.index + 1)}-renamed-${renameNote.slug}.md`,
  );
  const mutationTargets: BenchmarkMutationTargets = {
    addition: {
      content: renderAddition(),
      path: additionPath,
    },
    body: {
      after: mutationText.bodyAfter,
      before: mutationText.bodyBefore,
      path: bodyNote.projectPath,
    },
    deletion: { path: deletionNote.projectPath },
    link: {
      after: mutationText.linkAfter,
      before: mutationText.linkBefore,
      path: linkNote.projectPath,
    },
    rename: {
      from: renameNote.projectPath,
      to: renameTo,
    },
    route: {
      after: mutationText.routeAfter,
      before: mutationText.routeBefore,
      path: routeNote.projectPath,
    },
    title: {
      after: mutationText.titleAfter,
      before: mutationText.titleBefore,
      path: titleNote.projectPath,
    },
  };

  const routeAfter = `/${[...routeNote.section.routeSegments, `routed-${routeNote.slug}`].join("/")}/`;
  const additionRoute = `/${[...additionSection.routeSegments, "benchmark-added-note"].join("/")}/`;
  const renameRoute = `/${[...renameNote.section.routeSegments, `renamed-${renameNote.slug}`].join(
    "/",
  )}/`;
  const backlink = `<li><a href="${linkNote.route}">${linkNote.title}</a></li>`;
  const scenarioOracles: ScenarioOracles = {
    check: { expectedPages: options.pages, outputFiles: [] },
    "clean-build": {
      expectedPages: options.pages,
      outputFiles: [
        {
          contains: [mutationText.bodyBefore],
          exists: true,
          path: outputPathForRoute(bodyNote.route),
        },
      ],
    },
    "no-op-rebuild": {
      expectedPages: options.pages,
      outputFiles: [
        {
          contains: [mutationText.bodyBefore],
          exists: true,
          path: outputPathForRoute(bodyNote.route),
        },
      ],
    },
    "body-edit": {
      expectedPages: options.pages,
      outputFiles: [
        {
          contains: [mutationText.bodyAfter],
          excludes: [mutationText.bodyBefore],
          exists: true,
          path: outputPathForRoute(bodyNote.route),
        },
      ],
    },
    "title-edit": {
      expectedPages: options.pages,
      outputFiles: [
        {
          contains: [`<h1>${titleAfterValue}</h1>`],
          excludes: [`<h1>${titleNote.title}</h1>`],
          exists: true,
          path: outputPathForRoute(titleNote.route),
        },
      ],
    },
    "route-edit": {
      expectedPages: options.pages,
      outputFiles: [
        { exists: false, path: outputPathForRoute(routeNote.route) },
        {
          contains: [`<h1>${routeNote.title}</h1>`],
          exists: true,
          path: outputPathForRoute(routeAfter),
        },
      ],
    },
    "link-edit": {
      expectedPages: options.pages,
      outputFiles: [
        {
          contains: [`<a href="${secondLinkTarget.route}#details">target B</a>`],
          excludes: [`<a href="${firstLinkTarget.route}#details">target A</a>`],
          exists: true,
          path: outputPathForRoute(linkNote.route),
        },
        {
          excludes: [backlink],
          exists: true,
          path: outputPathForRoute(firstLinkTarget.route),
        },
        {
          contains: [backlink],
          exists: true,
          path: outputPathForRoute(secondLinkTarget.route),
        },
      ],
    },
    "file-add": {
      expectedPages: options.pages + 1,
      outputFiles: [
        {
          contains: ["<h1>Added benchmark note</h1>"],
          exists: true,
          path: outputPathForRoute(additionRoute),
        },
      ],
    },
    "file-delete": {
      expectedPages: options.pages - 1,
      outputFiles: [{ exists: false, path: outputPathForRoute(deletionNote.route) }],
    },
    "file-rename": {
      expectedPages: options.pages,
      outputFiles: [
        { exists: false, path: outputPathForRoute(renameNote.route) },
        {
          contains: [`<h1>${renameNote.title}</h1>`],
          exists: true,
          path: outputPathForRoute(renameRoute),
        },
      ],
    },
  };
  const mutationTargetsSha256 = canonicalJsonSha256(mutationTargets);
  const suiteSha256 = sha256(`${manifestSha256}\0${mutationTargetsSha256}\n`);
  const manifestPath = path.join(projectRoot, "benchmark-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        format: 2,
        linkFanout: options.linkFanout,
        manifestSha256,
        mutationTargets,
        mutationTargetsSha256,
        pages: options.pages,
        profile: options.profile,
        sources: manifest,
        suiteSha256,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    linkFanout: options.linkFanout,
    manifest,
    manifestPath,
    manifestSha256,
    mutationTargetsSha256,
    mutationTargets,
    notes: noteCount,
    ordinaryPage: { path: bodyNote.projectPath, route: bodyNote.route },
    pages: options.pages,
    profile: options.profile,
    root: projectRoot,
    scenarioOracles,
    sections: sectionCount,
    suiteSha256,
  };
}
