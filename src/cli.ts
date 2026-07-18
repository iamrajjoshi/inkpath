#!/usr/bin/env node
import { buildSite } from "./build.js";
import { startDevServer } from "./server.js";
import { INKPATH_VERSION } from "./version.js";

const help = `Inkpath ${INKPATH_VERSION}

Build small documentation and notes sites from Markdown.

Usage:
  inkpath build [project]
  inkpath check [project]
  inkpath dev [project] [--host 127.0.0.1] [--port 3000]
  inkpath --help
  inkpath --version

Project files:
  inkpath.yaml       Optional site configuration
  content/         Markdown source
  public/          Files copied to the site root
  site/            Generated output
`;

type Arguments = {
  command: "build" | "check" | "dev";
  host: string;
  port: number;
  project: string;
};

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function parseArguments(args: string[]): Arguments | "help" | "version" {
  if (!args.length || args.includes("--help") || args[0] === "help") return "help";
  if (args.includes("--version") || args[0] === "version") return "version";
  const command = args[0];
  if (command !== "build" && command !== "check" && command !== "dev") {
    throw new Error(`unknown command: ${command}`);
  }

  let host = "127.0.0.1";
  let port = 3000;
  let project = ".";
  let sawProject = false;
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--host") {
      if (command !== "dev") throw new Error("--host is only valid with inkpath dev");
      host = readValue(args, index, "--host");
      index += 1;
    } else if (value === "--port") {
      if (command !== "dev") throw new Error("--port is only valid with inkpath dev");
      const rawPort = readValue(args, index, "--port");
      port = Number(rawPort);
      if (!Number.isInteger(port) || port < 0 || port > 65_535)
        throw new Error("--port must be an integer from 0 to 65535");
      index += 1;
    } else if (value?.startsWith("--")) {
      throw new Error(`unknown option: ${value}`);
    } else if (value) {
      if (sawProject) throw new Error(`unexpected argument: ${value}`);
      project = value;
      sawProject = true;
    }
  }

  return { command, host, port, project };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed === "help") {
    console.log(help);
    return;
  }
  if (parsed === "version") {
    console.log(INKPATH_VERSION);
    return;
  }
  if (parsed.command === "dev") {
    if (parsed.host !== "127.0.0.1" && parsed.host !== "localhost" && parsed.host !== "::1") {
      console.warn(
        `Inkpath will be reachable from ${parsed.host}; use this only on a trusted network.`,
      );
    }
    await startDevServer(parsed.project, { host: parsed.host, port: parsed.port });
    return;
  }

  const result = await buildSite(parsed.project, { write: parsed.command === "build" });
  if (parsed.command === "check") {
    console.log(`Checked ${result.pages} pages (${result.diagrams} diagrams)`);
  } else {
    console.log(`Built ${result.pages} pages in ${Math.round(result.elapsedMs)}ms`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
