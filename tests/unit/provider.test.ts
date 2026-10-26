import { expect, test } from "bun:test";
import { BrowserDeadlineError } from "../../src/browser.ts";
import { RunError } from "../../src/diagnostics.ts";
import { backendConfig, decide, fieldValue } from "../../src/decision.ts";
import { runSchema, type Observation } from "../../src/contracts.ts";

const page: Observation = {
  url: "https://example.com",
  tree: "App",
  fingerprint: "one",
  elements: [],
  targets: { CLICK: { e1: { ref: "@e1", label: "Continue" } } },
};

test("provider HTTP failures stop before an executable decision exists", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("unavailable", { status: 503 }),
  });
  try {
    const input = runSchema.parse({
      prompt: "Continue",
      expect: [{ text: "App" }],
      steps: ["Click Continue"],
      session: "test",
      backend: { provider: "laya", baseUrl: String(server.url) },
    });
    await expect(decide(input, 0, page, [], Date.now() + 1000)).rejects.toThrow("HTTP 503");
  } finally {
    server.stop(true);
  }
});

const operations = ["PRESS_ENTER", "SCROLL_DOWN", "SCROLL_UP", "WAIT", "DONE", "BLOCKED", "CLICK"];
const pressEnter = {
  answers: {
    operation: {
      choice: "PRESS_ENTER",
      confidence: 1,
      probabilities: Object.fromEntries(operations.map((key) => [key, key === "PRESS_ENTER" ? 1 : 0])),
    },
  },
};
const decisionInput = (baseUrl: string, timeoutMs?: number) =>
  runSchema.parse({
    prompt: "Continue",
    expect: [{ text: "App" }],
    steps: ["Click Continue"],
    session: "test",
    backend: { provider: "laya", baseUrl, ...(timeoutMs ? { timeoutMs } : {}) },
  });

test("waits for a busy local model instead of failing the decision", async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => (++calls === 1 ? new Response("busy", { status: 503 }) : Response.json(pressEnter)),
  });
  try {
    const decision = await decide(decisionInput(String(server.url)), 0, page, [], Date.now() + 10_000);
    expect(decision.operation).toBe("PRESS_ENTER");
    expect(calls).toBe(2);
  } finally {
    server.stop(true);
  }
});

test("a decision cut off by the call deadline is a deadline error, not a failed decision", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      await Bun.sleep(1500);
      return Response.json(pressEnter);
    },
  });
  try {
    await expect(decide(decisionInput(String(server.url)), 0, page, [], Date.now() + 300)).rejects.toBeInstanceOf(
      BrowserDeadlineError,
    );
  } finally {
    server.stop(true);
  }
});

test("a refused connection is a backend error, never a pause, even close to the call deadline", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const baseUrl = String(closed.url);
  closed.stop(true);
  const error = await decide(decisionInput(baseUrl), 0, page, [], Date.now() + 5000).catch(
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(RunError);
  expect((error as RunError).code).toBe("BACKEND_UNREACHABLE");
});

test("backend.timeoutMs bounds how long one decision may take", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      await Bun.sleep(2500);
      return Response.json(pressEnter);
    },
  });
  try {
    await expect(decide(decisionInput(String(server.url), 1000), 0, page, [], Date.now() + 20_000)).rejects.toThrow(
      "did not answer within 1000 ms",
    );
  } finally {
    server.stop(true);
  }
});

test("local Laya is asked for the operation first and for a target only when one is needed", async () => {
  const sent: string[][] = [];
  let chosen = "PRESS_ENTER";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = (await request.json()) as { only?: string[]; questions: Record<string, { criteria: object }> };
      sent.push(body.only ?? []);
      const answers: Record<string, unknown> = {};
      for (const name of body.only ?? Object.keys(body.questions)) {
        const keys = name === "operation" ? operations : Object.keys(body.questions[name]!.criteria);
        const choice = name === "operation" ? chosen : "e1";
        answers[name] = {
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
        };
      }
      return Response.json({ answers });
    },
  });
  try {
    const input = decisionInput(String(server.url));
    expect(await decide(input, 0, page, [], Date.now() + 5000)).toMatchObject({ operation: "PRESS_ENTER" });
    expect(sent).toEqual([["operation"]]);
    sent.length = 0;
    chosen = "CLICK";
    expect(await decide(input, 0, page, [], Date.now() + 5000)).toMatchObject({ operation: "CLICK", targetId: "e1" });
    expect(sent).toEqual([["operation"], ["click_target"]]);
  } finally {
    server.stop(true);
  }
});

