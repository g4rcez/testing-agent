import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  BrowserCommandRejectedError,
  StaleDecisionError,
} from "../../src/browser.ts";
import {
  runSchema,
  type Decision,
  type Observation,
} from "../../src/contracts.ts";
import {
  resumeRun,
  recoverRun,
  saveRun,
  startRun,
  cancelRun,
  summarize,
  type RunnerDependencies,
} from "../../src/runner.ts";

let directory: string;
const previousRoot = process.env.JEV_STATE_DIR;
const previousSession = process.env.AGENT_BROWSER_SESSION;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jev-unit-"));
  process.env.JEV_STATE_DIR = directory;
  delete process.env.AGENT_BROWSER_SESSION;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.JEV_STATE_DIR;
  else process.env.JEV_STATE_DIR = previousRoot;
  if (previousSession === undefined) delete process.env.AGENT_BROWSER_SESSION;
  else process.env.AGENT_BROWSER_SESSION = previousSession;
});
const input = () =>
  runSchema.parse({
    prompt: "Use this app",
    steps: ["Enable the setting", "Open the result"],
    backend: { provider: "laya" },
    session: "unit",
    actionsPerCall: 1,
    expect: [{ text: "App", timeoutMs: 0 }],
  });
const observed = (fingerprint = "a", tree = "App"): Observation => ({
  url: "https://example.com",
  tree,
  fingerprint,
  targets: {},
  elements: [],
});
const decision = (operation: string): Decision => ({
  operation,
  target: undefined,
  confidence: 1,
});

test("resumes the same ordered steps without repeating acknowledged browser input", async () => {
  let actions = 0;
  const chosenSteps: number[] = [];
  const executed: string[] = [];
  const commands: string[][] = [];
  const dependencies: RunnerDependencies = {
    browser: (_session, _deadline, _signal, config) => {
      expect(config).toEqual({ args: { headed: false } });
      return {
        command: async (args) => {
          commands.push(args);
          return {};
        },
        observe: async () => observed(String(actions)),
        execute: async (d) => {
          actions++;
          executed.push(d.operation);
        },
      };
    },
    decide: async (_input, index) => {
      chosenSteps.push(index);
      return decision(
        actions > index ? "DONE" : index === 0 ? "CHECK" : "CLICK",
      );
    },
    fieldValue: async () => "unused",
  };
  const first = await startRun(
    { ...input(), recordVideo: true, browser: { args: { headed: false } } },
    dependencies,
  );
  expect(first.status).toBe("paused");
  expect(commands.map((args) => args.slice(0, 2))).toEqual([
    ["record", "start"],
  ]);
  const second = await resumeRun(first.runId, dependencies);
  expect(second.status).toBe("paused");
  const final = await resumeRun(first.runId, dependencies);
  expect(final.status).toBe("completed");
  expect(final.completedSteps.map((step) => step.instruction)).toEqual(
    input().steps.map((step) => step.instruction),
  );
  expect(chosenSteps).toEqual([0, 0, 1, 1]);
  expect(executed).toEqual(["CHECK", "CLICK"]);
  await resumeRun(first.runId, dependencies);
  expect(executed).toHaveLength(2);
  expect(commands.map((args) => args.slice(0, 2))).toEqual([
    ["record", "start"],
    ["record", "stop"],
  ]);
  expect(final.video?.status).toBe("saved");
  expect(summarize(final).passed).toBe(true);
  expect(summarize(final).steps.map((step) => step.status)).toEqual([
    "passed",
    "passed",
  ]);
});

test("recording start/stop failures never report a passed test", async () => {
  for (const failure of ["start", "stop"]) {
    const result = await startRun(
      { ...input(), recordVideo: true },
      {
        browser: () => ({
          command: async (args) => {
            if (args[1] === failure) throw new Error("private browser detail");
            return {};
          },
          observe: async () => observed(),
          execute: async () => {},
        }),
        decide: async () => decision("DONE"),
        fieldValue: async () => "unused",
      },
    );
    expect(result.video?.status).toBe("failed");
    expect(summarize(result).passed).toBe(false);
    expect(result.reason).not.toContain("private browser detail");
    expect(result.status).toBe(failure === "start" ? "blocked" : "failed");
  }
});

test("uncertain video startup cleans only a newly generated session", async () => {
  for (const kind of ["new", "reused", "rejected"] as const) {
    const commands: string[][] = [];
    const result = await startRun(
      {
        ...input(),
        session: kind === "reused" ? "unit" : undefined,
        url: "https://example.com",
        recordVideo: true,
      },
      {
        browser: () => ({
          command: async (args) => {
            commands.push(args);
            if (args[1] === "start")
              throw kind === "rejected"
                ? new BrowserCommandRejectedError("Already recording")
                : new Error("Lost start acknowledgement");
            return {};
          },
          observe: async () => observed(),
          execute: async () => {},
        }),
        decide: async () => decision("DONE"),
        fieldValue: async () => "unused",
      },
    );
    expect(result.status).toBe("blocked");
    expect(result.video?.status).toBe("failed");
    expect(commands.filter((args) => args[1] === "stop")).toHaveLength(
      kind === "new" ? 1 : 0,
    );
    if (kind === "reused") expect(result.video?.error).toContain("manually");
  }
});

