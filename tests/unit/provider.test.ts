import { expect, test } from "bun:test";
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
