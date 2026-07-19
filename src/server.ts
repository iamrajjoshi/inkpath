import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { watch } from "chokidar";
import { buildSite } from "./build.js";
import { isPathWithin } from "./utils.js";

type DevOptions = {
  host: string;
  port: number;
};

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
]);

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

export function safeRequestPath(outputDir: string, requestPath: string): string | undefined {
  const segments = requestPath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment.startsWith("."))) return undefined;
  const relative = requestPath.endsWith("/") ? `${requestPath}index.html` : requestPath;
  const target = path.resolve(outputDir, `.${relative}`);
  if (!isPathWithin(outputDir, target)) return undefined;
  return target;
}

export async function safeExistingFilePath(
  outputDir: string,
  requestPath: string,
): Promise<string | undefined> {
  const target = safeRequestPath(outputDir, requestPath);
  if (!target) return undefined;

  let canonicalRoot: string;
  try {
    const rootInfo = await lstat(outputDir);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return undefined;
    canonicalRoot = await realpath(outputDir);
  } catch {
    return undefined;
  }

  const relative = path.relative(outputDir, target);
  let cursor = outputDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }

  try {
    const canonicalTarget = await realpath(target);
    if (!isPathWithin(canonicalRoot, canonicalTarget)) return undefined;
    const info = await lstat(canonicalTarget);
    return info.isFile() ? canonicalTarget : undefined;
  } catch {
    return undefined;
  }
}

function reloadScript(endpoint: string): string {
  return `<script>new EventSource(${JSON.stringify(endpoint)}).addEventListener("reload",function(){location.reload()})</script>`;
}

export async function startDevServer(projectDirectory: string, options: DevOptions): Promise<void> {
  let result = await buildSite(projectDirectory);
  const clients = new Set<ServerResponse>();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://inkpath.local");
      let requestPath: string;
      try {
        requestPath = decodeURIComponent(url.pathname);
      } catch {
        send(response, 400, "Bad request");
        return;
      }
      if (requestPath.includes("\0") || requestPath.includes("\\")) {
        send(response, 400, "Bad request");
        return;
      }

      const basePath = result.site.config.site.basePath;
      const eventPath = `${basePath}/__inkpath/events`;

      if (requestPath === eventPath) {
        response.writeHead(200, {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        });
        response.write(": connected\n\n");
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }

      if (basePath) {
        if (requestPath === basePath) {
          response.writeHead(308, { Location: `${basePath}/` });
          response.end();
          return;
        }
        if (!requestPath.startsWith(`${basePath}/`)) {
          send(response, 404, "Not found");
          return;
        }
        requestPath = requestPath.slice(basePath.length) || "/";
      }

      if (!requestPath.endsWith("/") && !path.posix.extname(requestPath)) {
        response.writeHead(308, { Location: `${basePath}${requestPath}/` });
        response.end();
        return;
      }

      let filePath = await safeExistingFilePath(result.site.config.outputDir, requestPath);
      if (!filePath) {
        filePath = await safeExistingFilePath(result.site.config.outputDir, "/404.html");
        if (!filePath) {
          send(response, 404, "Not found");
          return;
        }
        response.statusCode = 404;
      }

      const extension = path.extname(filePath).toLowerCase();
      response.setHeader("Content-Type", mimeTypes.get(extension) ?? "application/octet-stream");
      const immutableAsset =
        requestPath.startsWith("/_inkpath/chunks/") ||
        /^\/_inkpath\/inkpath-[A-Z0-9]+\.js$/.test(requestPath);
      response.setHeader(
        "Cache-Control",
        immutableAsset ? "public, max-age=31536000, immutable" : "no-store",
      );
      if (extension === ".html") {
        const chunks: Buffer[] = [];
        const stream = createReadStream(filePath);
        for await (const chunk of stream)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const html = Buffer.concat(chunks)
          .toString("utf8")
          .replace("</body>", `${reloadScript(eventPath)}</body>`);
        response.end(html);
      } else {
        createReadStream(filePath).pipe(response);
      }
    } catch (error) {
      send(response, 500, error instanceof Error ? error.message : "Internal error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  console.log(
    `Inkpath is serving http://${options.host}:${options.port}${result.site.config.site.basePath || "/"}`,
  );

  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(
    [
      result.site.config.contentDir,
      result.site.config.publicDir,
      path.join(result.site.config.projectRoot, "inkpath.yaml"),
    ],
    { followSymlinks: false, ignoreInitial: true },
  );
  watcher.on("all", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        result = await buildSite(projectDirectory);
        for (const client of clients) client.write("event: reload\ndata: reload\n\n");
        console.log(`Rebuilt ${result.pages} pages in ${Math.round(result.elapsedMs)}ms`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }, 90);
  });

  await new Promise<void>((resolve) => {
    const close = async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
      for (const client of clients) client.end();
      server.close(() => resolve());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}
