import { afterAll, beforeAll, expect, test } from "bun:test";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// A form inside a same-site iframe: its fields belong to another document, which the page script must read and act
// in as well. The result is reported back to the outer page, which is what the test looks at.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-iframe");
});
afterAll(async () => {
  server.stop(true);
  await restore();
});

test("a form inside an iframe is filled and submitted", async () => {
  const result = await journey(`${server.url}iframe.html`, [
    { instruction: "Type ada@example.com into the Email field", value: "ada@example.com" },
    { instruction: "Click Subscribe", expect: { text: "Subscribed: ada@example.com" } },
  ]);
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
  expect(result.actions.map((action) => [action.operation, action.source])).toEqual([
    ["TYPE_TEXT", "fast"],
    ["CLICK", "fast"],
  ]);
}, 180_000);
