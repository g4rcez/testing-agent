import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Browser, StaleDecisionError, BrowserDeadlineError, BrowserCommandRejectedError } from "./browser.ts";
import { BackendSetupError } from "./backend.ts";
import { assume, backendConfig, decide, fieldValue } from "./decision.ts";
import { assumeDeterministic, resolveFast } from "./fastpath.ts";
import { RunError, observationDebug, type ReasonCode } from "./diagnostics.ts";
import { normalizeText, urlsEqual } from "./normalize.ts";
import {
  runSchema,
  type Assertion,
  type BrowserConfig,
  type Decision,
  type Observation,
  type RunInput,
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
  scroll: z
    .object({
      progress: z.number(),
      below: z.number(),
      above: z.number(),
      belowLabels: z.array(z.string()),
      aboveLabels: z.array(z.string()),
    })
    .optional(),
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
  probabilities: z.record(z.string(), z.number()).optional(),
  targetProbabilities: z.record(z.string(), z.number()).optional(),
  source: z.enum(["model", "fast", "deterministic"]).optional(),
  rule: z.string().optional(),
  rounds: z.number().optional(),
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
  source: z.enum(["model", "fast", "deterministic"]).default("model"),
  rule: z.string().optional(),
  dialogs: z.array(z.object({ type: z.string(), message: z.string() })).optional(),
});
const debugSchema = z.object({
  lastDecision: z
    .object({
      operation: z.string(),
      target: z.string().optional(),
      confidence: z.number(),
      targetConfidence: z.number().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
      targetProbabilities: z.record(z.string(), z.number()).optional(),
      source: z.enum(["model", "fast", "deterministic"]).optional(),
      rule: z.string().optional(),
      rounds: z.number().optional(),
      model: z.string().optional(),
      inferenceMs: z.number(),
    })
    .optional(),
  lastObservation: z
    .object({
      url: z.string(),
      title: z.string().optional(),
      fingerprint: z.string(),
      targetCounts: z.record(z.string(), z.number()),
      controls: z.array(z.string()).optional(),
      controlsFiltered: z.boolean(),
      textExcerpt: z.string(),
    })
    .optional(),
  error: z
    .object({
      name: z.string(),
      code: z.string(),
      message: z.string().optional(),
      details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .optional(),
  assertionChecks: z.array(z.object({ passed: z.boolean(), index: z.number(), message: z.string() })).optional(),
  tabs: z.object({ count: z.number(), active: z.string(), urls: z.array(z.string()) }).optional(),
});
const stateSchema = z.object({
  version: z.literal(2),
  runId: z.uuid(),
  session: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  input: runSchema,
  status: z.enum(["running", "paused", "blocked", "failed", "cancelled", "completed", "uncertain"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
  stepIndex: z.number().int().min(0),
  stepDecisions: z.number().int().min(0),
  actions: z.array(actionSchema),
  completedSteps: z.array(
    z.object({ instruction: z.string(), verification: z.enum(["model", "assertion", "assumption", "deterministic"]) }),
  ),
  pendingAction: z
    .object({
      actionId: z.uuid(),
      decision: decisionSchema,
      inferenceMs: z.number(),
      startedAt: z.number(),
      tabId: z.string().optional(),
    })
    .nullable(),
  reason: z.string().nullable(),
  reasonCode: z.string().nullable().optional(),
  debug: debugSchema.optional(),
  // The tabs the session has had, so a resumed or recovered run knows which is the opener and which are new.
  tabs: z
    .object({ active: z.string(), opener: z.string(), latest: z.string().optional(), known: z.array(z.string()) })
    .optional(),
  blockedRetries: z.number().int().min(0).default(0),
  unchangedActions: z.number().int().min(0),
  staleDecisions: z.number().int().min(0),
  video: z
    .object({
      path: z.string(),
      status: z.enum(["starting", "recording", "saved", "failed"]),
      error: z.string().optional(),
    })
    .optional(),
  assertions: z.array(z.object({ passed: z.boolean(), index: z.number(), message: z.string() })),
});
export type RunState = z.infer<typeof stateSchema>;
type BrowserPort = Pick<Browser, "command" | "observe" | "execute"> &
  Partial<Pick<Browser, "receipt" | "assert" | "tabs" | "switchTab">>;
export type RunnerDependencies = {
  browser: (session: string, deadline: number, signal?: AbortSignal, config?: BrowserConfig) => BrowserPort;
  decide: typeof decide;
  fieldValue: typeof fieldValue;
  assume?: typeof assume;
  resolve?: typeof resolveFast;
  /** Called right before the model is asked; lets a backend that starts on demand start now. */
  beforeModel?: () => Promise<void>;
};
export const defaultDependencies: RunnerDependencies = {
  browser: (session, deadline, signal, config) => new Browser(session, deadline, signal, config),
  decide,
  fieldValue,
  assume,
};

/** Ends or pauses a run with a stable code next to the human sentence. */
function stop(state: RunState, status: RunState["status"], code: ReasonCode, reason: string) {
  state.status = status;
  state.reasonCode = code;
  state.reason = reason;
}
function classify(error: unknown): { code: ReasonCode; reason: string } {
  if (error instanceof RunError) return { code: error.code, reason: error.message };
  if (error instanceof BackendSetupError) return { code: error.code, reason: error.message };
  if (error instanceof BrowserCommandRejectedError) return { code: "BROWSER_COMMAND_FAILED", reason: error.message };
  return { code: "INTERNAL", reason: error instanceof Error ? error.message : "Run failed" };
}
function remember(state: RunState, patch: NonNullable<RunState["debug"]>) {
  state.debug = { ...state.debug, ...patch };
}
// Everything needed to see why a run stopped without re-running it.
function debugReport(state: RunState) {
  const slowestInferenceMs = Math.max(0, ...state.actions.map((action) => action.inferenceMs));
  const now = state.endedAt ?? Date.now();
  return {
    ...state.debug,
    stepIndex: state.stepIndex,
    stepDecisions: state.stepDecisions,
    unchangedActions: state.unchangedActions,
    staleDecisions: state.staleDecisions,
    blockedRetries: state.blockedRetries,
    timings: {
      elapsedMs: now - state.createdAt,
      totalRemainingMs: Math.max(0, state.createdAt + state.input.totalTimeoutMs - now),
      slowestInferenceMs,
    },
  };
}
// Tab bookkeeping. agent-browser makes a tab opened by a click the active one and falls back to the
// opener when a pop-up closes; the runner notices the change, and can undo it with follow: "never".
async function syncTabs(
  browser: BrowserPort,
  state: RunState,
  expect: { opened?: boolean; closed?: boolean } = {},
): Promise<void> {
  if (!browser.tabs) return;
  let list: Awaited<ReturnType<NonNullable<BrowserPort["tabs"]>>>;
  try {
    list = await browser.tabs();
    // A tab appears a moment after the click that opens it and goes a moment after the one that closes
    // it; wait up to two seconds for the list to show it.
    for (let attempt = 0; (expect.opened || expect.closed) && state.tabs && attempt < 20; attempt++) {
      const known = new Set(state.tabs.known);
      const opened = list.some((tab) => !known.has(tab.id));
      const closed = !list.some((tab) => tab.id === state.tabs!.active);
      if ((expect.opened && opened) || (expect.closed && closed)) break;
      await Bun.sleep(100);
      list = await browser.tabs();
    }
  } catch (error) {
    // Tab tracking is advisory: an agent-browser that cannot list tabs must not fail the run.
    if (error instanceof BrowserDeadlineError) throw error;
    return;
  }
  if (!list.length) return;
  const previous = state.tabs;
  const seen = new Set(previous?.known ?? []);
  const fresh = previous ? list.filter((tab) => !seen.has(tab.id)) : [];
  let active = list.find((tab) => tab.active)?.id ?? list[0]!.id;
  // The active tab closed itself: return to the tab that opened it (agent-browser may not have yet).
  if (previous && !list.some((tab) => tab.id === previous.active) && browser.switchTab) {
    const back = list.find((tab) => tab.id === previous.opener) ?? list[0]!;
    if (active !== back.id || !list.find((tab) => tab.id === active)?.active) await browser.switchTab(back.id);
    active = back.id;
  }
  const follow = state.input.browser?.tabs?.follow ?? "auto";
  const newest = fresh.at(-1);
  // A tab appears in the list a moment before it becomes the active one; settle on the newest explicitly.
  if (follow === "auto" && newest && active !== newest.id && browser.switchTab) {
    await browser.switchTab(newest.id);
    active = newest.id;
  }
  if (
    follow === "never" &&
    previous &&
    fresh.length &&
    active !== previous.active &&
    list.some((tab) => tab.id === previous.active) &&
    browser.switchTab
  ) {
    await browser.switchTab(previous.active);
    active = previous.active;
  }
  const latest = fresh.at(-1)?.id ?? (list.some((tab) => tab.id === previous?.latest) ? previous?.latest : undefined);
  state.tabs = {
    active,
    opener: previous?.opener ?? list[0]!.id,
    known: list.map((tab) => tab.id),
    ...(latest ? { latest } : {}),
  };
  remember(state, { tabs: { count: list.length, active, urls: list.map((tab) => tab.url).slice(0, 5) } });
}
async function selectTab(browser: BrowserPort, state: RunState, wanted: string): Promise<void> {
  if (wanted === "current" || !browser.tabs || !browser.switchTab) return;
  const list = await browser.tabs();
  const opener = state.tabs?.opener ?? list[0]?.id;
  const id =
    wanted === "new"
      ? (state.tabs?.latest ?? list.filter((tab) => tab.id !== opener).at(-1)?.id)
      : wanted === "opener"
        ? opener
        : list.find((tab) => tab.id === wanted || tab.label === wanted)?.id;
  const tab = list.find((candidate) => candidate.id === id);
  if (!tab)
    throw new RunError("TAB_NOT_FOUND", `The step asks for tab "${wanted}", which is not open`, {
      tab: wanted,
      open: list.length,
    });
  if (!tab.active) await browser.switchTab(tab.id);
  state.tabs = {
    active: tab.id,
    opener: opener ?? tab.id,
    known: list.map((candidate) => candidate.id),
    ...(state.tabs?.latest ? { latest: state.tabs.latest } : {}),
  };
}
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
      state.status === "completed" && state.assertions.length > 0 && state.assertions.every((check) => check.passed),
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
        ...(status === "failed"
          ? {
              reason: state.reason,
              reasonCode: state.reasonCode ?? null,
              debug: { lastDecision: state.debug?.lastDecision, lastObservation: state.debug?.lastObservation },
            }
          : {}),
      };
    }),
    video: state.video ?? null,
    currentStep: state.stepIndex < state.input.steps.length ? state.stepIndex + 1 : null,
    totalSteps: state.input.steps.length,
    completedSteps: state.completedSteps,
    actions: state.actions,
    assertions: state.assertions,
    reason: state.reason,
    reasonCode: state.reasonCode ?? null,
    ...(state.status === "completed" ? {} : { debug: debugReport(state) }),
    elapsedMs: (state.endedAt ?? Date.now()) - state.createdAt,
    resume: state.status === "paused" ? { type: "agent.resume", request: { runId: state.runId } } : null,
  };
}
export function assertCompletion(observation: Observation, expected: Assertion | undefined): boolean {
  if (!expected) return true;
  if (expected.selector !== undefined)
    throw new Error("Element assertions require the real browser assertion evaluator");
  const exact = expected.caseSensitive === true;
  return (
    (expected.text === undefined ||
      normalizeText(observation.tree, exact).includes(normalizeText(expected.text, exact))) &&
    (expected.url === undefined || urlsEqual(expected.url, observation.url))
  );
}
async function evaluateAssertions(browser: BrowserPort, assertions: Assertion[]): Promise<AssertionResult> {
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
  dependencies: RunnerDependencies = defaultDependencies,
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
    reasonCode: null,
    blockedRetries: 0,
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
  dependencies: RunnerDependencies = defaultDependencies,
): Promise<RunState> {
  const state = await loadRun(runId);
  if (!["paused", "running"].includes(state.status)) return state;
  return executeRun(state, dependencies, false);
}
export async function recoverRun(
  runId: string,
  dependencies: RunnerDependencies = defaultDependencies,
): Promise<RunState> {
  return executeRun(await loadRun(runId), dependencies, true);
}
export async function cancelRun(runId: string, dependencies: RunnerDependencies = defaultDependencies) {
  const state = await loadRun(runId);
  if (!["paused", "running"].includes(state.status)) return summarize(state);
  await requestCancellation(runId);
  if (state.status === "paused") {
    let release: () => void;
    try {
      release = await acquireSession(state.session, runId);
    } catch (error) {
      if (error instanceof SessionBusyError) return { runId, status: "cancelling" };
      throw error;
    }
    try {
      const current = await loadRun(runId);
      stop(current, "cancelled", "CANCELLED", "Cancelled by user");
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
function recordAction(state: RunState, pending: NonNullable<RunState["pendingAction"]>) {
  state.actions.push({
    stepIndex: state.stepIndex,
    operation: pending.decision.operation,
    ...(pending.decision.target ? { target: pending.decision.target.label } : {}),
    ...(pending.decision.model ? { model: pending.decision.model } : {}),
    confidence: pending.decision.confidence,
    elapsedMs: Date.now() - state.createdAt,
    inferenceMs: pending.inferenceMs,
    executeMs: Date.now() - pending.startedAt,
    source: pending.decision.source ?? "model",
    ...(pending.decision.rule ? { rule: pending.decision.rule } : {}),
  });
}
async function finishVideo(state: RunState, dependencies: RunnerDependencies): Promise<void> {
  if (!state.video || !["starting", "recording"].includes(state.video.status)) return;
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
      .browser(state.session, Date.now() + 12_000, undefined, state.input.browser)
      .command(["record", "stop"]);
    state.video.status = unconfirmed ? "failed" : "saved";
  } catch {
    state.video.status = "failed";
    state.video.error = "Video finalization failed; inspect the browser session for an active recording";
    if (state.status === "completed") stop(state, "failed", "VIDEO_FINALIZE_FAILED", state.video.error);
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
  const callDeadline = Math.min(Date.now() + initial.input.timeoutMs, totalDeadline);
  const timeout = setTimeout(() => controller.abort("deadline"), Math.max(0, callDeadline - Date.now()));
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
    if ((await Bun.file(cancelPath(state.runId)).text()).trim() === "1") controller.abort("cancelled");
    const browser = dependencies.browser(state.session, callDeadline, controller.signal, state.input.browser);
    if (state.pendingAction) {
      // The receipt lives in the page that ran the action, which may no longer be the active tab.
      if (state.pendingAction.tabId && browser.switchTab)
        await browser.switchTab(state.pendingAction.tabId).catch(() => undefined);
      const receipt = browser.receipt
        ? await browser.receipt(state.pendingAction.actionId).catch(() => "unknown")
        : "unknown";
      if (recover && receipt === "executed") {
        recordAction(state, state.pendingAction);
        state.pendingAction = null;
        state.status = "paused";
      } else {
        stop(
          state,
          "uncertain",
          "INPUT_RECEIPT_MISSING",
          "Interrupted input has no confirmed execution receipt; automatic replay is disabled",
        );
        state.endedAt = Date.now();
        await finishVideo(state, dependencies);
        await saveRun(state);
        return state;
      }
    }
    if (!["running", "paused"].includes(state.status)) return state;
    state.status = "running";
    state.reason = null;
    state.reasonCode = null;
    state.endedAt = null;
    await saveRun(state);
    let executed = 0;
    try {
      if (state.input.recordVideo && !state.video) {
        const directory = resolve(stateRoot(), "videos");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        state.video = { path: resolve(directory, `${state.runId}.mp4`), status: "starting" };
        await saveRun(state);
        try {
          const fps = String(state.input.videoFps);
          await browser.command(["record", "start", state.video.path, "--fps", fps]);
        } catch (error) {
          if (error instanceof BrowserCommandRejectedError) state.video.status = "failed";
          const rejected = error instanceof BrowserCommandRejectedError;
          state.video.error = rejected
            ? "Video recording could not start; check agent-browser and ffmpeg"
            : "Video startup outcome is unknown; recording acknowledgement was interrupted";
          throw new RunError(rejected ? "VIDEO_START_FAILED" : "VIDEO_START_UNKNOWN", state.video.error);
        }
        state.video.status = "recording";
        await saveRun(state);
      } else if (state.video?.status === "starting") {
        state.video.error = "Video start was interrupted; inspect the browser session before retrying";
        throw new RunError("VIDEO_START_UNKNOWN", state.video.error);
      } else if (state.input.recordVideo && state.video?.status !== "recording") {
        throw new RunError(
          "VIDEO_ENDED",
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
      await syncTabs(browser, state);
      while (state.stepIndex < state.input.steps.length) {
        if (controller.signal.aborted) throw new Error("Run interrupted");
        // Do not start a decision that cannot finish in this call; resume starts it with a fresh budget.
        const slowest = Math.max(
          0,
          ...state.actions
            .filter((action) => action.source === "model")
            .slice(-5)
            .map((action) => action.inferenceMs),
        );
        const cannotFinish = executed > 0 && callDeadline < totalDeadline && callDeadline - Date.now() < slowest + 500;
        if (callDeadline - Date.now() < 300 || cannotFinish || executed >= state.input.actionsPerCall) {
          stop(state, "paused", "CALL_BUDGET", "Call budget reached; resume to continue");
          break;
        }
        if (state.stepDecisions >= state.input.maxStepDecisions) {
          stop(state, "blocked", "STEP_DECISION_BUDGET", "Current-step decision budget reached");
          break;
        }
        const step = state.input.steps[state.stepIndex];
        if (!step) throw new Error("Missing current step");
        // Choose the tab once, when the step starts: a pop-up may close itself as part of the step.
        if (step.tab && state.stepDecisions === 0) await selectTab(browser, state, step.tab);
        const observed = await browser.observe();
        let controlsFiltered = false;
        const completionAssertions = step.expect
          ? [step.expect]
          : state.stepIndex === state.input.steps.length - 1
            ? state.input.expect
            : undefined;
        if (completionAssertions) {
          const currentCompletion = await evaluateAssertions(
            browser,
            completionAssertions.map((assertion) => ({ ...assertion, timeoutMs: 0 })),
          );
          if (currentCompletion.passed && step.expect) {
            state.completedSteps.push({ instruction: step.instruction, verification: "assertion" });
            state.stepIndex++;
            state.stepDecisions = 0;
            state.unchangedActions = 0;
            state.staleDecisions = 0;
            await saveRun(state);
            continue;
          }
          if (!currentCompletion.passed && observed.controls) {
            observed.controls = observed.controls.filter((operation) => operation !== "DONE");
            controlsFiltered = true;
          }
        }
        remember(state, { lastObservation: observationDebug(observed, controlsFiltered) });
        state.stepDecisions++;
        await saveRun(state);
        // An unambiguous step is resolved from the page; only the rest is put to the model.
        const fast = state.input.fastPath
          ? (dependencies.resolve ?? resolveFast)(state.input, state.stepIndex, observed, state.actions)
          : null;
        let decision: Decision;
        let inferenceMs = 0;
        if (fast) decision = fast;
        else {
          // Starting a backend on demand is not inference time, so it stays out of the pause estimate.
          await dependencies.beforeModel?.();
          const inferenceStarted = Date.now();
          decision = await dependencies.decide(
            state.input,
            state.stepIndex,
            observed,
            state.actions,
            callDeadline,
            controller.signal,
          );
          inferenceMs = Date.now() - inferenceStarted;
        }
        remember(state, {
          lastDecision: {
            operation: decision.operation,
            ...(decision.target ? { target: decision.target.label } : {}),
            confidence: decision.confidence,
            ...(decision.targetConfidence === undefined ? {} : { targetConfidence: decision.targetConfidence }),
            ...(decision.probabilities ? { probabilities: decision.probabilities } : {}),
            ...(decision.targetProbabilities ? { targetProbabilities: decision.targetProbabilities } : {}),
            ...(decision.source ? { source: decision.source } : {}),
            ...(decision.rule ? { rule: decision.rule } : {}),
            ...(decision.rounds ? { rounds: decision.rounds } : {}),
            ...(decision.model ? { model: decision.model } : {}),
            inferenceMs,
          },
        });
        if (decision.operation === "DONE") {
          const current = await browser.observe();
          if (current.fingerprint !== observed.fingerprint) {
            state.staleDecisions++;
            if (state.staleDecisions >= 6)
              throw new RunError("STALE_OBSERVATION", "Frontend kept changing during decisions");
            continue;
          }
          if (step.expect) {
            const result = await evaluateAssertions(browser, [step.expect]);
            if (!result.passed) {
              stop(
                state,
                "failed",
                "DONE_ASSERTION_FAILED",
                "The model reported DONE, but current-step assertions failed",
              );
              state.assertions = result.checks;
              remember(state, { assertionChecks: result.checks });
              break;
            }
          }
          state.completedSteps.push({
            instruction: step.instruction,
            verification: step.expect ? "assertion" : decision.source === "fast" ? "deterministic" : "model",
          });
          state.stepIndex++;
          state.stepDecisions = 0;
          state.unchangedActions = 0;
          state.staleDecisions = 0;
          await saveRun(state);
          continue;
        }
        if (decision.operation === "BLOCKED") {
          // Nothing has been tried on this step yet: the answer may be below the fold, so scroll and ask again.
          const untouched = !state.actions.some(
            (action) => action.stepIndex === state.stepIndex && action.source !== "deterministic",
          );
          const scroll = observed.controls?.includes("SCROLL_DOWN")
            ? "SCROLL_DOWN"
            : observed.controls?.includes("SCROLL_UP")
              ? "SCROLL_UP"
              : undefined;
          if (!untouched || state.blockedRetries >= state.input.blockedRetries || !scroll) {
            const retried = state.blockedRetries > 0;
            const noScroll = untouched && !scroll && state.blockedRetries < state.input.blockedRetries;
            stop(
              state,
              "blocked",
              noScroll ? "MODEL_BLOCKED_NO_SCROLL" : "MODEL_BLOCKED",
              retried
                ? `The decision backend could not complete the current step after ${state.blockedRetries} scroll retries`
                : noScroll
                  ? "The decision backend could not complete the current step and the page cannot scroll further"
                  : "The decision backend could not complete the current step",
            );
            break;
          }
          state.blockedRetries++;
          decision = {
            operation: scroll,
            target: undefined,
            confidence: 1,
            source: "deterministic",
            ...(observed.snapshotId ? { snapshotId: observed.snapshotId } : {}),
          };
        }
        if (state.actions.length >= state.input.maxActions) {
          stop(state, "blocked", "ACTION_BUDGET", "Run action budget reached");
          break;
        }
        const text =
          decision.operation === "TYPE_TEXT"
            ? await dependencies.fieldValue(state.input, step, observed, decision, callDeadline, controller.signal)
            : undefined;
        const actionId = crypto.randomUUID();
        state.pendingAction = {
          actionId,
          decision: { ...decision, actionId },
          inferenceMs,
          startedAt: Date.now(),
          ...(state.tabs ? { tabId: state.tabs.active } : {}),
        };
        await saveRun(state);
        let outcome: Awaited<ReturnType<BrowserPort["execute"]>>;
        try {
          outcome = await browser.execute(
            { ...decision, actionId, ...(step.selector ? { expectedSelector: step.selector } : {}) },
            text,
          );
        } catch (error) {
          if (!(error instanceof StaleDecisionError)) throw error;
          state.pendingAction = null;
          state.staleDecisions++;
          await saveRun(state);
          if (state.staleDecisions >= 6)
            throw new RunError("STALE_TARGET", "Selected targets kept changing before dispatch");
          continue;
        }
        recordAction(state, state.pendingAction);
        if (outcome?.dialogs) state.actions.at(-1)!.dialogs = outcome.dialogs;
        state.pendingAction = null;
        state.staleDecisions = 0;
        await saveRun(state);
        executed++;
        // Only a click or Enter can open a tab; looking costs a browser call, so look only then.
        if (["CLICK", "PRESS_ENTER"].includes(decision.operation)) {
          await syncTabs(browser, state, { opened: outcome?.opensTab === true, closed: outcome?.closesTab === true });
          await saveRun(state);
        }
        // A step the page settled itself waits for its own expectation (up to the assertion's timeout)
        // instead of asking the model whether the page has caught up.
        if (decision.source === "fast" && step.expect) {
          const result = await evaluateAssertions(browser, [step.expect]);
          if (result.passed) {
            state.completedSteps.push({ instruction: step.instruction, verification: "assertion" });
            state.stepIndex++;
            state.stepDecisions = 0;
            state.unchangedActions = 0;
            state.staleDecisions = 0;
            await saveRun(state);
            continue;
          }
        }
        const after = await browser.observe();
        // A step may state what must be true on the page once its action is done.
        if (step.assume && !step.expect && decision.source !== "deterministic") {
          // A plain "the <field> box contains <value>" is read off the page; the model only judges the rest.
          const verdict = state.input.fastPath ? assumeDeterministic(step.assume, after) : undefined;
          if (verdict === undefined) await dependencies.beforeModel?.();
          const confirmed =
            verdict ??
            (await (dependencies.assume ?? assume)(
              state.input,
              state.stepIndex,
              after,
              callDeadline,
              controller.signal,
            ));
          if (confirmed) {
            state.completedSteps.push({
              instruction: step.instruction,
              verification: verdict === true ? "deterministic" : "assumption",
            });
            state.stepIndex++;
            state.stepDecisions = 0;
            state.unchangedActions = 0;
            state.staleDecisions = 0;
            await saveRun(state);
            continue;
          }
        }
        state.unchangedActions = after.fingerprint === observed.fingerprint ? state.unchangedActions + 1 : 0;
        if (state.unchangedActions >= 3) {
          stop(state, "blocked", "NO_PAGE_CHANGE", "Three actions produced no observable frontend change");
          break;
        }
      }
      if (state.stepIndex === state.input.steps.length) {
        const expected =
          state.input.expect ??
          (state.input.steps.at(-1)?.expect
            ? [state.input.steps.at(-1)?.expect].filter((item): item is Assertion => item !== undefined)
            : []);
        if (!expected.length) throw new Error("No deterministic final assertions were configured");
        const result = await evaluateAssertions(browser, expected);
        state.assertions = result.checks;
        if (result.passed) {
          state.status = "completed";
          state.reason = null;
          state.reasonCode = null;
        } else {
          stop(state, "failed", "FINAL_ASSERTION_FAILED", "Final test assertions failed");
          remember(state, { assertionChecks: result.checks });
        }
      }
    } catch (error) {
      const failure = classify(error);
      if (state.pendingAction) {
        stop(
          state,
          "uncertain",
          "INPUT_ACK_INTERRUPTED",
          "Input acknowledgement was interrupted; recover checks a receipt without replaying input",
        );
      } else if (controller.signal.reason === "cancelled") {
        stop(state, "cancelled", "CANCELLED", "Cancelled by user");
      } else if (state.video?.status === "failed" || state.video?.status === "starting") {
        stop(
          state,
          "blocked",
          error instanceof RunError && error.code.startsWith("VIDEO_") ? error.code : "VIDEO_FAILED",
          state.video.error ?? "Video recording failed",
        );
      } else if (Date.now() >= totalDeadline) {
        stop(state, "failed", "TOTAL_DEADLINE", "Total test deadline exceeded");
      } else if (controller.signal.aborted || error instanceof BrowserDeadlineError) {
        stop(state, "paused", "CALL_DEADLINE", "Call deadline reached; resume to continue");
      } else {
        stop(state, "blocked", failure.code, failure.reason);
      }
      remember(state, {
        error: {
          name: error instanceof Error ? error.name : "Error",
          code: failure.code,
          ...(error instanceof RunError ? { message: error.message, details: error.details } : {}),
        },
      });
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
