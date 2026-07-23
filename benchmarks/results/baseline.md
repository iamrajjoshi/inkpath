# Baseline performance

This report records the pre-optimization baseline for the deterministic `core`
fixture. The instrumented source differs from commit
`6a7e4b16491547b4bedde9b51c88413827fe4122` only by benchmark plumbing, phase
timers, and recovery tests; it contains no performance optimization. The built
artifact SHA-256 was
`381efcf4dc6b4a1bccc58ac6474c8b770c49cdb0bfd5b898edaa428d06e15eb5`.

## Method

- Apple M4 Pro, 14 logical CPUs, 24 GiB RAM
- macOS Darwin 25.3.0, arm64
- Node.js 26.5.0, Inkpath 0.3.0
- Each scenario ran in an isolated worker. The 100- and 1,000-page runs used one
  warmup and five measured samples. The 10,000-page run used three measured
  samples and no warmup because each rebuild already performs a full initial
  build in the same worker.
- The reported operation excludes worker/module startup, fixture mutation,
  semantic-oracle checks, canonical comparison builds, hashing, and compression.
- p95 is nearest-rank. Peak RSS is the p95 of the worker's observed maximum RSS.
- Every mutation was checked with a scenario-specific semantic oracle. Output
  was deterministic across samples, and mutation output was compared with a
  clean canonical build.

Commands:

```sh
pnpm benchmark -- --engine baseline --pages 100,1000 --warmups 1 --samples 5 \
  --json /tmp/inkpath-baseline-small.json \
  --markdown /tmp/inkpath-baseline-small.md

pnpm benchmark -- --engine baseline --pages 10000 --warmups 0 --samples 3 \
  --json /tmp/inkpath-baseline-10k.json \
  --markdown /tmp/inkpath-baseline-10k.md
```

Fixture identity was identical at every scale/run for the relevant prefix. The
10,000-page suite SHA-256 was
`14e9f2f150c6e9ed20aa8272e8142aad374b4d0d20729fbbba9e4f807dae41e5`, and its
source manifest SHA-256 was
`6c1d0db215b2940cd5c229fecd1f7443a5a0c2c52dcd65473b97635a13cd6a20`.

## Summary

|  Pages | Scenario      |      Median |         p95 | Peak RSS p95 |
| -----: | ------------- | ----------: | ----------: | -----------: |
|    100 | Check         |    67.55 ms |    71.51 ms |     92.0 MiB |
|    100 | Clean build   |   108.46 ms |   122.86 ms |    100.7 MiB |
|    100 | No-op rebuild |    87.97 ms |   115.84 ms |    108.3 MiB |
|    100 | Body edit     |    86.54 ms |    99.60 ms |    108.5 MiB |
|  1,000 | Check         |   366.82 ms |   368.89 ms |    149.9 MiB |
|  1,000 | Clean build   |   648.74 ms |   662.87 ms |    190.0 MiB |
|  1,000 | No-op rebuild |   713.52 ms |   737.89 ms |    238.7 MiB |
|  1,000 | Body edit     |   702.90 ms |   729.75 ms |    238.5 MiB |
| 10,000 | Check         | 3,172.57 ms | 3,253.69 ms |    277.1 MiB |
| 10,000 | Clean build   | 6,385.20 ms | 6,573.77 ms |    594.6 MiB |
| 10,000 | No-op rebuild | 7,987.19 ms | 8,216.87 ms |    731.9 MiB |
| 10,000 | Body edit     | 8,420.68 ms | 9,352.18 ms |    734.4 MiB |

The baseline therefore misses the 10,000-page goals by 3.2x for a clean build,
168x for a body edit, and 2.9x for dev-server memory. A 5x body-edit improvement
requires a median of at most 1,684.14 ms; a 2x clean-build improvement requires
at most 3,192.60 ms.

## All mutation medians

|  Pages |    No-op |     Body |    Title |    Route | Link/backlink |      Add |   Delete |   Rename |
| -----: | -------: | -------: | -------: | -------: | ------------: | -------: | -------: | -------: |
|    100 |    87.97 |    86.54 |    85.59 |    85.01 |         86.42 |    84.58 |    83.65 |    84.25 |
|  1,000 |   713.52 |   702.90 |   752.61 |   732.59 |        705.09 |   725.43 |   824.37 |   794.62 |
| 10,000 | 7,987.19 | 8,420.68 | 7,537.02 | 8,657.43 |      7,848.40 | 8,761.81 | 8,150.12 | 9,018.32 |

All values are milliseconds. The 1,000-page delete p95 had a single 3,271.67 ms
outlier; the other samples were 745.25-993.13 ms.

## Raw operation samples

