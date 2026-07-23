# Final performance

This report records the original optimized implementation against the deterministic `core` fixture, followed by a validated second optimization pass. The original publication-quality suite remains the source of the clean-build, body-edit, memory, and byte-weight headline tables. The follow-up replaces structural full fallbacks with cached topology reconciliation, lowers the watcher delay safely, and improves clean-build file copying. Reviewed-artifact development, structural, and clean-build validation results are reported explicitly below; the fresh end-to-end clean-build result does not replace the original 2.28-second figure because unrelated host load made the rerun non-comparable.

## Method

- Apple M4 Pro, 14 logical CPUs, 24 GiB RAM
- macOS Darwin 25.3.0, arm64; Node.js 26.5.0; Inkpath 0.3.0
- Source base commit: `6a7e4b16491547b4bedde9b51c88413827fe4122`, with the reported optimization tree uncommitted
- Original headline-suite `dist/` SHA-256: `ca7cb8bfaba430386ea08a98726395107e27960733e97725067cc6dde35ff040`
- Baseline `dist/` SHA-256: `381efcf4dc6b4a1bccc58ac6474c8b770c49cdb0bfd5b898edaa428d06e15eb5`
- Reviewed follow-up `dist/` SHA-256: `0287135706f479c38971a434ed6df05a1bb86ad380c4bdb1f34a9c3ff9cd03ed` (63 files, 442,063 bytes); CLI SHA-256: `76122fea6064ecc275a255d7df249a32d4ab91b01b83a98df39b5881ae3c4764`
- Follow-up development provenance identity: `f3079a8c35cd47e6bb45c39f341d406b6c3e04af592dc69dd2cacf132f147131`; verified comparison lock SHA-256: `65ce8af172969be46ba3d64457ae042ce2b2ce2dfc687c9b361cf1453e36f80e`
- All follow-up runs used the dirty working tree at base commit `6a7e4b16491547b4bedde9b51c88413827fe4122`. The complete built artifact hash above, raw samples below, and exact commands identify the measured implementation; dirty path names alone are not treated as provenance.
- Headline runs use the `core` profile: prose, nested sections, links/backlinks, anchors, syntax-colored code, and local assets. The deterministic `rich` profile adds sampled Mermaid and KaTeX pages; those optional features are covered by correctness and output-budget tests but are not part of the headline timings.
- The 100- and 1,000-page runs used one warmup and five measured samples. The 10,000- and 100,000-page runs used three measured samples without a warmup. The 50,000-page run used one sample without a warmup and is a scaling check, not a stable p95 estimate.
- Each sample ran in an isolated plain-JavaScript worker. Rebuild timing surrounds only `engine.rebuild()` after an untimed initial build and deterministic mutation. Clean and check timing includes engine construction. Compression, semantic oracles, output hashing, fixture restoration, and the canonical build are outside the timed operation.
- Every multi-sample writing scenario was deterministic across samples. Every writing scenario's complete output-tree SHA-256, including the 50,000- and 100,000-page runs, matched one clean build performed after the same mutation.

Reproduce the measured suites from a clean checkout with:

```sh
pnpm benchmark -- --pages 100,1000 --warmups 1 --samples 5 \
  --json benchmark-small.json --markdown benchmark-small.md

pnpm benchmark -- --pages 10000 --warmups 0 --samples 3 \
  --json benchmark-10k.json --markdown benchmark-10k.md

pnpm benchmark -- --pages 10000 --link-fanout 32 \
  --scenarios check,clean-build,no-op-rebuild,body-edit,title-edit,link-edit \
  --warmups 0 --samples 3 --json benchmark-dense-10k.json

pnpm benchmark -- --pages 50000 --scenarios body-edit \
  --warmups 0 --samples 1 --skip-output-bytes --json benchmark-50k.json

pnpm benchmark -- --pages 100000 --large --scenarios body-edit \
  --warmups 0 --samples 3 --skip-output-bytes \
  --json benchmark-100k.json --markdown benchmark-100k.md
```

See [`benchmarks/README.md`](../README.md) for fixture construction, timing boundaries, raw JSON fields, and runner options. Times below are medians unless marked p95.

## Follow-up optimization pass

