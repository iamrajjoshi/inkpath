import { readFileSync } from "node:fs";

type PackageMetadata = {
  version?: unknown;
};

const metadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

if (typeof metadata.version !== "string" || !metadata.version) {
  throw new Error("package.json needs a version");
}

export const INKPATH_VERSION = metadata.version;