|  Pages | Scenario      | Samples (ms)                             |
| -----: | ------------- | ---------------------------------------- |
|    100 | Check         | 64.04, 67.55, 71.51, 63.93, 70.78        |
|    100 | Clean build   | 107.66, 122.86, 107.52, 108.46, 110.00   |
|    100 | No-op         | 86.48, 107.26, 115.84, 87.97, 83.61      |
|    100 | Body          | 84.64, 99.60, 86.54, 91.94, 85.39        |
|    100 | Title         | 87.73, 85.59, 88.03, 84.39, 82.40        |
|    100 | Route         | 82.19, 85.78, 92.84, 82.42, 85.01        |
|    100 | Link/backlink | 86.42, 86.06, 87.44, 87.57, 83.72        |
|    100 | Add           | 84.58, 82.69, 89.55, 83.48, 85.88        |
|    100 | Delete        | 85.14, 83.65, 87.41, 82.27, 83.27        |
|    100 | Rename        | 83.44, 86.51, 84.25, 83.57, 84.35        |
|  1,000 | Check         | 367.43, 366.82, 353.78, 368.89, 361.28   |
|  1,000 | Clean build   | 662.87, 661.00, 646.32, 648.74, 632.69   |
|  1,000 | No-op         | 676.85, 727.62, 702.34, 713.52, 737.89   |
|  1,000 | Body          | 701.21, 725.62, 702.90, 695.61, 729.75   |
|  1,000 | Title         | 759.21, 752.61, 709.19, 713.40, 967.73   |
|  1,000 | Route         | 732.59, 703.84, 755.30, 734.05, 707.26   |
|  1,000 | Link/backlink | 689.04, 705.09, 717.46, 696.79, 714.17   |
|  1,000 | Add           | 700.45, 794.60, 730.07, 690.49, 725.43   |
|  1,000 | Delete        | 3,271.67, 801.53, 745.25, 993.13, 824.37 |
|  1,000 | Rename        | 809.29, 794.62, 754.31, 801.52, 753.09   |
| 10,000 | Check         | 3,162.55, 3,172.57, 3,253.69             |
| 10,000 | Clean build   | 6,573.77, 6,385.20, 6,218.77             |
| 10,000 | No-op         | 7,576.18, 7,987.19, 8,216.87             |
| 10,000 | Body          | 7,998.47, 8,420.68, 9,352.18             |
| 10,000 | Title         | 7,537.02, 7,483.74, 8,520.52             |
| 10,000 | Route         | 8,657.43, 9,303.05, 8,484.26             |
| 10,000 | Link/backlink | 7,848.40, 8,506.08, 7,689.52             |
| 10,000 | Add           | 7,512.57, 8,761.81, 9,317.27             |
| 10,000 | Delete        | 9,040.65, 7,723.93, 8,150.12             |
| 10,000 | Rename        | 8,703.23, 9,193.99, 9,018.32             |

## Phase breakdown

Median instrumented phases for the 10,000-page baseline:

| Scenario    | Config | Content | Markdown | Graph | Assets | Document render | Output write | Publish |   Total |
| ----------- | -----: | ------: | -------: | ----: | -----: | --------------: | -----------: | ------: | ------: |
| Check       |   5.67 | 1,241.5 |  1,884.8 | 41.00 |      0 |               0 |            0 |       0 | 3,172.4 |
| Clean build |   5.55 | 1,312.5 |  1,910.6 | 41.47 |  101.8 |           500.7 |      2,487.8 |    0.27 | 6,385.0 |
| No-op       |   1.02 | 1,763.1 |  1,897.0 | 95.82 |  108.3 |           460.0 |      2,448.4 | 1,279.4 | 7,987.2 |
| Body edit   |   1.06 | 1,844.9 |  1,977.6 | 42.74 |  98.98 |           496.9 |      2,578.6 | 1,283.0 | 8,420.7 |

All values are milliseconds. `outputWrite` is the residual around output
preparation and filesystem writes; compression is never part of it.

CPU profiles of 10,000-page check and clean builds identified two dominant
causes that agree with these phase timers:

- constructing MarkdownIt/linkify state once per page consumed about 1.1-1.4s;
- filesystem-idle samples accounted for about 3.7s of the clean build, consistent
  with serial source reads and serial output writes.

Secondary code-audit findings were per-page full-site scans for feed detection,
quadratic sibling pagination work, repeated backlink deduplication, and redundant
asset work. Optimizations are retained only when this benchmark shows a material
improvement without changing canonical output.

## Output baseline

|  Pages |     HTML raw |  HTML gzip-9 | HTML Brotli-11 |  CSS raw / gzip / Brotli | JavaScript |
| -----: | -----------: | -----------: | -------------: | -----------------------: | ---------: |
|    100 |    470,012 B |    141,183 B |      105,555 B | 11,254 / 2,847 / 2,455 B |        0 B |
|  1,000 |  4,955,519 B |  1,465,769 B |    1,101,873 B | 11,254 / 2,847 / 2,455 B |        0 B |
| 10,000 | 52,616,679 B | 14,891,015 B |   11,221,040 B | 11,254 / 2,847 / 2,455 B |        0 B |

Compression is performed per file, after timing. At 10,000 pages, mean HTML is
5.14 KiB raw, 1.45 KiB gzip, and 1.10 KiB Brotli. The fixture's ordinary pages
ship no JavaScript; Mermaid and KaTeX assets remain opt-in on pages that use
those features.
