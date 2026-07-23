# Static-site generator comparison

On this corpus and these configurations, Hugo had the lowest 1,000-page
one-shot production medians. Inkpath had the lowest observed 1,000-page
persistent-development median and the lowest clean-build and development
medians among the tools selected for completed 10,000-page runs. Those are
bounded observations, not a universal ranking: the themes, generated features,
client runtimes, and watcher semantics are materially different.

> **Follow-up:** A later Inkpath-only run of the same 1,000-page persistent-development protocol measured 60.62 ms median and 61.98 ms p95 after the watcher scheduler changed from a fixed 90 ms delay to a tested 55/75/90 ms adaptive policy. That reviewed run used `dist/` SHA-256 `0287135706f479c38971a434ed6df05a1bb86ad380c4bdb1f34a9c3ff9cd03ed`; the competitor rows and publication lock below remain the original pinned comparison and were not rerun or silently combined with the newer Inkpath artifact.

In concrete terms, Inkpath's 1,000-page clean median was 414.8 ms versus
Hugo's minimal-template 328.7 ms, Quartz's 1,761.3 ms, MkDocs' 5,088.9 ms, and
Docusaurus' 49,092.3 ms. For a persistent body edit, Inkpath measured 98.2 ms
from write start through native build completion, versus Quartz at 319.8 ms,
Docusaurus at 333.8 ms, Hugo at 500.0 ms, and MkDocs at 5,053.8 ms. Inkpath's
separate ordinary-page budget test verifies that it emits no script. These
values describe the matrix below; they are not normalized equivalent-feature
scores.

## Reference environment and provenance

- Apple M4 Pro, 14 logical CPUs, 24 GiB RAM
- macOS Darwin 25.3.0, arm64
- Node.js 26.5.0
- 20 ms process-tree RSS sampling
- Final publication-lock SHA-256:
  `65ce8af172969be46ba3d64457ae042ce2b2ce2dfc687c9b361cf1453e36f80e`

The timing JSON initially recorded predecessor lock
`34c134fcb5dba2e5b96faa12dcbfeabb5f619e61d695e16084885f08298cdcb0`.
A publication audit found that Quartz core statically loads the installed
`og-image` checkout even though its output plugin is disabled. The final lock
adds only that checkout's existing commit and package-lock digest; no installed
tool or timing boundary changed. Afterward, a fresh all-five 20-page clean smoke
revalidated the installations and all 20 routes, anchors, 80 links, one code
block, and one asset under the final lock.

The exact installation procedure and runner commands are documented in the
[comparison harness README](../comparison/README.md). The checked
[provenance lock](../comparison/versions.lock.json) pins these identities:

