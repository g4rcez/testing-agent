import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser } from "../../src/browser.ts";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// A strip that scrolls sideways and holds 1,000 columns, of which about a dozen are in the page.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-horizontal");
});
afterAll(async () => {
  server.stop(true);
  await restore();
});

test("a strip that scrolls sideways is reported as a target to scroll right, and its clipped controls are not offered", async () => {
  const session = `jev-horizontal-${crypto.randomUUID()}`;
  const browser = new Browser(session, Date.now() + 40_000);
  try {
    await browser.command(["open", `${server.url}virtual-grid.html`]);
    const observed = await browser.observe();
    const right = Object.values(observed.targets.SCROLL_RIGHT ?? {});
    expect(right.map((target) => target.label)).toContain("Columns");
    expect(Object.keys(observed.targets.SCROLL_LEFT ?? {})).toHaveLength(0);
    const clickable = Object.values(observed.targets.CLICK ?? {}).map((target) => target.label);
    expect(clickable).toContain("Open column #0001");
    expect(clickable).not.toContain("Open column #0012");
  } finally {
    await new Browser(session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}, 90_000);

test("scrolling right in a named strip shows the columns after the first ones", async () => {
  const result = await journey(`${server.url}virtual-grid.html`, [
    { instruction: "Scroll right in the Columns list" },
    { instruction: "Click Open column #0008", expect: { text: "Opened column #0008" } },
  ]);
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
  expect(result.actions[0]).toMatchObject({ operation: "SCROLL_RIGHT", rule: "scroll" });
}, 180_000);

test("a column far along a strip is found by scrolling sideways", async () => {
  const result = await journey(`${server.url}virtual-grid.html`, [
    { instruction: "Click Open column #0640", expect: { text: "Opened column #0640" } },
  ]);
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
}, 180_000);
