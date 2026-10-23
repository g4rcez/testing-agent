import { z } from "zod";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ChoiceAnswer, ChoiceQuestion } from "@receptron/laya";
import { validateChoice } from "./decision.ts";

export const LAYA_REVISION = "d42786bdff8a7550316339c5fbf8f46caa83ea1b";
const modelName = `receptron/laya-onnx@${LAYA_REVISION}`;
const targetSchema = z.object({
  element: z.string(),
  role: z.string().optional(),
  current_value: z.string().optional(),
  checked: z.unknown().optional(),
});
const requestSchema = z.object({
  state: z.object({
    task: z.object({ current_step: z.string().min(1) }).passthrough(),
    elements: z.array(
      z
        .object({
          label: z.string(),
          value: z.string(),
          operations: z.array(z.string()),
          checked: z.string().optional(),
        })
        .passthrough(),
    ),
    page: z.object({ url: z.string().optional(), title: z.string().optional(), text: z.string().default("") }),
    recent_actions: z.array(z.unknown()),
  }),
  questions: z
    .record(
      z.string(),
      z.object({
        type: z.literal("choice"),
        instructions: z.union([
          z.string(),
          z.object({ goal: z.string(), operation: z.string().optional() }).passthrough(),
        ]),
        criteria: z
          .record(z.string(), z.union([z.string(), targetSchema]))
          .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 200),
      }),
    )
    .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 8),
});

export type LayaTokenBudget = { countTokens(text: string): number; maxLength: number; headMaxLength: number };

// The pinned runtime uses Python's JSON separators before tokenization.
function spacedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(spacedJson).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}: ${spacedJson(item)}`)
      .join(", ")}}`;
  return JSON.stringify(value) ?? "null";
}

function stateRoom(questions: Record<string, ChoiceQuestion>, budget: LayaTokenBudget): number {
  const count = (text: string) => budget.countTokens(text.replaceAll("[MASK]", " "));
  return Math.min(
    ...Object.values(questions).map((question) => {
      let options = Object.entries(question.criteria).map(
        ([key, value]) => 1 + Math.min(48, count(` ${value ? `${key}: ${value}` : key}`)),
      );
      const sum = () => options.reduce((total, size) => total + size, 0);
      if (budget.headMaxLength - sum() < 16) {
        const per = Math.max(4, Math.floor((budget.headMaxLength - 16) / options.length));
        options = options.map((size) => Math.min(size, per));
      }
      const instructionLength = count(
        `choice question: ${typeof question.instructions === "string" ? question.instructions : spacedJson(question.instructions)}`,
      );
      if (instructionLength > Math.max(8, budget.headMaxLength - sum()))
        throw new Error("Local Laya instructions exceed the model context limit");
      return budget.maxLength - instructionLength - sum() - 4;
    }),
  );
}

