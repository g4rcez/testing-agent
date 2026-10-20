import { describe, expect, test } from "bun:test";
import { envelopeSchema, PROTOCOL, runSchema } from "../../src/contracts.ts";

const input = {
  prompt: "Find a hotel",
  steps: [
    "Search Lisbon",
    { instruction: "Open Casa Flora", expect: { text: "Casa Flora" } },
  ],
  backend: { provider: "laya" },
  url: "https://example.com",
};

describe("plugin inputs", () => {
  test("normalizes ordered steps and preserves the initial prompt", () => {
    const parsed = runSchema.parse(input);
    expect(parsed.prompt).toBe(input.prompt);
    expect(parsed.steps.map((step) => step.instruction)).toEqual([
      "Search Lisbon",
      "Open Casa Flora",
    ]);
    expect(parsed.timeoutMs).toBeLessThan(60_000);
  });
  test("rejects empty steps, shell-like sessions and executable URLs", () => {
    expect(runSchema.safeParse({ ...input, steps: [] }).success).toBe(false);
    expect(
      runSchema.safeParse({ ...input, session: "--config evil" }).success,
    ).toBe(false);
    expect(
      runSchema.safeParse({ ...input, url: "javascript:alert(1)" }).success,
    ).toBe(false);
  });
  test("requires an explicit backend and a browser destination", () => {
    expect(runSchema.safeParse({ ...input, backend: undefined }).success).toBe(
      false,
    );
    expect(runSchema.safeParse({ ...input, url: undefined }).success).toBe(
      false,
    );
  });
  test("checks the plugin protocol", () => {
    expect(
      envelopeSchema.parse({ protocol: PROTOCOL, type: "plugin.manifest" })
        .request,
    ).toEqual({});
    expect(
      envelopeSchema.safeParse({ protocol: "other", type: "agent.run" })
        .success,
    ).toBe(false);
  });
});
