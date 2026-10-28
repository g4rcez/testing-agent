import { extname, resolve } from "node:path";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { layaSettingsSchema, runSchema } from "./contracts.ts";
import { cancelRun, defaultDependencies, loadRun, recoverRun, resumeRun, startRun, summarize } from "./runner.ts";
import { stateRoot } from "./store.ts";
import { writeReports } from "./report.ts";
import { insertEditorSchema, testJsonSchema } from "./editor-schema.ts";
import { BackendSetupError, prepareBackend, type BackendHandle } from "./backend.ts";
import { initTests, type InitFormat } from "./init.ts";
import { layaSettingsFromEnv, serveLocalLaya } from "./local-laya.ts";
import { detectEnv, formatManual, planSetup, runSetup } from "./setup.ts";

const help = `testing-agent - AI-driven browser tests through agent-browser

Usage:
  testing-agent test <file.yaml|file.yml|file.json> [--backend jev|laya] [--url URL] [--session NAME] [--video-fps 1-60] [--report-dir DIR] [--no-autostart] [--no-fast-path]
  jev-test run <test.json|test.yaml|test.yml> [--backend jev|laya] [--url URL] [--session NAME] [--video-fps 1-60] [--report-dir DIR]
  jev-test validate <test.json|test.yaml|test.yml>
  jev-test status|resume|recover|cancel <run-id> [--report-dir DIR]
  testing-agent init [folder] [--yaml|--json]
  testing-agent -v|--version
  testing-agent setup [--manual]
  testing-agent setup laya [--language L] [--max-len N] [--head-max-len N] [--threads N] [--model-dir DIR]
  testing-agent lsp <file.yaml|file.yml|file.json>
  jev-test schema
  jev-test --help

A local Laya server that is not running is started for the run and stopped with it; --no-autostart
(or TESTING_AGENT_AUTOSTART=0, backend.autostart: false) turns that off. In CI it is off unless
TESTING_AGENT_AUTOSTART=1.
Steps the page makes unambiguous (type a value into a named field, press Enter, click a uniquely
named control) are done without the model; --no-fast-path (or fastPath: false) sends every step to it.
Test/run records video by default (requires ffmpeg); --video-fps sets its frame rate
(default 60). Browser settings belong in
browser.args (option names without --) and browser.env in the test file.
Tests require explicit final expect assertions. Test/run and resume automatically
continue paused calls within the total test deadline. JSON and JUnit reports
are written for terminal results. Exit codes: 0 passed, 1 failed/blocked/uncertain,
2 invalid input, 130 cancelled. Credentials come from environment variables.
`;

async function readTest(path: string) {
  const file = Bun.file(path);
  if (file.size > 1_000_000) throw new Error("Test definition exceeds 1 MB");
  const yaml = [".yaml", ".yml"].includes(extname(path).toLowerCase());
  let value: unknown;
  try {
    value = yaml ? Bun.YAML.parse(await file.text()) : await file.json();
  } catch {
    throw new Error(`Cannot read a valid ${yaml ? "YAML" : "JSON"} test definition`);
  }
  return z.record(z.string(), z.unknown()).parse(value);
}

