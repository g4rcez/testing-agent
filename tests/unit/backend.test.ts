import { expect, test } from "bun:test";
import {
  checkBackend,
  ensureBackend,
  BackendSetupError,
} from "../../src/backend.ts";

test("preflight probes the configured decision endpoint without inference", async () => {
  let cancelled = false;
  await checkBackend(
    { provider: "laya", baseUrl: "http://127.0.0.1:8791/prefix" },
    async (url, options) => {
      expect(url).toBe("http://127.0.0.1:8791/prefix/v1/systemone");
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(options.body).toBeUndefined();
      expect(options.signal).toBeDefined();
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 405 },
      );
    },
  );
  expect(cancelled).toBe(true);
});

test("an unreachable backend gives setup instructions without exposing transport details", async () => {
  try {
    await checkBackend({ provider: "laya" }, async () => {
      throw new Error("private endpoint and credential");
    });
    throw new Error("Expected preflight failure");
  } catch (error) {
    expect(error).toBeInstanceOf(BackendSetupError);
    expect(String(error)).not.toContain("private endpoint");
    expect((error as BackendSetupError).setup).toContain(
      "https://github.com/receptron/laya",
    );
    expect((error as BackendSetupError).setup).toContain("laya-server.py");
  }
});

test("Jev missing credentials fails before any network request", async () => {
  let calls = 0;
  await expect(
    checkBackend(
      { provider: "jev", apiKeyEnv: "PREFLIGHT_MISSING_KEY" },
      async () => {
        calls++;
        return new Response();
      },
    ),
  ).rejects.toBeInstanceOf(BackendSetupError);
  expect(calls).toBe(0);
});

test("backend auth and readiness errors fail closed", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await expect(
      checkBackend(
        { provider: "laya" },
        async () => new Response(null, { status }),
      ),
    ).rejects.toBeInstanceOf(BackendSetupError);
  }
  for (const status of [200, 400, 404, 405, 501]) {
    await expect(
      checkBackend(
        { provider: "laya" },
        async () => new Response(null, { status }),
      ),
    ).resolves.toBeUndefined();
  }
});

test("preflight refuses redirects and does not forward credentials", async () => {
  let reached = false;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      reached = true;
      return new Response("unexpected");
    },
  });
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.redirect(String(target.url));
    },
  });
  try {
    await expect(
      checkBackend({ provider: "laya", baseUrl: String(source.url) }),
    ).rejects.toBeInstanceOf(BackendSetupError);
    expect(reached).toBe(false);
  } finally {
    source.stop(true);
    target.stop(true);
  }
});

test("an unreachable Laya server is started after the user agrees", async () => {
  let up = false;
  let started = 0;
  await ensureBackend(
    { provider: "laya" },
    async () => {
      if (!up) throw new Error("down");
      return new Response(null, { status: 405 });
    },
    {
      interactive: true,
      confirm: async () => true,
      start: () => {
        started++;
        up = true;
      },
      wait: async () => undefined,
    },
  );
  expect(started).toBe(1);
});

test("declining or running non-interactively keeps the setup error", async () => {
  const down = async () => {
    throw new Error("down");
  };
  for (const prompts of [
    { interactive: true, confirm: async () => false },
    { interactive: false, confirm: async () => true },
  ])
    await expect(
      ensureBackend({ provider: "laya" }, down, {
        ...prompts,
        start: () => {
          throw new Error("must not start");
        },
        wait: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(BackendSetupError);
});
