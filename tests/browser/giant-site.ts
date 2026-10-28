import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { Browser } from "../../src/browser.ts";
import { runSchema } from "../../src/contracts.ts";
import { defaultDependencies, startRun, type RunnerDependencies } from "../../src/runner.ts";

const root = join(import.meta.dir, "../../fixtures/giant-website");

export const demoLogin = { username: "demo", password: "s3cret!" };
const popupShell = `<!doctype html><meta charset="utf-8"><title>Invoices</title><div id="root"></div><script src="/popup-app.js"></script>`;

// The popup is a React app; it is bundled once per test process and kept in memory, so there is nothing to build
// or check in.
let popupBundle: Promise<string> | undefined;
function buildPopup(): Promise<string> {
  popupBundle ??= Bun.build({
    entrypoints: [join(root, "popup-app.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  }).then(async (result) => {
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    return result.outputs[0]!.text();
  });
  return popupBundle;
}

// Serves fixtures/giant-website on a free port. Pages are plain HTML (plus one React popup), so the tests exercise
// a real browser against real scrolling, timers, observers, requests and a login.
export function serveGiantSite(port = 0) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/popup-app.html")
        return new Response(popupShell, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/popup-app.js")
        return new Response(await buildPopup(), { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/api/login" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
        return body.username === demoLogin.username && body.password === demoLogin.password
          ? new Response("{}", { headers: { "set-cookie": "session=ok; HttpOnly; Path=/; SameSite=Lax" } })
          : new Response("{}", { status: 401 });
      }
      if (url.pathname === "/api/invoices") {
        if (!request.headers.get("cookie")?.includes("session=ok")) return new Response("{}", { status: 401 });
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 100));
        await Bun.sleep(300);
        const items = Array.from(
          { length: Math.max(0, Math.min(limit, 5000 - offset)) },
          (_, at) => `#${String(offset + at + 1).padStart(5, "0")}`,
        );
        return Response.json({ items });
      }
      const name = url.pathname.replace(/^\/+/, "") || "index.html";
      const file = Bun.file(join(root, normalize(name).replace(/^(\.\.[/\\])+/, "")));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
}

// Gives each test file its own state directory, as the other browser tests do.
export async function isolatedState(prefix: string) {
  const previous = process.env.JEV_STATE_DIR;
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  process.env.JEV_STATE_DIR = directory;
  return async () => {
    if (previous === undefined) delete process.env.JEV_STATE_DIR;
    else process.env.JEV_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  };
}

// Runs a journey with the model switched off: the fast path and the deterministic code must settle every step.
export async function journey(
  url: string,
  steps: unknown[],
  extra: Record<string, unknown> = {},
  decide: RunnerDependencies["decide"] = async () => {
    throw new Error("the model must not be asked");
  },
) {
  const session = `jev-giant-${crypto.randomUUID()}`;
  try {
    return await startRun(
      runSchema.parse({
        prompt: "Work through a hard page",
        steps,
        backend: { provider: "laya" },
        session,
        url,
        actionsPerCall: 30,
        maxStepDecisions: 30,
        timeoutMs: 45_000,
        ...extra,
      }),
      { ...defaultDependencies, decide },
    );
  } finally {
    await new Browser(session, Date.now() + 12_000).command(["close"]).catch(() => undefined);
  }
}
