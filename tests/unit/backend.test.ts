import { expect, test } from "bun:test";
import { checkBackend, ensureBackend, prepareBackend, BackendSetupError, type LayaProcess } from "../../src/backend.ts";

test("preflight probes the configured decision endpoint without inference", async () => {
  let cancelled = false;
  await checkBackend({ provider: "laya", baseUrl: "http://127.0.0.1:8791/prefix" }, async (url, options) => {
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
  });
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
    expect((error as BackendSetupError).setup).toContain("https://github.com/receptron/laya");
    expect((error as BackendSetupError).setup).toContain("laya-server.py");
  }
});

test("Jev missing credentials fails before any network request", async () => {
  let calls = 0;
  await expect(
    checkBackend({ provider: "jev", apiKeyEnv: "PREFLIGHT_MISSING_KEY" }, async () => {
      calls++;
      return new Response();
    }),
  ).rejects.toBeInstanceOf(BackendSetupError);
  expect(calls).toBe(0);
});

test("backend auth and readiness errors fail closed", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await expect(checkBackend({ provider: "laya" }, async () => new Response(null, { status }))).rejects.toBeInstanceOf(
      BackendSetupError,
    );
  }
  for (const status of [200, 400, 404, 405, 501]) {
    await expect(
      checkBackend({ provider: "laya" }, async () => new Response(null, { status })),
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
    await expect(checkBackend({ provider: "laya", baseUrl: String(source.url) })).rejects.toBeInstanceOf(
      BackendSetupError,
    );
    expect(reached).toBe(false);
  } finally {
    source.stop(true);
    target.stop(true);
  }
});

const refuse = async () => {
  throw new Error("down");
};
const noServer = (): LayaProcess => {
  throw new Error("must not start");
};
const never = new Promise<number>(() => undefined);

test("an unreachable local Laya server is started without asking and stopped by the caller", async () => {
  let up = false;
  let stopped = 0;
  const ports: number[] = [];
  const started = await ensureBackend(
    { provider: "laya" },
    async () => {
      if (!up) throw new Error("down");
      return new Response(null, { status: 405 });
    },
    {
      autostart: true,
      start: (port) => {
        ports.push(port);
        up = true;
        return { exited: never, stop: async () => void stopped++ };
      },
      wait: async () => undefined,
    },
  );
  expect(ports).toEqual([8791]);
  expect(started).toBeDefined();
  expect(stopped).toBe(0);
  await started!.stop();
  expect(stopped).toBe(1);
});

test("a server that is already running is never started or stopped", async () => {
  const started = await ensureBackend({ provider: "laya" }, async () => new Response(null, { status: 405 }), {
    autostart: true,
    start: noServer,
    wait: async () => undefined,
  });
  expect(started).toBeUndefined();
});

test("a custom local port is passed to the server it starts", async () => {
  let up = false;
  const ports: number[] = [];
  await ensureBackend(
    { provider: "laya", baseUrl: "http://127.0.0.1:9123" },
    async () => {
      if (!up) throw new Error("down");
      return new Response(null, { status: 405 });
    },
    {
      autostart: true,
      start: (port) => {
        ports.push(port);
        up = true;
        return { exited: never, stop: async () => undefined };
      },
      wait: async () => undefined,
    },
  );
  expect(ports).toEqual([9123]);
});

test("autostart can be turned off, and only ever applies to a local Laya server", async () => {
  const deps = { start: noServer, wait: async () => undefined };
  const previous = process.env.TESTING_AGENT_AUTOSTART;
  try {
    await expect(ensureBackend({ provider: "laya" }, refuse, { ...deps, autostart: false })).rejects.toBeInstanceOf(
      BackendSetupError,
    );
    await expect(ensureBackend({ provider: "laya", autostart: false }, refuse, deps)).rejects.toBeInstanceOf(
      BackendSetupError,
    );
    process.env.TESTING_AGENT_AUTOSTART = "0";
    await expect(ensureBackend({ provider: "laya" }, refuse, deps)).rejects.toBeInstanceOf(BackendSetupError);
    await expect(
      ensureBackend({ provider: "laya", baseUrl: "https://models.example.com" }, refuse, { ...deps, autostart: true }),
    ).rejects.toBeInstanceOf(BackendSetupError);
    await expect(
      ensureBackend({ provider: "jev", baseUrl: "http://127.0.0.1:9" }, refuse, { ...deps, autostart: true }),
    ).rejects.toBeInstanceOf(BackendSetupError);
  } finally {
    if (previous === undefined) delete process.env.TESTING_AGENT_AUTOSTART;
    else process.env.TESTING_AGENT_AUTOSTART = previous;
  }
});