// Long pages offer more targets than the model's option window holds. Keep the
// ones that share the most words with the current step, in page order.
function pruneOptions(
  asked: z.infer<typeof requestSchema>["questions"],
  questions: Record<string, ChoiceQuestion>,
  kept: Record<string, string[]>,
  budget: LayaTokenBudget,
): void {
  const count = (text: string) => budget.countTokens(text.replaceAll("[MASK]", " "));
  for (const [name, question] of Object.entries(questions)) {
    const entries = Object.entries(question.criteria);
    const room = budget.headMaxLength - 16 - count(`choice question: ${question.instructions}`);
    const cap = Math.max(1, Math.floor(room / 5));
    if (entries.length <= cap) continue;
    const source = asked[name]?.instructions;
    const goal = (typeof source === "string" ? source : (source?.goal ?? ""))
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2);
    const score = (description: string) => goal.filter((word) => description.toLowerCase().includes(word)).length;
    const keep = new Set(
      entries
        .map(([key, description], index) => ({ key, index, score: score(String(description)) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, cap)
        .map((item) => item.key),
    );
    question.criteria = Object.fromEntries(entries.filter(([key]) => keep.has(key)));
    kept[name] = Object.keys(question.criteria);
  }
}

export function prepareLayaRequest(input: unknown, budget?: LayaTokenBudget) {
  const parsed = requestSchema.parse(input);
  const ids: Record<string, Record<string, string>> = {};
  const questions: Record<string, ChoiceQuestion> = {};
  for (const [name, question] of Object.entries(parsed.questions)) {
    ids[name] = {};
    const goal = typeof question.instructions === "string" ? question.instructions : question.instructions.goal;
    const operation = typeof question.instructions === "string" ? undefined : question.instructions.operation;
    questions[name] = {
      type: "choice",
      instructions: operation ? `${operation}: ${goal}` : `${goal} Which browser action is needed now?`,
      criteria: Object.fromEntries(
        Object.entries(question.criteria).map(([key, value], index) => {
          const short = index.toString(36);
          ids[name]![short] = key;
          const description =
            typeof value === "string"
              ? `${key}: ${value}`
              : `${value.element.replace(/^\[[^\]]+\]\s*/, "")} (${value.role ?? "control"})${value.current_value ? ` value=${value.current_value}` : ""}${value.checked === undefined ? "" : ` checked=${value.checked}`}`;
          return [short, description];
        }),
      ),
    };
  }
  const kept: Record<string, string[]> = {};
  if (budget) pruneOptions(parsed.questions, questions, kept, budget);
  const fields = parsed.state.elements
    .filter((element) =>
      element.operations.some((operation) => ["TYPE_TEXT", "SELECT", "CHECK", "UNCHECK"].includes(operation)),
    )
    .map(({ label, value, checked }) => ({ label, value, ...(checked === undefined ? {} : { checked }) }));
  const contexts = new Map<string, unknown>();
  for (const question of Object.values(parsed.questions)) {
    const context =
      typeof question.instructions === "string"
        ? question.instructions
        : Object.fromEntries(Object.entries(question.instructions).filter(([key]) => key !== "operation"));
    contexts.set(JSON.stringify(context), context);
  }
  const state = {
    current_step: parsed.state.task.current_step,
    instructions: [...contexts.values()],
    task: parsed.state.task,
    fields,
    recent_actions: parsed.state.recent_actions,
    page: { ...parsed.state.page, text: "", truncated: false },
  };
  if (budget) {
    const room = stateRoom(questions, budget);
    const fits = () => budget.countTokens(spacedJson(state).replaceAll("[MASK]", " ")) <= room;
    // The model window is small: shed the full step list, then the long rules,
    // keeping the current step, which is all the model acts on.
    if (!fits() && Array.isArray(state.task.steps)) state.task = { ...state.task, steps: [state.current_step] };
    if (!fits())
      state.instructions = state.instructions.map((item) =>
        item && typeof item === "object"
          ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "rules"))
          : item,
      );
    if (!fits()) throw new Error("Local Laya task and observed field/history state exceed the model context limit");
    const text = parsed.state.page.text;
    state.page.truncated = true;
    let low = 0,
      high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      state.page.text = text.slice(0, middle);
      if (fits()) low = middle;
      else high = middle - 1;
    }
    state.page.text = text.slice(0, low);
    state.page.truncated = low < text.length;
    if (!fits()) throw new Error("Local Laya page context exceeds the model context limit");
  } else state.page.text = parsed.state.page.text;
  return { state, questions, ids, kept };
}

export function restoreLayaAnswers(
  prepared: ReturnType<typeof prepareLayaRequest>,
  answers: Record<string, ChoiceAnswer>,
): Record<string, ChoiceAnswer> {
  return Object.fromEntries(
    Object.entries(prepared.ids).map(([name, ids]) => {
      const answer = answers[name]!;
      validateChoice(answer, prepared.kept[name] ?? Object.keys(ids));
      return [
        name,
        {
          ...answer,
          choice: ids[answer.choice]!,
          // Options pruned to fit the model window were never offered: probability 0.
          probabilities: Object.fromEntries(
            Object.entries(ids).map(([key, original]) => [original, answer.probabilities[key] ?? 0]),
          ),
        },
      ];
    }),
  );
}

