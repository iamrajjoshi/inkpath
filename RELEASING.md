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

## Release a version

Update the version in `package.json`, then run:

```bash
pnpm verify
pnpm package:check
```

Commit and push the version change. Create a tag with the same version and push it:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The `v0.1.0` tag already belongs to the original scoped-package release. The first tag-driven release for `inkpath` should therefore use `0.1.1` or newer.

The release workflow checks the tag, installs the packed package in a temporary project, and publishes it to npm. It downloads the registry archive, records its SHA-256 checksum, and attaches both files to a GitHub release. Rerunning the workflow won't try to republish an existing version.
