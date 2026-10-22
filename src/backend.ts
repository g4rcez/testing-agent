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
    throw new BackendSetupError(
      backend,
      `${backend.provider} backend is not configured correctly`,
    );
  }
  let response: Response;
  try {
    response = await request(`${config.baseUrl}/v1/systemone`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : {},
    });
  } catch {
    throw new BackendSetupError(
      backend,
      `${backend.provider} backend is not reachable; no browser was started`,
    );
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