The reviewed follow-up artifact was measured with these exact commands. Both runners rebuild `dist/`, record the complete artifact and Git identity, emit every raw sample to JSON, and verify that the artifact remains unchanged during the run.

```sh
pnpm benchmark:compare:dev -- \
  --tools inkpath --pages 1000 --warmups 2 --samples 10 \
  --inkpath-executable "$PWD/dist/cli.js" \
  --json follow-up-reviewed-dev.json --quiet

pnpm benchmark -- \
  --pages 10000 --scenarios route-edit,file-add,file-delete,file-rename \
  --warmups 0 --samples 1 --skip-output-bytes \
  --json follow-up-reviewed-structural.json --quiet

pnpm benchmark -- \
  --pages 10000 --scenarios clean-build --warmups 0 --samples 3 \
  --skip-output-bytes --json follow-up-reviewed-clean.json --quiet
```

The development scheduler now waits 55 ms for an isolated change, 75 ms after a burst begins, and at most 90 ms for a continuous stream. The 55 ms floor is intentional: Chokidar 5 suppresses repeated `change` events for the same path for 50 ms. A 15 ms prototype completed one rebuild quickly enough for the next immediate edit to land inside that suppression window; the persistent-development harness caught the missed event. The selected delay completed two warmups and ten alternating edits without loss.

On the same 1,000-page persistent-development protocol used by the comparison report, current Inkpath measured 60.62 ms median and 61.98 ms p95 from edit start through native rebuild completion. The ten raw samples were 60.41, 60.36, 60.56, 61.87, 60.69, 60.93, 61.98, 60.69, 60.45, and 60.49 ms; discarded warmups were 63.37 and 62.62 ms. The earlier fixed-90-ms run measured 98.23 ms median and 99.97 ms p95, so median observed latency fell 38.3%. HTTP checks verified the final edited marker and an unchanged page; browser rendering remains outside the boundary.

Route changes, additions, deletions, renames, draft/publish transitions, section moves, and coalesced multi-file Markdown batches now reconstruct topology from cached page state. They re-render Markdown and HTML only for affected pages, recompute and validate the complete graph, restore public files previously shadowed by removed generated routes, and publish changed files through the rollback journal. Configuration, public-file events, direct content-asset events, commit changes, missing core output, and first/last Mermaid or KaTeX transitions still use a full build.

One canonical 10,000-page reviewed-artifact sweep produced these validation samples. Each row is one raw sample, not a stable median or p95 estimate:

| Scenario      | Follow-up sample | Earlier full-fallback median | Observed improvement |
| ------------- | ---------------: | ---------------------------: | -------------------: |
| Route edit    |        127.38 ms |                  3,572.83 ms |                28.0× |
| File addition |        118.62 ms |                  3,575.03 ms |                30.1× |
| File deletion |        121.10 ms |                  3,620.39 ms |                29.9× |
| File rename   |        124.35 ms |                  3,441.33 ms |                27.7× |

Every sample's complete output manifest exactly matched a clean build after the same mutation. The route, addition, deletion, and rename output SHA-256 values were `df984980d518f9fcc47cdbec4a1ce5f13ecf2b760c8c8bd9e8f6d70a933d9be7`, `f7d3f03f753c38df7b79922e2286555c749364d53d29e0b8152aaa932daac091`, `cf808ceee38629094c401ed4fb0264213b1e91163d682572a9e5c507ac970d39`, and `ce1823cc4e2d3ef7bcbec858e91276d4b6b546d481b43ba81d15acd24977a26e`, respectively.

Exploratory source-read concurrency sweeps selected 32. Their one-off runner and raw samples were not retained, so those timings and the earlier asset-tree microbenchmark are intentionally excluded from the reportable results. Static asset trees are now planned once, destination directories are deduplicated and created in depth order, validated regular files use concurrent `copyFile`, and redundant recursive `mkdir` and metadata calls are removed. Page writes retain the faster recursive/pipelined strategy rather than imposing a full directory barrier.

