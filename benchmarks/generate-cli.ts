import path from "node:path";
import { generateBenchmarkSite, type BenchmarkProfile } from "./generate.js";

type Options = {
  linkFanout?: number;
  output: string;
  pages: number;
  profile: BenchmarkProfile;
};

const help = `Generate a deterministic Inkpath benchmark site

Usage:
  pnpm benchmark:generate -- --pages 1000 [options]

Options:
  --pages <count>      Exact published page count (required; minimum 20)
  --output <path>      Empty destination directory (default: .inkpath-benchmark/site-<count>)
  --profile <name>     core or rich (default: core)
  --link-fanout <n>    Internal links per linkable note (default: 4)
  --help               Show this help
`;

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} needs a value`);
  return value;
}

function integer(value: string, option: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${option} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function parseArguments(args: string[]): Options | "help" {
  if (args.includes("--help")) return "help";
  let linkFanout: number | undefined;
  let output: string | undefined;
  let pages: number | undefined;
  let profile: BenchmarkProfile = "core";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--" && index === 0) {
      continue;
    } else if (argument === "--pages") {
      pages = integer(valueAfter(args, index, argument), argument, 20);
      index += 1;
    } else if (argument === "--output") {
      output = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--profile") {
      const value = valueAfter(args, index, argument);
      if (value !== "core" && value !== "rich") {
        throw new Error("--profile must be core or rich");
      }
      profile = value;
      index += 1;
    } else if (argument === "--link-fanout") {
      linkFanout = integer(valueAfter(args, index, argument), argument, 0);
      index += 1;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }

  if (pages === undefined) throw new Error("--pages is required");
  return {
    ...(linkFanout === undefined ? {} : { linkFanout }),
    output: path.resolve(output ?? `.inkpath-benchmark/site-${pages}`),
    pages,
    profile,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write(help);
    return;
  }
  const fixture = await generateBenchmarkSite(options.output, {
    pages: options.pages,
    profile: options.profile,
    ...(options.linkFanout === undefined ? {} : { linkFanout: options.linkFanout }),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        linkFanout: fixture.linkFanout,
        manifestSha256: fixture.manifestSha256,
        mutationTargetsSha256: fixture.mutationTargetsSha256,
        pages: fixture.pages,
        profile: fixture.profile,
        root: fixture.root,
        suiteSha256: fixture.suiteSha256,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
