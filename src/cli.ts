import { extname, resolve } from "node:path";
import { z } from "zod";
import { runSchema } from "./contracts.ts";
import {
  cancelRun,
  recoverRun,
  resumeRun,
  startRun,
  summarize,
  loadRun,
} from "./runner.ts";
import { stateRoot } from "./store.ts";
import { writeReports } from "./report.ts";
import { insertEditorSchema, testJsonSchema } from "./editor-schema.ts";
import { BackendSetupError, ensureBackend } from "./backend.ts";
import { serveLocalLaya } from "./local-laya.ts";

const help = `testing-agent - AI-driven browser tests through agent-browser

Usage:
  testing-agent test <file.yaml|file.yml|file.json> [--backend jev|laya] [--url URL] [--session NAME] [--report-dir DIR]
  jev-test run <test.json|test.yaml|test.yml> [--backend jev|laya] [--url URL] [--session NAME] [--report-dir DIR]
  jev-test validate <test.json|test.yaml|test.yml>
  jev-test status|resume|recover|cancel <run-id> [--report-dir DIR]
  testing-agent setup laya
  testing-agent lsp <file.yaml|file.yml|file.json>
  jev-test schema
  jev-test --help

Test/run records video by default (requires ffmpeg). Browser settings belong in
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
    throw new Error(
      `Cannot read a valid ${yaml ? "YAML" : "JSON"} test definition`,
    );
  }
  return z.record(z.string(), z.unknown()).parse(value);
}

export async function runCli(args: string[]): Promise<number> {
  const [command, positional, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(help);
    return 0;
  }
  if (command === "schema") {
    console.log(JSON.stringify(testJsonSchema(), null, 2));
    return 0;
  }
  if (command === "setup") {
    if (positional !== "laya" || rest.length)
      throw new Error("Use: testing-agent setup laya");
    await serveLocalLaya();
    return 0;
  }
  if (!positional)
    throw new Error("A test file or run ID is required; use --help");
  if (command === "lsp") {
    if (rest.length)
      throw new Error("The lsp command takes one file and no options");
    console.log(JSON.stringify(await insertEditorSchema(positional)));
    return 0;
  }
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (
      !flag ||
      !["--backend", "--url", "--session", "--report-dir"].includes(flag) ||
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
    console.log(
      JSON.stringify(summarize(await loadRun(z.uuid().parse(positional)))),
    );
    return 0;
  }
  let state;
  if (command === "test" || command === "run" || command === "validate") {
    const raw = await readTest(positional);
    if (flags["--backend"])
      raw.backend = {
        ...z.record(z.string(), z.unknown()).parse(raw.backend ?? {}),
        provider: flags["--backend"],
      };
    if (flags["--url"]) raw.url = flags["--url"];
    if (flags["--session"]) raw.session = flags["--session"];
    if (command !== "validate") raw.recordVideo = true;
    const input = runSchema.parse(raw);
    if (command === "validate") {
      console.log(
        JSON.stringify({
          valid: true,
          name: input.name,
          steps: input.steps.length,
        }),
      );
      return 0;
    }
    await ensureBackend(input.backend);
    state = await startRun(input);
  } else if (command === "resume" || command === "recover") {
    const runId = z.uuid().parse(positional);
    state =
      command === "recover" ? await recoverRun(runId) : await resumeRun(runId);
  } else throw new Error("Unknown command; use --help");
  while (state.status === "paused") state = await resumeRun(state.runId);
  const reports = await writeReports(
    state,
    flags["--report-dir"] ?? resolve(stateRoot(), "reports"),
  );
  console.log(JSON.stringify({ ...summarize(state), reports }));
  return state.status === "completed"
    ? 0
    : state.status === "cancelled"
      ? 130
      : 1;
}

if (
  import.meta.main ||
  /(?:^|[\\/])(?:testing-agent|agent-tester|jev-test|agent-browser-jev)$/.test(
    process.argv[1] ?? "",
  )
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
        ...(error instanceof BackendSetupError ? { setup: error.setup } : {}),
      }),
    );
    process.exitCode = error instanceof BackendSetupError ? 1 : 2;
  }
}
