import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../src/browser.ts";
import { runSchema } from "../../src/contracts.ts";
import { defaultDependencies, startRun } from "../../src/runner.ts";

// Controls inside a scrolling list are out of reach until the list is scrolled. The page reports the
// list, what it hides and where; the runner scrolls the right one.
const item = (n: number) => `<li><button onclick="out.textContent='Picked: Item ${n}'">Item ${n}</button></li>`;
const filter = (n: number) => `<button onclick="out.textContent='Filter: ${n}'">Filter ${n}</button>`;
const app = `<!doctype html><title>Scroll</title><body style="margin:0">
<h2>Countries</h2>
<ul id=countries style="height:160px;overflow:auto;margin:0;padding:0;list-style:none">
${Array.from({ length: 40 }, (_, index) => item(index + 1)).join("")}</ul>
<h2>Filters</h2>
<div id=filters style="height:90px;overflow:auto">${Array.from({ length: 12 }, (_, index) => filter(index + 1)).join("<br>")}</div>
<p id=out>Nothing picked</p></body>`;

let server: ReturnType<typeof Bun.serve>;
let state: string;
const previousState = process.env.JEV_STATE_DIR;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(app, { headers: { "content-type": "text/html" } }),
  });
  state = await mkdtemp(join(tmpdir(), "jev-scroll-"));
  process.env.JEV_STATE_DIR = state;
});
afterAll(async () => {
  server.stop(true);
  if (previousState === undefined) delete process.env.JEV_STATE_DIR;
  else process.env.JEV_STATE_DIR = previousState;
  await rm(state, { recursive: true, force: true });
});

test("a scrolling list is reported with what it hides, and its hidden controls are not offered as targets", async () => {
  const session = `jev-scroll-${crypto.randomUUID()}`;
  const browser = new Browser(session, Date.now() + 40_000);
  try {
    await browser.command(["open", String(server.url)]);
    const observed = await browser.observe();
    const clickable = Object.values(observed.targets.CLICK ?? {}).map((target) => target.label);
    expect(clickable).toContain("Item 1");
    expect(clickable).not.toContain("Item 30");
    const down = Object.values(observed.targets.SCROLL_DOWN ?? {});
    const countries = down.find((target) => target.label === "Countries");
    expect(countries?.role).toBe("scrollable");
    expect(countries?.scroll?.above).toBe(0);
    expect(countries?.scroll?.below).toBeGreaterThan(30);
    expect(countries?.scroll?.belowLabels).toContain("Item 30");
    expect(down.map((target) => target.label)).toContain("Filters");
    expect(Object.keys(observed.targets.SCROLL_UP ?? {})).toHaveLength(0);
    // The page itself does not scroll, so there is no "Page" option here.
    expect(down.map((target) => target.label)).not.toContain("Page");
    expect(observed.text).not.toContain("Item 30");
  } finally {
    await new Browser(session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}, 60_000);

async function journey(steps: unknown[]) {
  const session = `jev-scroll-${crypto.randomUUID()}`;
  try {
    return await startRun(
      runSchema.parse({
        prompt: "Pick things out of scrolling lists",
        steps,
        backend: { provider: "laya" },
        session,
        url: String(server.url),
        actionsPerCall: 30,
        maxStepDecisions: 30,
        timeoutMs: 40_000,
      }),
      {
        ...defaultDependencies,
        decide: async () => {
          throw new Error("the model must not be asked");
        },
      },
    );
  } finally {
    await new Browser(session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}

test("a control hidden in a list is scrolled into view and clicked without the model", async () => {
  const result = await journey([
    { instruction: "Click Item 30", expect: { text: "Picked: Item 30" } },
    { instruction: "Click Filter 9", expect: { text: "Filter: 9" } },
  ]);
  expect(result.status, result.reason ?? "").toBe("completed");
  const operations = result.actions.map((action) => action.operation);
  expect(operations.at(-1)).toBe("CLICK");
  expect(operations.filter((operation) => operation === "SCROLL_DOWN").length).toBeGreaterThan(2);
  expect(result.actions.every((action) => action.source === "fast")).toBe(true);
  expect(result.actions.filter((action) => action.rule === "reveal").length).toBeGreaterThan(2);
}, 120_000);

test("scrolling can be asked for by container name", async () => {
  const result = await journey([
    { instruction: "Scroll down the Countries list" },
    { instruction: "Click Item 20", expect: { text: "Picked: Item 20" } },
  ]);
  expect(result.status, result.reason ?? "").toBe("completed");
  expect(result.actions[0]).toMatchObject({ operation: "SCROLL_DOWN", rule: "scroll" });
}, 120_000);
