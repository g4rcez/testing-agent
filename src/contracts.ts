import { z } from "zod";

export const PROTOCOL = "agent-browser.plugin.v1";
export const capabilities = [
  "command.run",
  "agent.run",
  "agent.resume",
  "agent.status",
  "agent.context",
  "agent.cancel",
  "agent.recover",
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
export const assertionSchema = z
  .object({
    text: text.optional(),
    url: z.url().optional(),
    selector: z.string().min(1).max(1000).optional(),
    visible: z.boolean().optional(),
    value: z.string().max(2000).optional(),
    checked: z.boolean().optional(),
    count: z.number().int().min(0).max(10000).optional(),
    timeoutMs: z.number().int().min(0).max(10000).default(2000),
  })
  .refine(
    (value) =>
      value.text !== undefined ||
      value.url !== undefined ||
      value.selector !== undefined,
    "Supply a deterministic text, URL, or element assertion",
  )
  .refine(
    (value) =>
      value.selector !== undefined ||
      [value.visible, value.value, value.checked, value.count].every(
        (item) => item === undefined,
      ),
    "Element assertions require a selector",
  );
export type Assertion = z.infer<typeof assertionSchema>;
export const stepSchema = z
  .object({
    instruction: text,
    value: z.string().max(2000).optional(),
    valueFromEnv: envName.optional(),
    selector: z.string().min(1).max(1000).optional(),
    expect: assertionSchema.optional(),
  })
  .refine(
    (value) => value.value === undefined || value.valueFromEnv === undefined,
    "Choose value or valueFromEnv",
  )
  .refine(
    (value) => value.valueFromEnv === undefined || value.selector !== undefined,
    "Sensitive field values require a selector binding",
  );
export const runSchema = z
  .object({
    name: z.string().trim().min(1).max(200).default("AI browser test"),
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
    totalTimeoutMs: z.number().int().min(1000).max(1800000).default(120000),
    expect: z.array(assertionSchema).min(1).max(20).optional(),
    minConfidence: z.number().min(0).max(1).default(0),
  })
  .refine(
    (value) => value.url !== undefined || value.session !== undefined,
    "Supply an app URL or existing session",
  )
  .refine(
    (value) =>
      value.expect !== undefined || value.steps.at(-1)?.expect !== undefined,
    "A test requires final expect assertions; model DONE alone cannot pass a test",
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
  value?: string | undefined;
  role?: string;
  currentValue?: string | undefined;
  checked?: string | undefined;
};
export type Element = {
  index: string;
  label: string;
  role: string;
  value: string;
  operations: string[];
  checked?: string | undefined;
};
export type Observation = {
  url: string;
  tree: string;
  fingerprint: string;
  targets: Record<string, Record<string, Target>>;
  elements: Element[];
  snapshotId?: string;
  documentId?: string;
  controls?: string[];
  title?: string;
  text?: string;
};
export type Decision = {
  operation: string;
  target: Target | undefined;
  confidence: number;
  targetConfidence?: number;
  targetId?: string;
  snapshotId?: string;
  actionId?: string;
  expectedSelector?: string;
  model?: string;
};
