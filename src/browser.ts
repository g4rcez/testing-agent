import { z } from "zod";
import type { Decision, Observation } from "./contracts.ts";
import { pageExpression, type PageRequest } from "./page.ts";
import { assertionExpression, assertionResultSchema, type AssertionResult } from "./assertions.ts";
import type { Assertion, BrowserConfig } from "./contracts.ts";

const candidateSchema = z.object({
  ref: z.string(),
  label: z.string(),
  role: z.string(),
  value: z.string().optional(),
  currentValue: z.string().optional(),
  checked: z.string().optional(),
});
const observationSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string().max(12_000),
  tree: z.string().max(200_000),
  elements: z.array(
    z.object({
      index: z.string(),
      label: z.string(),
      role: z.string(),
      value: z.string(),
      operations: z.array(z.string()),
      checked: z.string().optional(),
    }),
  ),
  targets: z.record(z.string(), z.record(z.string(), candidateSchema)),
  controls: z.array(z.string()),
  documentId: z.uuid(),
  snapshotId: z.uuid(),
});
const responseSchema = z.object({ success: z.boolean(), data: z.unknown(), error: z.string().nullable().optional() });
const receiptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stale"), reason: z.string() }),
  z.object({ status: z.enum(["executed", "uncertain"]), actionId: z.uuid() }),
]);
export class StaleDecisionError extends Error {}
export class BrowserDeadlineError extends Error {}
export class BrowserCommandRejectedError extends Error {}

export class Browser {
  constructor(
    readonly session: string,
    readonly deadline: number,
    readonly signal?: AbortSignal,
    readonly config?: BrowserConfig,
  ) {}

  async command(args: string[], stdin?: string): Promise<unknown> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new BrowserDeadlineError("Browser call deadline reached");
    let stdout: string;
    try {
      const child = Bun.spawn(
        [
          process.env.AGENT_BROWSER_BIN ?? "agent-browser",
          ...Object.entries(this.config?.args ?? {}).flatMap(([key, value]) =>
            (Array.isArray(value) ? value : [value]).flatMap((item) =>
              item === true ? ["--" + key] : ["--" + key, String(item)],
            ),
          ),
          "--session",
          this.session,
          "--json",
          ...args,
        ],
        {
          timeout: Math.min(12_000, remaining),
          stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
          stdout: "pipe",
          stderr: "ignore",
          env: { ...process.env, ...this.config?.env },
          ...(this.signal ? { signal: this.signal } : {}),
        },
      );
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code !== 0) throw new Error("agent-browser exited with code " + code);
      stdout = text;
    } catch {
      if (this.signal?.aborted) throw new Error("Run cancelled");
      if (Date.now() >= this.deadline) throw new BrowserDeadlineError("Browser call deadline reached");
      throw new Error("agent-browser " + args[0] + " failed or timed out");
    }
    const response = responseSchema.parse(JSON.parse(stdout));
    if (!response.success) throw new BrowserCommandRejectedError("agent-browser " + args[0] + " rejected the command");
    return response.data;
  }

  async evaluate(request: PageRequest): Promise<unknown> {
    return z.object({ result: z.unknown() }).parse(await this.command(["eval", "--stdin"], pageExpression(request)))
      .result;
  }

  // A page that is still navigating can fail the first read; retry briefly.
  private async observeWithRetry(): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.evaluate({ type: "observe" });
      } catch (error) {
        if (
          attempt >= 3 ||
          this.signal?.aborted ||
          error instanceof BrowserDeadlineError ||
          this.deadline - Date.now() < 3000
        )
          throw error;
        await Bun.sleep(700);
      }
    }
  }

  async observe(): Promise<Observation> {
    const result = observationSchema.parse(await this.observeWithRetry());
    const { snapshotId: _snapshotId, ...semantic } = result;
    return { ...result, fingerprint: new Bun.CryptoHasher("sha256").update(JSON.stringify(semantic)).digest("hex") };
  }

  async execute(decision: Decision, text?: string): Promise<void> {
    if (!decision.snapshotId) throw new Error("Decision has no bound observation");
    const receipt = receiptSchema.parse(
      await this.evaluate({
        type: "execute",
        snapshotId: decision.snapshotId,
        actionId: decision.actionId ?? crypto.randomUUID(),
        operation: decision.operation,
        targetId: decision.targetId,
        text,
        expectedSelector: decision.expectedSelector,
      }),
    );
    if (receipt.status === "stale") throw new StaleDecisionError(receipt.reason);
    if (receipt.status !== "executed") throw new Error("Browser input was interrupted");
  }

  async receipt(actionId: string): Promise<"executed" | "uncertain" | "unknown"> {
    const result = await this.evaluate({ type: "receipt", actionId });
    return result === null ? "unknown" : z.object({ status: z.enum(["executed", "uncertain"]) }).parse(result).status;
  }

  async assert(assertions: Assertion[]): Promise<AssertionResult> {
    const requested = Math.max(...assertions.map((item) => item.timeoutMs));
    const timeout = Math.max(0, Math.min(requested, this.deadline - Date.now() - 200));
    const data = z
      .object({ result: z.unknown() })
      .parse(await this.command(["eval", "--stdin"], assertionExpression(assertions, timeout)));
    const result = assertionResultSchema.parse(data.result);
    if (!result.passed && timeout < requested)
      throw new BrowserDeadlineError("Call deadline interrupted assertion evaluation");
    return result;
  }
}