const crowded = (count: number): Observation => ({
  ...page,
  targets: {
    CLICK: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `e${index + 1}`,
        { ref: `e${index + 1}`, label: `Item ${index + 1}`, role: "button" },
      ]),
    ),
  },
});

// A scripted model that picks the option whose description holds "Item 47", else the first one.
function wantsItem47() {
  const asked: Array<{ only?: string[] | undefined; options: number }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = (await request.json()) as {
        only?: string[];
        questions: Record<string, { criteria: Record<string, { element?: string }> }>;
      };
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(body.questions)) {
        if (body.only && !body.only.includes(name)) continue;
        const keys = name === "operation" ? operations : Object.keys(question.criteria);
        const found = keys.find((key) => question.criteria[key]?.element?.endsWith("Item 47"));
        const choice = name === "operation" ? "CLICK" : (found ?? keys[0]!);
        asked.push({ ...(body.only ? { only: body.only } : {}), options: keys.length });
        answers[name] = {
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
        };
      }
      return Response.json({ answers });
    },
  });
  return { server, asked };
}

test("a long list of controls is asked in groups and the group winners decide", async () => {
  const { server, asked } = wantsItem47();
  try {
    const decision = await decide(decisionInput(String(server.url)), 0, crowded(60), [], Date.now() + 10_000);
    expect(decision).toMatchObject({ operation: "CLICK", targetId: "e47", rounds: 4 });
    expect(decision.target?.label).toBe("Item 47");
    expect(asked.map((request) => request.options)).toEqual([operations.length, 25, 25, 10, 3]);
  } finally {
    server.stop(true);
  }
});

test("a list that fits one group, or chunkSize 0, is asked in a single target round", async () => {
  for (const { count, chunkSize } of [
    { count: 25, chunkSize: undefined },
    { count: 30, chunkSize: undefined },
    { count: 60, chunkSize: 0 },
    { count: 60, chunkSize: 100 },
  ]) {
    const { server, asked } = wantsItem47();
    try {
      const input = runSchema.parse({
        prompt: "Continue",
        expect: [{ text: "App" }],
        steps: ["Click Item 47"],
        session: "test",
        backend: { provider: "laya", baseUrl: String(server.url), ...(chunkSize === undefined ? {} : { chunkSize }) },
      });
      const decision = await decide(input, 0, crowded(count), [], Date.now() + 10_000);
      expect(decision.rounds).toBeUndefined();
      expect(asked).toHaveLength(2);
      expect(asked[1]?.only).toEqual(["click_target"]);
    } finally {
      server.stop(true);
    }
  }
});

test("local Laya waits longer by default than a hosted endpoint", () => {
  expect(backendConfig({ provider: "laya" }).timeoutMs).toBe(60_000);
  expect(backendConfig({ provider: "laya", timeoutMs: 5000 }).timeoutMs).toBe(5000);
});

test("rejects an invented target returned over the provider wire", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body: unknown = await request.json();
      const operations = ["PRESS_ENTER", "SCROLL_DOWN", "SCROLL_UP", "WAIT", "DONE", "BLOCKED", "CLICK"];
      expect(body).toHaveProperty("questions.click_target");
      return Response.json({
        answers: {
          operation: {
            choice: "CLICK",
            confidence: 1,
            probabilities: Object.fromEntries(operations.map((key) => [key, key === "CLICK" ? 1 : 0])),
          },
          click_target: { choice: "invented", confidence: 1, probabilities: { invented: 1 } },
        },
      });
    },
  });
  try {
    const input = runSchema.parse({
      prompt: "Continue",
      expect: [{ text: "App" }],
      steps: ["Click Continue"],
      session: "test",
      backend: { provider: "laya", baseUrl: String(server.url) },
    });
    await expect(decide(input, 0, page, [], Date.now() + 1000)).rejects.toThrow("invalid choices");
  } finally {
    server.stop(true);
  }
});

test("an explicit field value requires no generation endpoint", async () => {
  const input = runSchema.parse({
    prompt: "Search",
    expect: [{ text: "App" }],
    steps: [{ instruction: "Search Lisbon", value: "Lisbon" }],
    session: "test",
    backend: { provider: "laya" },
  });
  expect(
    await fieldValue(
      input,
      { instruction: "Search Lisbon", value: "Lisbon" },
      page,
      { operation: "TYPE_TEXT", target: undefined, confidence: 1 },
      Date.now() + 1000,
    ),
  ).toBe("Lisbon");
});

test("requires configured Jev authentication before using the browser", () => {
  expect(() => backendConfig({ provider: "jev", apiKeyEnv: "JEV_MISSING_TEST_KEY" })).toThrow("requires");
});
