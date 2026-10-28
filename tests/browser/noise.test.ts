import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser } from "../../src/browser.ts";
import { runSchema } from "../../src/contracts.ts";
import { makeRequest } from "../../src/decision.ts";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// 1,500 menu links come before the article, so they use up the controls offered to the model before the
// button we need is reached.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-noise");
});
afterAll(async () => {
  server.stop(true);
  await restore();
});

test("a button far below a mega menu is found and clicked", async () => {
  const result = await journey(`${server.url}noise.html`, [
    { instruction: "Click Confirm subscription", expect: { text: "Subscription confirmed" } },
  ]);
  expect(result.status, result.reason ?? "").toBe("completed");
}, 120_000);

test("what the page has below the screen is reported, with the best match for the step first", async () => {
  const session = `jev-noise-${crypto.randomUUID()}`;
  const browser = new Browser(session, Date.now() + 40_000);
  try {
    await browser.command(["open", `${server.url}noise.html`]);
    const observed = await browser.observe(undefined, "Click Confirm subscription");
    expect(observed.offscreen?.[0]).toBe("Confirm subscription (button, below the view)");
    expect(observed.offscreen).toHaveLength(60);
    expect(observed.offscreenMore).toBeGreaterThan(1000);
    // What is reported is also what the model is told, after the text of the screen.
    expect(makeRequest(runSchema.parse(minimalRun), 0, observed, []).state.page.text).toContain(
      "Also on the page, out of view",
    );
  } finally {
    await new Browser(session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}, 60_000);

const minimalRun = {
  prompt: "Subscribe",
  steps: ["Click Confirm subscription"],
  backend: { provider: "laya" },
  session: "unused",
  expect: [{ text: "Subscription confirmed" }],
};
