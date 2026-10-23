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
    instructions: {
      original_request: input.prompt,
      goal: "Open the result",
    },
  });
  expect(request.state.task).toEqual({
    prompt: input.prompt,
    current_step: "Open the result",
    current_step_number: 2,
    steps: ["Search Lisbon", "Open the result"],
  });
});
test("rejects invented targets and invalid probability distributions", () => {
  expect(() =>
    validateChoice(
      { choice: "evil", probabilities: { e1: 1 }, confidence: 1 },
      ["e1"],
    ),
  ).toThrow();
  expect(() =>
    validateChoice(
      { choice: "e1", probabilities: { e1: 0.2, e2: 0.8 }, confidence: 1 },
      ["e1", "e2"],
    ),
  ).toThrow();
  expect(() =>
    validateChoice(
      { choice: "e1", probabilities: { e1: Number.NaN }, confidence: 1 },
      ["e1"],
    ),
  ).toThrow();
  expect(
    validateChoice(
      { choice: "e1", probabilities: { e1: 1 }, confidence: 0.8 },
      ["e1"],
    ).choice,
  ).toBe("e1");
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
  expect(request.state.recent_actions).toEqual([
    { action: "Now", kind: "click" },
  ]);
});

test("an assumption needs its distinctive words visible on the page", async () => {
  const { assumptionGrounded } = await import("../../src/decision.ts");
  const page: Observation = {
    ...observation,
    text: "Main Page Welcome",
    elements: [
      {
        index: "e1",
        label: "Search Wikipedia",
        role: "searchbox",
        value: "IPv4",
        operations: ["TYPE_TEXT"],
      },
    ],
  };
  expect(
    assumptionGrounded("The Search Wikipedia box contains IPv4", page),
  ).toBe(true);
  expect(
    assumptionGrounded("The Search Wikipedia box contains Spider-Man", page),
  ).toBe(false);
});
