import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../src/browser.ts";
import { runSchema } from "../../src/contracts.ts";
import { defaultDependencies, startRun } from "../../src/runner.ts";

// A form whose result arrives a moment later: the step's expectation is awaited across the navigation.
// This is end-to-end coverage of a slow submission. It does not reproduce the failed-read bug seen on
// Wikipedia (agent-browser waits across a navigation here, and passes with or without the retry); that
// failure is injected deterministically in tests/unit/browser-retry.test.ts and tests/unit/runner.test.ts.
const form = `<form action="/search"><input name="q" aria-label="Query"><button type="submit">Go</button></form>`;
const SERVER_DELAY_MS = 700;

let server: ReturnType<typeof Bun.serve>;
let state: string;
const previousState = process.env.JEV_STATE_DIR;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/search") {
        await Bun.sleep(SERVER_DELAY_MS);
        const body = `<h1>Result for ${url.searchParams.get("q")}</h1>${form}`;
        return new Response(`<!doctype html><title>Results</title><body>${body}`, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(`<!doctype html><title>Search</title><body><h1>Search page</h1>${form}`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  state = await mkdtemp(join(tmpdir(), "jev-navigation-"));
  process.env.JEV_STATE_DIR = state;
});
afterAll(async () => {
  server.stop(true);
  if (previousState === undefined) delete process.env.JEV_STATE_DIR;
  else process.env.JEV_STATE_DIR = previousState;
  await rm(state, { recursive: true, force: true });
});

test("a step whose expectation is awaited across a slow form submission completes without the model", async () => {
  const session = `jev-navigation-${crypto.randomUUID()}`;
  try {
    const result = await startRun(
      runSchema.parse({
        prompt: "Search for ipv4",
        steps: [
          { instruction: "Type ipv4 into the Query box", value: "ipv4" },
          { instruction: "Press Enter in the Query box to search", expect: { text: "Result for ipv4" } },
        ],
        backend: { provider: "laya" },
        session,
        url: String(server.url),
        actionsPerCall: 10,
        timeoutMs: 40_000,
      }),
      {
        ...defaultDependencies,
        decide: async () => {
          throw new Error("the model must not be asked");
        },
      },
    );
    expect(result.status, `${result.reasonCode}: ${result.reason}`).toBe("completed");
    expect(result.actions.map((action) => [action.operation, action.source])).toEqual([
      ["TYPE_TEXT", "fast"],
      ["PRESS_ENTER", "fast"],
    ]);
    expect(result.completedSteps.at(-1)?.verification).toBe("assertion");
    // The navigation was in flight while the expectation was awaited.
    expect(result.endedAt! - result.createdAt).toBeGreaterThan(SERVER_DELAY_MS);
  } finally {
    await new Browser(session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}, 90_000);