export type LocalLayaModel = {
  budget: LayaTokenBudget;
  systemOne(
    state: unknown,
    questions: Record<string, ChoiceQuestion>,
  ): Promise<{ answers: Record<string, ChoiceAnswer> }>;
  close(): Promise<void>;
};

export function startLocalLayaServer(model: LocalLayaModel, options: { port?: number; apiKey?: string } = {}) {
  let active: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 8791,
    maxRequestBodySize: 1_000_000,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (!["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port) !== server.port)
        return Response.json({ error: "Invalid local host" }, { status: 403 });
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        return Response.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({ ready: true, model: modelName });
      if (url.pathname !== "/v1/systemone") return Response.json({ error: "Not found" }, { status: 404 });
      if (options.apiKey && request.headers.get("authorization") !== `Bearer ${options.apiKey}`)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (request.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });
      if (active || closing) return Response.json({ error: "Local model is busy" }, { status: 503 });
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return Response.json({ error: "Use application/json" }, { status: 415 });
      // Reserve capacity before reading the body; there is no unbounded queue.
      let finish!: () => void;
      active = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        const prepared = prepareLayaRequest(await request.json(), model.budget);
        if (request.signal.aborted) return new Response(null, { status: 499 });
        const result = await model.systemOne(prepared.state, prepared.questions);
        return Response.json({ model: modelName, answers: restoreLayaAnswers(prepared, result.answers) });
      } catch {
        return Response.json(
          { error: "Local Laya could not answer this request; check its input and model context limits" },
          { status: 422 },
        );
      } finally {
        finish();
        active = undefined;
      }
    },
  });
  return {
    server,
    close() {
      closing ??= (async () => {
        const pending = active;
        await server.stop(true);
        await pending;
        await model.close();
      })();
      return closing;
    },
  };
}

export async function serveLocalLaya(): Promise<void> {
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.LAYA_PORT ?? 8791);
  console.log(
    JSON.stringify({
      loading: true,
      model: modelName,
      message: "First setup downloads about 1.7 GB of weights; later runs use the cache.",
    }),
  );
  const { Laya } = await import("@receptron/laya").catch(() => {
    throw new Error(
      "Optional Laya runtime is unavailable. Reinstall testing-agent with optional dependencies enabled. Setup: https://github.com/receptron/laya",
    );
  });
  const model = await Laya.load({
    revision: LAYA_REVISION,
    token: "",
    sessionOptions: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
  let local: ReturnType<typeof startLocalLayaServer>;
  try {
    // Resolve the tokenizer from the runtime that declares it, including nested installs.
    const require = createRequire(import.meta.resolve("@receptron/laya"));
    const { Tokenizer } = (await import(require.resolve("@huggingface/tokenizers"))) as {
      Tokenizer: new (
        data: unknown,
        config: unknown,
      ) => { encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] } };
    };
    const tokenizer = new Tokenizer(
      await Bun.file(join(model.modelDir, "tokenizer/tokenizer.json")).json(),
      await Bun.file(join(model.modelDir, "tokenizer/tokenizer_config.json")).json(),
    );
    const budget: LayaTokenBudget = {
      countTokens: (text) => tokenizer.encode(text, { add_special_tokens: false }).ids.length,
      maxLength: model.config.max_len,
      headMaxLength: model.config.head_max_len,
    };
    local = startLocalLayaServer(
      { budget, systemOne: (state, questions) => model.systemOne(state, questions), close: () => model.close() },
      { port, ...(process.env.LAYA_API_KEY ? { apiKey: process.env.LAYA_API_KEY } : {}) },
    );
  } catch (error) {
    await model.close();
    throw error;
  }
  console.log(JSON.stringify({ ready: true, url: String(local.server.url), model: modelName }));
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void local.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
