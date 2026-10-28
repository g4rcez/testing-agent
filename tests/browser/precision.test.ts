import { afterAll, beforeAll, expect, test } from "bun:test";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// The same label on many controls: the page has an Edit and a Delete in every order row, an Edit in two sections,
// and a Pay that is a link in one section and a button in the other. A step says which one by its row, its section,
// its place in the page or its kind of control, and the wrong one must never be clicked.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-precision");
}, 240_000);
afterAll(async () => {
  server.stop(true);
  await restore();
}, 240_000);

async function click(instruction: string, shows: string) {
  const result = await journey(`${server.url}precision.html`, [{ instruction, expect: { text: shows } }]);
  expect(result.status, JSON.stringify({ reason: result.reason, code: result.reasonCode })).toBe("completed");
  expect(result.actions.map((action) => [action.operation, action.source])).toEqual([["CLICK", "fast"]]);
}

test("a control is chosen by the row it is in", async () => {
  await click("Click Delete in the row of Order #1002", "Deleted order #1002");
  await click("Click the Edit button in the row for Order #1003", "Edited order #1003");
}, 240_000);

test("a control is chosen by the section it is in", async () => {
  await click("Click the Edit button in the Billing section", "Edited billing");
  await click("Click Edit in the Shipping section", "Edited shipping");
}, 240_000);

test("a control is chosen by its place among the same ones", async () => {
  await click("Click the second Delete button", "Deleted order #1002");
  await click("Click the first Edit button", "Edited order #1001");
  await click("Click the last Edit button", "Edited shipping");
}, 240_000);

test("a control is chosen by its kind when the label is the same", async () => {
  await click("Click the Pay button", "Paid shipping (button)");
  await click("Click the Pay link", "Paid billing (link)");
}, 240_000);

test("a row or section that is not on the page is never guessed", async () => {
  const result = await journey(`${server.url}precision.html`, [
    { instruction: "Click Delete in the row of Order #9999", expect: { text: "Deleted order #9999" } },
  ]);
  expect(result.status).toBe("failed");
  expect(result.reasonCode).toBe("SEARCH_NOT_FOUND");
  const unchanged = await journey(`${server.url}precision.html`, [
    { instruction: "Click the fifth Delete button", expect: { text: "Deleted order" } },
  ]);
  expect(unchanged.status).not.toBe("completed");
}, 240_000);