The reproducible three-sample reviewed-artifact clean-build validation measured 2,658.64, 2,536.37, and 2,339.57 ms: 2,536.37 ms median and 2,658.64 ms p95. Its integrated asset-phase median was 44.05 ms (72.09 ms p95), compared with 91.09 ms in the original headline suite, but this cross-run phase comparison is indicative rather than a controlled A/B. The complete 10,097-file output SHA-256 was `649ef1bb12e96d1005717d8b8e858d16c1ecb3e436d708840db6f0c3f8760f5b`. Host variance in content loading and Markdown parsing kept the end-to-end rerun non-comparable, so the original publication-quality clean-build table remains the headline result.

## Targets

| Target                                                  |                                                                        Measured result | Status                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------: | ---------------------------------------------------- |
| 10,000-page clean build ≤2,000 ms                       |                                                    2,282.81 ms median; 2,296.47 ms p95 | Missed by 282.81 ms                                  |
| 10,000-page body edit ≤50 ms                            |                                                            6.25 ms median; 6.77 ms p95 | Passed                                               |
| 100,000-page body edit ≤100 ms                          |                                                          10.22 ms median; 14.14 ms p95 | Passed                                               |
| Browser refresh after edit ≤200 ms                      | 61.98 ms p95 through watcher completion at 1,000 pages; browser rendering not measured | Unverified end to end                                |
| Typical page: zero JS and ≤15 KiB compressed HTML + CSS |                                                     0 JS; 4,026 B gzip; 3,356 B Brotli | Passed                                               |
| 10,000-page development state ≤250 MiB RSS              |                                         235.4 MiB persistent-engine worker max RSS p95 | Qualified: watcher/server overhead was not measured  |
| No meaningful incremental regression with denser links  |                             Body +7.9%; link edit -3.1%; title +105% at 8× link fanout | Qualified: title work scales with backlink consumers |
| At least 5× faster body edit                            |                                                                               1,346.4× | Passed                                               |
| At least 2× faster 10,000-page clean build              |                                                                                  2.80× | Passed                                               |
| No typical-page weight increase                         |                                         Complete 10,000-page byte totals are unchanged | Passed                                               |

The successful 100,000-page retry used the required `--large` guard and disabled only post-timing compressed-byte accounting. Its three operation samples were 9.56, 14.14, and 10.22 ms. The 100,907-file, 547.3 MiB incremental output had SHA-256 `7be11eb27d9864406dde647c00643b4f4f0922472d2121c5e50550ee867e7092`, exactly matching a clean build after the same mutation. Worker max RSS p95 was 944.7 MiB; worker lifetime includes the roughly 28–30 second untimed initial build and complete output-manifest hashing required for validation.

## Scale results

The default fixture has four deterministic internal links per linkable note.

|   Pages | Check median / p95 |     Clean median / p95 | No-op median / p95 | Body edit median / p95 | Body-edit max RSS p95 |
| ------: | -----------------: | ---------------------: | -----------------: | ---------------------: | --------------------: |
|     100 |   39.61 / 40.47 ms |       66.79 / 69.06 ms |   0.452 / 0.990 ms |         5.17 / 5.83 ms |              98.2 MiB |
|   1,000 | 139.40 / 140.34 ms |     295.63 / 298.94 ms |   0.630 / 0.718 ms |        5.83 / 10.61 ms |             126.6 MiB |
|  10,000 | 969.46 / 975.00 ms | 2,282.81 / 2,296.47 ms |   0.677 / 3.652 ms |         6.25 / 6.77 ms |             235.4 MiB |
|  50,000 |                  — |                      — |                  — |      15.09 / 15.09 ms¹ |             490.8 MiB |
| 100,000 |                  — |                      — |                  — |       10.22 / 14.14 ms |             944.7 MiB |

¹ One sample, so median and p95 are the same. Its worker lifetime includes the untimed initial build required to populate the persistent state.

## 10,000-page scenarios

This table is the original publication-quality suite. The follow-up table above supersedes the route/add/delete/rename implementation and records its separately bounded measurements.

