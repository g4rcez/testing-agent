import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { layaSettingsSchema, runSchema } from "./contracts.ts";
import {
  cancelRun,
  defaultDependencies,
  loadRun,
  recoverRun,
  resumeRun,
  startRun,
  summarize,
  type RunState,
} from "./runner.ts";
import { stateRoot } from "./store.ts";
import { writeReports } from "./report.ts";
import { insertEditorSchema, testJsonSchema } from "./editor-schema.ts";
import { BackendSetupError, prepareBackend, type BackendHandle } from "./backend.ts";
import { initTests, type InitFormat } from "./init.ts";
import { layaSettingsFromEnv, serveLocalLaya } from "./local-laya.ts";
import { detectEnv, formatManual, planSetup, runSetup } from "./setup.ts";

const help = `testing-agent - AI-driven browser tests through agent-browser

Usage:
  testing-agent <command> [options]

Commands:
  test <file>          Run a test definition (YAML or JSON); alias: run
  validate <file>      Check a test definition without opening a browser
  status <run-id>      Print the result of a run
  resume <run-id>      Continue a paused run
  recover <run-id>     Check an interrupted run's last input and continue
  cancel <run-id>      Cancel a running or paused run
  init [folder]        Create an example test (--yaml or --json)
  setup [laya]         Install or start the optional local backend
  lsp <file>           Add the editor schema reference to a test file
  schema               Print the JSON Schema of a test definition
  help [command]       Show help for a command

Options for test, run, validate, status, resume, recover and cancel:
  --backend jev|laya   Decision backend        --url URL           Page to open
  --session NAME       Browser session         --video-fps 1-60    Video frame rate
  --report-dir DIR     Where reports go        --no-autostart      Do not start a local Laya server
  --no-fast-path       Send every step to the model

General options:
  -h, --help           Show help (also: testing-agent <command> --help)
  -v, -V, --version    Print the version
  --                   End of options; what follows is a file name or a run ID

Options take a value as "--url URL" or "--url=URL", and can come before or after the file.
The same binary is installed as agent-tester, jev-test and agent-browser-jev.

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

// What `testing-agent <command> --help` prints. The general help above lists every option once.
const commandHelp: Record<string, string> = {
  test: "Usage: testing-agent test <file.yaml|file.yml|file.json> [options]\n\nRuns the test, records video, writes JSON and JUnit reports and prints the result as JSON on stdout.\nExit codes: 0 passed, 1 failed/blocked/uncertain, 2 invalid input, 130 cancelled.\nOptions: --backend, --url, --session, --video-fps, --report-dir, --no-autostart, --no-fast-path.",
  run: "Usage: testing-agent run <file> [options]\n\nSame as test.",
  validate:
    "Usage: testing-agent validate <file> [options]\n\nChecks the test definition and prints {valid, name, steps}. No browser is opened and no backend is needed.\nExit codes: 0 valid, 2 invalid.",
  status: "Usage: testing-agent status <run-id>\n\nPrints the stored result of a run.",
  resume: "Usage: testing-agent resume <run-id> [options]\n\nContinues a paused run within its total deadline.",
  recover:
    "Usage: testing-agent recover <run-id> [options]\n\nChecks the receipt of the last input of an interrupted run and, if it was executed, continues.",
  cancel: "Usage: testing-agent cancel <run-id>\n\nAsks a running or paused run to stop.",
  init: "Usage: testing-agent init [folder] [--yaml|--json]\n\nCreates an example test and prints what it created.",
  setup:
    "Usage: testing-agent setup [--manual]\n       testing-agent setup laya [--language L] [--revision R] [--model-dir DIR] [--max-len N] [--head-max-len N] [--threads N]\n\nsetup installs what the tests need; --manual prints the steps instead. setup laya runs the local model server in the foreground.",
  lsp: "Usage: testing-agent lsp <file>\n\nAdds the editor JSON Schema reference to a test file and prints what it did.",
  schema: "Usage: testing-agent schema\n\nPrints the JSON Schema of a test definition.",
};

// One line for a person at a terminal; the JSON on stdout stays the result for programs.
function resultLine(state: RunState): string {
  const result = summarize(state);
  const steps = `${result.steps.filter((step) => step.success).length}/${result.totalSteps} steps`;
  const seconds = `${(result.elapsedMs / 1000).toFixed(1)} s`;
  return result.passed
    ? `passed: ${result.name} (${steps}, ${seconds})`
    : `${state.status}: ${result.name}${result.reason ? ` - ${result.reason}` : ""} (${steps}, ${seconds})`;
}

/** A mistake in how the command was called: exit code 2, with a pointer to the help. */
class UsageError extends Error {}

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

const runOptions = {
  backend: { type: "string" },
  url: { type: "string" },
  session: { type: "string" },
  "video-fps": { type: "string" },
  "report-dir": { type: "string" },
  "no-autostart": { type: "boolean" },
  "no-fast-path": { type: "boolean" },
} as const;

/** One operand (a file or a run ID) and the options, in any order; `--opt value`, `--opt=value` and `--` work. */
function parseCommandLine(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, options: runOptions, allowPositionals: true });
  if (positionals.length !== 1) throw new Error("Give one test file or run ID; use --help");
  const flags: Record<string, string> = {};
  for (const name of ["backend", "url", "session", "video-fps", "report-dir"] as const) {
    const value = values[name];
    if (value !== undefined) flags[`--${name}`] = value;
  }
  return {
    operand: positionals[0]!,
    flags,
    noAutostart: values["no-autostart"] === true,
    noFastPath: values["no-fast-path"] === true,
  };
}

export async function runCli(args: string[]): Promise<number> {
  const [command, positional, ...rest] = args;
  const wantsHelp = args.some(
    (arg, index) => (arg === "-h" || arg === "--help") && !args.slice(0, index).includes("--"),
  );
  if (!command || command === "--help" || command === "-h" || (command === "help" && !positional)) {
    console.log(help);
    return 0;
  }
  if (command === "help" || wantsHelp) {
    const topic = command === "help" ? positional! : command;
    const text = commandHelp[topic];
    if (!text) throw new UsageError(`Unknown command "${topic}"`);
    console.log(text);
    return 0;
  }
  if (command === "-v" || command === "-V" || command === "--version") {
    console.log(pkg.version);
    return 0;
  }
  if (!(command in commandHelp)) throw new UsageError(`Unknown command "${command}"`);
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
  if (command === "lsp") {
    if (!positional || rest.length) throw new UsageError("The lsp command takes one file and no options");
    console.log(JSON.stringify(await insertEditorSchema(positional)));
    return 0;
  }
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(args.slice(1));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Invalid options");
  }
  const { operand, flags, noAutostart, noFastPath } = parsed;
  if (command === "cancel") {
    console.log(JSON.stringify(await cancelRun(z.uuid().parse(operand))));
    return 0;
  }
  if (command === "status") {
    console.log(JSON.stringify(summarize(await loadRun(z.uuid().parse(operand)))));
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
  // Without the fast path every step needs the model, so it loads while the browser opens instead of when the
  // first step asks. A failure to start is reported where the step asks for the model, not here.
  const startEarly = (fastPath: boolean) => {
    if (!fastPath) void backend?.ready().catch(() => undefined);
  };
  const dependencies = () => ({ ...defaultDependencies, beforeModel: () => backend?.ready() ?? Promise.resolve() });
  const onSignal = () => void stopStarted().finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    let state;
    if (command === "test" || command === "run" || command === "validate") {
      const raw = await readTest(operand);
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
      startEarly(input.fastPath);
      state = await startRun(input, dependencies());
    } else if (command === "resume" || command === "recover") {
      const runId = z.uuid().parse(operand);
      const savedInput = (await loadRun(runId)).input;
      const saved = savedInput.backend;
      if (noAutostart) saved.autostart = false;
      backend = await prepareBackend(saved);
      startEarly(savedInput.fastPath);
      state = command === "recover" ? await recoverRun(runId, dependencies()) : await resumeRun(runId, dependencies());
    } else throw new UsageError(`Unknown command "${command}"`);
    while (state.status === "paused") state = await resumeRun(state.runId, dependencies());
    const reports = await writeReports(state, flags["--report-dir"] ?? resolve(stateRoot(), "reports"));
    console.log(JSON.stringify({ ...summarize(state), reports }));
    if (process.stderr.isTTY) console.error(resultLine(state));
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
    const message =
      error instanceof z.ZodError
        ? "Invalid test or command input: " + z.prettifyError(error)
        : error instanceof Error
          ? error.message
          : "Command failed";
    if (process.stderr.isTTY) {
      // At a terminal: a sentence and what to do next. Piped: one JSON object, as programs have always read it.
      console.error(`error: ${message}`);
      if (error instanceof BackendSetupError) console.error(error.setup);
      else if (error instanceof UsageError) console.error("Run 'testing-agent --help' for usage.");
    } else
      console.error(
        JSON.stringify({
          error: message,
          ...(error instanceof BackendSetupError ? { code: error.code, setup: error.setup } : {}),
          ...(error instanceof UsageError ? { hint: "Run 'testing-agent --help' for usage." } : {}),
        }),
      );
    process.exitCode = error instanceof BackendSetupError ? 1 : 2;
  }
}
