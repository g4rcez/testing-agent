import { afterAll, beforeAll, expect, test } from "bun:test";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// A single-page app: routes show a skeleton before their content, a sticky header covers the top of the page, and
// going back leaves the row that was clicked right under that header.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-spa");
});
afterAll(async () => {
  server.stop(true);
  await restore();
});

test("a link is clicked while the route is still a skeleton, and again after going back to find it under the header", async () => {
  const result = await journey(`${server.url}spa.html`, [
    { instruction: "Click Report 7", expect: { text: "Report 7 details" } },
    { instruction: "Click Back to reports", expect: { text: "Report 30" } },
    { instruction: "Click Report 7", expect: { text: "Report 7 details" } },
  ]);
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
  expect(result.actions.map((action) => action.operation)).toEqual(["CLICK", "CLICK", "CLICK"]);
}, 180_000);

test("a link asked for while a slow route is still a skeleton is waited for, not reported missing", async () => {
  const result = await journey(`${server.url}spa.html?delay=2500`, [
    { instruction: "Click Report 7", expect: { text: "Report 7 details" } },
  ]);
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
}, 180_000);

test("after a click, a page that is slow to show its result is waited for, not searched for the control it just clicked", async () => {
  // The route after the click takes longer than the step's expectation waits, so the step is still open while the
  // page shows a skeleton with none of its controls. A model that is asked says to wait.
  const waits: Parameters<typeof journey>[3] = async (_input, _step, observation) => ({
    operation: "WAIT",
    target: undefined,
    confidence: 1,
    source: "model",
    ...(observation.snapshotId ? { snapshotId: observation.snapshotId } : {}),
  });
  const result = await journey(
    `${server.url}spa.html?after=3000`,
    [{ instruction: "Click Report 7", expect: { text: "Report 7 details" } }],
    {},
    waits,
  );
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
}, 180_000);
