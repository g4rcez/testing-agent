import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const controller = process.env.AGENT_BROWSER_BIN ?? "agent-browser";
const app =
  "<button onclick=\"document.querySelector('p').textContent='Clicked '+(++window.clicks)\">Continue</button><p>Not clicked</p><script>window.clicks=0</script>";
async function plugin(
  type: string,
  runId: string,
  env: Record<string, string | undefined>,
) {
  const process = Bun.spawn(
    [
      controller,
      "plugin",
      "run",
      "jev",
      type,
      "--payload",
      JSON.stringify({ runId }),
      "--json",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(process.stdout).text();
  await process.exited;
  return output;
}
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("Worker exited before the input signal");
    output += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  return output.split("\n")[0] ?? "";
}

test("SIGKILL recovery confirms an existing receipt and never repeats input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-kill-"));
  const session = "jev-kill-" + crypto.randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/")
        return new Response(app, { headers: { "Content-Type": "text/html" } });
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/systemone"
      )
        return new Response("Not found", { status: 404 });
      const body = await request.json();
      const operation = body.state.page.text.includes("Clicked 1")
        ? "DONE"
        : "CLICK";
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([name, raw]) => {
          const question = raw as { criteria: Record<string, unknown> };
          const keys = Object.keys(question.criteria);
          const selected = name === "operation" ? operation : keys[0];
          return [
            name,
            {
              type: "choice",
              choice: selected,
              confidence: 1,
              probabilities: Object.fromEntries(
                keys.map((key) => [key, key === selected ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return Response.json({ answers, model: "interruption-fixture" });
    },
  });
  const input = {
    prompt: "Click Continue exactly once",
    steps: ["Click Continue"],
    backend: { provider: "laya", baseUrl: String(server.url) },
    session,
    url: String(server.url),
    expect: [{ text: "Clicked 1" }],
  };
  const env = { ...process.env, JEV_STATE_DIR: dir, JEV_TEST_HOLD_ACK: "1" };
  const child = Bun.spawn(
    ["bun", "tests/fixtures/interrupted-run.ts", JSON.stringify(input)],
    { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    expect(JSON.parse(await firstLine(child.stdout))).toEqual({
      event: "input-applied",
    });
    const file = (await readdir(dir)).find((name) => name.endsWith(".json"));
    if (!file) throw new Error("No durable state");
    const state = await Bun.file(join(dir, file)).json();
    expect(await plugin("agent.resume", state.runId, env)).toContain(
      "live process",
    );
    expect(await plugin("agent.recover", state.runId, env)).toContain(
      "live process",
    );
    child.kill(9);
    await child.exited;
    expect(await plugin("agent.resume", state.runId, env)).toContain(
      "agent.recover",
    );
    const recovered = JSON.parse(
      await plugin("agent.recover", state.runId, env),
    );
    expect(recovered.data.status).toBe("completed");
    expect(recovered.data.actions).toHaveLength(1);
    const result = Bun.spawn(
      [controller, "--session", session, "--json", "eval", "window.clicks"],
      { stdout: "pipe" },
    );
    expect(
      JSON.parse(await new Response(result.stdout).text()).data.result,
    ).toBe(1);
    await result.exited;
  } finally {
    child.kill();
    await child.exited;
    const close = Bun.spawn([controller, "--session", session, "close"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await close.exited;
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("cancellation aborts an in-flight model request and persists a terminal status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-cancel-"));
  const session = "jev-cancel-" + crypto.randomUUID();
  let notify = () => {};
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  let release = () => {};
  const held = new Promise<Response>((resolve) => {
    release = () => resolve(new Response("cancelled", { status: 503 }));
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/")
        return new Response(app, { headers: { "Content-Type": "text/html" } });
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/systemone"
      )
        return new Response("Not found", { status: 404 });
      notify();
      return held;
    },
  });
  const env = { ...process.env, JEV_STATE_DIR: dir };
  const input = {
    prompt: "Click Continue",
    steps: ["Click Continue"],
    backend: { provider: "laya", baseUrl: String(server.url) },
    session,
    url: String(server.url),
    expect: [{ text: "Clicked 1" }],
  };
  const child = Bun.spawn(
    ["bun", "tests/fixtures/interrupted-run.ts", JSON.stringify(input)],
    { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    await started;
    const file = (await readdir(dir)).find((name) => name.endsWith(".json"));
    if (!file) throw new Error("No durable state");
    const state = await Bun.file(join(dir, file)).json();
    expect(await plugin("agent.cancel", state.runId, env)).toContain(
      "cancelling",
    );
    const output = JSON.parse(await new Response(child.stdout).text());
    expect(output.status).toBe("cancelled");
    expect(output.actions).toHaveLength(0);
    await child.exited;
  } finally {
    release();
    child.kill();
    await child.exited;
    const close = Bun.spawn([controller, "--session", session, "close"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await close.exited;
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
