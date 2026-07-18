# Releasing Inkpath

Inkpath publishes `@iamrajjoshi/inkpath` when a matching `v*` tag reaches GitHub.

## One-time setup

Create a granular npm token with read and write access to `@iamrajjoshi/inkpath`. Enable **Bypass 2FA** so the GitHub workflow can publish without an interactive prompt. Add the token to the repository without pasting it into a shell command:

```bash
gh secret set NPM_TOKEN --repo iamrajjoshi/inkpath
```

The command reads the token from a hidden prompt. The first npm release must use a token because the package doesn't exist in the registry yet. After that release, npm trusted publishing can replace the stored token.

## Release a version

Update the version in `package.json`, then run:

```bash
pnpm verify
pnpm package:check
```

Commit and push the version change. Create a tag with the same version and push it:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow checks the tag, installs the packed package in a temporary project, and publishes it to npm. It downloads the registry archive, records its SHA-256 checksum, and attaches both files to a GitHub release. Rerunning the workflow won't try to republish an existing version.