| Scenario           | Final median |   Final p95 | Baseline median | Improvement | Incremental path    |
| ------------------ | -----------: | ----------: | --------------: | ----------: | ------------------- |
| Check              |    969.46 ms |   975.00 ms |     3,172.57 ms |       3.27× | Complete validation |
| Clean build        |  2,282.81 ms | 2,296.47 ms |     6,385.20 ms |       2.80× | Clean build         |
| No-op rebuild      |     0.677 ms |    3.652 ms |     7,987.19 ms |     11,804× | No-op               |
| Body edit          |      6.25 ms |     6.77 ms |     8,420.68 ms |      1,346× | Partial             |
| Title edit         |     22.65 ms |    28.29 ms |     7,537.02 ms |        333× | Partial             |
| Route edit         |  3,572.83 ms | 3,993.87 ms |     8,657.43 ms |       2.42× | Full fallback       |
| Link/backlink edit |      8.07 ms |     8.44 ms |     7,848.40 ms |        973× | Partial             |
| File addition      |  3,575.03 ms | 3,639.39 ms |     8,761.81 ms |       2.45× | Full fallback       |
| File deletion      |  3,620.39 ms | 4,017.08 ms |     8,150.12 ms |       2.25× | Full fallback       |
| File rename        |  3,441.33 ms | 3,508.76 ms |     9,018.32 ms |       2.62× | Full fallback       |

The measured no-op supplies no changed paths. A touched but byte-unchanged Markdown file reparses that one source and also resolves to a no-op; focused tests cover that separate path.

Partial mode requires write mode, an unchanged commit SHA, and a present core output tree. A single ordinary body/link/title/order edit uses the narrowly bounded path. Structural Markdown changes and multi-file batches use cached topology reconciliation: only changed source bytes are read, unchanged Markdown results are translated to the candidate graph, affected documents are rendered, and the complete anchor/backlink graph plus discovery outputs are revalidated. First/last Mermaid or KaTeX transitions fall back to a full build so feature assets remain exact. Validation occurs before publication. Failed validation leaves both cached state and the last valid output unchanged, and a later correction recovers without restarting the server.

## Clean-build profile

| Phase              |   Baseline |       Final | Improvement |
| ------------------ | ---------: | ----------: | ----------: |
| Configuration      |    5.55 ms |     5.77 ms |       0.96× |
| Content loading    | 1,312.5 ms |   601.19 ms |       2.18× |
| Markdown           | 1,910.6 ms |   320.98 ms |       5.95× |
| Graph validation   |   41.47 ms |    30.01 ms |       1.38× |
| Assets             |   101.8 ms |    91.09 ms |       1.12× |
| Document rendering |   500.7 ms |   165.55 ms |       3.02× |
| Output writing     | 2,487.8 ms | 1,069.90 ms |       2.33× |
| Publish            |    0.27 ms |     0.27 ms |       0.99× |
| Total              | 6,385.0 ms | 2,282.52 ms |       2.80× |

Profiling identified repeated Markdown parser construction and serial filesystem work as the dominant baseline costs. The retained changes reuse one build-scoped Markdown renderer, parallelize source reads and output writes with fixed concurrency, avoid repeated full-site rendering indexes and scans, deduplicate backlinks with sets, and reuse content-addressed feature assets. Output writing remains the largest final phase at 1.07 seconds, followed by content loading at 601 ms and Markdown at 321 ms; those phases explain the remaining clean-build target miss.

For comparison, the 10,000-page body edit spent 3.65 ms writing affected files, 0.59 ms rendering Markdown, 0.44 ms loading content, 0.44 ms rendering documents, and 0.43 ms updating and validating graph edges (5.94 ms total inside the engine).

## Link-density stress

The dense fixture raises fanout from 4 to 32 links. Its source manifest is 34.8 MiB versus 9.2 MiB for the default fixture.

| 10,000-page operation |    Fanout 4 |   Fanout 32 | Change |
| --------------------- | ----------: | ----------: | -----: |
| Check                 |   969.46 ms | 2,317.96 ms |  +139% |
| Clean build           | 2,282.81 ms | 3,541.38 ms |   +55% |
| No-op rebuild         |    0.677 ms |    0.526 ms |   -22% |
| Body edit             |     6.25 ms |     6.75 ms |  +7.9% |
| Title edit            |    22.65 ms |    46.37 ms |  +105% |
| Link/backlink edit    |     8.07 ms |     7.82 ms |  -3.1% |

