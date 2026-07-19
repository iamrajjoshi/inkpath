import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflowRoot = path.resolve(import.meta.dirname, "..", ".github", "workflows");
const supportedActions = new Map([
  ["actions/checkout", { sha: "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0", version: "v7.0.0" }],
  [
    "actions/configure-pages",
    { sha: "45bfe0192ca1faeb007ade9deae92b16b8254a0d", version: "v6.0.0" },
  ],
  ["actions/deploy-pages", { sha: "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128", version: "v5.0.0" }],
  [
    "actions/download-artifact",
    { sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", version: "v8.0.1" },
  ],
  ["actions/setup-node", { sha: "820762786026740c76f36085b0efc47a31fe5020", version: "v7.0.0" }],
  [
    "actions/upload-artifact",
    { sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", version: "v7.0.1" },
  ],
  [
    "actions/upload-pages-artifact",
    { sha: "fc324d3547104276b827a68afc52ff2a11cc49c9", version: "v5.0.0" },
  ],
  ["pnpm/action-setup", { sha: "0ebf47130e4866e96fce0953f49152a61190b271", version: "v6.0.9" }],
]);

interface WorkflowStep {
  env?: Record<string, unknown>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
}

interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

test("pins supported GitHub Actions to their current stable commits", async () => {
  const workflowNames = (await readdir(workflowRoot))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  assert.ok(workflowNames.length > 0);

  let actions = 0;
  const seenActions = new Set<string>();
  for (const workflowName of workflowNames) {
    const source = await readFile(path.join(workflowRoot, workflowName), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S.*))?$/);
      if (!match) continue;
      const action = match[1] ?? "";
      if (action.startsWith("./") || action.startsWith("docker://")) continue;
      actions += 1;
      assert.match(
        action,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${workflowName}:${index + 1} must pin the action to a full commit SHA`,
      );
      assert.match(
        match[2] ?? "",
        /^v\d+(?:\.\d+(?:\.\d+)?)?$/,
        `${workflowName}:${index + 1} must retain the action version as a comment`,
      );
      const separator = action.lastIndexOf("@");
      const repository = action.slice(0, separator);
      const sha = action.slice(separator + 1);
      const supported = supportedActions.get(repository);
      assert.ok(
        supported,
        `${workflowName}:${index + 1} must add ${repository} to the supported action manifest`,
      );
      assert.equal(
        sha,
        supported.sha,
        `${workflowName}:${index + 1} must use ${repository}@${supported.version}`,
      );
      assert.equal(
        match[2],
        supported.version,
        `${workflowName}:${index + 1} must identify the pinned ${repository} release`,
      );
      seenActions.add(repository);
    }
  }
  assert.ok(actions > 0);
  assert.deepEqual([...seenActions].sort(), [...supportedActions.keys()].sort());
});

test("isolates release verification, npm publishing, and GitHub release permissions", async () => {
  const source = await readFile(path.join(workflowRoot, "release.yml"), "utf8");
  const workflow = parse(source) as Workflow;
  const verify = workflow.jobs.verify;
  const publish = workflow.jobs.publish;
  const githubRelease = workflow.jobs["github-release"];

  assert.ok(verify);
  assert.ok(publish);
  assert.ok(githubRelease);
  assert.match(source, /workflow_dispatch:[\s\S]*tag:[\s\S]*required: true/);
  assert.match(source, /RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(source, /ref: \$\{\{ env\.RELEASE_TAG \}\}/);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(verify.permissions, { contents: "read" });
  assert.deepEqual(publish.permissions, { "id-token": "write" });
  assert.deepEqual(githubRelease.permissions, { contents: "write" });
  assert.equal(publish.needs, "verify");
  assert.equal(githubRelease.needs, "publish");

  const verifyScript = verify.steps.map((step) => step.run ?? "").join("\n");
  const publishScript = publish.steps.map((step) => step.run ?? "").join("\n");
  const githubReleaseScript = githubRelease.steps.map((step) => step.run ?? "").join("\n");
  const privilegedActions = [...publish.steps, ...githubRelease.steps]
    .map((step) => step.uses ?? "")
    .join("\n");

  assert.match(verifyScript, /pnpm install --frozen-lockfile/);
  assert.match(verifyScript, /pnpm verify/);
  assert.match(verifyScript, /npm pack --pack-destination release/);
  assert.match(verifyScript, /pnpm package:check "release\/inkpath-\$\{package_version\}\.tgz"/);
  assert.match(verifyScript, /shasum -a 256/);
  assert.ok(
    verifyScript.indexOf("npm pack --pack-destination release") <
      verifyScript.indexOf("pnpm package:check"),
    "the workflow must test the prepared archive rather than create another archive afterward",
  );

  assert.doesNotMatch(privilegedActions, /actions\/checkout@|pnpm\/action-setup@/);
  assert.doesNotMatch(publishScript, /\bpnpm\b/);
  assert.doesNotMatch(publishScript, /npm (?:ci|exec|install|pack|run|test)\b/);
  assert.match(publishScript, /awk '\{ print \$2 \}' release\/checksums\.txt/);
  assert.match(publishScript, /shasum -a 256 -c checksums\.txt/);
  assert.match(publishScript, /archive="\.\/release\/inkpath-\$\{version\}\.tgz"/);
  assert.match(publishScript, /npm publish --ignore-scripts --provenance "\$\{archive\}"/);
  assert.match(publishScript, /test "\$\{actual_sha\}" = "\$\{expected_sha\}"/);
  assert.ok(
    publishScript.indexOf("shasum -a 256 -c checksums.txt") < publishScript.indexOf("npm publish"),
    "the publish job must verify the prepared archive before publication",
  );

  assert.doesNotMatch(githubReleaseScript, /\b(?:npm|pnpm)\b/);
  assert.match(githubReleaseScript, /awk '\{ print \$2 \}' release\/checksums\.txt/);
  assert.match(githubReleaseScript, /shasum -a 256 -c checksums\.txt/);
  assert.match(githubReleaseScript, /gh release (?:create|upload)/);
  assert.ok(
    githubReleaseScript.indexOf("shasum -a 256 -c checksums.txt") <
      githubReleaseScript.indexOf("gh release"),
    "the GitHub release job must verify the prepared archive before upload",
  );

  const createRelease = githubRelease.steps.find(
    (step) => step.name === "Create the GitHub release",
  );
  assert.equal(createRelease?.env?.GH_REPO, "${{ github.repository }}");

  const upload = verify.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const publishDownload = publish.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  const releaseDownload = githubRelease.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );

  assert.ok(upload?.with);
  assert.ok(publishDownload?.with);
  assert.ok(releaseDownload?.with);
  assert.equal(upload.with.name, publishDownload.with.name);
  assert.equal(upload.with.name, releaseDownload.with.name);
  assert.equal(upload.with.archive, true);
  assert.match(String(upload.with.path), /release\/\*\.tgz/);
  assert.match(String(upload.with.path), /release\/checksums\.txt/);
  assert.equal(publishDownload.with.path, "release");
  assert.equal(releaseDownload.with.path, "release");
  assert.equal(publishDownload.with["digest-mismatch"], "error");
  assert.equal(releaseDownload.with["digest-mismatch"], "error");
  assert.equal(publishDownload.with["github-token"], undefined);
  assert.equal(releaseDownload.with["github-token"], undefined);
});