| Tool       | Exact version                                                         | Provenance used by these runs                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inkpath    | 0.3.0 workspace                                                       | Built artifact `ca7cb8bfaba430386ea08a98726395107e27960733e97725067cc6dde35ff040`; source commit `6a7e4b16491547b4bedde9b51c88413827fe4122` with the benchmark worktree dirty and recorded |
| Hugo       | [0.164.0](https://github.com/gohugoio/hugo/releases/tag/v0.164.0)     | Darwin universal executable `360e2bb3b2fa34785f693e590558d449e6b7626fb7105c75bc1ef8a89f099fb9`                                                                                             |
| MkDocs     | [1.6.1](https://pypi.org/project/mkdocs/1.6.1/)                       | CPython 3.12.8; exact 16-distribution inventory `5f6bdad9dd98d26bb9afc9e5e845bfaffc6e99f407575fa0ebc68dce98729fce`                                                                         |
| Docusaurus | [3.10.2](https://github.com/facebook/docusaurus/releases/tag/v3.10.2) | npm lock `6473e35564d486dadcdb2cb17ae588d60033b1d08c88b5a55bf4df8396faa402`; React and ReactDOM 19.2.7                                                                                     |
| Quartz     | [5.0.0](https://github.com/jackyzha0/quartz/releases/tag/v5.0.0)      | Clean commit `ab346fa66a895e12d63a308e70ce330ba795822a`, root lock `b0486eb49bfbd1769189da57165a3acb4cc59f75a0cb72f4eb50d026568f8b85`, and pinned plugin checkouts                         |

## Corpus and configuration

The deterministic corpus has the exact requested page count, five home or
nested-section landing pages, ordinary prose, two headings and a stable anchor
per page, four relative links per page, a TypeScript block on every tenth leaf
note, and a local text asset on every thirteenth leaf note. A body-edit scenario
changes one equal-length marker. The projector adapts file names, frontmatter,
and routes to each tool's native conventions.

Every successful 1,000-page production sample validated 1,000 pages, 1,000
anchors, 4,000 links, 99 code blocks, and 76 assets. The corresponding
10,000-page counts were 10,000 pages and anchors, 40,000 links, 999 code blocks,
and 768 assets. Source and output identities were stable within each scenario.

| Tool       | Benchmark configuration                                                    | Navigation and generated features                                                                | Browser payload                                                                                                                               |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Inkpath    | Native knowledge-base build                                                | Native navigation, backlinks, strict validation, and discovery files                             | Zero JavaScript on these ordinary pages; shared native CSS                                                                                    |
| Hugo       | Deliberately minimal native templates; unrelated output kinds disabled     | No generated navigation in the benchmark templates                                               | No CSS or JavaScript                                                                                                                          |
| MkDocs     | Built-in `mkdocs` theme; plugins disabled                                  | Full theme navigation repeated in generated HTML                                                 | Local theme CSS and JavaScript; CDN Highlight assets referenced by pages are not present in, and therefore excluded from, on-disk byte totals |
| Docusaurus | Classic docs preset with autogenerated sidebar                             | Full docs navigation and hydrated React output                                                   | Per-page and shared React JavaScript                                                                                                          |
| Quartz     | Trimmed configuration; SPA, popovers, analytics, and remote fonts disabled | Pinned content, folder, Markdown, link, syntax, description, draft, property, and footer plugins | Small emitted scripts; not the default full Quartz configuration                                                                              |

This matrix is why output size and build time cannot be read independently or
treated as an equivalent-feature product ranking.

## 1,000-page production

Each scenario used one discarded warmup and five measured samples. Every sample
recreated its project at the same absolute path, preventing path-sensitive
bundlers from receiving a benchmark-controlled input difference, while still
starting a fresh generator process. Clean builds began without output or a
project-local cache. Repeat and body-edit builds first ran an untimed production
build, retained its output and project-local cache, then timed a fresh one-shot
process; the body mutation occurred between the two builds. These are not
persistent incremental rebuilds.

| Tool       | Scenario  | Warmup (ms) | Measured samples in order (ms)                             | Median (ms) |   p95 (ms) | Peak RSS p95 (MiB) |
| ---------- | --------- | ----------: | ---------------------------------------------------------- | ----------: | ---------: | -----------------: |
| Inkpath    | Clean     |     408.925 | 414.823, 445.500, 412.936, 425.114, 407.531                |     414.823 |    445.500 |            128.406 |
| Inkpath    | Repeat    |     532.213 | 528.215, 555.892, 630.457, 913.064, 754.352                |     630.457 |    913.064 |            129.516 |
| Inkpath    | Body edit |     725.159 | 773.340, 782.538, 967.253, 825.239, 774.114                |     782.538 |    967.253 |            130.234 |
| Hugo       | Clean     |     371.743 | 323.901, 322.915, 377.024, 328.722, 342.999                |     328.722 |    377.024 |             98.734 |
| Hugo       | Repeat    |     271.539 | 382.096, 318.255, 324.266, 272.743, 259.632                |     318.255 |    382.096 |            102.500 |
| Hugo       | Body edit |     307.959 | 278.903, 289.816, 329.044, 265.565, 457.499                |     289.816 |    457.499 |            100.313 |
| MkDocs     | Clean     |   4,446.267 | 4,289.899, 5,106.822, 4,854.258, 5,088.868, 6,423.128      |   5,088.868 |  6,423.128 |             47.000 |
| MkDocs     | Repeat    |   6,511.443 | 7,587.412, 5,942.717, 8,230.131, 5,907.101, 6,221.133      |   6,221.133 |  8,230.131 |             47.219 |
| MkDocs     | Body edit |   7,424.131 | 7,589.071, 4,784.113, 4,561.848, 5,005.439, 5,155.845      |   5,005.439 |  7,589.071 |             46.875 |
| Docusaurus | Clean     |  69,273.015 | 58,246.554, 49,105.059, 48,536.697, 43,086.111, 49,092.289 |  49,092.289 | 58,246.554 |          2,919.125 |
| Docusaurus | Repeat    |  25,322.920 | 27,867.636, 21,458.761, 18,991.742, 20,891.715, 26,093.466 |  21,458.761 | 27,867.636 |          1,558.938 |
| Docusaurus | Body edit |  24,061.685 | 27,112.603, 23,395.475, 24,632.145, 24,660.045, 26,907.612 |  24,660.045 | 27,112.603 |          1,544.156 |
| Quartz     | Clean     |   1,919.840 | 1,732.215, 1,699.633, 1,761.296, 1,766.605, 1,953.957      |   1,761.296 |  1,953.957 |            906.266 |
| Quartz     | Repeat    |   2,218.722 | 3,138.221, 3,199.553, 3,557.245, 2,987.478, 3,044.785      |   3,138.221 |  3,557.245 |            906.344 |
| Quartz     | Body edit |   1,898.993 | 3,429.467, 3,375.017, 2,824.195, 3,123.055, 4,234.921      |   3,375.017 |  4,234.921 |            915.359 |

Nearest-rank p95 is the maximum measured value with five samples. The RSS value
is the p95 of the highest sampled sum for each fresh process tree.

### Clean-build output

These are complete on-disk clean outputs. `gzip-9` and `Brotli-11` compress each
file independently after timing; totals include HTML, CSS, JavaScript, and
other emitted files. Network-only resources are absent.

| Tool       | Files | Total raw (B) | Total gzip-9 (B) | Total Brotli-11 (B) | Standalone JS raw (B) | Standalone JS gzip-9 (B) | Standalone JS Brotli-11 (B) |
| ---------- | ----: | ------------: | ---------------: | ------------------: | --------------------: | -----------------------: | --------------------------: |
| Inkpath    | 1,081 |     4,429,362 |        1,315,030 |             968,589 |                     0 |                        0 |                           0 |
| Hugo       | 1,076 |     1,086,919 |          514,451 |             340,479 |                     0 |                        0 |                           0 |
| MkDocs     | 1,100 |   124,482,239 |        9,506,127 |           5,043,740 |                91,523 |                   27,061 |                      23,840 |
| Docusaurus | 2,091 |   131,288,642 |        8,757,883 |           5,622,730 |             4,425,152 |                1,423,668 |                   1,156,946 |
| Quartz     | 1,084 |     7,593,756 |        2,342,148 |           1,809,390 |                   664 |                      385 |                         290 |

MkDocs' and Docusaurus' full navigation accounts for substantial per-page
output growth. Hugo's smaller output reflects its deliberately minimal template,
not the same user-facing feature set as Inkpath, MkDocs, Docusaurus, or Quartz.

## 1,000-page persistent development

Each tool ran one fresh native development server, with two discarded alternating
edits and ten measured alternating edits. The clock began immediately before an
equal-length positioned write and ended at the tool's native rebuild-complete
log after flush, fsync, and close. It includes file I/O, watcher delivery or
polling, debounce, scheduling, and rebuild work. It excludes HTTP semantic
checks, browser notification, reload, rendering, setup, and shutdown.

| Tool       | Warmups (ms)         | Measured samples in order (ms)                                                                               | Median (ms) |  p95 (ms) | Persistent process-tree peak RSS (MiB) |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------------------------ | ----------: | --------: | -------------------------------------: |
| Inkpath    | 99.495, 95.796       | 98.343, 97.666, 96.319, 95.605, 99.974, 99.120, 99.952, 96.133, 98.106, 99.389                               |      98.225 |    99.974 |                                136.250 |
| Hugo       | 148.037, 514.683     | 500.880, 476.172, 512.842, 498.742, 499.527, 493.802, 503.529, 478.530, 510.218, 500.502                     |     500.015 |   512.842 |                                120.406 |
| MkDocs     | 5,407.258, 5,213.326 | 5,151.941, 5,301.028, 5,050.769, 5,056.878, 4,993.752, 5,047.447, 5,440.101, 4,926.912, 5,175.061, 5,013.340 |   5,053.824 | 5,440.101 |                                 56.953 |
| Docusaurus | 321.887, 347.181     | 338.114, 346.041, 333.983, 331.780, 323.273, 329.387, 333.566, 324.306, 335.521, 389.036                     |     333.774 |   389.036 |                              1,606.938 |
| Quartz     | 106.363, 26.175      | 309.289, 539.042, 319.637, 319.979, 320.627, 316.480, 319.977, 318.678, 318.635, 324.414                     |     319.807 |   539.042 |                                870.672 |

Nearest-rank p95 is again the maximum measured value with ten samples. Hugo's
edited route was requested before every change so its Fast Render behavior
included that page. MkDocs used its default full clean rebuild, not
`--dirtyreload`.

Inkpath, Hugo, MkDocs, and Quartz received untimed HTTP-body checks for the final
edited marker and an unchanged page. Docusaurus' development server returned a
client-rendered shell, so its measured boundary was only the native successful
compile log plus HTTP status. After shutdown, an untimed production build
validated all 1,000 Docusaurus routes, anchors, links, code blocks, assets, and
the final marker. Browser visibility and HMR were not verified.

## Selected 10,000-page results

MkDocs and Docusaurus were not taken to 10,000 pages: their 1,000-page output
growth and observed production cost made that run impractical on this benchmark
host. The completed clean runs used one warmup and three measured samples.

| Tool    | Warmup (ms) | Clean samples in order (ms)        | Median (ms) |   p95 (ms) | Peak RSS p95 (MiB) |
| ------- | ----------: | ---------------------------------- | ----------: | ---------: | -----------------: |
| Inkpath |   3,632.120 | 3,282.161, 3,215.696, 3,166.671    |   3,215.696 |  3,282.161 |            224.359 |
| Hugo    |   2,959.401 | 3,954.341, 3,998.008, 4,019.245    |   3,998.008 |  4,019.245 |            442.031 |
| Quartz  |   9,896.074 | 11,544.676, 13,187.101, 12,066.672 |  12,066.672 | 13,187.101 |          1,501.969 |

| Tool    |  Files | Total raw (B) | Total gzip-9 (B) | Total Brotli-11 (B) | Standalone JS raw / gzip-9 / Brotli-11 (B) |
| ------- | -----: | ------------: | ---------------: | ------------------: | -----------------------------------------: |
| Inkpath | 10,773 |    44,228,768 |       13,117,968 |           9,668,920 |                                  0 / 0 / 0 |
| Hugo    | 10,768 |    10,880,601 |        5,148,078 |           3,406,675 |                                  0 / 0 / 0 |
| Quartz  | 10,776 |    75,113,632 |       22,852,664 |          17,545,965 |                            664 / 385 / 290 |

The selected 10,000-page development runs used two warmups and ten measured
edits:

| Tool    | Warmups (ms)     | Measured samples in order (ms)                                                           | Median (ms) | p95 (ms) | Persistent process-tree peak RSS (MiB) |
| ------- | ---------------- | ---------------------------------------------------------------------------------------- | ----------: | -------: | -------------------------------------: |
| Inkpath | 118.991, 115.389 | 108.539, 111.138, 107.593, 109.912, 100.227, 96.246, 97.334, 94.902, 96.662, 96.535      |      98.781 |  111.138 |                                279.828 |
| Hugo    | 697.837, 454.748 | 496.142, 477.008, 511.009, 479.558, 508.644, 495.448, 495.519, 519.870, 483.001, 474.654 |     495.484 |  519.870 |                                575.391 |

### Quartz 10,000-page development timeout

Quartz reached its ready state, but its first alternating edit timed out after
exactly 600,000 ms while waiting for a native rebuild-complete event. At the
failure boundary the source contained variant B while the generated
output still contained variant A. No warmup or measured timing completed, so
600,000 ms is a timeout threshold, not a benchmark sample, and no Quartz
10,000-page development number is reported.

## Interpretation limits

- Production timing includes the complete fresh generator process. Corpus
  projection, untimed initial builds, mutation, semantic validation, output
  hashing, compression, and cleanup are outside the clock.
- Development timing is edit-start-to-native-completion, not browser refresh.
  Browser notification, reload, rendering, and visual correctness are unverified
  for every tool.
- RSS is a sampled sum across each generator process and its descendants. It is
  an approximate process-tree footprint, may miss a short peak, and may
  double-count shared memory pages, so it should be treated as an approximate
  upper-bound comparison rather than unique physical memory.
- Output compression is performed independently per emitted file at gzip level
  9 and Brotli quality 11 after timing. External CDN resources, including the
  MkDocs theme's Highlight assets, are not counted.
- The standalone-JavaScript columns classify emitted files by `.js`, `.mjs`,
  or `.cjs` extension. Inline scripts remain in HTML totals, so those columns
  are not total executable browser payload. Inkpath's zero-script statement is
  additionally enforced by its separate ordinary-page output-budget test.
- The fixed absolute sample path controls a reproducibility variable but does
  not make theme and feature sets equivalent.
- Hugo's executable and Inkpath's built tree are content-hashed. Docusaurus is
  checked through its npm lock, selected package manifests, and exact declared
  versions; MkDocs through its exact installed distribution inventory and
  interpreter identity. The latter two checks do not hash every installed code
  file, so the report does not claim full-tree content attestation for them.
- Results apply to the pinned versions, corpus, configurations, machine, and
  runner boundaries above. They do not establish a universal fastest static-site
  generator.
