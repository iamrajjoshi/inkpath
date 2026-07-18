import path from "node:path";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section"
  );
}

export function stripOrderPrefix(value: string): string {
  return value.replace(/^\d+[-_.\s]+/, "");
}

export function titleFromSlug(value: string): string {
  return stripOrderPrefix(value)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function orderFromName(value: string): number {
  const match = value.match(/^(\d+)[-_.\s]+/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function normalizeRoute(route: string): string {
  const normalized = `/${route}`.replace(/\/{2,}/g, "/");
  return normalized === "/" ? normalized : `${normalized.replace(/\/$/, "")}/`;
}

export function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === "/") return "";
  return `/${basePath}`.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

export function siteUrl(basePath: string, route: string): string {
  const normalizedRoute = normalizeRoute(route);
  return `${basePath}${normalizedRoute}` || "/";
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function isExternalUrl(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
}

export function firstSentence(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  const match = clean.match(/^(.+?[.!?])(?:\s|$)/);
  return match?.[1] ?? clean;
}

export function isPathWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

export function assertInsideProject(projectRoot: string, target: string, label: string): void {
  const relative = path.relative(projectRoot, target);
  if (!relative || !isPathWithin(projectRoot, target)) {
    throw new Error(`${label} must be a directory inside the project root`);
  }
}

export function formatDate(value: unknown): string | undefined {
  if (!(typeof value === "string" || value instanceof Date)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return undefined;
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}