export async function runCli(args: string[]): Promise<number> {
  const [command, positional, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(help);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    console.log(pkg.version);
    return 0;
  }
  if (command === "schema") {
    console.log(JSON.stringify(testJsonSchema(), null, 2));
    return 0;
  }
  if (command === "init") {
    const operands = args.slice(1);
    const formats = operands.filter((arg) => arg === "--yaml" || arg === "--json");
    const names = operands.filter((arg) => !arg.startsWith("--"));
    if (
      formats.length > 1 ||
      names.length > 1 ||
      operands.some((arg) => arg.startsWith("--") && !["--yaml", "--json"].includes(arg))
    )
      throw new Error("Use: testing-agent init [folder] [--yaml|--json]");
    const result = await initTests({
      ...(names[0] ? { folder: names[0] } : {}),
      ...(formats[0] ? { format: formats[0].slice(2) as InitFormat } : {}),
    });
    console.log(JSON.stringify(result));
    for (const file of result.created) console.info(`Created ${file}`);
    for (const file of result.skipped) console.warn(`Kept existing ${file}`);
    console.info(
      `Run it with: testing-agent test ${result.folder}/example.test.${result.created[0]?.endsWith(".json") || result.skipped[0]?.endsWith(".json") ? "json" : "yaml"}`,
    );
    return 0;
  }
  if (command === "setup") {
    if (positional === "laya") {
      // Flags override the LAYA_* environment; laya_config.json supplies whatever is left unset.
      const flagNames = {
        "--language": "language",
        "--revision": "revision",
        "--model-dir": "modelDir",
        "--max-len": "maxLen",
        "--head-max-len": "headMaxLen",
        "--threads": "threads",
      } as const;
      const given: Record<string, string | number> = {};
      for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index] as keyof typeof flagNames;
        const value = rest[index + 1];
        if (!flagNames[flag] || !value || value.startsWith("--") || flagNames[flag] in given)
          throw new Error(
            "Use: testing-agent setup laya [--language L] [--revision R] [--model-dir DIR] [--max-len N] [--head-max-len N] [--threads N]",
          );
        given[flagNames[flag]] = ["--max-len", "--head-max-len", "--threads"].includes(flag) ? Number(value) : value;
      }
      await serveLocalLaya(layaSettingsSchema.parse({ ...layaSettingsFromEnv(), ...given }));
      return 0;
    }
    const manual = positional === "--manual";
    if ((positional && !manual) || rest.length) throw new Error("Use: testing-agent setup [--manual] or setup laya");
    const env = detectEnv();
    if (manual) {
      console.log(formatManual(planSetup(env), env));
      return 0;
    }
    return (await runSetup(env)).failed ? 1 : 0;
  }
  if (!positional) throw new Error("A test file or run ID is required; use --help");
  if (command === "lsp") {
    if (rest.length) throw new Error("The lsp command takes one file and no options");
    console.log(JSON.stringify(await insertEditorSchema(positional)));
    return 0;
  }
  const flags: Record<string, string> = {};
  const noAutostart = rest.includes("--no-autostart");
  const noFastPath = rest.includes("--no-fast-path");
  const pairs = rest.filter((arg) => arg !== "--no-autostart" && arg !== "--no-fast-path");
  for (let index = 0; index < pairs.length; index += 2) {
    const flag = pairs[index],
      value = pairs[index + 1];
    if (
      !flag ||
      !["--backend", "--url", "--session", "--video-fps", "--report-dir"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      flags[flag]
    )
      throw new Error("Invalid or repeated option; use --help");
    flags[flag] = value;
  }
  if (command === "cancel") {
    console.log(JSON.stringify(await cancelRun(z.uuid().parse(positional))));
    return 0;
  }
  if (command === "status") {
    console.log(JSON.stringify(summarize(await loadRun(z.uuid().parse(positional)))));
    return 0;
  }
  // A local server is started only when a step needs the model, and stopped with the run; one that
  // was already running is left alone.
  let backend: BackendHandle | undefined;
  const stopStarted = async () => {
    const server = backend;
    backend = undefined;
    await server?.stop();
  };
  const dependencies = () => ({ ...defaultDependencies, beforeModel: () => backend?.ready() ?? Promise.resolve() });
  const onSignal = () => void stopStarted().finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    let state;
    if (command === "test" || command === "run" || command === "validate") {
      const raw = await readTest(positional);
      if (flags["--backend"])
        raw.backend = {
          ...z.record(z.string(), z.unknown()).parse(raw.backend ?? {}),
          provider: flags["--backend"].toLowerCase(),
        };
      if (flags["--url"]) raw.url = flags["--url"];
      if (flags["--session"]) raw.session = flags["--session"];
      if (flags["--video-fps"]) raw.videoFps = Number(flags["--video-fps"]);
      if (command !== "validate") raw.recordVideo = true;
      if (noAutostart)
        raw.backend = { ...z.record(z.string(), z.unknown()).parse(raw.backend ?? {}), autostart: false };
      if (noFastPath) raw.fastPath = false;
      const input = runSchema.parse(raw);
      if (command === "validate") {
        console.log(JSON.stringify({ valid: true, name: input.name, steps: input.steps.length }));
        return 0;
      }
      backend = await prepareBackend(input.backend);
      state = await startRun(input, dependencies());
    } else if (command === "resume" || command === "recover") {
      const runId = z.uuid().parse(positional);
      const saved = (await loadRun(runId)).input.backend;
      if (noAutostart) saved.autostart = false;
      backend = await prepareBackend(saved);
      state = command === "recover" ? await recoverRun(runId, dependencies()) : await resumeRun(runId, dependencies());
    } else throw new Error("Unknown command; use --help");
    while (state.status === "paused") state = await resumeRun(state.runId, dependencies());
    const reports = await writeReports(state, flags["--report-dir"] ?? resolve(stateRoot(), "reports"));
    console.log(JSON.stringify({ ...summarize(state), reports }));
    return state.status === "completed" ? 0 : state.status === "cancelled" ? 130 : 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await stopStarted();
  }
}

if (
  import.meta.main ||
  /(?:^|[\\/])(?:testing-agent|agent-tester|jev-test|agent-browser-jev)$/.test(process.argv[1] ?? "")
) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof z.ZodError
            ? "Invalid test or command input: " + z.prettifyError(error)
            : error instanceof Error
              ? error.message
              : "Command failed",
        ...(error instanceof BackendSetupError ? { code: error.code, setup: error.setup } : {}),
      }),
    );
    process.exitCode = error instanceof BackendSetupError ? 1 : 2;
  }
}
