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
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Use an HTTP(S) endpoint");
const session = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

// Settings for the local Laya model. They reach the server when a test starts it (and are checked
// against a server that is already running); values left out fall back to laya_config.json.
export const layaSettingsSchema = z
  .object({
    // "en" is the English checkpoint at the bundle root; any other name is a bundle subfolder, e.g. "multilingual".
    language: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .optional(),
    revision: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,64}$/)
      .optional(),
    // A bundle directory (laya.onnx, laya.onnx.data, laya_config.json, tokenizer/) exported by hand.
    modelDir: z.string().min(1).max(1000).optional(),
    // The model window in tokens (max_len) and the part reserved for the question and its options (head_max_len).
    maxLen: z.number().int().min(64).max(4096).optional(),
    headMaxLen: z.number().int().min(16).max(4096).optional(),
    threads: z.number().int().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (value) => value.maxLen === undefined || value.headMaxLen === undefined || value.headMaxLen <= value.maxLen,
    "headMaxLen cannot be larger than maxLen",
  );
export type LayaSettings = z.infer<typeof layaSettingsSchema>;

export const backendSchema = z.object({
  provider: z.enum(["jev", "laya"]),
  baseUrl: endpoint.optional(),
  model: text.optional(),
  apiKeyEnv: envName.optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  // Local Laya: a target question with more options than the model window holds (about 30) is asked in
  // groups of this size and settled in a final round, instead of dropping the options that do not fit.
  // 0 turns it off.
  chunkSize: z.number().int().min(0).max(200).optional(),
  // Start the local Laya server when it is not running (default); false only reports the setup error.
  autostart: z.boolean().optional(),
  laya: layaSettingsSchema.optional(),
});
export const assertionSchema = z
  .object({
    // Text, value and URL checks ignore case and accents unless this is true; URL paths always keep case.
    caseSensitive: z.boolean().optional(),
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
    (value) => value.text !== undefined || value.url !== undefined || value.selector !== undefined,
    "Supply a deterministic text, URL, or element assertion",
  )
  .refine(
    (value) =>
      value.selector !== undefined ||
      [value.visible, value.value, value.checked, value.count].every((item) => item === undefined),
    "Element assertions require a selector",
  );
export type Assertion = z.infer<typeof assertionSchema>;
export const stepSchema = z
  .object({
    instruction: text,
    value: z.string().max(2000).optional(),
    valueFromEnv: envName.optional(),
    assume: text.optional(),
    selector: z.string().min(1).max(1000).optional(),
    // Which tab the step works in: "current" (default), "new" (the latest tab opened), "opener" (the first
    // tab), or a tab id or label such as "t2".
    tab: z.string().min(1).max(60).optional(),
    expect: assertionSchema.optional(),
  })
  .refine((value) => value.value === undefined || value.valueFromEnv === undefined, "Choose value or valueFromEnv")
  .refine(
    (value) => value.valueFromEnv === undefined || value.selector !== undefined,
    "Sensitive field values require a selector binding",
  );
export const browserSchema = z
  .object({
    args: z
      .record(
        z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .refine(
            (key) => !["session", "json", "help", "version"].includes(key),
            "Use the test session field; JSON output is managed by the runner",
          ),
        z.union([z.string().max(10000), z.boolean(), z.array(z.string().max(10000)).min(1).max(100)]),
      )
      .optional(),
    env: z
      .record(
        z
          .string()
          .regex(
            /^(AGENT_BROWSER_[A-Z0-9_]+|BROWSER_USE_(API_KEY|PROFILE_ID|PROXY_COUNTRY|ENABLE_RECORDING)|OBSCURA_ALLOW_PRIVATE_NETWORK|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/,
          )
          .refine((key) => key !== "AGENT_BROWSER_BIN", "The browser executable cannot be set in a test file"),
        z.string().max(10000),
      )
      .optional(),
    // alert/confirm/prompt are answered by the runner (a dialog would otherwise freeze the click).
    dialogs: z
      .object({ policy: z.enum(["accept", "dismiss"]).default("accept"), promptText: z.string().max(1000).optional() })
      .optional(),
    // A click or Enter that opens a tab or pop-up: "auto" keeps working in the new tab, "never" returns to the opener.
    tabs: z.object({ follow: z.enum(["auto", "never"]).default("auto") }).optional(),
  })
  .strict();
export type BrowserConfig = z.infer<typeof browserSchema>;

export const runSchema = z
  .object({
    name: z.string().trim().min(1).max(200).default("AI browser test"),
    prompt: text,
    steps: z
      .array(z.union([text.transform((instruction): z.infer<typeof stepSchema> => ({ instruction })), stepSchema]))
      .min(1)
      .max(100),
    backend: backendSchema,
    textModel: z
      .object({ baseUrl: endpoint, model: text, apiKeyEnv: envName.default("TEXT_MODEL_API_KEY") })
      .optional(),
    session: session.optional(),
    browser: browserSchema.optional(),
    recordVideo: z.boolean().optional(),
    videoFps: z.number().int().min(1).max(60).default(60),
    url: z
      .url()
      .refine((value) => ["http:", "https:", "file:"].includes(new URL(value).protocol), "Unsupported app URL")
      .optional(),
    maxActions: z.number().int().min(1).max(200).default(60),
    maxStepDecisions: z.number().int().min(1).max(100).default(20),
    actionsPerCall: z.number().int().min(1).max(200).default(20),
    blockedRetries: z.number().int().min(0).max(5).default(2),
    // Resolve unambiguous steps from the page without the model; false sends every step to the model.
    fastPath: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(45_000).default(45_000),
    totalTimeoutMs: z.number().int().min(1000).max(1800000).default(120000),
    expect: z.array(assertionSchema).min(1).max(20).optional(),
    minConfidence: z.number().min(0).max(1).default(0),
  })
  .refine((value) => value.url !== undefined || value.session !== undefined, "Supply an app URL or existing session")
  .refine(
    (value) => value.expect !== undefined || value.steps.at(-1)?.expect !== undefined,
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
  // For a scrollable container: what it still holds out of view.
  scroll?: { progress: number; below: number; above: number; belowLabels: string[]; aboveLabels: string[] } | undefined;
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
  // Why this decision was made and how sure the model was; kept small for the debug report.
  probabilities?: Record<string, number>;
  targetProbabilities?: Record<string, number>;
  source?: "model" | "fast" | "deterministic";
  rule?: string;
  // Model passes the target took when the options were asked in groups.
  rounds?: number;
};
