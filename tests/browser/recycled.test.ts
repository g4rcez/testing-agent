import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser, StaleDecisionError } from "../../src/browser.ts";
import type { Decision } from "../../src/contracts.ts";
import { serveGiantSite } from "./giant-site.ts";

// A virtualized list reuses its row elements: after a scroll the button that said "Open order #00003" says
// something else. A decision made from the old screen must never be applied to what the element shows now.
let server: ReturnType<typeof serveGiantSite>;
beforeAll(() => {
  server = serveGiantSite();
});
afterAll(() => {
  server.stop(true);
});

test("a decision for a row whose element was recycled is refused, and no order is opened", async () => {
  const browser = new Browser(`jev-recycled-${crypto.randomUUID()}`, Date.now() + 40_000);
  try {
    await browser.command(["open", `${server.url}virtual-list.html`]);
    const observed = await browser.observe();
    const [id, target] =
      Object.entries(observed.targets.CLICK ?? {}).find(([, item]) => item.label === "Open order #00003") ?? [];
    expect(target?.label).toBe("Open order #00003");
    const decision: Decision = {
      operation: "CLICK",
      targetId: id!,
      target: target!,
      snapshotId: observed.snapshotId!,
      actionId: crypto.randomUUID(),
      confidence: 1,
    };
    // Scroll far away and back near the top by a different amount: the same elements now show other orders.
    await browser.command([
      "eval",
      "(() => { const v = document.getElementById('viewport'); v.scrollTop = 40 * 3000; v.dispatchEvent(new Event('scroll')); })()",
    ]);
    await expect(browser.execute(decision)).rejects.toBeInstanceOf(StaleDecisionError);
    expect((await browser.assert([{ text: "No order opened", timeoutMs: 0 }])).passed).toBe(true);
  } finally {
    await new Browser(browser.session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}, 90_000);