test("cancellation during video startup preserves cancelled status and cleans the owned recording", async () => {
  const commands: string[][] = [];
  const result = await startRun(
    {
      ...input(),
      session: undefined,
      url: "https://example.com",
      recordVideo: true,
    },
    {
      browser: (_session, _deadline, signal) => ({
        command: async (args) => {
          commands.push(args);
          if (args[1] === "start") {
            if (!signal || !args[2])
              throw new Error("Missing recording context");
            const aborted = new Promise<never>((_resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new Error("Aborted")),
                { once: true },
              ),
            );
            await Bun.write(
              join(directory, basename(args[2], ".webm") + ".cancel"),
              "1",
            );
            return aborted;
          }
          expect(signal).toBeUndefined();
          return {};
        },
        observe: async () => observed(),
        execute: async () => {},
      }),
      decide: async () => decision("DONE"),
      fieldValue: async () => "unused",
    },
  );
  expect(result.status).toBe("cancelled");
  expect(result.video?.status).toBe("failed");
  expect(commands.map((args) => args.slice(0, 2))).toEqual([
    ["record", "start"],
    ["record", "stop"],
  ]);
});

test("an acknowledged video start remains eligible for cleanup when persistence fails", async () => {
  let savedPath = "";
  const commands: string[][] = [];
  const result = await startRun(
    { ...input(), recordVideo: true },
    {
      browser: () => ({
        command: async (args) => {
          commands.push(args);
          if (args[1] === "start" && args[2]) {
            savedPath = join(directory, basename(args[2], ".webm") + ".json");
            await rename(savedPath, savedPath + ".backup");
            await mkdir(savedPath);
          } else if (args[1] === "stop") {
            await rm(savedPath, { recursive: true });
            await rename(savedPath + ".backup", savedPath);
          }
          return {};
        },
        observe: async () => observed(),
        execute: async () => {},
      }),
      decide: async () => decision("DONE"),
      fieldValue: async () => "unused",
    },
  );
  expect(result.status).toBe("blocked");
  expect(result.video?.status).toBe("saved");
  expect(commands.map((args) => args.slice(0, 2))).toEqual([
    ["record", "start"],
    ["record", "stop"],
  ]);
});

test("paused cancellation finalizes video with an independent cleanup signal", async () => {
  const commands: string[][] = [];
  const dependencies: RunnerDependencies = {
    browser: (_session, _deadline, signal) => ({
      command: async (args) => {
        if (args[1] === "stop") expect(signal).toBeUndefined();
        commands.push(args);
        return {};
      },
      observe: async () => observed(),
      execute: async () => {},
    }),
    decide: async () => decision("CLICK"),
    fieldValue: async () => "unused",
  };
  const paused = await startRun(
    { ...input(), recordVideo: true },
    dependencies,
  );
  expect(paused.status).toBe("paused");
  const cancelled = await cancelRun(paused.runId, dependencies);
  expect(cancelled.status).toBe("cancelled");
  expect(commands.map((args) => args.slice(0, 2))).toEqual([
    ["record", "start"],
    ["record", "stop"],
  ]);
});

test("failed step output includes remaining skipped steps and preserves final assertion failure", async () => {
  const dependencies: RunnerDependencies = {
    browser: () => ({
      command: async () => ({}),
      observe: async () => observed(),
      execute: async () => {},
    }),
    decide: async () => decision("BLOCKED"),
    fieldValue: async () => "unused",
  };
  const blocked = await startRun(input(), dependencies);
  expect(summarize(blocked).steps.map((step) => step.status)).toEqual([
    "failed",
    "skipped",
  ]);
  const failed = await startRun(
    { ...input(), expect: [{ text: "Missing", timeoutMs: 0 }] },
    { ...dependencies, decide: async () => decision("DONE") },
  );
  expect(summarize(failed).steps.every((step) => step.success)).toBe(true);
  expect(summarize(failed).passed).toBe(false);
});

test("discards a stale decision before any input", async () => {
  let observations = 0;
  let predictions = 0;
  const result = await startRun(
    { ...input(), steps: [{ instruction: "Open result" }] },
    {
      browser: () => ({
        command: async () => ({}),
        observe: async () => observed(observations++ === 0 ? "old" : "new"),
        execute: async () => {
          throw new StaleDecisionError("changed before dispatch");
        },
      }),
      decide: async () => decision(predictions++ === 0 ? "CLICK" : "DONE"),
      fieldValue: async () => "unused",
    },
  );
  expect(result.status).toBe("completed");
  expect(result.actions).toHaveLength(0);
  expect(result.pendingAction).toBeNull();
  expect(predictions).toBe(2);
});

