import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  layaSettingsFromEnv,
  layaSettingsToEnv,
  prepareBundle,
  prepareLayaRequest,
  restoreLayaAnswers,
  startLocalLayaServer,
  type LocalLayaModel,
} from "../../src/local-laya.ts";

const budget = { countTokens: (text: string) => text.length, maxLength: 4096, headMaxLength: 1024 };
const input = {
  state: {
    task: {
      prompt: "Use the blog",
      steps: ["Type ls", "Press Enter"],
      current_step: "Type ls",
      current_step_number: 1,
    },
    page: { text: "Blog" },
    elements: [{ label: "Terminal", role: "textbox", value: "", operations: ["TYPE_TEXT"] }],
    recent_actions: [],
  },
  questions: {
    operation: {
      type: "choice",
      instructions: { goal: "Type ls", rules: "Keep original intent", original_request: "Use the blog" },
      criteria: { TYPE_TEXT: "Type text", DONE: "Completed" },
    },
    type_text_target: {
      type: "choice",
      instructions: { goal: "Type ls", operation: "TYPE_TEXT" },
      criteria: {
        "long-stable-target-id": { element: "[long-stable-target-id] Terminal", role: "textbox", current_value: "" },
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
  expect(prepared.questions.type_text_target!.instructions).toContain("TYPE_TEXT");
  expect(Object.values(prepared.questions.type_text_target!.criteria)[0]).toContain("Terminal");
  expect(JSON.stringify(prepared.questions.type_text_target)).not.toContain("long-stable-target-id");
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
  expect(result.operation!.probabilities).toEqual({ TYPE_TEXT: 0.9, DONE: 0.1 });
  expect(result.type_text_target!.choice).toBe("long-stable-target-id");
  expect(result.type_text_target!.confidence).toBe(1);
});

test("context budgeting preserves instructions and task, clips only page text, and rejects oversized field state", () => {
  const longPage = { ...input, state: { ...input.state, page: { text: "visible page ".repeat(1000) } } };
  const prepared = prepareLayaRequest(longPage, budget);
  expect(prepared.state.page.truncated).toBe(true);
  expect(prepared.state.page.text.length).toBeLessThan(longPage.state.page.text.length);
  expect(prepared.state.task).toEqual(input.state.task);
  expect(prepared.state.instructions).toContainEqual(input.questions.operation.instructions);
  const longField = {
    ...input,
    state: { ...input.state, elements: [{ ...input.state.elements[0]!, value: "x".repeat(10_000) }] },
  };
  expect(() => prepareLayaRequest(longField, budget)).toThrow("context limit");
});

test("only answers the asked questions but sizes the state for all of them", () => {
  const tight = { countTokens: (text: string) => text.length, maxLength: 900, headMaxLength: 400 };
  const long = { ...input, state: { ...input.state, page: { text: "x".repeat(5000) } } };
  const all = prepareLayaRequest(long, tight);
  const operation = prepareLayaRequest({ ...long, only: ["operation"] }, tight);
  expect(Object.keys(operation.questions)).toEqual(["operation"]);
  expect(Object.keys(operation.ids)).toEqual(["operation"]);
  expect(operation.state).toEqual(all.state);
  expect(all.state.page.truncated).toBe(true);
  const target = prepareLayaRequest({ ...long, only: ["type_text_target"] }, tight);
  expect(Object.keys(target.questions)).toEqual(["type_text_target"]);
  expect(target.state).toEqual(all.state);
  expect(() => prepareLayaRequest({ ...long, only: ["missing"] }, tight)).toThrow("Unknown question");
});

test("local server forwards only the requested questions to the model", async () => {
  const asked: string[][] = [];
  const model: LocalLayaModel = {
    budget,
    async systemOne(_state, questions) {
      asked.push(Object.keys(questions));
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([name, question]) => {
            const keys = Object.keys(question.criteria);
            return [
              name,
              {
                type: "choice",
                choice: keys[0]!,
                probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])),
                confidence: 1,
                answer_confidence: 1,
                rl_agent: { act_probability: 1 },
              },
            ];
          }),
        ),
      };
    },
    async close() {},
  };
  const local = startLocalLayaServer(model, { port: 0 });
  const url = String(local.server.url) + "v1/systemone";
  const post = (body: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const response = await post({ ...input, only: ["operation"] });
    expect(response.status).toBe(200);
    expect(Object.keys((await response.json()).answers)).toEqual(["operation"]);
    expect((await post({ ...input, only: ["missing"] })).status).toBe(422);
    expect(asked).toEqual([["operation"]]);
  } finally {
    await local.close();
  }
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
                probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])),
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
    const headers = { "content-type": "application/json", authorization: "Bearer fixture-key" };
    expect(
      (
        await fetch(url + "v1/systemone", {
          method: "POST",
          headers: { ...headers, origin: "https://untrusted.example" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
    expect((await fetch(url + "v1/systemone", { method: "POST", headers, body: "{}" })).status).toBe(422);
    expect(calls).toBe(0);
    const response = await fetch(url + "v1/systemone", { method: "POST", headers, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    expect((await response.json()).answers.type_text_target.choice).toBe("long-stable-target-id");
    expect(calls).toBe(1);
  } finally {
    await local.close();
    await local.close();
  }
  expect(closed).toBe(1);
});

test("local server answers an identical request once, joining a run in flight and then caching it", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  const model: LocalLayaModel = {
    budget,
    async systemOne(_state, questions) {
      calls++;
      enter();
      await pending;
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([name, question]) => {
            const keys = Object.keys(question.criteria);
            return [
              name,
              {
                type: "choice",
                choice: keys[0]!,
                probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])),
                confidence: 1,
                answer_confidence: 1,
                rl_agent: { act_probability: 1 },
              },
            ];
          }),
        ),
      };
    },
    async close() {},
  };
  const local = startLocalLayaServer(model, { port: 0 });
  const url = String(local.server.url) + "v1/systemone";
  const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
  try {
    const first = fetch(url, options);
    await entered;
    const joined = fetch(url, options);
    release();
    const [one, two] = await Promise.all([first, joined]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(await two.json()).toEqual(await one.json());
    expect(calls).toBe(1);
    expect((await fetch(url, options)).status).toBe(200);
    expect(calls).toBe(1);
    const other = {
      ...options,
      body: JSON.stringify({ ...input, state: { ...input.state, recent_actions: [{ n: 1 }] } }),
    };
    expect((await fetch(url, other)).status).toBe(200);
    expect(calls).toBe(2);
  } finally {
    await local.close();
  }
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
  const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
  try {
    const first = fetch(url, options);
    await entered;
    const other = {
      ...options,
      body: JSON.stringify({ ...input, state: { ...input.state, recent_actions: [{ n: 1 }] } }),
    };
    expect((await fetch(url, other)).status).toBe(503);
    release();
    const response = await first;
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("private model state");
  } finally {
    release();
    await local.close();
  }
});

