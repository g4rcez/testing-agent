import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Browser } from "./browser.ts";
import { backendConfig, decide, fieldValue } from "./decision.ts";
import { runSchema, type Observation, type RunInput } from "./contracts.ts";

const actionSchema = z.object({
  stepIndex: z.number().int(),
  operation: z.string(),
  target: z.string().optional(),
  confidence: z.number(),
  elapsedMs: z.number(),
});
const stateSchema = z.object({
  version: z.literal(1),
  runId: z.uuid(),
  session: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  input: runSchema,
  status: z.enum(["running", "paused", "blocked", "completed", "uncertain"]),
  stepIndex: z.number().int().min(0),
  stepDecisions: z.number().int().min(0),
  actions: z.array(actionSchema),
  completedSteps: z.array(
    z.object({
      instruction: z.string(),
      verification: z.enum(["model", "assertion"]),
    }),
  ),
  pendingAction: z.string().nullable(),
  reason: z.string().nullable(),
  unchangedActions: z.number().int().min(0),
  staleDecisions: z.number().int().min(0),
});
export type RunState = z.infer<typeof stateSchema>;
export type RunnerDependencies = {
  browser: (
    session: string,
    deadline: number,
  ) => Pick<Browser, "command" | "observe" | "execute">;
  decide: typeof decide;
  fieldValue: typeof fieldValue;
};
const defaults: RunnerDependencies = {
  browser: (session, deadline) => new Browser(session, deadline),
  decide,
  fieldValue,
};
const root = () => resolve(process.env.JEV_STATE_DIR ?? ".agent-browser-jev");
const file = (runId: string) =>
  resolve(root(), `${z.uuid().parse(runId)}.json`);

