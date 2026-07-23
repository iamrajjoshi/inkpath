# Static-site generator comparison

This harness projects one deterministic Markdown corpus into native projects for
Inkpath 0.3.0, Hugo 0.164.0, MkDocs 1.6.1, Docusaurus 3.10.2, and Quartz 5.0.0.
It reports production build time, persistent development rebuild time,
process-tree resident memory, semantic validation, and production output bytes.
See [the measured comparison](../results/comparison.md) for the reference-host
results and their interpretation limits.

The runner never installs software or invokes a package manager. Prepare the
five tools first, then pass their exact executable paths. Every installation is
checked against [versions.lock.json](versions.lock.json) before a timed process
starts.

## Reference environment

The checked lock was prepared for macOS arm64 with the universal macOS Hugo
package, Node.js 26.5.0, npm 11.17.0, pnpm 10.25.0, and Python 3.12. Use the same
runtime versions when reproducing it. Hugo's binary digest makes this lock
platform-specific; another platform needs a deliberately regenerated lock and
must not be compared as the same run.

Run setup from the Inkpath repository root:

```sh
export INKPATH_REPOSITORY="$PWD"
export INKPATH_COMPARISON_TOOLS="$INKPATH_REPOSITORY/.inkpath-benchmark/comparison-tools"
mkdir -p "$INKPATH_COMPARISON_TOOLS"

node --version
npm --version
corepack enable
corepack prepare pnpm@10.25.0 --activate
pnpm --version
```

The commands below reconstruct the locked installations from their official
release artifacts and package metadata. They are not a claim that this was the
historical shell transcript used to create the lock. Each checksum command must
succeed; do not continue after a mismatch.

### Inkpath 0.3.0 workspace

```sh
cd "$INKPATH_REPOSITORY"
pnpm install --frozen-lockfile
pnpm build

export INKPATH_COMPARISON_INKPATH_EXECUTABLE="$INKPATH_REPOSITORY/dist/cli.js"
node "$INKPATH_COMPARISON_INKPATH_EXECUTABLE" --version
```

The runner records the complete `dist/` tree identity and the workspace Git
identity, then verifies that `dist/` did not change during the run. Use a clean
checkout when publishing results.

### Hugo 0.164.0

The provenance lock selects Hugo's signed Darwin universal package, not a
Homebrew build or another release archive.

```sh
export HUGO_PACKAGE="$INKPATH_COMPARISON_TOOLS/hugo_0.164.0_darwin-universal.pkg"

curl --fail --location \
  https://github.com/gohugoio/hugo/releases/download/v0.164.0/hugo_0.164.0_darwin-universal.pkg \
  --output "$HUGO_PACKAGE"
test "$(shasum -a 256 "$HUGO_PACKAGE" | awk '{print $1}')" = \
  "c994e2cc6946838bb76521039509a7ce71282827e7035e344b6c225a83a5d0d3"

sudo installer -pkg "$HUGO_PACKAGE" -target /
export INKPATH_COMPARISON_HUGO_EXECUTABLE="$(command -v hugo)"
test "$(shasum -a 256 "$INKPATH_COMPARISON_HUGO_EXECUTABLE" | awk '{print $1}')" = \
  "360e2bb3b2fa34785f693e590558d449e6b7626fb7105c75bc1ef8a89f099fb9"
"$INKPATH_COMPARISON_HUGO_EXECUTABLE" version
```

### MkDocs 1.6.1

MkDocs provenance is the complete Python distribution inventory, not only the
top-level version. The final virtual environment must contain exactly the
versions below. Removing the bootstrap packaging tools after installation keeps
the inventory identical to the lock.

```sh
export MKDOCS_ROOT="$INKPATH_COMPARISON_TOOLS/mkdocs-1.6.1"
python3.12 -m venv "$MKDOCS_ROOT"

"$MKDOCS_ROOT/bin/python" -m pip install --no-deps \
  click==8.4.2 \
  ghp-import==2.1.0 \
  jinja2==3.1.6 \
  markdown==3.10.2 \
  markupsafe==3.0.3 \
  mergedeep==1.3.4 \
  mkdocs==1.6.1 \
  mkdocs-get-deps==0.2.2 \
  packaging==26.2 \
  pathspec==1.1.1 \
  platformdirs==4.10.1 \
  python-dateutil==2.9.0.post0 \
  pyyaml==6.0.3 \
  pyyaml-env-tag==1.1 \
  six==1.17.0 \
  watchdog==6.0.0
"$MKDOCS_ROOT/bin/python" -m pip uninstall --yes pip setuptools wheel

export INKPATH_COMPARISON_MKDOCS_EXECUTABLE="$MKDOCS_ROOT/bin/mkdocs"
"$INKPATH_COMPARISON_MKDOCS_EXECUTABLE" --version
```

