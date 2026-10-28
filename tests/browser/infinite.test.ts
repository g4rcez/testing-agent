import { afterAll, beforeAll, expect, test } from "bun:test";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// An infinite feed only grows when its bottom is reached, and every page arrives after a network delay.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-infinite");
});
afterAll(async () => {
  server.stop(true);
  await restore();
});

test("a post on the ninth page of an infinite feed is found and opened", async () => {
  const result = await journey(`${server.url}infinite.html`, [
    { instruction: "Click Post 170 (page 9)", expect: { text: "Opened post 170" } },
  ]);
  expect(result.status, result.reason ?? "").toBe("completed");
}, 180_000);

test("a post past the end of the feed ends with a clear reason", async () => {
  const result = await journey(`${server.url}infinite.html`, [
    { instruction: "Click Post 999 (page 50)", expect: { text: "Opened post 999" } },
  ]);
  expect(result.status).toBe("failed");
  expect(result.reasonCode).toBe("SEARCH_NOT_FOUND");
}, 180_000);

test("a text assertion that asks to search finds text far down the feed", async () => {
  const result = await journey(
    `${server.url}infinite.html`,
    [{ instruction: "Click Post 1 (page 1)", expect: { text: "Opened post 1" } }],
    { expect: [{ text: "Post 300 (page 15)", search: true }] },
  );
  expect(result.status, result.reason ?? "").toBe("completed");
}, 180_000);

test("a text assertion that asks to search still fails when the feed does not have the text", async () => {
  const result = await journey(
    `${server.url}infinite.html`,
    [{ instruction: "Click Post 1 (page 1)", expect: { text: "Opened post 1" } }],
    { expect: [{ text: "Post 301 (page 16)", search: true }] },
  );
  expect(result.status).toBe("failed");
  expect(result.reasonCode).toBe("FINAL_ASSERTION_FAILED");
}, 180_000);
