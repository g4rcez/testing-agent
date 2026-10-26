import { expect, test } from "bun:test";
import { makeRequest, validateChoice } from "../../src/decision.ts";
import { runSchema, type Observation } from "../../src/contracts.ts";

const observation: Observation = {
  url: "https://example.com",
  tree: "App",
  fingerprint: "one",
  elements: [],
  targets: { CLICK: { e1: { ref: "e1", label: "Search", role: "button" } } },
};
test("preserves original intent and all steps while selecting only the current step", () => {
  const input = runSchema.parse({
    prompt: "Bookmarked hotel research",
    steps: ["Search Lisbon", "Open the result"],
    session: "test",
    expect: [{ text: "App" }],
    backend: { provider: "laya" },
  });
  const request = makeRequest(input, 1, observation, []);
  expect(request.questions.operation).toMatchObject({
    instructions: { original_request: input.prompt, goal: "Open the result" },
  });
  expect(request.state.task).toEqual({
    prompt: input.prompt,
    current_step: "Open the result",
    current_step_number: 2,
    steps: ["Search Lisbon", "Open the result"],
  });
});
test("rejects invented targets and invalid probability distributions", () => {
  expect(() => validateChoice({ choice: "evil", probabilities: { e1: 1 }, confidence: 1 }, ["e1"])).toThrow();
  expect(() =>
    validateChoice({ choice: "e1", probabilities: { e1: 0.2, e2: 0.8 }, confidence: 1 }, ["e1", "e2"]),
  ).toThrow();
  expect(() => validateChoice({ choice: "e1", probabilities: { e1: Number.NaN }, confidence: 1 }, ["e1"])).toThrow();
  expect(validateChoice({ choice: "e1", probabilities: { e1: 1 }, confidence: 0.8 }, ["e1"]).choice).toBe("e1");
});

test("only the current step's actions are sent as recent actions", () => {
  const input = runSchema.parse({
    prompt: "Search",
    steps: ["Type", "Click Search"],
    session: "test",
    expect: [{ text: "App" }],
    backend: { provider: "laya" },
  });
  const request = makeRequest(input, 1, observation, [
    { operation: "TYPE_TEXT", target: "Old", stepIndex: 0 },
    { operation: "CLICK", target: "Now", stepIndex: 1 },
  ]);
  expect(request.state.recent_actions).toEqual([{ action: "Now", kind: "click" }]);
});

test("an assumption needs its distinctive words visible on the page", async () => {
  const { assumptionGrounded } = await import("../../src/decision.ts");
  const page: Observation = {
    ...observation,
    text: "Main Page Welcome",
    elements: [{ index: "e1", label: "Search Wikipedia", role: "searchbox", value: "IPv4", operations: ["TYPE_TEXT"] }],
  };
  expect(assumptionGrounded("The Search Wikipedia box contains IPv4", page)).toBe(true);
  expect(assumptionGrounded("The Search Wikipedia box contains Spider-Man", page)).toBe(false);
  expect(assumptionGrounded("the SEARCH wikipedia box contains ipv4", page)).toBe(true);
  expect(
    assumptionGrounded("The box contains Café", { ...page, elements: [{ ...page.elements[0]!, value: "CAFE" }] }),
  ).toBe(true);
});

test("scrollable containers reach the model with what they hide, and the scroll operations are described", async () => {
  const { makeRequest } = await import("../../src/decision.ts");
  const input = runSchema.parse({
    prompt: "Pick a country",
    steps: ["Choose Spain from the list"],
    session: "s",
    backend: { provider: "laya" },
    expect: [{ text: "Spain" }],
  });
  const screen: Observation = {
    ...observation,
    controls: ["WAIT", "DONE", "BLOCKED"],
    targets: {
      SCROLL_DOWN: {
        s1: {
          ref: "s1",
          label: "Countries",
          role: "scrollable",
          currentValue: "20% scrolled",
          scroll: {
            progress: 20,
            below: 7,
            above: 3,
            belowLabels: ["Spain", "Sweden", "Switzerland", "Turkey", "Ukraine"],
            aboveLabels: ["Albania", "Austria", "Belgium"],
          },
        },
        page: { ref: "page", label: "Page", role: "scrollable", currentValue: "0% scrolled" },
      },
    },
  };
  const { questions, operations } = makeRequest(input, 0, screen, []);
  expect(operations.SCROLL_DOWN).toContain("scrollable area");
  const criteria = (questions.scroll_down_target as { criteria: Record<string, { element: string }> }).criteria;
  expect(criteria.s1!.element).toBe(
    "[s1] Countries (scrollable, 20% scrolled; 7 below: Spain, Sweden, Switzerland, Turkey, ...; 3 above: Albania, Austria, Belgium)",
  );
  expect(criteria.page!.element).toBe("[page] Page");
});
