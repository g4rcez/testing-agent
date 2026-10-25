import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../src/browser.ts";
import { runSchema } from "../../src/contracts.ts";
import { defaultDependencies, startRun } from "../../src/runner.ts";

// Pop-ups, new tabs and dialogs against a real browser. Every step is settled by the fast path, so no
// model is involved: the point is how the runner follows tabs and answers dialogs.
const opener = `<!doctype html><title>Opener</title><body>
<h1>Opener page</h1><p id=msg>No message</p><p id=out></p>
<a target=_blank rel=opener href="/popup" onclick="out.textContent='Link clicked'">Open link in new tab</a>
<button onclick="window.open('/popup');out.textContent='Window opened'">Open popup window</button>
<button onclick="out.textContent='Confirmed: '+(confirm('Sure?')?'yes':'no')">Confirm</button>
<button onclick="out.textContent='Prompt: '+prompt('Name?','nobody')">Ask name</button>
<button onclick="alert('Heads up');out.textContent='Alerted'">Raise alert</button>
<script>addEventListener('message',e=>{msg.textContent='Message: '+e.data})</script></body>`;
const popup = `<!doctype html><title>Popup</title><body><h1>Popup page</h1>
<button onclick="if(opener)opener.postMessage('done','*');window.close()">Finish</button></body>`;

let server: ReturnType<typeof Bun.serve>;
let state: string;
const previousState = process.env.JEV_STATE_DIR;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new Response(new URL(request.url).pathname === "/popup" ? popup : opener, {
        headers: { "content-type": "text/html" },
      }),
  });
  state = await mkdtemp(join(tmpdir(), "jev-tabs-"));
  process.env.JEV_STATE_DIR = state;
});
afterAll(async () => {
  server.stop(true);
  if (previousState === undefined) delete process.env.JEV_STATE_DIR;
  else process.env.JEV_STATE_DIR = previousState;
  await rm(state, { recursive: true, force: true });
});

async function journey(steps: unknown[], extra: Record<string, unknown> = {}) {
  const session = `jev-tabs-${crypto.randomUUID()}`;
  try {
    return await startRun(
      runSchema.parse({
        prompt: "Work with pop-ups and dialogs",
        steps,
        backend: { provider: "laya" },
        session,
        url: String(server.url),
        actionsPerCall: 10,
        timeoutMs: 40_000,
        ...extra,
      }),
      {
        ...defaultDependencies,
        decide: async () => {
          throw new Error("the model must not be asked");
        },
      },
    );
  } finally {
    await new Browser(session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}

test("a link that opens a new tab is followed, and the opener is back when the pop-up closes", async () => {
  const result = await journey([
    { instruction: "Click Open link in new tab", expect: { text: "Popup page" } },
    { instruction: "Click Finish", expect: { text: "Message: done" } },
  ]);
  expect(
    result.status,
    JSON.stringify({ reason: result.reason, debug: result.debug, actions: result.actions.length }),
  ).toBe("completed");
  expect(result.actions.map((action) => [action.operation, action.source])).toEqual([
    ["CLICK", "fast"],
    ["CLICK", "fast"],
  ]);
  expect(result.tabs?.known).toHaveLength(1);
}, 90_000);

test("window.open pop-ups work the same way", async () => {
  const result = await journey([
    { instruction: "Click Open popup window", expect: { text: "Popup page" } },
    { instruction: "Click Finish", expect: { text: "Message: done" } },
  ]);
  expect(result.status, result.reason ?? "").toBe("completed");
}, 90_000);

test("tabs.follow: never returns to the opener, and a step can ask for the new tab", async () => {
  const result = await journey(
    [
      { instruction: "Click Open link in new tab", expect: { text: "Link clicked" } },
      { instruction: "Click Finish", tab: "new", expect: { text: "Message: done" } },
    ],
    { browser: { tabs: { follow: "never" } } },
  );
  expect(result.status, result.reason ?? "").toBe("completed");
}, 90_000);

test("a step that names a tab which is not open fails with a clear code", async () => {
  const result = await journey([{ instruction: "Click Raise alert", tab: "new", expect: { text: "Alerted" } }]);
  expect(result.status).toBe("blocked");
  expect(result.reasonCode).toBe("TAB_NOT_FOUND");
}, 90_000);

test("alert, confirm and prompt are answered by policy and never freeze the click", async () => {
  const accepted = await journey([
    { instruction: "Click Confirm", expect: { text: "Confirmed: yes" } },
    { instruction: "Click Ask name", expect: { text: "Prompt: nobody" } },
    { instruction: "Click Raise alert", expect: { text: "Alerted" } },
  ]);
  expect(accepted.status, accepted.reason ?? "").toBe("completed");
  expect(accepted.actions.map((action) => action.dialogs)).toEqual([
    [{ type: "confirm", message: "Sure?" }],
    [{ type: "prompt", message: "Name?" }],
    [{ type: "alert", message: "Heads up" }],
  ]);
  const dismissed = await journey(
    [
      { instruction: "Click Confirm", expect: { text: "Confirmed: no" } },
      { instruction: "Click Ask name", expect: { text: "Prompt: null" } },
    ],
    { browser: { dialogs: { policy: "dismiss" } } },
  );
  expect(dismissed.status, dismissed.reason ?? "").toBe("completed");
  const typed = await journey([{ instruction: "Click Ask name", expect: { text: "Prompt: Ada" } }], {
    browser: { dialogs: { policy: "accept", promptText: "Ada" } },
  });
  expect(typed.status, typed.reason ?? "").toBe("completed");
}, 120_000);