export async function saveRun(state: RunState): Promise<void> {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const path = file(state.runId);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

export async function loadRun(runId: string): Promise<RunState> {
  return stateSchema.parse(JSON.parse(await readFile(file(runId), "utf8")));
}

export function summarize(state: RunState) {
  return {
    runId: state.runId,
    session: state.session,
    status: state.status,
    currentStep:
      state.stepIndex + 1 <= state.input.steps.length
        ? state.stepIndex + 1
        : null,
    totalSteps: state.input.steps.length,
    completedSteps: state.completedSteps,
    actions: state.actions,
    reason: state.reason,
    resume:
      state.status === "paused"
        ? { type: "agent.resume", request: { runId: state.runId } }
        : null,
  };
}

export function assertCompletion(
  observation: Observation,
  expected: RunInput["steps"][number]["expect"],
): boolean {
  if (!expected) return true;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return (
    (expected.text === undefined ||
      normalize(observation.tree).includes(normalize(expected.text))) &&
    (expected.url === undefined || observation.url === expected.url)
  );
}

export async function startRun(
  input: RunInput,
  dependencies: RunnerDependencies = defaults,
): Promise<RunState> {
  backendConfig(input.backend);
  const runId = crypto.randomUUID();
  const state: RunState = {
    version: 1,
    runId,
    session: input.session ?? `jev-${runId}`,
    input,
    status: "paused",
    stepIndex: 0,
    stepDecisions: 0,
    actions: [],
    completedSteps: [],
    pendingAction: null,
    reason: null,
    unchangedActions: 0,
    staleDecisions: 0,
  };
  await saveRun(state);
  return executeRun(state, dependencies, input.url);
}

export async function resumeRun(
  runId: string,
  dependencies: RunnerDependencies = defaults,
): Promise<RunState> {
  const state = await loadRun(runId);
  if (state.status !== "paused" && state.status !== "running") return state;
  return executeRun(state, dependencies);
}

async function executeRun(
  initial: RunState,
  dependencies: RunnerDependencies,
  url?: string,
): Promise<RunState> {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const lock = resolve(root(), `session-${initial.session}.lock`);
  try {
    await mkdir(lock);
  } catch {
    throw new Error(
      "This browser session is already running, or its lock needs inspection after an interrupted process",
    );
  }
  try {
    // Re-read after acquiring the lock so concurrent resumes cannot replay old state.
    const state = await loadRun(initial.runId);
    if (state.pendingAction) {
      state.status = "uncertain";
      state.reason =
        "A previous process stopped during browser input. Inspect the app before starting a new run.";
      await saveRun(state);
      return state;
    }
    if (["completed", "blocked", "uncertain"].includes(state.status))
      return state;
    const started = Date.now();
    const deadline = started + state.input.timeoutMs;
    const browser = dependencies.browser(state.session, deadline);
    state.status = "running";
    state.reason = null;
    await saveRun(state);
    let executed = 0;
    try {
      if (url) {
        state.pendingAction = "OPEN";
        await saveRun(state);
        await browser.command(["open", url]);
        state.pendingAction = null;
        await saveRun(state);
      }
      while (state.stepIndex < state.input.steps.length) {
        if (
          deadline - Date.now() < 2000 ||
          executed >= state.input.actionsPerCall
        ) {
          state.status = "paused";
          state.reason =
            "Call budget reached; resume to continue the same step list";
          break;
        }
        if (state.stepDecisions >= state.input.maxStepDecisions) {
          state.status = "blocked";
          state.reason =
            "Run action budget or current-step decision budget reached";
          break;
        }
        const step = state.input.steps[state.stepIndex];
        if (!step) throw new Error("Missing current step");
        const observed = await browser.observe();
        state.stepDecisions += 1;
        await saveRun(state);
        const decision = await dependencies.decide(
          state.input,
          state.stepIndex,
          observed,
          state.actions,
          deadline,
        );
        const text =
          decision.operation === "TYPE_TEXT"
            ? await dependencies.fieldValue(
                state.input,
                step,
                observed,
                decision,
                deadline,
              )
            : undefined;
        const current = await browser.observe();
        if (current.fingerprint !== observed.fingerprint) {
          state.staleDecisions += 1;
          if (state.staleDecisions >= 6) {
            state.status = "blocked";
            state.reason = "The frontend kept changing during decisions";
            break;
          }
          continue;
        }
        state.staleDecisions = 0;
        if (decision.operation === "DONE") {
          if (!assertCompletion(current, step.expect)) {
            state.status = "blocked";
            state.reason =
              "The model reported DONE, but the current step's expected text or URL was not present";
            break;
          }
          state.completedSteps.push({
            instruction: step.instruction,
            verification: step.expect ? "assertion" : "model",
          });
          state.stepIndex += 1;
          state.stepDecisions = 0;
          state.unchangedActions = 0;
          await saveRun(state);
          continue;
        }
        if (decision.operation === "BLOCKED") {
          state.status = "blocked";
          state.reason =
            "The decision backend could not complete the current step";
          break;
        }
        if (state.actions.length >= state.input.maxActions) {
          state.status = "blocked";
          state.reason = "Run action budget reached";
          break;
        }
        state.pendingAction = decision.operation;
        await saveRun(state);
        await browser.execute(decision, text);
        state.actions.push({
          stepIndex: state.stepIndex,
          operation: decision.operation,
          ...(decision.target ? { target: decision.target.label } : {}),
          confidence: decision.confidence,
          elapsedMs: Date.now() - started,
        });
        state.pendingAction = null;
        await saveRun(state);
        executed += 1;
        const after = await browser.observe();
        state.unchangedActions =
          after.fingerprint === observed.fingerprint
            ? state.unchangedActions + 1
            : 0;
        if (state.unchangedActions >= 3) {
          state.status = "blocked";
          state.reason = "Three actions produced no observable frontend change";
          break;
        }
      }
      if (state.stepIndex === state.input.steps.length)
        state.status = "completed";
    } catch (error) {
      state.status = state.pendingAction ? "uncertain" : "blocked";
      state.reason = state.pendingAction
        ? "Browser input was interrupted; its effect is unknown. Inspect the app before starting a new run."
        : error instanceof Error
          ? error.message
          : "Run failed";
    }
    await saveRun(state);
    return state;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
