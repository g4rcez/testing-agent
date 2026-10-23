import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runSchema } from "../src/contracts.ts";
import { backendConfig } from "../src/decision.ts";
import { Browser } from "../src/browser.ts";
import { resumeRun, startRun, summarize } from "../src/runner.ts";

const exec = promisify(execFile);
const args = process.argv.slice(2).filter((value) => value !== "--");
let provider: "laya" | "jev" = "laya";
let repeats = 3;
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index],
    value = args[index + 1];
  if (flag === "--backend" && (value === "jev" || value === "laya")) provider = value;
  else if (flag === "--repeats" && value && /^[1-5]$/.test(value)) repeats = Number(value);
  else throw new Error("Use --backend jev|laya and --repeats 1..5");
}
const config = backendConfig({ provider });
const health: unknown =
  provider === "laya"
    ? await (await fetch(config.baseUrl + "/health", { signal: AbortSignal.timeout(3000) })).json()
    : { model: config.model };
const pages: Record<string, string> = {
  "/click":
    "<button onclick=\"document.querySelector('p').textContent='Action completed'\">Continue</button><p>Action pending</p>",
  "/form":
    '<form onsubmit="event.preventDefault();document.querySelector(\'p\').textContent=\'Saved \'+this.city.value"><label>City <input name="city" aria-label="City"></label><button>Save</button></form><p>Not saved</p>',
  "/check":
    "<label><input id=\"enabled\" type=\"checkbox\" onchange=\"document.querySelector('p').textContent=this.checked?'Feature enabled':'Feature disabled'\">Enable feature</label><p>Feature disabled</p>",
  "/select":
    '<label>Category <select id="category" aria-label="Category" onchange="document.querySelector(\'p\').textContent=\'Selected \'+this.value"><option>All</option><option>Design</option><option>Nature</option></select></label><p>Selected All</p>',
  "/navigate": '<a href="/destination">Open destination</a>',
  "/destination": "<h1>Destination page</h1>",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/hotel") return new Response(Bun.file(new URL("../tests/browser/app.html", import.meta.url)));
    const page = pages[path];
    return new Response(
      page
        ? "<!doctype html><title>Live acceptance</title><style>body{font:18px system-ui;margin:60px}button,input,select{font:inherit;padding:12px}label{display:block;margin:20px}</style>" +
            page
        : "Not found",
      { status: page ? 200 : 404, headers: { "Content-Type": "text/html" } },
    );
  },
});
const cases = [
  {
    name: "click",
    prompt: "Click Continue to complete the action",
    steps: ["Click Continue"],
    expect: [{ text: "Action completed" }],
  },
  {
    name: "form",
    prompt: "Enter Lisbon as City and save the form",
    steps: [
      { instruction: "Enter Lisbon in City", value: "Lisbon", expect: { selector: "[name=city]", value: "Lisbon" } },
      "Click Save",
    ],
    expect: [{ text: "Saved Lisbon" }],
  },
  {
    name: "check",
    prompt: "Enable the feature",
    steps: ["Check Enable feature"],
    expect: [{ selector: "#enabled", checked: true }],
  },
  {
    name: "select",
    prompt: "Choose Design as the Category",
    steps: ["Select Design in Category"],
    expect: [{ selector: "#category", value: "Design" }],
  },
  {
    name: "navigate",
    prompt: "Open the destination page",
    steps: ["Open destination"],
    expect: [{ text: "Destination page" }, { url: new URL("/destination", server.url).href }],
  },
  { ...(await Bun.file(new URL("../examples/stay-search.json", import.meta.url)).json()), name: "hotel" },
];
const results: unknown[] = [];
let passed = 0;
const started = Date.now();
try {
  for (let repeat = 1; repeat <= repeats; repeat++)
    for (const testCase of cases) {
      const input = runSchema.parse({
        ...testCase,
        name: testCase.name + " repeat " + repeat,
        backend: { provider },
        url: new URL("/" + testCase.name, server.url).href,
        maxStepDecisions: 8,
        totalTimeoutMs: 60_000,
      });
      let state = await startRun(input);
      while (state.status === "paused") state = await resumeRun(state.runId);
      results.push({ repeat, ...summarize(state) });
      if (state.status === "completed") passed++;
      console.log(
        JSON.stringify({
          case: testCase.name,
          repeat,
          status: state.status,
          reason: state.reason,
          actions: state.actions.length,
          inferenceMs: state.actions.map((action) => action.inferenceMs),
        }),
      );
      await new Browser(state.session, Date.now() + 5000).command(["close"]);
    }
} finally {
  server.stop(true);
}
const revision = await exec("git", ["rev-parse", "HEAD"]);
const dirty = await exec("git", ["status", "--porcelain"]);
const browser = await exec(process.env.AGENT_BROWSER_BIN ?? "agent-browser", ["--version"]);
await mkdir("docs/evidence", { recursive: true });
const receipt = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  codeRevision: revision.stdout.trim(),
  workingTreeDirty: dirty.stdout.trim().length > 0,
  provider,
  health,
  browser: browser.stdout.trim(),
  passed,
  total: cases.length * repeats,
  elapsedMs: Date.now() - started,
  boundary:
    "Real model calls and browser actions on local acceptance fixtures; includes browser startup and assertions. This is not a general website accuracy benchmark.",
  results,
};
const historyPath = `docs/evidence/live-${provider}-${receipt.date.replace(/[:.]/g, "-")}.json`;
await Bun.write(historyPath, JSON.stringify(receipt, null, 2) + "\n");
await Bun.write(`docs/evidence/live-${provider}.json`, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ passed, total: cases.length * repeats, receipt: historyPath }));
if (passed !== cases.length * repeats) process.exitCode = 1;