Body and link edits remain effectively flat because they touch only changed graph edges. A title edit rerenders each destination of the edited page's outgoing links because those destination pages display its title in their backlink entries. Raising fanout from 4 to 32 therefore grows the correctly affected output set, in addition to rebuilding site-wide indexes. The body-edit worker's max RSS p95 also rises from 235.4 MiB to 396.6 MiB. The measured check and clean-build changes are consistent with the larger source and edge count; this stress run did not expose quadratic backlink work.

## Production bytes

The optimized 10,000-page output is byte-for-byte unchanged from the baseline, so no production minifier or precompressed duplicate files were added.

| Type       |  Files |          Raw |       gzip-9 |    Brotli-11 |
| ---------- | -----: | -----------: | -----------: | -----------: |
| HTML       | 10,001 | 52,616,679 B | 14,891,015 B | 11,221,040 B |
| CSS        |      1 |     11,254 B |      2,847 B |      2,455 B |
| JavaScript |      0 |          0 B |          0 B |          0 B |

The automated 15 KiB per-view budget compresses each file offline with gzip-9 and Brotli-11, modeling separate response bodies. Its ordinary page uses HTML plus one shared stylesheet: two measured content/style bodies, 4,026 B gzip, 3,356 B Brotli, and no script. The Mermaid-and-KaTeX page's HTML and two stylesheets total 9,038 B gzip and 7,492 B Brotli; Mermaid JavaScript, dynamic chunks, fonts, browser-generated favicon requests, headers, and protocol overhead are outside those figures.

## Correctness and remaining limits

- `pnpm verify` passes 229 of 230 tests with one case-sensitive-filesystem test skipped on this case-insensitive macOS volume. `pnpm package:check` also passes.
- Tests cover body, headings and incoming anchors, links and backlinks, title/order navigation, summaries and discovery files, local assets, Mermaid cache reuse, stale or missing output, commit changes, additions, deletions, renames, drafts, configuration, watcher races, failed-build recovery, transaction rollback, public-file shadow restoration, source-order parity, adaptive scheduling, and symlink rejection. Structural cases compare their complete file manifests with clean builds.
- Body/link/title/order edits and structural Markdown changes use the partial paths described above. Checks, commit changes, missing core output, configuration, public assets, direct content-asset events, and first/last Mermaid or KaTeX transitions use a full validated build.
- The persistent state retains parsed page objects, rendered Markdown, headings, outgoing and incoming references, navigation order, renderer indexes, and shared generated-output hashes after structural reconciliation. It does not retain explicit per-source file metadata/content hashes or every generated page's hash; structural planning and complete graph validation remain O(N + E), while Markdown and HTML rendering are limited to affected pages.
- The timed add/delete/rename mutations use unreferenced notes. Focused tests separately exercise linked structural changes, page and section route moves, simultaneous link repair plus deletion, public-file restoration, and stale-output removal.
- Caught validation and publication failures restore or retain the previous output and cached graph. Partial publication stages all payloads and rolls back failures, but installs multiple files sequentially, so external filesystem readers can briefly observe mixed generations. The development server waits for an active rebuild before serving existing or missing files, preventing that mixed view through its HTTP path. The clean-build publisher's two-rename commit is likewise not durable against a process crash after moving the previous tree and before installing the staged tree.
- Published-output health checks cover the core output entries, not a hash of every file. External deletion or corruption of an unrelated generated page or asset is not guaranteed to trigger a full repair on the next otherwise-partial edit.
- The end-to-end 200 ms browser-refresh target was not instrumented. The current 1,000-page persistent-development p95 is 61.98 ms through watcher build completion; SSE delivery, HTTP fetch, and browser rendering remain outside that boundary.
- Quartz, MkDocs, Docusaurus, and Hugo are covered by the pinned harness in `benchmarks/comparison/`; their native-tool measurements are published separately in [`comparison.md`](comparison.md). This Inkpath-only report includes no competitor numbers and makes no competitive speed claim.
- Complete output hashes establish incremental-versus-clean equivalence; scenario oracles and focused unit tests provide independent semantic checks. Wall-time thresholds stay out of ordinary CI because machine variance would make them flaky. Stable CI checks enforce output semantics, deterministic identity, transaction recovery, zero ordinary-page JavaScript, and the 15 KiB compressed page budget.
