import { join } from "node:path";
import type { Backend } from "./contracts.ts";
import { backendConfig } from "./decision.ts";
import { layaSettingsToEnv } from "./local-laya.ts";

export type BackendSetupCode =
  | "BACKEND_MISCONFIGURED"
  | "BACKEND_UNREACHABLE"
  | "BACKEND_NOT_READY"
  | "BACKEND_START_FAILED"
  | "BACKEND_CONFIG_MISMATCH";

export class BackendSetupError extends Error {
  readonly setup: string;

  constructor(
    backend: Backend,
    message: string,
    readonly code: BackendSetupCode = "BACKEND_UNREACHABLE",
  ) {
    super(message);
    this.name = "BackendSetupError";
    this.setup =
      backend.provider === "laya"
        ? "Start the optional local backend with: testing-agent setup laya. Or start the existing Python service with: uv run tools/laya-server.py. Setup: https://github.com/receptron/laya. Then retry the test."
        : "Configure TYPESAFE_API_KEY (or the environment variable named by backend.apiKeyEnv), check TYPESAFE_BASE_URL or backend.baseUrl, and make sure the Jev endpoint is reachable. Then retry the test.";
  }
}

export async function checkBackend(
  backend: Backend,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  let config: ReturnType<typeof backendConfig>;
  try {
    config = backendConfig(backend);
  } catch {
    throw new BackendSetupError(
      backend,
      `${backend.provider} backend is not configured correctly`,
      "BACKEND_MISCONFIGURED",
    );
  }
  let response: Response;
  try {
    response = await request(`${config.baseUrl}/v1/systemone`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
  } catch {
    throw new BackendSetupError(backend, `${backend.provider} backend is not reachable; no browser was started`);
  }
  try {
    // GET need not be implemented by a POST-only inference endpoint.
    if (!(response.ok || [400, 404, 405, 501].includes(response.status)))
      throw new BackendSetupError(
        backend,
        `${backend.provider} backend is not ready (HTTP ${response.status}); no browser was started`,
        "BACKEND_NOT_READY",
      );
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** A local Laya server this process launched. */
export type LayaProcess = { exited: Promise<number>; stop(): Promise<void> };
/** Handle for a server started by ensureBackend; absent when one was already running. */
export type StartedBackend = { stop(): Promise<void> };

export type BackendDeps = {
  /** Forces autostart on or off; by default `backend.autostart`, TESTING_AGENT_AUTOSTART and CI decide. */
  autostart?: boolean;
  start(port: number, env: Record<string, string>): LayaProcess;
  wait(ms: number): Promise<void>;
};

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FIRST_START_TIMEOUT_MS = 15 * 60_000;

// The entry is resolved from this module, so it is the right file for the CLI, the plugin and the
// bundled dist alike (process.argv[1] is the wrong program for the plugin and a stale build otherwise).
function layaEntry(): string {
  return join(import.meta.dir, import.meta.path.endsWith(".ts") ? "cli.ts" : "cli.js");
}

function startLayaProcess(port: number, settings: Record<string, string>): LayaProcess {
  const child = Bun.spawn([process.execPath, layaEntry(), "setup", "laya"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...settings, LAYA_PORT: String(port) },
  });
  // The server's progress lines go to stderr: stdout stays the single JSON result of the command.
  void (async () => {
    for await (const chunk of child.stdout) process.stderr.write(chunk);
  })().catch(() => undefined);
  return {
    exited: child.exited,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await child.exited;
      clearTimeout(forced);
    },
  };
}

const defaultDeps: BackendDeps = { start: startLayaProcess, wait: (ms) => Bun.sleep(ms) };

function autostartEnabled(backend: Backend): boolean {
  const setting = process.env.TESTING_AGENT_AUTOSTART?.toLowerCase();
  if (setting && ["0", "false", "off", "no"].includes(setting)) return false;
  if (backend.autostart === false) return false;
  if (setting && ["1", "true", "on", "yes"].includes(setting)) return true;
  // A multi-gigabyte first download should never be a surprise in CI.
  return !process.env.CI;
}

/**
 * A running server keeps the window and language it was started with. If the test asks for
 * different ones, say so instead of silently using a differently sized context.
 */
async function verifyLayaSettings(
  backend: Backend,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const wanted = backend.laya;
  if (backend.provider !== "laya" || !wanted) return;
  let health: Record<string, unknown>;
  try {
    const response = await request(`${backendConfig(backend).baseUrl}/health`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    health = (await response.json()) as Record<string, unknown>;
  } catch {
    return;
  }
  // Servers that do not report a setting (the Python service) cannot be checked for it.
  const differing = (
    [
      ["language", wanted.language, health.language],
      ["revision", wanted.revision, health.revision],
      ["maxLen", wanted.maxLen, health.maxLen],
      ["headMaxLen", wanted.headMaxLen, health.headMaxLen],
    ] as const
  ).filter(([, want, have]) => want !== undefined && have !== undefined && want !== have);
  if (differing.length)
    throw new BackendSetupError(
      backend,
      `The running Laya server was started with different settings (${differing
        .map(([name, want, have]) => `${name}: test wants ${want}, server has ${have}`)
        .join("; ")}). Stop it and rerun, or start it with: testing-agent setup laya ${Object.entries(wanted)
        .map(([name, value]) => `--${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} ${value}`)
        .join(" ")}`,
      "BACKEND_CONFIG_MISMATCH",
    );
}

/** Starts the local Laya server and waits until it answers; stops it again if it never does. */
async function startServer(
  backend: Backend,
  request: ((url: string, options: RequestInit) => Promise<Response>) | undefined,
  deps: BackendDeps,
  timeoutMs: number,
  port: number,
): Promise<StartedBackend> {
  process.stderr.write(
    JSON.stringify({
      backend: "starting",
      provider: "laya",
      port,
      note: "The first start downloads about 1.7 GB of model weights; later starts take a few seconds.",
    }) + "\n",
  );
  const server = deps.start(port, layaSettingsToEnv(backend.laya));
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const exited = await Promise.race([server.exited, deps.wait(2000).then(() => undefined)]);
      if (exited !== undefined)
        throw new BackendSetupError(
          backend,
          `The local Laya server exited with code ${exited} before it was ready`,
          "BACKEND_START_FAILED",
        );
      try {
        await checkBackend(backend, request);
        process.stderr.write(JSON.stringify({ backend: "ready", provider: "laya", port }) + "\n");
        return { stop: () => server.stop() };
      } catch (probe) {
        if (Date.now() > deadline) throw probe;
      }
    }
  } catch (failure) {
    await server.stop();
    throw failure;
  }
}

