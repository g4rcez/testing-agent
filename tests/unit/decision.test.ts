import { expect, test } from "bun:test";
import { parseSnapshot } from "../../src/browser.ts";
import { makeRequest, validateChoice } from "../../src/decision.ts";
import { runSchema } from "../../src/contracts.ts";

const observation = parseSnapshot({
  origin: "https://example.com",
  snapshot:
    '- searchbox "Destination" [ref=e1]: Lisbon\n- combobox "Category" [ref=e2]: All\n  - option "All" [selected, ref=e3]\n  - option "Design" [ref=e4]\n- checkbox "Free cancellation" [checked=false, ref=e5]\n- button "Search" [ref=e6]',
  refs: {
    e1: { name: "Destination", role: "searchbox" },
    e2: { name: "Category", role: "combobox" },
    e3: { name: "All", role: "option" },
    e4: { name: "Design", role: "option" },
    e5: { name: "Free cancellation", role: "checkbox" },
    e6: { name: "Search", role: "button" },
  },
});

test("maps observed options and checkbox state into executable targets", () => {
  expect(observation.targets.SELECT?.["@e2:e4"]).toEqual({
    ref: "@e2",
    label: "Category → Design",
    value: "Design",
    role: "combobox",
  });
  expect(observation.targets.CHECK?.e5?.ref).toBe("@e5");
  expect(observation.targets.UNCHECK).toBeUndefined();
});
test("preserves original intent and all steps while selecting only the current step", () => {
  const input = runSchema.parse({
    prompt: "Bookmarked hotel research",
    steps: ["Search Lisbon", "Open the result"],
    session: "test",
    backend: { provider: "laya" },
  });
  const request = makeRequest(input, 1, observation, []);
  expect(request.questions.operation).toMatchObject({
    instructions: {
      initial_prompt: input.prompt,
      current_step: "Open the result",
      current_step_number: 2,
      steps: ["Search Lisbon", "Open the result"],
    },
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
