import { afterAll, beforeAll, expect, test } from "bun:test";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// 600 small links fill the screen, and the button the step needs is the last control in the document. Only 150
// controls are offered, so which 150 decides whether the button can be reached at all.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-dense");
});
afterAll(async () => {
  server.stop(true);
  await restore();
});

test("a button on a screen crowded with links is offered, because the controls offered are the ones the step is about", async () => {
  const result = await journey(`${server.url}dense.html`, [
    { instruction: "Click Confirm subscription", expect: { text: "Subscription confirmed" } },
  ]);
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
  expect(result.actions.map((action) => [action.operation, action.source])).toEqual([["CLICK", "fast"]]);
}, 120_000);