/**
 * A backend that may still have to be started. `ready()` starts a local Laya server the first time it
 * is called (and waits for it), so a run that never needs the model never loads it. `stop()` stops
 * only a server this handle started.
 */
export type BackendHandle = { ready(): Promise<void>; stop(): Promise<void>; readonly started: boolean };

/**
 * Checks the backend. A server that answers is used as it is (after checking its settings). A local
 * Laya server that does not answer is started on the first `ready()` when autostart is on; otherwise
 * the setup error is thrown now, before any browser is opened.
 */
export async function prepareBackend(
  backend: Backend,
  request?: (url: string, options: RequestInit) => Promise<Response>,
  deps: BackendDeps = defaultDeps,
  timeoutMs = Number(process.env.LAYA_START_TIMEOUT_MS) || FIRST_START_TIMEOUT_MS,
): Promise<BackendHandle> {
  try {
    await checkBackend(backend, request);
  } catch (error) {
    if (!(error instanceof BackendSetupError) || error.code === "BACKEND_MISCONFIGURED") throw error;
    const url = new URL(backendConfig(backend).baseUrl);
    if (backend.provider !== "laya" || !localHosts.has(url.hostname) || !(deps.autostart ?? autostartEnabled(backend)))
      throw error;
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    let starting: Promise<StartedBackend> | undefined;
    let server: StartedBackend | undefined;
    return {
      get started() {
        return server !== undefined;
      },
      async ready() {
        starting ??= startServer(backend, request, deps, timeoutMs, port);
        server = await starting;
      },
      async stop() {
        await starting?.catch(() => undefined);
        const running = server;
        server = undefined;
        await running?.stop();
      },
    };
  }
  await verifyLayaSettings(backend, request);
  return { started: false, ready: async () => undefined, stop: async () => undefined };
}

/**
 * Checks the backend and, for a local Laya server that is not running, starts it and waits until it
 * answers. Returns a handle to stop it only when this call started it; a server that was already
 * running is never touched.
 */
export async function ensureBackend(
  backend: Backend,
  request?: (url: string, options: RequestInit) => Promise<Response>,
  deps: BackendDeps = defaultDeps,
  timeoutMs = Number(process.env.LAYA_START_TIMEOUT_MS) || FIRST_START_TIMEOUT_MS,
): Promise<StartedBackend | undefined> {
  const handle = await prepareBackend(backend, request, deps, timeoutMs);
  await handle.ready();
  return handle.started ? { stop: () => handle.stop() } : undefined;
}
