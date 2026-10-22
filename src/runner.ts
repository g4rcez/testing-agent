import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  Browser,
  StaleDecisionError,
  BrowserDeadlineError,
  BrowserCommandRejectedError,
} from "./browser.ts";
import { backendConfig, decide, fieldValue } from "./decision.ts";
import {
  runSchema,
  type Observation,
  type RunInput,
  type Decision,
  type Assertion,
  type BrowserConfig,
} from "./contracts.ts";
import type { AssertionResult } from "./assertions.ts";
import {
  acquireSession,
  atomicWrite,
  cancelPath,
  readState,
  statePath,
  requestCancellation,
  SessionBusyError,
  stateRoot,
} from "./store.ts";

const targetSchema = z.object({
  ref: z.string(),
  label: z.string(),
  role: z.string().optional(),
  value: z.string().optional(),
  currentValue: z.string().optional(),
  checked: z.string().optional(),
});
const decisionSchema = z.object({
  operation: z.string(),
  target: targetSchema.optional(),
  confidence: z.number(),
  targetConfidence: z.number().optional(),
  snapshotId: z.string().optional(),
  targetId: z.string().optional(),
  actionId: z.string().optional(),
  model: z.string().optional(),
});
const actionSchema = z.object({
  stepIndex: z.number().int(),
  operation: z.string(),
  target: z.string().optional(),
  confidence: z.number(),
  elapsedMs: z.number(),
  inferenceMs: z.number(),
  executeMs: z.number(),
  model: z.string().optional(),
});
const stateSchema = z.object({
  version: z.literal(2),
  runId: z.uuid(),
  session: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  input: runSchema,
  status: z.enum([
    "running",
    "paused",
    "blocked",
    "failed",
    "cancelled",
    "completed",
    "uncertain",
  ]),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
  stepIndex: z.number().int().min(0),
  stepDecisions: z.number().int().min(0),
  actions: z.array(actionSchema),
  completedSteps: z.array(
    z.object({
      instruction: z.string(),
      verification: z.enum(["model", "assertion"]),
    }),
  ),
  pendingAction: z
    .object({
      actionId: z.uuid(),
      decision: decisionSchema,
      inferenceMs: z.number(),
      startedAt: z.number(),
    })
    .nullable(),
  reason: z.string().nullable(),
  unchangedActions: z.number().int().min(0),
  staleDecisions: z.number().int().min(0),
  video: z
    .object({
      path: z.string(),
      status: z.enum(["starting", "recording", "saved", "failed"]),
      error: z.string().optional(),
    })
    .optional(),
  assertions: z.array(
    z.object({ passed: z.boolean(), index: z.number(), message: z.string() }),
  ),
});
export type RunState = z.infer<typeof stateSchema>;
type BrowserPort = Pick<Browser, "command" | "observe" | "execute"> &
  Partial<Pick<Browser, "receipt" | "assert">>;
export type RunnerDependencies = {
  browser: (
    session: string,
    deadline: number,
    signal?: AbortSignal,
    config?: BrowserConfig,
  ) => BrowserPort;
  decide: typeof decide;
  fieldValue: typeof fieldValue;
};
const defaults: RunnerDependencies = {
  browser: (session, deadline, signal, config) =>
    new Browser(session, deadline, signal, config),
  decide,
  fieldValue,
};