test("long pages keep the options that match the step and restore pruned ones at zero", () => {
  const criteria = Object.fromEntries(
    Array.from({ length: 80 }, (_, index) => [
      `e${index}`,
      { element: `[e${index}] ${index === 70 ? "Search" : "link"}`, role: "link" },
    ]),
  );
  const long = {
    ...input,
    state: { ...input.state, task: { ...input.state.task, steps: ["a", "b"] } },
    questions: {
      click_target: { type: "choice", instructions: { goal: "Click Search", operation: "CLICK" }, criteria },
    },
  };
  const prepared = prepareLayaRequest(long, budget);
  const small = { ...budget, countTokens: () => 5, headMaxLength: 100 };
  const pruned = prepareLayaRequest(long, small);
  expect(Object.keys(prepared.questions.click_target!.criteria)).toHaveLength(80);
  const kept = Object.keys(pruned.questions.click_target!.criteria);
  expect(kept.length).toBeLessThan(80);
  expect(Object.values(pruned.ids.click_target!)).toContain("e70");
  expect(pruned.kept.click_target).toEqual(kept);
  const restored = restoreLayaAnswers(pruned, {
    click_target: {
      type: "choice",
      choice: kept[0]!,
      probabilities: Object.fromEntries(kept.map((key) => [key, key === kept[0] ? 1 : 0])),
      confidence: 1,
    },
  } as never);
  expect(Object.keys(restored.click_target!.probabilities)).toHaveLength(80);
});

