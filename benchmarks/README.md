# Inkpath benchmarks

The benchmark suite generates deterministic sites in a temporary directory and exercises Inkpath through isolated worker processes. Generated pages and result files are not committed automatically.

To inspect or profile a fixture directly, generate it into the ignored benchmark directory. The destination must be empty so an old fixture can never contaminate a run.

```bash
pnpm benchmark:generate -- --pages 10000 --output .inkpath-benchmark/site-10000
```

The benchmark command builds Inkpath and compiles the benchmark runner and worker before timing. Timed workers execute as plain JavaScript, so TypeScript loader startup and memory are not attributed to Inkpath.

```bash
pnpm benchmark
```

The default is a practical smoke run: 100 pages, the `core` fixture profile, one warmup, three measured samples, and every scenario. A minimal validation run is:

```bash
pnpm benchmark -- \
  --pages 20 \
  --scenarios check,clean-build,body-edit \
  --warmups 0 \
  --samples 1
```

For the standard scale sweep:

```bash
pnpm benchmark -- \
  --pages 100,1000,10000 \
  --samples 5 \
  --warmups 1 \
  --json benchmark-results.json \
  --markdown benchmark-results.md
```

Fixtures of 100,000 pages or more require the explicit `--large` guard:

```bash
pnpm benchmark -- --pages 100000 --large --samples 3
```

For a latency-only large-site run, `--skip-output-bytes` avoids the intentionally
expensive post-timing gzip-9 and Brotli-11 pass. It does not disable semantic
oracles, deterministic output hashes, or canonical clean-build comparison.

Use `--profile rich` to include the generator's highlighting, Mermaid, KaTeX, and richer content workload. `--link-fanout` controls deterministic internal-link density. Run `--help` for all options.

## Competitive comparison

The separate [competitive comparison harness](comparison/README.md) projects one
deterministic corpus into native Inkpath, Hugo, MkDocs, Docusaurus, and Quartz
projects. It measures fresh and repeat production processes as well as each
tool's persistent development server. Installations are preinstalled, pinned,
and provenance-checked before timing; the runner never installs dependencies or
contacts a package registry. The [reference comparison results](results/comparison.md)
include the raw samples, output-weight measurements, and cross-tool limitations.

## Scenarios

Scenario IDs are stable so results can be compared across revisions:

| ID              | Timed operation                                                   |
| --------------- | ----------------------------------------------------------------- |
| `check`         | Complete validation with output writing disabled.                 |
| `clean-build`   | Production build after ensuring the output directory is absent.   |
| `no-op-rebuild` | Second production build without a source change.                  |
| `body-edit`     | Rebuild after changing one page body without changing its route.  |
| `title-edit`    | Rebuild after changing one page title.                            |
| `route-edit`    | Rebuild after changing one page slug.                             |
| `link-edit`     | Rebuild after a deterministic link change that changes backlinks. |
| `file-add`      | Rebuild after adding one valid Markdown file.                     |
| `file-delete`   | Rebuild after deleting one unreferenced Markdown file.            |
| `file-rename`   | Rebuild after renaming one unreferenced Markdown file.            |

Rebuild scenarios perform an untimed initial build in the same worker, apply the mutation, and then time the rebuild. This keeps an incremental engine's in-memory state alive while retaining process isolation between samples. Baseline mode performs the same protocol with repeated `buildSite` calls.

## Methodology

- Every warmup and measured sample runs in a fresh plain-JavaScript child process. One working fixture is reused per page count; the output directory and the handful of mutation targets are restored from the pristine generated fixture before every worker.
- Warmup timings are recorded but excluded from summaries. JSON includes every raw measured sample.
- Median uses the middle value, or the mean of the two middle values for an even sample count. p95 uses nearest rank: the value at `ceil(0.95 × n)` in sorted order.
- Clean-build and check headline times include incremental-engine factory setup; the output directory is removed before that setup begins. Rebuild headline times surround the rebuild call after an untimed initial build and mutation. Worker wall time, module import, engine-call time, initial build, and mutation time are reported separately.
- Workers pass `{ profile: true }` and retain Inkpath's phase timings when the installed `dist/` supports them.
- `process.resourceUsage().maxRSS` is converted from KiB to bytes. Current RSS, heap used/total, external memory, and array-buffer memory are sampled immediately after the timed operation. For rebuild scenarios, lifetime max RSS includes the initial build because that state is required for a meaningful rebuild. These are worker-process measurements and do not include subprocesses launched by dependencies.
- Every writing sample receives a deterministic SHA-256 manifest of its complete output tree. Hashes must agree across warmups and measured samples. HTML, CSS, and JavaScript byte accounting runs only after all timing and canonical validation are complete, once per fixture (on `clean-build` when selected). Each emitted file is compressed independently with gzip level 9 and Brotli quality 11.
- Output accounting includes all `.html`, `.css`, `.js`, and `.mjs` files under the generated output directory. Ordinary-page and per-request budgets should also inspect representative individual files.
- Each sample checks its expected page count and cheap semantic oracles for edited content, routes, links/backlinks, additions, deletions, renames, and stale output. When `auto` selects an incremental engine, canonical validation restores the pristine source, applies the scenario mutation, and performs exactly one untimed clean baseline build. Its complete output hash must match the measured incremental output; no pre-mutation baseline output tree is needed.

The report records Node/V8 versions, OS and architecture, CPU model and logical count, physical memory, Inkpath version, Git commit/branch/dirty paths, a SHA-256 identity for the complete imported `dist/` artifact, fixture profile and graph density, the source manifest identity, and a mutation-workload identity. The runner aborts if `dist/` changes during a run. Keep the machine otherwise idle and compare results from the same hardware and power settings. These benchmarks intentionally stay outside ordinary unit tests because wall time and peak memory vary by machine.

## Output

With no output option, the runner writes Markdown to standard output and progress to standard error. Use `--json <path>` and/or `--markdown <path>` for files; `-` means standard output. JSON is the source of truth for automation and includes:

- raw worker samples and discarded warmup timings;
- median and nearest-rank p95 operation, worker-wall, build, phase, and memory metrics;
- a complete output-tree identity for every writing sample, plus raw/gzip/Brotli byte totals and file counts by output type once per fixture;
- hardware, runtime, Git, runner, and fixture metadata.

Do not write both formats to `-` in one invocation because their streams would be ambiguous.

## Incremental-engine protocol

`--engine baseline` always calls `buildSite(project, { write, profile: true })`. The default `--engine auto` first looks for either of these exports in `dist/index.js`:

```ts
createBuildEngine(projectDirectory);
createIncrementalBuildEngine(projectDirectory);
```

The engine contract is explicit and versioned by the worker protocol:

```ts
type BuildEngine = {
  build(options: { write: boolean; profile: true }): Promise<BuildResult>;
  rebuild(
    changedPaths: readonly string[],
    options: { write: boolean; profile: true },
  ): Promise<BuildResult>;
  check?(options: { write: false; profile: true }): Promise<BuildResult>;
  close?(): Promise<void> | void;
};
```

The worker passes exact project-relative changed paths returned by the scenario mutation. Engines returned by either factory must implement the two-argument `rebuild(changedPaths, options)` method; arity inspection and the previous one-argument legacy form are intentionally unsupported because default parameters make `Function.length` ambiguous.
