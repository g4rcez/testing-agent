import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { demoLogin, isolatedState, journey, serveGiantSite } from "./giant-site.ts";

// billing.html opens the invoices in a window.open() popup. The popup asks for a login, then shows 5,000
// invoices in a react-window list that fetches its rows as they scroll into view.
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
let stateDirectory: string;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-popup-login");
  stateDirectory = process.env.JEV_STATE_DIR!;
  process.env.GIANT_PASSWORD = demoLogin.password;
});
afterAll(async () => {
  delete process.env.GIANT_PASSWORD;
  server.stop(true);
  await restore();
});

const signIn = [
  { instruction: "Click Choose invoice", expect: { text: "Sign in" } },
  { instruction: "Type demo into the Username field", value: "demo" },
  { instruction: "Type the password into the Password field", selector: "#password", valueFromEnv: "GIANT_PASSWORD" },
  { instruction: "Click Sign in", expect: { text: "Open invoice #00001" } },
];

async function everything(directory: string): Promise<string> {
  const names = await readdir(directory, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    names.filter((entry) => entry.isFile()).map((entry) => Bun.file(join(entry.parentPath, entry.name)).text()),
  );
  return texts.join("\n");
}

test("sign in to the popup, find an invoice deep in the list, and hand it back to the opener", async () => {
  const result = await journey(`${server.url}billing.html`, [
    ...signIn,
    { instruction: "Click Open invoice #04217", expect: { text: "Confirm #04217" } },
    { instruction: "Click Confirm", expect: { text: "Invoice #04217 selected" } },
  ]);
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
  expect(result.actions.every((action) => action.source !== "model")).toBe(true);
  expect(result.tabs?.known).toHaveLength(1);
  // The password was typed into the page, never written to the run's state.
  expect(await everything(stateDirectory)).not.toContain(demoLogin.password);
}, 180_000);

test("a wrong password is refused by the popup and the list never appears", async () => {
  process.env.GIANT_PASSWORD = "not-the-password";
  try {
    const result = await journey(`${server.url}billing.html`, [
      ...signIn.slice(0, 3),
      { instruction: "Click Sign in", expect: { text: "Invalid username or password" } },
    ]);
    expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
  } finally {
    process.env.GIANT_PASSWORD = demoLogin.password;
  }
}, 180_000);