export async function saveRun(state: RunState): Promise<void> {
  state.updatedAt = Date.now();
  await atomicWrite(statePath(state.runId), state);
}
export async function loadRun(runId: string): Promise<RunState> {
  return stateSchema.parse(await readState(runId));
}
export function summarize(state: RunState) {
  return {
    runId: state.runId,
    session: state.session,
    name: state.input.name,
    status: state.status,
    passed:
      state.status === "completed" &&
      state.assertions.length > 0 &&
      state.assertions.every((check) => check.passed),
    steps: state.input.steps.map((step, index) => {
      const completed = state.completedSteps[index];
      const status = completed
        ? "passed"
        : index === state.stepIndex
          ? ["paused", "running"].includes(state.status)
            ? "pending"
            : "failed"
          : "skipped";
      return {
        step: index + 1,
        instruction: step.instruction,
        status,
        success: status === "passed",
        ...(completed ? { verification: completed.verification } : {}),
        ...(status === "failed" ? { reason: state.reason } : {}),
      };
    }),
    video: state.video ?? null,
    currentStep:
      state.stepIndex < state.input.steps.length ? state.stepIndex + 1 : null,
    totalSteps: state.input.steps.length,
    completedSteps: state.completedSteps,
    actions: state.actions,
    assertions: state.assertions,
    reason: state.reason,
    elapsedMs: (state.endedAt ?? Date.now()) - state.createdAt,
    resume:
      state.status === "paused"
        ? { type: "agent.resume", request: { runId: state.runId } }
        : null,
  };
}
export function assertCompletion(
  observation: Observation,
  expected: Assertion | undefined,
): boolean {
  if (!expected) return true;
  if (expected.selector !== undefined)
    throw new Error(
      "Element assertions require the real browser assertion evaluator",
    );
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return (
    (expected.text === undefined ||
      normalize(observation.tree).includes(normalize(expected.text))) &&
    (expected.url === undefined || observation.url === expected.url)
  );
}
async function evaluateAssertions(
  browser: BrowserPort,
  assertions: Assertion[],
): Promise<AssertionResult> {
  if (browser.assert) return browser.assert(assertions);
  const observation = await browser.observe();
  const checks = assertions.map((assertion, index) => ({
    index,
    passed: assertCompletion(observation, assertion),
    message: "Expected frontend state was not observed",
  }));
  return { passed: checks.every((check) => check.passed), checks };
}
export async function startRun(
  input: RunInput,
  dependencies: RunnerDependencies = defaults,
): Promise<RunState> {
  backendConfig(input.backend);
  const runId = crypto.randomUUID();
  const now = Date.now();
  const state: RunState = {
    version: 2,
    runId,
    session: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .parse(
        input.session ??
          input.browser?.env?.AGENT_BROWSER_SESSION ??
          process.env.AGENT_BROWSER_SESSION ??
          "jev-" + runId,
      ),
    input,
    status: "paused",
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    stepIndex: 0,
    stepDecisions: 0,
    actions: [],
    completedSteps: [],
    pendingAction: null,
    reason: null,
    unchangedActions: 0,
    staleDecisions: 0,
    assertions: [],
  };
  await atomicWrite(cancelPath(runId), 0);
  await saveRun(state);
  return executeRun(state, dependencies, false, input.url);
}
export async function resumeRun(
  runId: string,
  dependencies: RunnerDependencies = defaults,
): Promise<RunState> {
  const state = await loadRun(runId);
  if (!["paused", "running"].includes(state.status)) return state;
  return executeRun(state, dependencies, false);
}
export async function recoverRun(
  runId: string,
  dependencies: RunnerDependencies = defaults,
): Promise<RunState> {
  return executeRun(await loadRun(runId), dependencies, true);
}
export async function cancelRun(
  runId: string,
  dependencies: RunnerDependencies = defaults,
) {
  const state = await loadRun(runId);
  if (!["paused", "running"].includes(state.status)) return summarize(state);
  await requestCancellation(runId);
  if (state.status === "paused") {
    let release: () => void;
    try {
      release = await acquireSession(state.session, runId);
    } catch (error) {
      if (error instanceof SessionBusyError)
        return { runId, status: "cancelling" };
      throw error;
    }
    try {
      const current = await loadRun(runId);
      current.status = "cancelled";
      current.reason = "Cancelled by user";
      current.endedAt = Date.now();
      await finishVideo(current, dependencies);
      await saveRun(current);
      return summarize(current);
    } finally {
      release();
    }
  }
  return { runId, status: "cancelling" };
}
function recordAction(
  state: RunState,
  pending: NonNullable<RunState["pendingAction"]>,
) {
  state.actions.push({
    stepIndex: state.stepIndex,
    operation: pending.decision.operation,
    ...(pending.decision.target
      ? { target: pending.decision.target.label }
      : {}),
    ...(pending.decision.model ? { model: pending.decision.model } : {}),
    confidence: pending.decision.confidence,
    elapsedMs: Date.now() - state.createdAt,
    inferenceMs: pending.inferenceMs,
    executeMs: Date.now() - pending.startedAt,
  });
}
async function finishVideo(
  state: RunState,
  dependencies: RunnerDependencies,
): Promise<void> {
  if (!state.video || !["starting", "recording"].includes(state.video.status))
    return;
  const unconfirmed = state.video.status === "starting";
  if (unconfirmed && state.session !== "jev-" + state.runId) {
    state.video.status = "failed";
    state.video.error =
      "Video startup outcome is unknown in a reused session; inspect it and stop recording manually if needed";
    return;
  }
  try {
    // Finalization must still work after the execution signal or deadline expires.
    await dependencies
      .browser(
        state.session,
        Date.now() + 12_000,
        undefined,
        state.input.browser,
      )
      .command(["record", "stop"]);
    state.video.status = unconfirmed ? "failed" : "saved";
  } catch {
    state.video.status = "failed";
    state.video.error =
      "Video finalization failed; inspect the browser session for an active recording";
    if (state.status === "completed") {
      state.status = "failed";
      state.reason = state.video.error;
    }
  }
}

