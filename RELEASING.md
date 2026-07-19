# Releasing Inkpath

Inkpath publishes `inkpath` when a matching `v*` tag reaches GitHub.

## One-time bootstrap

npm requires a package to exist before it can use trusted publishing. Publish `0.1.0` once from a clean checkout after verifying the package:

```bash
pnpm verify
pnpm package:check
npm login
npm publish --access public
npm logout
```

Confirm that the package exists:

```bash
npm view inkpath@0.1.0 version
```

`pnpm package:check` installs the packed archive in a temporary project, builds a site with Mermaid and KaTeX, and verifies that the generated notices match the dependency versions resolved for that consumer build.

Then configure the GitHub Actions trusted publisher in the `inkpath` package settings on npm:

- Organization or user: `iamrajjoshi`
- Repository: `inkpath`
- Workflow filename: `release.yml`
- Environment: leave blank
- Allowed action: `npm publish`

The equivalent command with npm 11.15 or newer is:

```bash
npm trust github inkpath \
  --repo iamrajjoshi/inkpath \
  --file release.yml \
  --allow-publish
```

The release workflow uses short-lived OIDC credentials and does not need an `NPM_TOKEN` secret.

The workflow keeps each trust boundary small:

- `verify` has read-only repository access. It installs dependencies, runs every check, packs the npm archive, records its SHA-256 checksum, and uploads both as a short-lived workflow artifact.
- `publish` has only `id-token: write`. It does not check out the repository, install dependencies, or run package scripts. It verifies the uploaded checksum and publishes that exact archive with scripts disabled.
- `github-release` has only `contents: write`. It verifies the same archive again before attaching the archive and checksum to the release.

After publication, the workflow downloads the registry copy and requires its SHA-256 digest to match the prepared archive. A rerun therefore accepts an existing npm version only when it contains exactly the bytes produced by the read-only verification job.

Artifact downloads are scoped to the current repository and workflow run. They intentionally omit a GitHub token and cross-run identifiers, so neither privileged job needs `actions: read` or access to artifacts from another run. The transport remains explicitly archived because it contains both the package and checksum, and digest mismatches are configured to fail before Inkpath verifies its package-level checksum.

## Release a version

Update the version in `package.json`, then run:

```bash
pnpm verify
pnpm package:check
```

Commit and push the version change. Create a tag with the same version and push it:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow checks the tag, installs the packed package in a temporary project, and publishes that verified archive to npm. It confirms that the registry serves the same bytes, then attaches the archive and its SHA-256 checksum to a GitHub release. Rerunning the workflow won't try to republish an existing version, but it will still reject a registry archive that does not match the verified artifact.
