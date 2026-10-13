#!/usr/bin/env node
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DiskCache } from "../compare/cache.js";
import { ConfigError, loadCompareConfig } from "../compare/config.js";
import { STARTER_CONFIG } from "../compare/init.js";
import { runCompare } from "../compare/run.js";
import { FixtureLoadError, loadFixture } from "../fixtures/load.js";
import { createProvider, ProviderError, type ProviderFactory } from "../providers/index.js";
import { renderCompareHtml } from "../report/compare-html.js";
import { buildCompareJson } from "../report/compare-json.js";
import { renderCompareText } from "../report/compare-text.js";
import { redactCompareResult } from "../report/redact.js";
import { buildJsonReport } from "../report/json.js";
import { renderTextReport } from "../report/text.js";
import { runFixture, type CaseResult } from "../runner/run.js";

const USAGE = `switch — snapshot tests for AI model upgrades

Usage:
  switch init                     Write a starter switch.yaml in this directory.
  switch compare [switch.yaml]    Run every case on baseline and candidate and
                                         report consistent behavior changes.
  switch check <fixture.json>...  Advanced: offline check of saved responses.
  switch --help

compare options:
  --repeat <n>        Override samples per model per case.
  --json <file>       Also write the JSON report (use - for stdout).
  --html <file>       HTML report path (default: switch-report.html).
  --no-html           Do not write the HTML report.
  --no-cache          Ignore and do not write .switch-cache/.
  --concurrency <n>   Parallel model calls (default: 4).

check options:
  --json              Emit the machine-readable report instead of text.
  --allow-fail        Exit 0 even when a check fails (fixture load errors still exit 2).

Exit codes:
  0  no regression (compare) / no failing check (check)
  1  a regression, or a case with no usable samples (compare) / a failing check (check)
  2  usage error, invalid config, missing credentials, or a fixture could not be loaded
`;

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  progress?: (text: string) => void;
  providerFactory: ProviderFactory;
  now?: () => string;
}

const defaultIo = (): CliIo => ({
  cwd: process.cwd(),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  ...(process.stderr.isTTY ? { progress: (t: string) => process.stderr.write(t) } : {}),
  providerFactory: createProvider,
});

async function packageVersion(): Promise<string> {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(await readFile(fileURLToPath(url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function runCheck(rest: string[], io: CliIo): Promise<number> {
  const json = rest.includes("--json");
  const allowFail = rest.includes("--allow-fail");
  const paths = rest.filter((a) => !a.startsWith("--"));
  if (paths.length === 0) {
    io.stderr(`check requires at least one fixture path\n\n${USAGE}`);
    return 2;
  }

  const cases: CaseResult[] = [];
  for (const path of paths) {
    try {
      cases.push(runFixture(await loadFixture(resolve(io.cwd, path))));
    } catch (error) {
      if (error instanceof FixtureLoadError) {
        io.stderr(`${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }

  const report = buildJsonReport(cases, await packageVersion());
  io.stdout(json ? JSON.stringify(report, null, 2) + "\n" : renderTextReport(report) + "\n");

  if (report.totals.fail > 0 && !allowFail) return 1;
  return 0;
}

async function runInit(io: CliIo): Promise<number> {
  const path = resolve(io.cwd, "switch.yaml");
  try {
    await writeFile(path, STARTER_CONFIG, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      io.stderr("switch.yaml already exists; not overwriting it.\n");
      return 2;
    }
    throw error;
  }
  io.stdout("Wrote switch.yaml. Edit the cases, then run: switch compare\n");
  return 0;
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new ConfigError(`${flag} must be an integer from 1 to 50`);
  return n;
}

async function runCompareCommand(rest: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        repeat: { type: "string" },
        json: { type: "string" },
        html: { type: "string" },
        "no-html": { type: "boolean" },
        "no-cache": { type: "boolean" },
        concurrency: { type: "string" },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    io.stderr(`compare takes one config path\n\n${USAGE}`);
    return 2;
  }
  const configPath = resolve(io.cwd, positionals[0] ?? "switch.yaml");

  let config, providers, concurrency;
  let configText = "";
  try {
    config = await loadCompareConfig(configPath, async (path) => {
      const text = await readFile(path, "utf8");
      if (path === configPath) configText = text;
      return text;
    });
    const repeat = positiveInt(values.repeat, "--repeat");
    if (repeat !== undefined) config.repeat = repeat;
    concurrency = positiveInt(values.concurrency, "--concurrency") ?? 4;
    providers = { baseline: io.providerFactory(config.baseline), candidate: io.providerFactory(config.candidate) };
    await providers.baseline.preflight();
    if (providers.candidate.id !== providers.baseline.id) await providers.candidate.preflight();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof ProviderError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const compared = await runCompare(config, {
    ...providers,
    cache: values["no-cache"] ? null : new DiskCache(resolve(io.cwd, ".switch-cache")),
    concurrency,
    ...(io.progress ? { onProgress: (done: number, total: number) => io.progress!(`\rsampling ${done}/${total}${done === total ? "\n" : ""}`) } : {}),
  });
  const result = redactCompareResult(compared, configText);

  const generatedAt = io.now?.() ?? new Date().toISOString();
  let reportPath: string | undefined;
  if (!values["no-html"]) {
    reportPath = values.html ?? "switch-report.html";
    await writeFile(resolve(io.cwd, reportPath), renderCompareHtml(result, generatedAt));
  }
  if (values.json !== undefined) {
    const json = JSON.stringify(buildCompareJson(result, await packageVersion(), generatedAt), null, 2) + "\n";
    if (values.json === "-") io.stdout(json);
    else await writeFile(resolve(io.cwd, values.json), json);
  }
  const text = renderCompareText(result, reportPath) + "\n";
  if (values.json === "-") io.stderr(text);
  else io.stdout(text);

  return result.totals.regression > 0 || result.totals.error > 0 ? 1 : 0;
}

export async function main(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return command ? 0 : 2;
  }
  switch (command) {
    case "check":
      return runCheck(rest, io);
    case "init":
      return runInit(io);
    case "compare":
      return runCompareCommand(rest, io);
    default:
      io.stderr(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entry && entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${(error as Error).stack ?? error}\n`);
      process.exit(2);
    },
  );
}
