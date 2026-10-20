import { z } from "zod";

export const PROTOCOL = "agent-browser.plugin.v1";
export const capabilities = [
  "command.run",
  "agent.run",
  "agent.resume",
  "agent.status",
  "agent.context",
];
const text = z.string().trim().min(1).max(10_000);
const endpoint = z
  .url()
  .refine(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "Use an HTTP(S) endpoint",
  );
const session = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const backendSchema = z.object({
  provider: z.enum(["jev", "laya"]),
  baseUrl: endpoint.optional(),
  model: text.optional(),
  apiKeyEnv: envName.optional(),
});
export const stepSchema = z.object({
  instruction: text,
  value: z.string().max(2000).optional(),
  expect: z
    .object({ text: text.optional(), url: z.url().optional() })
    .refine(
      (value) => value.text !== undefined || value.url !== undefined,
      "Supply expected text or URL",
    )
    .optional(),
});
export const runSchema = z
  .object({
    prompt: text,
    steps: z
      .array(
        z.union([
          text.transform((instruction): z.infer<typeof stepSchema> => ({
            instruction,
          })),
          stepSchema,
        ]),
      )
      .min(1)
      .max(100),
    backend: backendSchema,
    textModel: z
      .object({
        baseUrl: endpoint,
        model: text,
        apiKeyEnv: envName.default("TEXT_MODEL_API_KEY"),
      })
      .optional(),
    session: session.optional(),
    url: z
      .url()
      .refine(
        (value) =>
          ["http:", "https:", "file:"].includes(new URL(value).protocol),
        "Unsupported app URL",
      )
      .optional(),
    maxActions: z.number().int().min(1).max(200).default(60),
    maxStepDecisions: z.number().int().min(1).max(100).default(20),
    actionsPerCall: z.number().int().min(1).max(200).default(20),
    timeoutMs: z.number().int().min(1000).max(45_000).default(45_000),
  })
  .refine(
    (value) => value.url !== undefined || value.session !== undefined,
    "Supply an app URL or existing session",
  );

export const envelopeSchema = z.object({
  protocol: z.literal(PROTOCOL),
  type: z.string(),
  capability: z.string().optional(),
  request: z.unknown().default({}),
});
export const resumeSchema = z.object({ runId: z.uuid() });
export const contextSchema = z.object({ session });
export type RunInput = z.infer<typeof runSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Backend = z.infer<typeof backendSchema>;

export type Target = {
  ref: string;
  label: string;
  value?: string;
  role?: string;
  currentValue?: string;
  checked?: string;
};
export type Element = {
  index: string;
  label: string;
  role: string;
  value: string;
  operations: string[];
  checked?: string;
};
export type Observation = {
  url: string;
  tree: string;
  fingerprint: string;
  targets: Record<string, Record<string, Target>>;
  elements: Element[];
};
export type Decision = {
  operation: string;
  target: Target | undefined;
  confidence: number;
  targetConfidence?: number;
};
