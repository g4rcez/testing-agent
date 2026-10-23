import type { Backend } from "./contracts.ts";
import { backendConfig } from "./decision.ts";

export class BackendSetupError extends Error {
  readonly setup: string;

  constructor(backend: Backend, message: string) {
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
    throw new BackendSetupError(backend, `${backend.provider} backend is not configured correctly`);
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
      );
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

export type BackendPrompts = {
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
  start(): void;
  wait(ms: number): Promise<void>;
};

async function askYesNo(question: string): Promise<boolean> {
  process.stderr.write(`${question} [y/N] `);
  for await (const line of console) return /^y(es)?$/i.test(line.trim());
  return false;
}

function spawnLayaSetup(): void {
  const child = Bun.spawn([process.execPath, process.argv[1] ?? "", "setup", "laya"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  child.unref();
}

const defaultPrompts: BackendPrompts = {
  interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  confirm: askYesNo,
  start: spawnLayaSetup,
  wait: (ms) => Bun.sleep(ms),
};

// Checks the backend; for an unreachable local Laya in a terminal, offers to start it.
export async function ensureBackend(
  backend: Backend,
  request?: (url: string, options: RequestInit) => Promise<Response>,
  prompts: BackendPrompts = defaultPrompts,
  timeoutMs = 15 * 60_000,
): Promise<void> {
  try {
    return await checkBackend(backend, request);
  } catch (error) {
    if (
      !(error instanceof BackendSetupError) ||
      backend.provider !== "laya" ||
      !prompts.interactive ||
      !(await prompts.confirm(
        "The Laya server is not running. Set it up now with https://github.com/receptron/laya (first run downloads ~1.7 GB)?",
      ))
    )
      throw error;
  }
  prompts.start();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await prompts.wait(2000);
    try {
      return await checkBackend(backend, request);
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}