The provenance check rejects missing, additional, or differently versioned
distributions. It also records the Python implementation, Python version, and
interpreter digest in the report.

### Docusaurus 3.10.2

Create one dependency root with this exact package manifest. Docusaurus samples
symlink its `node_modules`; project-local build caches remain isolated between
sample projects.

```sh
export DOCUSAURUS_ROOT="$INKPATH_COMPARISON_TOOLS/docusaurus-3.10.2"
mkdir -p "$DOCUSAURUS_ROOT"
cd "$DOCUSAURUS_ROOT"

node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";

const packageJson = {
  name: "inkpath-competitive-docusaurus",
  private: true,
  version: "1.0.0",
  dependencies: {
    "@docusaurus/core": "3.10.2",
    "@docusaurus/preset-classic": "3.10.2",
    react: "19.2.7",
    "react-dom": "19.2.7",
  },
};
writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
NODE

npm install
test "$(shasum -a 256 package-lock.json | awk '{print $1}')" = \
  "6473e35564d486dadcdb2cb17ae588d60033b1d08c88b5a55bf4df8396faa402"

export INKPATH_COMPARISON_DOCUSAURUS_ROOT="$DOCUSAURUS_ROOT"
export INKPATH_COMPARISON_DOCUSAURUS_EXECUTABLE="$DOCUSAURUS_ROOT/node_modules/@docusaurus/core/bin/docusaurus.mjs"
node "$INKPATH_COMPARISON_DOCUSAURUS_EXECUTABLE" --version
```

The runner checks the package-lock digest, the `@docusaurus/core` manifest
digest, and the exact versions of both Docusaurus packages, React, and ReactDOM.

### Quartz 5.0.0

Quartz is pinned to the official `v5.0.0` source commit. Its build imports
plugins from Git checkouts below `.quartz/plugins`, so installing only the root
Node dependencies is insufficient.

```sh
export QUARTZ_ROOT="$INKPATH_COMPARISON_TOOLS/quartz-5.0.0"
git clone https://github.com/jackyzha0/quartz.git "$QUARTZ_ROOT"
git -C "$QUARTZ_ROOT" checkout --detach ab346fa66a895e12d63a308e70ce330ba795822a
test "$(git -C "$QUARTZ_ROOT" rev-parse HEAD)" = \
  "ab346fa66a895e12d63a308e70ce330ba795822a"

cd "$QUARTZ_ROOT"
npm install
npm run install-plugins
test "$(shasum -a 256 package-lock.json | awk '{print $1}')" = \
  "b0486eb49bfbd1769189da57165a3acb4cc59f75a0cb72f4eb50d026568f8b85"
test "$(shasum -a 256 quartz.lock.json | awk '{print $1}')" = \
  "967f243601c16a8ea7a880bd84cd200e8f99ae4fa4001027f6d24ef05b63f880"

for plugin in \
  note-properties \
  syntax-highlighting \
  github-flavored-markdown \
  crawl-links \
  description \
  remove-draft \
  content-page \
  folder-page \
  footer \
  og-image
do
  test -d "$QUARTZ_ROOT/.quartz/plugins/$plugin"
done

export INKPATH_COMPARISON_QUARTZ_ROOT="$QUARTZ_ROOT"
export INKPATH_COMPARISON_QUARTZ_EXECUTABLE="$QUARTZ_ROOT/quartz/bootstrap-cli.mjs"
node "$INKPATH_COMPARISON_QUARTZ_EXECUTABLE" --version
```

The runner requires a clean root checkout and checks its commit, root package lock, Quartz plugin lock, and the
commit and package-lock digest of every enabled benchmark plugin listed in
`versions.lock.json`. The `og-image` checkout is also required because Quartz
core imports it while loading the benchmark configuration.

## Run production comparisons

Return to the Inkpath repository. The package script builds Inkpath, compiles
the harness, and invokes the plain-JavaScript comparison runner.

```sh
cd "$INKPATH_REPOSITORY"
pnpm benchmark:compare -- \
  --tools inkpath,hugo,mkdocs,docusaurus,quartz \
  --pages 1000 \
  --scenarios clean-production,repeat-production,body-edit-production \
  --warmups 1 \
  --samples 5 \
  --json comparison-production.json \
  --markdown comparison-production.md
```

Use 100 pages and one sample for a setup check:

```sh
pnpm benchmark:compare -- \
  --tools inkpath,hugo,mkdocs,docusaurus,quartz \
  --pages 100 \
  --scenarios clean-production \
  --warmups 0 \
  --samples 1
```

Each measured production sample uses a fresh projected project and a fresh CLI
process. The runner removes and recreates that project at the same absolute path
for every iteration so a bundler cannot turn the sample number into an output
difference. A clean build starts without output or a project-local cache. Repeat
and body-edit scenarios first run an untimed production build, preserve its
output and project-local cache, then time another fresh one-shot process. They
are warm one-shot builds, not persistent development-server rebuilds.