test("rejects premature DONE when an explicit completion assertion fails", async () => {
  const result = await startRun(
    {
      ...input(),
      steps: [
        {
          instruction: "Open the result",
          expect: { text: "Result details", timeoutMs: 0 },
        },
      ],
    },
    {
      browser: () => ({
        command: async () => ({}),
        observe: async () => observed(),
        execute: async () => {
          throw new Error("should not execute");
        },
      }),
      decide: async () => decision("DONE"),
      fieldValue: async () => "unused",
    },
  );
  expect(result.status).toBe("failed");
  expect(result.completedSteps).toHaveLength(0);
  expect(result.reason).toContain("assertions failed");
});

test("never retries an input whose acknowledgement was lost", async () => {
  let executed = 0;
  const dependencies: RunnerDependencies = {
    browser: () => ({
      command: async () => ({}),
      observe: async () => observed(),
      execute: async () => {
        executed++;
        throw new Error("lost acknowledgement after click");
      },
    }),
    decide: async () => decision("CLICK"),
    fieldValue: async () => "unused",
  };
  const result = await startRun(input(), dependencies);
  expect(result.status).toBe("uncertain");
  await resumeRun(result.runId, dependencies);
  expect(executed).toBe(1);
});

test("recovery does not continue actions after an uncertain run finalized its video", async () => {
  let inputs = 0;
  const commands: string[][] = [];
  const dependencies: RunnerDependencies = {
    browser: () => ({
      command: async (args) => {
        commands.push(args);
        return {};
      },
      observe: async () => observed(),
      execute: async () => {
        inputs++;
        throw new Error("Lost acknowledgement");
      },
      receipt: async () => "executed",
    }),
    decide: async () => decision("CLICK"),
    fieldValue: async () => "unused",
  };
  const uncertain = await startRun(
    { ...input(), recordVideo: true },
    dependencies,
  );
  expect(uncertain.status).toBe("uncertain");
  expect(uncertain.video?.status).toBe("saved");
  const recovered = await recoverRun(uncertain.runId, dependencies);
  expect(recovered.status).toBe("blocked");
  expect(recovered.reason).toContain("Video recording has already ended");
  expect(inputs).toBe(1);
  expect(commands.map((args) => args.slice(0, 2))).toEqual([
    ["record", "start"],
    ["record", "stop"],
  ]);
});

test("detects a process interrupted after persisting its input intent", async () => {
  const dependencies: RunnerDependencies = {
    browser: () => ({
      command: async () => ({}),
      observe: async () => observed(),
      execute: async () => {},
    }),
    decide: async () => decision("BLOCKED"),
    fieldValue: async () => "unused",
  };
  const state = await startRun(input(), dependencies);
  state.status = "running";
  state.pendingAction = {
    actionId: crypto.randomUUID(),
    decision: { operation: "CLICK", confidence: 1 },
    inferenceMs: 0,
    startedAt: Date.now(),
  };
  await saveRun(state);
  expect((await resumeRun(state.runId, dependencies)).status).toBe("uncertain");
});

test("can accept DONE after the last permitted action", async () => {
  let executed = 0;
  const result = await startRun(
    {
      ...input(),
      steps: [{ instruction: "Open result" }],
      maxActions: 1,
      actionsPerCall: 2,
    },
    {
      browser: () => ({
        command: async () => ({}),
        observe: async () => observed(String(executed)),
        execute: async () => {
          executed++;
        },
      }),
      decide: async () => decision(executed ? "DONE" : "CLICK"),
      fieldValue: async () => "unused",
    },
  );
  expect(result.status).toBe("completed");
  expect(executed).toBe(1);
});

for (const kind of ["call", "total"] as const) {
  test(`${kind} deadlines abort pending decisions and preserve the correct status`, async () => {
    const commands: string[][] = [];
    const result = await startRun(
      {
        ...input(),
        recordVideo: true,
        timeoutMs: kind === "call" ? 1000 : 45000,
        totalTimeoutMs: kind === "total" ? 1000 : 10000,
      },
      {
        browser: (_session, _deadline, signal) => ({
          command: async (args) => {
            if (args[1] === "stop") expect(signal).toBeUndefined();
            commands.push(args);
            return {};
          },
          observe: async () => observed(),
          execute: async () => {
            throw new Error("No input expected");
          },
        }),
        decide: async (
          _input,
          _index,
          _observed,
          _history,
          _deadline,
          signal,
        ) =>
          new Promise((_resolve, reject) => {
            if (!signal) throw new Error("Missing cancellation signal");
            signal.addEventListener(
              "abort",
              () => reject(new Error("Aborted")),
              { once: true },
            );
          }),
        fieldValue: async () => "unused",
      },
    );
    expect(result.status).toBe(kind === "call" ? "paused" : "failed");
    expect(result.actions).toHaveLength(0);
    expect(result.video?.status).toBe(kind === "call" ? "recording" : "saved");
    expect(commands.filter((args) => args[1] === "stop")).toHaveLength(
      kind === "call" ? 0 : 1,
    );
  }, 5000);
}
