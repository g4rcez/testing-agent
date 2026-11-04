import { expect, test } from "bun:test";
import { runSchema, type Observation, type Target } from "../../src/contracts.ts";
import { resolveFast } from "../../src/fastpath.ts";

const target = (ref: string, label: string, role: string, currentValue = ""): Target => ({
  ref,
  label,
  role,
  currentValue,
});
const page = (targets: Observation["targets"]): Observation => ({
  url: "https://example.com",
  tree: "App",
  fingerprint: "one",
  elements: [],
  snapshotId: "snap",
  targets,
});
const run = (steps: unknown[], extra: Record<string, unknown> = {}) =>
  runSchema.parse({
    prompt: "Test",
    steps,
    session: "sentences",
    backend: { provider: "laya" },
    expect: [{ text: "App" }],
    ...extra,
  });
const wiki = page({ TYPE_TEXT: { e3: target("e3", "Search Wikipedia", "searchbox") } });
const login = page({ TYPE_TEXT: { e1: target("e1", "Login", "textbox") } });

test("a check written as a sentence is the same check as the object", () => {
  const input = run([
    { instruction: "Press Enter", expect: "The URL is https://example.com/a and the page shows Hello" },
    { instruction: "Click Next", expect: "I see Welcome back" },
    { instruction: "Click Done", expect: 'The page shows "Saved. And done"' },
  ]);
  expect(input.steps.map((step) => step.expect)).toEqual([
    { text: "Hello", url: "https://example.com/a", timeoutMs: 2000 },
    { text: "Welcome back", timeoutMs: 2000 },
    { text: "Saved. And done", timeoutMs: 2000 },
  ]);
  expect(run(["Click Go"], { expect: ["The page shows Tom and Jerry", { text: "x" }] }).expect).toEqual([
    { text: "Tom and Jerry", timeoutMs: 2000 },
    { text: "x", timeoutMs: 2000 },
  ]);
});

test("a sentence that is not a check says how to write one", () => {
  const result = runSchema.safeParse({
    prompt: "Test",
    steps: [{ instruction: "Click Go", expect: "Everything is fine" }],
    session: "sentences",
    backend: { provider: "laya" },
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.message).toBe(
    'Write the check as "The page shows <text>", "The URL is <address>" or both joined by "and"',
  );
});

test("the text to type is read from the step, as written", () => {
  expect(resolveFast(run(["Type Large language model into the Search Wikipedia box"]), 0, wiki, [])).toMatchObject({
    operation: "TYPE_TEXT",
    targetId: "e3",
    text: "Large language model",
    source: "fast",
    rule: "type",
  });
  expect(resolveFast(run(["Fill in the Login field with Ana"]), 0, login, [])).toMatchObject({
    operation: "TYPE_TEXT",
    targetId: "e1",
    text: "Ana",
  });
  // The field shows the text: the step is done.
  const typed = page({ TYPE_TEXT: { e1: target("e1", "Login", "textbox", "ana") } });
  expect(resolveFast(run(["Fill in the Login field with Ana"]), 0, typed, [])).toMatchObject({ operation: "DONE" });
});

test("a step in another language gives its text with its own accents", () => {
  const busca = page({ TYPE_TEXT: { e1: target("e1", "Busca", "textbox") } });
  expect(resolveFast(run(["Digite Olá no campo Busca"], { languages: ["pt"] }), 0, busca, [])).toMatchObject({
    operation: "TYPE_TEXT",
    text: "Olá",
  });
});

test("where the sentence could split in two, the field the page has decides", () => {
  const search = page({ TYPE_TEXT: { e3: target("e3", "Search Wikipedia", "searchbox") } });
  expect(resolveFast(run(["Type Learn in Spanish into the Search Wikipedia box"]), 0, search, [])).toMatchObject({
    text: "Learn in Spanish",
    targetId: "e3",
  });
});

test("a text model keeps writing the text, unless the step puts it in quotes", () => {
  const withModel = { textModel: { baseUrl: "https://text.example.com", model: "writer" } };
  expect(resolveFast(run(["Type a valid email into the Login box"], withModel), 0, login, [])).toBeNull();
  expect(resolveFast(run(['Type "ana@example.com" into the Login box'], withModel), 0, login, [])).toMatchObject({
    text: "ana@example.com",
  });
});