async function executeRun(
  initial: RunState,
  dependencies: RunnerDependencies,
  recover: boolean,
  url?: string,
): Promise<RunState> {
  const release = await acquireSession(initial.session, initial.runId, recover);
  const controller = new AbortController();
  const totalDeadline = initial.createdAt + initial.input.totalTimeoutMs;
  const callDeadline = Math.min(
    Date.now() + initial.input.timeoutMs,
    totalDeadline,
  );
  const timeout = setTimeout(
    () => controller.abort("deadline"),
    Math.max(0, callDeadline - Date.now()),
  );
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(cancelPath(initial.runId), () => {
      void Bun.file(cancelPath(initial.runId))
        .text()
        .then((value) => {
          if (value.trim() === "1") controller.abort("cancelled");
        })
        .catch(() => controller.abort("cancelled"));
    });
    const state = await loadRun(initial.runId);
    if ((await Bun.file(cancelPath(state.runId)).text()).trim() === "1")
      controller.abort("cancelled");
    const browser = dependencies.browser(
      state.session,
      callDeadline,
      controller.signal,
      state.input.browser,
    );
    if (state.pendingAction) {
      const receipt = browser.receipt
        ? await browser
            .receipt(state.pendingAction.actionId)
            .catch(() => "unknown")
        : "unknown";
      if (recover && receipt === "executed") {
        recordAction(state, state.pendingAction);
        state.pendingAction = null;
        state.status = "paused";
      } else {
        state.status = "uncertain";
        state.reason =
          "Interrupted input has no confirmed execution receipt; automatic replay is disabled";
        state.endedAt = Date.now();
        await finishVideo(state, dependencies);
        await saveRun(state);
        return state;
      }
    }
    if (!["running", "paused"].includes(state.status)) return state;
    state.status = "running";
    state.reason = null;
    state.endedAt = null;
    await saveRun(state);
    let executed = 0;
    try {
      if (state.input.recordVideo && !state.video) {
        const directory = resolve(stateRoot(), "videos");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        state.video = {
          path: resolve(directory, `${state.runId}.webm`),
          status: "starting",
        };
        await saveRun(state);
        try {
          await browser.command(["record", "start", state.video.path]);
        } catch (error) {
          if (error instanceof BrowserCommandRejectedError)
            state.video.status = "failed";
          state.video.error =
            error instanceof BrowserCommandRejectedError
              ? "Video recording could not start; check agent-browser and ffmpeg"
              : "Video startup outcome is unknown; recording acknowledgement was interrupted";
          throw new Error(state.video.error);
        }
        state.video.status = "recording";
        await saveRun(state);
      } else if (state.video?.status === "starting") {
        state.video.error =
          "Video start was interrupted; inspect the browser session before retrying";
        throw new Error(state.video.error);
      } else if (
        state.input.recordVideo &&
        state.video?.status !== "recording"
      ) {
        throw new Error(
          "Video recording has already ended; start a new test instead of continuing without video",
        );
      }
      if (url) {
        state.pendingAction = {
          actionId: crypto.randomUUID(),
          decision: { operation: "OPEN", confidence: 1 },
          inferenceMs: 0,
          startedAt: Date.now(),
        };
        await saveRun(state);
        await browser.command(["open", url]);
        state.pendingAction = null;
        await saveRun(state);
      }
      while (state.stepIndex < state.input.steps.length) {
        if (controller.signal.aborted) throw new Error("Run interrupted");
        if (
          callDeadline - Date.now() < 300 ||
          executed >= state.input.actionsPerCall
        ) {
          state.status = "paused";
          state.reason = "Call budget reached; resume to continue";
          break;
        }
        if (state.stepDecisions >= state.input.maxStepDecisions) {
          state.status = "blocked";
          state.reason = "Current-step decision budget reached";
          break;
        }
        const step = state.input.steps[state.stepIndex];
        if (!step) throw new Error("Missing current step");
        const observed = await browser.observe();
        const completionAssertions = step.expect
          ? [step.expect]
          : state.stepIndex === state.input.steps.length - 1
            ? state.input.expect
            : undefined;
        if (completionAssertions) {
          const currentCompletion = await evaluateAssertions(
            browser,
            completionAssertions.map((assertion) => ({
              ...assertion,
              timeoutMs: 0,
            })),
          );
          if (currentCompletion.passed && step.expect) {
            state.completedSteps.push({
              instruction: step.instruction,
              verification: "assertion",
            });
            state.stepIndex++;
            state.stepDecisions = 0;
            state.unchangedActions = 0;
            state.staleDecisions = 0;
            await saveRun(state);
            continue;
          }
          if (!currentCompletion.passed && observed.controls)
            observed.controls = observed.controls.filter(
              (operation) => operation !== "DONE",
            );
        }
        state.stepDecisions++;
        await saveRun(state);
        const inferenceStarted = Date.now();
        const decision = await dependencies.decide(
          state.input,
          state.stepIndex,
          observed,
          state.actions,
          callDeadline,
          controller.signal,
        );
        const inferenceMs = Date.now() - inferenceStarted;
        if (decision.operation === "DONE") {
          const current = await browser.observe();
          if (current.fingerprint !== observed.fingerprint) {
            state.staleDecisions++;
            if (state.staleDecisions >= 6)
              throw new Error("Frontend kept changing during decisions");
            continue;
          }
          if (step.expect) {
            const result = await evaluateAssertions(browser, [step.expect]);
            if (!result.passed) {
              state.status = "failed";
              state.reason =
                "The model reported DONE, but current-step assertions failed";
              state.assertions = result.checks;
              break;
            }
          }
          state.completedSteps.push({
            instruction: step.instruction,
            verification: step.expect ? "assertion" : "model",
          });
          state.stepIndex++;
          state.stepDecisions = 0;
          state.unchangedActions = 0;
          state.staleDecisions = 0;
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
        const text =
          decision.operation === "TYPE_TEXT"
            ? await dependencies.fieldValue(
                state.input,
                step,
                observed,
                decision,
                callDeadline,
                controller.signal,
              )
            : undefined;
        const actionId = crypto.randomUUID();
        state.pendingAction = {
          actionId,
          decision: { ...decision, actionId },
          inferenceMs,
          startedAt: Date.now(),
        };
        await saveRun(state);
        try {
          await browser.execute(
            {
              ...decision,
              actionId,
              ...(step.selector ? { expectedSelector: step.selector } : {}),
            },
            text,
          );
        } catch (error) {
          if (!(error instanceof StaleDecisionError)) throw error;
          state.pendingAction = null;
          state.staleDecisions++;
          await saveRun(state);
          if (state.staleDecisions >= 6)
            throw new Error("Selected targets kept changing before dispatch");
          continue;
        }
        recordAction(state, state.pendingAction);
        state.pendingAction = null;
        state.staleDecisions = 0;
        await saveRun(state);
        executed++;
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
      if (state.stepIndex === state.input.steps.length) {
        const expected =
          state.input.expect ??
          (state.input.steps.at(-1)?.expect
            ? [state.input.steps.at(-1)?.expect].filter(
                (item): item is Assertion => item !== undefined,
              )
            : []);
        if (!expected.length)
          throw new Error("No deterministic final assertions were configured");
        const result = await evaluateAssertions(browser, expected);
        state.assertions = result.checks;
        state.status = result.passed ? "completed" : "failed";
        state.reason = result.passed ? null : "Final test assertions failed";
      }
    } catch (error) {
      if (state.pendingAction) {
        state.status = "uncertain";
        state.reason =
          "Input acknowledgement was interrupted; recover checks a receipt without replaying input";
      } else if (controller.signal.reason === "cancelled") {
        state.status = "cancelled";
        state.reason = "Cancelled by user";
      } else if (
        state.video?.status === "failed" ||
        state.video?.status === "starting"
      ) {
        state.status = "blocked";
        state.reason = state.video.error ?? "Video recording failed";
      } else if (Date.now() >= totalDeadline) {
        state.status = "failed";
        state.reason = "Total test deadline exceeded";
      } else if (
        controller.signal.aborted ||
        error instanceof BrowserDeadlineError
      ) {
        state.status = "paused";
        state.reason = "Call deadline reached; resume to continue";
      } else {
        state.status = "blocked";
        state.reason = error instanceof Error ? error.message : "Run failed";
      }
    }
    if (!["running", "paused"].includes(state.status)) {
      await finishVideo(state, dependencies);
      state.endedAt = Date.now();
    }
    await saveRun(state);
    return state;
  } finally {
    watcher?.close();
    clearTimeout(timeout);
    release();
  }
}