test("a server that exits before it is ready fails fast and is cleaned up", async () => {
  let stopped = 0;
  const error = await ensureBackend({ provider: "laya" }, refuse, {
    autostart: true,
    start: () => ({ exited: Promise.resolve(1), stop: async () => void stopped++ }),
    wait: () => new Promise((resolve) => setTimeout(resolve, 50)),
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(BackendSetupError);
  expect((error as BackendSetupError).code).toBe("BACKEND_START_FAILED");
  expect((error as BackendSetupError).message).toContain("exited with code 1");
  expect(stopped).toBe(1);
});

test("a server that never becomes ready times out and is stopped", async () => {
  let stopped = 0;
  await expect(
    ensureBackend(
      { provider: "laya" },
      refuse,
      {
        autostart: true,
        start: () => ({ exited: never, stop: async () => void stopped++ }),
        wait: () => new Promise((resolve) => setTimeout(resolve, 20)),
      },
      60,
    ),
  ).rejects.toBeInstanceOf(BackendSetupError);
  expect(stopped).toBe(1);
});

const healthReport = (report: Record<string, unknown> | undefined, status = 200) =>
  (async (url: string) =>
    url.endsWith("/health")
      ? new Response(JSON.stringify(report), { status })
      : new Response(null, { status: 405 })) as (url: string, options: RequestInit) => Promise<Response>;

test("a running server with a different window or language is reported, not silently used", async () => {
  const running = { ready: true, language: "en", revision: "abc", maxLen: 512, headMaxLen: 192 };
  const deps = { start: noServer, wait: async () => undefined };
  const error = await ensureBackend(
    { provider: "laya", laya: { language: "en", maxLen: 256, headMaxLen: 96 } },
    healthReport(running),
    deps,
  ).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(BackendSetupError);
  expect((error as BackendSetupError).code).toBe("BACKEND_CONFIG_MISMATCH");
  expect((error as BackendSetupError).message).toContain("maxLen: test wants 256, server has 512");
  expect((error as BackendSetupError).message).toContain("--max-len 256");
  // Matching settings, a server that does not report them, and an unreadable report all pass.
  expect(
    await ensureBackend({ provider: "laya", laya: { maxLen: 512, headMaxLen: 192 } }, healthReport(running), deps),
  ).toBeUndefined();
  expect(
    await ensureBackend({ provider: "laya", laya: { maxLen: 256 } }, healthReport({ ready: true }), deps),
  ).toBeUndefined();
  expect(
    await ensureBackend({ provider: "laya", laya: { maxLen: 256 } }, healthReport(undefined, 404), deps),
  ).toBeUndefined();
  expect(await ensureBackend({ provider: "laya" }, healthReport(running), deps)).toBeUndefined();
});

test("the Laya settings of a test are handed to the server it starts", async () => {
  let up = false;
  let received: Record<string, string> = {};
  await ensureBackend(
    { provider: "laya", laya: { language: "multilingual", maxLen: 256, headMaxLen: 96, threads: 2 } },
    async () => {
      if (!up) throw new Error("down");
      return new Response(null, { status: 405 });
    },
    {
      autostart: true,
      start: (_port, env) => {
        received = env;
        up = true;
        return { exited: never, stop: async () => undefined };
      },
      wait: async () => undefined,
    },
  );
  expect(received).toEqual({
    LAYA_LANGUAGE: "multilingual",
    LAYA_MAX_LEN: "256",
    LAYA_HEAD_MAX_LEN: "96",
    LAYA_THREADS: "2",
  });
});

test("a local server is started only when something needs the model, and only once", async () => {
  let up = false;
  let starts = 0;
  let stopped = 0;
  const handle = await prepareBackend(
    { provider: "laya" },
    async () => {
      if (!up) throw new Error("down");
      return new Response(null, { status: 405 });
    },
    {
      autostart: true,
      start: () => {
        starts++;
        up = true;
        return { exited: never, stop: async () => void stopped++ };
      },
      wait: async () => undefined,
    },
  );
  expect([starts, handle.started]).toEqual([0, false]);
  await handle.stop();
  expect(stopped).toBe(0);
  await Promise.all([handle.ready(), handle.ready()]);
  await handle.ready();
  expect([starts, handle.started]).toEqual([1, true]);
  await handle.stop();
  await handle.stop();
  expect([stopped, handle.started]).toEqual([1, false]);
});

test("a server that is already running makes the handle a no-op", async () => {
  const handle = await prepareBackend({ provider: "laya" }, async () => new Response(null, { status: 405 }), {
    autostart: true,
    start: noServer,
    wait: async () => undefined,
  });
  await handle.ready();
  await handle.stop();
  expect(handle.started).toBe(false);
});

test("without autostart a missing server is still reported before anything starts", async () => {
  await expect(
    prepareBackend({ provider: "laya" }, refuse, { autostart: false, start: noServer, wait: async () => undefined }),
  ).rejects.toBeInstanceOf(BackendSetupError);
});
