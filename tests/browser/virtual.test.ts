import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser } from "../../src/browser.ts";
import type { RunnerDependencies } from "../../src/runner.ts";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// A virtualized list keeps about 30 rows in the DOM out of 10,000, so the row we want is not on the page
// until the list has been scrolled to it.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-virtual");
});
afterAll(async () => {
  server.stop(true);
  await restore();
});

test("an order deep in a virtualized list is found and opened", async () => {
  const result = await journey(`${server.url}virtual-list.html`, [
    { instruction: "Click Open order #08731", expect: { text: "Opened order #08731" } },
  ]);
  expect(result.status, result.reason ?? "").toBe("completed");
}, 180_000);

test("an order that does not exist ends with a clear reason instead of scrolling forever", async () => {
  const result = await journey(`${server.url}virtual-list.html`, [
    { instruction: "Click Open order #12345", expect: { text: "Opened order #12345" } },
  ]);
  expect(result.status).toBe("failed");
  expect(result.reasonCode).toBe("SEARCH_NOT_FOUND");
}, 180_000);

// A model decides from what is on screen, so a control that is not there is a BLOCKED. This stand-in clicks the
// order when its button is among the targets and says BLOCKED otherwise, as a model reading the screen would.
const seesOnlyTheScreen: RunnerDependencies["decide"] = async (_input, _step, observation) => {
  const [id, target] =
    Object.entries(observation.targets.CLICK ?? {}).find(([, candidate]) => candidate.label === "Open order #08731") ??
    [];
  return target && id
    ? {
        operation: "CLICK",
        target,
        targetId: id,
        confidence: 1,
        source: "model",
        ...(observation.snapshotId ? { snapshotId: observation.snapshotId } : {}),
      }
    : { operation: "BLOCKED", target: undefined, confidence: 1, source: "model" };
};

test("when the model says BLOCKED because the order is off screen, the search brings it into reach", async () => {
  const result = await journey(
    `${server.url}virtual-list.html`,
    [{ instruction: "Click Open order #08731", expect: { text: "Opened order #08731" } }],
    { fastPath: false },
    seesOnlyTheScreen,
  );
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
  expect(result.actions.map((action) => [action.operation, action.source])).toEqual([["CLICK", "model"]]);
}, 180_000);

async function scrollTargets(page: string) {
  const session = `jev-virtual-${crypto.randomUUID()}`;
  const browser = new Browser(session, Date.now() + 40_000);
  try {
    await browser.command(["open", `${server.url}${page}`]);
    await browser.command(["eval", "--stdin"], "new Promise((resolve) => setTimeout(resolve, 900))");
    return Object.values((await browser.observe()).targets.SCROLL_DOWN ?? {});
  } finally {
    await new Browser(session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}

test("a virtualized list says that only some of its rows exist, and a list that is all there does not", async () => {
  const orders = (await scrollTargets("virtual-list.html")).find((target) => target.label === "Orders");
  expect(orders?.scroll?.virtual).toEqual({ rendered: 30, total: 10000 });
  const feed = (await scrollTargets("infinite.html")).find((target) => target.label === "Feed");
  expect(feed?.scroll).toBeDefined();
  expect(feed?.scroll?.virtual).toBeUndefined();
}, 90_000);

test("with two lists that have the same rows, the search looks in the list the step names", async () => {
  const invoices = await journey(`${server.url}two-lists.html`, [
    { instruction: "Click Open item #04217 in the Invoices list", expect: { text: "Opened invoices item #04217" } },
  ]);
  expect(invoices.status, JSON.stringify({ reason: invoices.reason, debug: invoices.debug })).toBe("completed");
  const orders = await journey(`${server.url}two-lists.html`, [
    { instruction: "Click Open item #00777 in the Orders list", expect: { text: "Opened orders item #00777" } },
  ]);
  expect(orders.status, JSON.stringify({ reason: orders.reason, debug: orders.debug })).toBe("completed");
}, 240_000);
