import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoPendingBuildActivity,
  parseDevelopmentArguments,
  waitForCompletionAfterClose,
  writeInPlaceAndClose,
} from "../benchmarks/comparison/dev-run.js";
import {
  completionDetector,
  LogTimeline,
  readyDetector,
  stripAnsi,
  type LogEvent,
} from "../benchmarks/comparison/dev-supervisor.js";
import type { ComparisonTool } from "../benchmarks/comparison/corpus.js";

function event(text: string, sequence = 1): LogEvent {
  return { atMs: sequence, sequence, stream: "stdout", text };
}

test("development ready detectors match native logs after ANSI removal", () => {
  const messages: Record<ComparisonTool, string> = {
    docusaurus: "Client: Compiled successfully in 1.23s",
    hugo: "Web Server is available at http://localhost:1313/",
    inkpath: "Inkpath is serving http://127.0.0.1:4321/",
    mkdocs: "INFO - Serving on http://127.0.0.1:8000/",
    quartz: "Started a Quartz server listening at http://localhost:8080",
  };
  for (const [tool, message] of Object.entries(messages) as [ComparisonTool, string][]) {
    assert.equal(readyDetector(tool)(event(message)), true, tool);
  }
  assert.equal(stripAnsi("\u001B[32mDone rebuilding in 15ms\u001B[0m"), "Done rebuilding in 15ms");
});

test("development completion detectors use each generator's native boundary", () => {
  const messages: Partial<Record<ComparisonTool, string>> = {
    docusaurus: "Client: Compiled successfully in 712ms",
    hugo: "Total in 14 ms",
    inkpath: "Rebuilt 100 pages in 8ms",
    quartz: "Done rebuilding in 31ms",
  };
  for (const [tool, message] of Object.entries(messages) as [ComparisonTool, string][]) {
    assert.equal(completionDetector(tool)(event(message)), true, tool);
  }

  const mkdocs = completionDetector("mkdocs");
  assert.equal(mkdocs(event("Reloading browsers...", 1)), false);
  assert.equal(mkdocs(event("Documentation built in 0.12 seconds", 2)), false);
  assert.equal(mkdocs(event("Reloading browsers...", 3)), true);
});

test("log timeline handles chunk boundaries, checkpoints, and carriage returns", async () => {
  const timeline = new LogTimeline();
  timeline.feed("stdout", "Client: Compiled successfully in initial build\n", 1);
  const checkpoint = timeline.cursor();
  const completion = timeline.waitFor(checkpoint, completionDetector("docusaurus"), 1_000);
  timeline.feed("stderr", "progress\rClient: Com", 2);
  timeline.feed("stderr", "piled successfully in rebuild\r", 3);
  const matched = await completion;
  assert.equal(matched.sequence, checkpoint + 2);
  assert.equal(matched.atMs, 3);
  assert.equal(matched.text, "Client: Compiled successfully in rebuild");
});

test("development CLI parses pinned roots and benchmark controls", () => {
  const parsed = parseDevelopmentArguments([
    "--tools",
    "inkpath,docusaurus,quartz",
    "--pages",
    "100,1000",
    "--samples",
    "9",
    "--warmups",
    "0",
    "--rss-sample-interval",
    "25",
    "--timeout",
    "120000",
    "--http-timeout",
    "10000",
    "--inkpath-executable",
    "/tmp/inkpath",
    "--docusaurus-executable",
    "/tmp/docusaurus",
    "--docusaurus-root",
    "/tmp/docusaurus-root",
    "--quartz-executable",
    "/tmp/quartz",
    "--quartz-root",
    "/tmp/quartz-root",
    "--json",
    "result.json",
    "--quiet",
  ]);
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.deepEqual(parsed.tools, ["inkpath", "docusaurus", "quartz"]);
  assert.deepEqual(parsed.pages, [100, 1000]);
  assert.equal(parsed.samples, 9);
  assert.equal(parsed.warmups, 0);
  assert.equal(parsed.rssSampleIntervalMs, 25);
  assert.equal(parsed.timeoutMs, 120_000);
  assert.equal(parsed.httpTimeoutMs, 10_000);
  assert.equal(parsed.quiet, true);
  assert.equal(parsed.toolConfigurations.docusaurus.toolRoot, "/tmp/docusaurus-root");
  assert.equal(parsed.toolConfigurations.quartz.toolRoot, "/tmp/quartz-root");
});

test("development CLI rejects ambiguous output and incomplete tool roots", () => {
  assert.throws(
    () =>
      parseDevelopmentArguments([
        "--tools",
        "inkpath",
        "--inkpath-executable",
        "/tmp/inkpath",
        "--json",
        "-",
        "--markdown",
        "-",
      ]),
    /cannot both be written to stdout/,
  );
  assert.throws(
    () =>
      parseDevelopmentArguments([
        "--tools",
        "docusaurus",
        "--docusaurus-executable",
        "/tmp/docusaurus",
      ]),
    /docusaurus needs --docusaurus-root/,
  );
  assert.throws(
    () =>
      parseDevelopmentArguments([
        "--tools",
        "inkpath",
        "--pages",
        "19",
        "--inkpath-executable",
        "/tmp/inkpath",
      ]),
    /at least 20 pages/,
  );
});

test("development mutation uses an equal-length positioned write on the existing inode", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-dev-mutation-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const file = path.join(root, "note.md");
  await writeFile(file, "variant-A\n", "utf8");
  const before = await stat(file);
  const edit = await writeInPlaceAndClose(file, "variant-B\n");
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(file, "utf8"), "variant-B\n");
  assert.ok(Number.isFinite(edit.editStartedAt));
  assert.ok(edit.closedAt >= edit.editStartedAt);
  await assert.rejects(writeInPlaceAndClose(file, "short\n"), /must have equal byte lengths/);
  assert.equal(await readFile(file, "utf8"), "variant-B\n");
});

test("completion timing rejects pre-close and stale build events", async () => {
  const early = new LogTimeline();
  early.feed("stdout", "Rebuilt 20 pages in 1ms\n", 12);
  await assert.rejects(
    waitForCompletionAfterClose(early, "inkpath", 0, { closedAt: 15, editStartedAt: 10 }, 100),
    /before the edited source was closed/,
  );

  const stale = new LogTimeline();
  stale.feed("stdout", "Change detected, rebuilding site (#1).\n", 5);
  stale.feed("stdout", "Total in 14 ms\n", 20);
  await assert.rejects(
    waitForCompletionAfterClose(stale, "hugo", 0, { closedAt: 15, editStartedAt: 10 }, 100),
    /no rebuild start after the measured edit/,
  );

  const valid = new LogTimeline();
  valid.feed("stdout", "Change detected, rebuilding site (#1).\n", 12);
  valid.feed("stdout", "Total in 14 ms\n", 20);
  const completion = await waitForCompletionAfterClose(
    valid,
    "hugo",
    0,
    { closedAt: 15, editStartedAt: 10 },
    100,
  );
  assert.equal(completion.atMs, 20);
});

test("development sessions reject unprompted build activity between edits", () => {
  const timeline = new LogTimeline();
  timeline.feed("stdout", "Done rebuilding in 20ms\n", 20);
  assert.throws(
    () => assertNoPendingBuildActivity(timeline, "quartz", 0),
    /build activity before the next edit/,
  );
});
