import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSchema,
  type Decision,
  type Observation,
} from "../../src/contracts.ts";
import {
  resumeRun,
  saveRun,
  startRun,
  type RunnerDependencies,
} from "../../src/runner.ts";

let directory: string;
const previousRoot = process.env.JEV_STATE_DIR;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jev-unit-"));
  process.env.JEV_STATE_DIR = directory;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.JEV_STATE_DIR;
  else process.env.JEV_STATE_DIR = previousRoot;
});
const input = () =>
  runSchema.parse({
    prompt: "Use this app",
    steps: ["Enable the setting", "Open the result"],
    backend: { provider: "laya" },
    session: "unit",
    actionsPerCall: 1,
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
  const dependencies: RunnerDependencies = {
    browser: () => ({
      command: async () => ({}),
      observe: async () => observed(String(actions)),
      execute: async (d) => {
        actions++;
        executed.push(d.operation);
      },
    }),
    decide: async (_input, index) => {
      chosenSteps.push(index);
      return decision(
        actions > index ? "DONE" : index === 0 ? "CHECK" : "CLICK",
      );
    },
    fieldValue: async () => "unused",
  };
  const first = await startRun(input(), dependencies);
  expect(first.status).toBe("paused");
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
});

test("discards a stale decision before any input", async () => {
  let observations = 0;
  let predictions = 0;
  let executed = 0;
  const result = await startRun(
    { ...input(), steps: [{ instruction: "Open result" }] },
    {
      browser: () => ({
        command: async () => ({}),
        observe: async () => observed(observations++ === 0 ? "old" : "new"),
        execute: async () => {
          executed++;
        },
      }),
      decide: async () => decision(predictions++ === 0 ? "CLICK" : "DONE"),
      fieldValue: async () => "unused",
    },
  );
  expect(result.status).toBe("completed");
  expect(executed).toBe(0);
  expect(predictions).toBe(2);
});

test("rejects premature DONE when an explicit completion assertion fails", async () => {
  const result = await startRun(
    {
      ...input(),
      steps: [
        { instruction: "Open the result", expect: { text: "Result details" } },
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
  expect(result.status).toBe("blocked");
  expect(result.completedSteps).toHaveLength(0);
  expect(result.reason).toContain("expected text or URL");
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
  state.pendingAction = "CLICK";
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
