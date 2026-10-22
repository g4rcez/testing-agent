import { expect, test } from "bun:test";
import {
  prepareLayaRequest,
  restoreLayaAnswers,
  startLocalLayaServer,
  type LocalLayaModel,
} from "../../src/local-laya.ts";

const budget = {
  countTokens: (text: string) => text.length,
  maxLength: 4096,
  headMaxLength: 1024,
};
const input = {
  state: {
    task: {
      prompt: "Use the blog",
      steps: ["Type ls", "Press Enter"],
      current_step: "Type ls",
      current_step_number: 1,
    },
    page: { text: "Blog" },
    elements: [
      {
        label: "Terminal",
        role: "textbox",
        value: "",
        operations: ["TYPE_TEXT"],
      },
    ],
    recent_actions: [],
  },
  questions: {
    operation: {
      type: "choice",
      instructions: {
        goal: "Type ls",
        rules: "Keep original intent",
        original_request: "Use the blog",
      },
      criteria: { TYPE_TEXT: "Type text", DONE: "Completed" },
    },
    type_text_target: {
      type: "choice",
      instructions: { goal: "Type ls", operation: "TYPE_TEXT" },
      criteria: {
        "long-stable-target-id": {
          element: "[long-stable-target-id] Terminal",
          role: "textbox",
          current_value: "",
        },
      },
    },
  },
};

test("local adapter retains task context and removes identifier overhead, not choices", () => {
  const prepared = prepareLayaRequest(input);
  expect(prepared.state.task).toEqual(input.state.task);
  expect(prepared.state.current_step).toBe("Type ls");
  expect(prepared.questions.operation!.instructions).toContain("Type ls");
  expect(prepared.state.instructions).toContainEqual({
    goal: "Type ls",
    rules: "Keep original intent",
    original_request: "Use the blog",
  });
  expect(prepared.questions.type_text_target!.instructions).toContain(
    "TYPE_TEXT",
  );
  expect(
    Object.values(prepared.questions.type_text_target!.criteria)[0],
  ).toContain("Terminal");
  expect(JSON.stringify(prepared.questions.type_text_target)).not.toContain(
    "long-stable-target-id",
  );
  const result = restoreLayaAnswers(prepared, {
    operation: {
      type: "choice",
      choice: "0",
      probabilities: { "0": 0.9, "1": 0.1 },
      confidence: 0.5,
      answer_confidence: 0.9,
      rl_agent: { act_probability: 1 },
    },
    type_text_target: {
      type: "choice",
      choice: "0",
      probabilities: { "0": 1 },
      confidence: 1,
      answer_confidence: 1,
      rl_agent: { act_probability: 1 },
    },
  });
  expect(result.operation!.choice).toBe("TYPE_TEXT");
  expect(result.operation!.probabilities).toEqual({
    TYPE_TEXT: 0.9,
    DONE: 0.1,
  });
  expect(result.type_text_target!.choice).toBe("long-stable-target-id");
  expect(result.type_text_target!.confidence).toBe(1);
});

test("context budgeting preserves instructions and task, clips only page text, and rejects oversized field state", () => {
  const longPage = {
    ...input,
    state: { ...input.state, page: { text: "visible page ".repeat(1000) } },
  };
  const prepared = prepareLayaRequest(longPage, budget);
  expect(prepared.state.page.truncated).toBe(true);
  expect(prepared.state.page.text.length).toBeLessThan(
    longPage.state.page.text.length,
  );
  expect(prepared.state.task).toEqual(input.state.task);
  expect(prepared.state.instructions).toContainEqual(
    input.questions.operation.instructions,
  );
  const longField = {
    ...input,
    state: {
      ...input.state,
      elements: [{ ...input.state.elements[0]!, value: "x".repeat(10_000) }],
    },
  };
  expect(() => prepareLayaRequest(longField, budget)).toThrow("context limit");
});

test("local server validates input, isolates browser origins, and closes its model once", async () => {
  let calls = 0;
  let closed = 0;
  const model: LocalLayaModel = {
    budget,
    async systemOne(_state, questions) {
      calls++;
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([name, question]) => {
            const keys = Object.keys(question.criteria);
            return [
              name,
              {
                type: "choice",
                choice: keys[0]!,
                probabilities: Object.fromEntries(
                  keys.map((key, index) => [key, index === 0 ? 1 : 0]),
                ),
                confidence: 1,
                answer_confidence: 1,
                rl_agent: { act_probability: 1 },
              },
            ];
          }),
        ),
      };
    },
    async close() {
      closed++;
    },
  };
  const local = startLocalLayaServer(model, { port: 0, apiKey: "fixture-key" });
  const url = String(local.server.url);
  try {
    expect((await fetch(url + "health")).status).toBe(200);
    expect(calls).toBe(0);
    expect((await fetch(url + "v1/systemone")).status).toBe(401);
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer fixture-key",
    };
    expect(
      (
        await fetch(url + "v1/systemone", {
          method: "POST",
          headers: { ...headers, origin: "https://untrusted.example" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url + "v1/systemone", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(422);
    expect(calls).toBe(0);
    const response = await fetch(url + "v1/systemone", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).answers.type_text_target.choice).toBe(
      "long-stable-target-id",
    );
    expect(calls).toBe(1);
  } finally {
    await local.close();
    await local.close();
  }
  expect(closed).toBe(1);
});

test("local server has bounded concurrency and preserves model errors", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const model: LocalLayaModel = {
    budget,
    async systemOne() {
      enter();
      await pending;
      throw new Error("private model state");
    },
    async close() {},
  };
  const local = startLocalLayaServer(model, { port: 0 });
  const url = String(local.server.url) + "v1/systemone";
  const options = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  };
  try {
    const first = fetch(url, options);
    await entered;
    expect((await fetch(url, options)).status).toBe(503);
    release();
    const response = await first;
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("private model state");
  } finally {
    release();
    await local.close();
  }
});
