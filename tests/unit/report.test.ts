import { expect, test } from "bun:test";
import { runSchema } from "../../src/contracts.ts";
import { junitReport } from "../../src/report.ts";
import type { RunState } from "../../src/runner.ts";

test("JUnit escapes names and reports a non-passing status as a failure", () => {
  const input = runSchema.parse({
    name: 'Search <&" hotel',
    prompt: "Test",
    steps: ["Open"],
    session: "report",
    backend: { provider: "laya" },
    expect: [{ text: "Done" }],
  });
  const state: RunState = {
    version: 2,
    runId: crypto.randomUUID(),
    session: "report",
    input,
    status: "failed",
    createdAt: 1000,
    updatedAt: 2000,
    endedAt: 2000,
    stepIndex: 1,
    stepDecisions: 0,
    actions: [],
    completedSteps: [],
    pendingAction: null,
    reason: "Missing <result>",
    reasonCode: "FINAL_ASSERTION_FAILED",
    blockedRetries: 0,
    unchangedActions: 0,
    staleDecisions: 0,
    assertions: [{ passed: false, index: 0, message: "Missing" }],
  };
  expect(junitReport(state)).toContain('failures="1"');
  expect(junitReport(state)).toContain("Search &lt;&amp;&quot; hotel");
  expect(junitReport(state)).toContain("Missing &lt;result&gt;");
  expect(junitReport(state)).toContain('type="FINAL_ASSERTION_FAILED"');
  state.debug = {
    lastDecision: { operation: "CLICK", target: "Save <now>", confidence: 0.4, inferenceMs: 120, source: "model" },
    lastObservation: {
      url: "https://example.com/form",
      fingerprint: "abc",
      targetCounts: { CLICK: 3 },
      controlsFiltered: false,
      textExcerpt: "Form page",
    },
  };
  const report = junitReport(state);
  expect(report).toContain("last decision: CLICK -&gt; Save &lt;now&gt;");
  expect(report).toContain("page: https://example.com/form");
  expect(report).toContain("&quot;targetCounts&quot;:{&quot;CLICK&quot;:3}");
  state.status = "completed";
  expect(junitReport(state)).toContain('failures="1"');
  state.assertions[0] = { passed: true, index: 0, message: "Passed" };
  expect(junitReport(state)).toContain('failures="0"');
});