test("Laya settings travel through the environment and are validated", () => {
  const settings = layaSettingsFromEnv({
    LAYA_LANGUAGE: "multilingual",
    LAYA_MAX_LEN: "384",
    LAYA_HEAD_MAX_LEN: "128",
    LAYA_THREADS: "6",
    LAYA_REVISION: "",
  });
  expect(settings).toEqual({ language: "multilingual", maxLen: 384, headMaxLen: 128, threads: 6 });
  expect(layaSettingsToEnv(settings)).toEqual({
    LAYA_LANGUAGE: "multilingual",
    LAYA_MAX_LEN: "384",
    LAYA_HEAD_MAX_LEN: "128",
    LAYA_THREADS: "6",
  });
  expect(layaSettingsFromEnv({})).toEqual({});
  expect(layaSettingsToEnv(undefined)).toEqual({});
  expect(() => layaSettingsFromEnv({ LAYA_MAX_LEN: "100", LAYA_HEAD_MAX_LEN: "200" })).toThrow("headMaxLen");
  expect(() => layaSettingsFromEnv({ LAYA_LANGUAGE: "../etc" })).toThrow();
  expect(() => layaSettingsFromEnv({ LAYA_THREADS: "many" })).toThrow();
});

test("preparing the model files never overwrites a hand-edited laya_config.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "laya-bundle-"));
  try {
    const config = join(directory, "laya_config.json");
    const mine = JSON.stringify({ max_len: 256, head_max_len: 96 });
    const published = JSON.stringify({ max_len: 512, head_max_len: 192, temperature: [1, 1, 1] });
    await Bun.write(config, mine);
    const seen: unknown[] = [];
    // The real downloader replaces any file whose size differs from the published one.
    const downloader = async (options: { revision: string; subfolder?: string; token: string }) => {
      seen.push(options);
      await Bun.write(config, published);
      return directory;
    };
    expect(await prepareBundle({ directory, revision: "abc", subfolder: "multilingual" }, downloader)).toBe(directory);
    expect(await Bun.file(config).text()).toBe(mine);
    expect(await readdir(directory)).toEqual(["laya_config.json"]);
    expect(seen).toEqual([{ revision: "abc", subfolder: "multilingual", token: "" }]);

    // A start interrupted after the download replaced the file leaves a backup of the user's copy.
    await Bun.write(config, published);
    await Bun.write(`${config}.user`, mine);
    await prepareBundle({ directory, revision: "abc" }, downloader);
    expect(await Bun.file(config).text()).toBe(mine);
    expect(await readdir(directory)).toEqual(["laya_config.json"]);

    // First download: nothing to keep, the published file stays.
    await rm(config);
    await prepareBundle({ directory, revision: "abc" }, downloader);
    expect(await Bun.file(config).text()).toBe(published);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the health report names the model settings the server runs with", async () => {
  const model: LocalLayaModel = { budget, systemOne: async () => ({ answers: {} }), close: async () => {} };
  const local = startLocalLayaServer(model, {
    port: 0,
    model: "receptron/laya-onnx@abc/multilingual",
    info: { language: "multilingual", maxLen: 384, headMaxLen: 128 },
  });
  try {
    const health = await (await fetch(String(local.server.url) + "health")).json();
    expect(health).toEqual({
      ready: true,
      model: "receptron/laya-onnx@abc/multilingual",
      language: "multilingual",
      maxLen: 384,
      headMaxLen: 128,
    });
  } finally {
    await local.close();
  }
});