The timed interval contains the complete generator process. Project creation,
the untimed setup build, mutation, semantic validation, output hashing,
compression, and cleanup are excluded. Peak RSS is the highest sampled sum of
the process and its descendants. Output totals compress each emitted file
independently with gzip level 9 and Brotli quality 11. Every tree is hashed and
counted independently; compression totals are reused only when the canonical
tree hash plus raw per-category identities match exactly.

At 1,000 pages, the built-in MkDocs and Docusaurus configurations already emit
roughly 120 MiB of HTML because full navigation is repeated across pages. Do not
blindly extend the five-tool command to 10,000 pages. The reference report runs
selected 10,000-page Inkpath, Hugo, and Quartz clean-build observations
separately and states the omitted tools rather than treating the subset as a
complete ranking.

## Run persistent development comparisons

```sh
cd "$INKPATH_REPOSITORY"
pnpm benchmark:compare:dev -- \
  --tools inkpath,hugo,mkdocs,docusaurus,quartz \
  --pages 1000 \
  --warmups 2 \
  --samples 10 \
  --json comparison-development.json \
  --markdown comparison-development.md
```

One fresh native development server runs per tool and corpus size. The clock
starts immediately before an equal-length positioned overwrite of the body-edit
source and stops at the tool's native rebuild-complete log after the file has
been flushed, fsynced, and closed. It therefore includes the write, watcher
delivery or polling, debounce, scheduling, and rebuild. It excludes server
startup, shutdown, semantic checks, browser notification, browser reload, and
rendering.

Hugo's edited route is requested before each mutation so Fast Render includes
it. MkDocs uses its default full clean rebuild, not `--dirtyreload`. HTTP checks
verify the final edited marker and an unchanged route for Inkpath, Hugo, MkDocs,
and Quartz. Docusaurus serves a client-rendered development shell, so its HTTP
check is status-only and an untimed production build validates its route output
after shutdown. Browser visibility and HMR behavior are not measured for any
tool.

Run `pnpm benchmark:compare -- --help` or
`pnpm benchmark:compare:dev -- --help` for executable flags, root flags,
timeouts, RSS sampling, output destinations, and environment-variable names.

## Corpus and semantic checks

Every scale has an exact page count and the same abstract content graph:

- five home or nested section landing pages;
- ordinary prose, `Overview` and `Details` headings, and a stable `#details`
  anchor on every page;
- four deterministic relative Markdown links per page;
- a TypeScript code block on every tenth leaf note;
- a local text asset on every thirteenth leaf note;
- one equal-length, deterministic body mutation used by production and
  development edit scenarios.

The projector applies only the source names, frontmatter, routes, and minimal
configuration each tool needs. After every production sample, semantic checks
verify every expected output route, unique body markers, anchors, four resolved
links, code blocks, copied assets, and the correct mutation marker. Corpus and
project-manifest SHA-256 identities are included in both report formats.

## Interpretation limits

The corpus exercises a common Markdown subset, but the products do not emit an
identical feature set or theme:

- Inkpath uses its normal knowledge-base output, including validation and
  discovery files.
- Hugo uses deliberately small native templates and disables unrelated output
  kinds.
- MkDocs uses its built-in theme with plugins disabled.
- Docusaurus uses the classic docs preset and its React client runtime.
- Quartz disables SPA navigation, popovers, analytics, and remote fonts, then
  enables the pinned content, folder, Markdown, link, syntax, description,
  draft, property, and footer plugins required by the fixture.

Syntax highlighters, generated navigation, backlink behavior, asset pipelines,
and client JavaScript therefore differ. Output categories use file extensions;
inline scripts stay in the HTML category and external scripts are absent from
on-disk totals. Treat timings, memory, semantic counts, and output bytes
together. The report is evidence for this defined corpus and configuration,
not a universal fastest-generator ranking.

## Provenance lock

[versions.lock.json](versions.lock.json) is part of the benchmark result. The
runner records its SHA-256 and refuses installations that do not match:

- Inkpath: version, complete built artifact identity, and workspace Git state;
- Hugo: version and executable digest;
- MkDocs: version and the exact Python distribution inventory;
- Docusaurus: root package lock, core package manifest, and required package
  versions;
- Quartz: source commit, root package lock, plugin lock, and enabled plugin Git
  commits and package locks.

The Inkpath artifact is rechecked after all samples, and the runner requests
offline package-manager behavior inside timed processes. Never edit the lock to
bypass a mismatch. A legitimate tool or dependency update requires a reviewed
lock change, fresh provenance, and a new report clearly identified as a
different comparison.
