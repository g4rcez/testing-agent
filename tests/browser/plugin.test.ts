import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const exec = promisify(execFile);
const controller = process.env.AGENT_BROWSER_BIN ?? "agent-browser";
const criterionSchema = z.union([
  z.string(),
  z.object({ element: z.string() }).passthrough(),
]);
const questionSchema = z.object({
  criteria: z.record(z.string(), criterionSchema),
  instructions: z
    .object({
      goal: z.string(),
      original_request: z.string(),
    })
    .passthrough(),
});
const requestSchema = z.object({
  state: z.object({
    task: z.object({
      prompt: z.string(),
      steps: z.array(z.string()),
      current_step_number: z.number(),
    }),
    page: z.object({ text: z.string() }),
    elements: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        checked: z.string().optional(),
      }),
    ),
  }),
  questions: z.record(z.string(), questionSchema),
});
const resultSchema = z.object({
  protocol: z.literal("agent-browser.plugin.v1"),
  success: z.literal(true),
  data: z.object({
    runId: z.uuid(),
    status: z.string(),
    reason: z.string().nullable(),
    completedSteps: z.array(
      z.object({ instruction: z.string(), verification: z.string() }),
    ),
    actions: z.array(z.object({ operation: z.string() })),
  }),
});

for (const provider of ["jev", "laya"] as const) {
  test(`${provider}: plugin follows ordered steps in Chromium and resumes across processes`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), `jev-browser-${provider}-`));
    const session = `jev-test-${crypto.randomUUID()}`;
    let textRequests = 0;
    const visitedSteps: number[] = [];
    const auth: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/")
          return new Response(Bun.file(new URL("./app.html", import.meta.url)));
        if (url.pathname === "/chat/completions") {
          textRequests++;
          return Response.json({
            choices: [
              { message: { content: JSON.stringify({ text: "Lisbon" }) } },
            ],
          });
        }
        if (url.pathname !== "/v1/systemone")
          return new Response("Not found", { status: 404 });
        const body = requestSchema.parse(await request.json());
        const operationQuestion = body.questions.operation;
        if (!operationQuestion)
          return new Response("Missing operation", { status: 400 });
        const index = body.state.task.current_step_number;
        expect(body.state.task.prompt).toBe(
          "Find Casa Flora using these filters and open its details.",
        );
        expect(body.state.task.steps).toHaveLength(5);
        visitedSteps.push(index);
        auth.push(request.headers.get("authorization"));
        const tree = body.state.page.text;
        const complete = [
          false,
          body.state.elements.some(
            (element) =>
              element.label === "Destination" && element.value === "Lisbon",
          ),
          body.state.elements.some(
            (element) =>
              element.label === "Category" && element.value === "Design",
          ),
          body.state.elements.some(
            (element) =>
              element.label === "Free cancellation" &&
              element.checked === "true",
          ),
          tree.includes("1 matching stay"),
          tree.includes(
            "Applied filters: Lisbon / Design / cancellation enabled",
          ),
        ][index];
        const operations = [
          "",
          "TYPE_TEXT",
          "SELECT",
          "CLICK",
          "CLICK",
          "CLICK",
        ];
        const labels = [
          "",
          "Destination",
          "Category → Design",
          "Free cancellation",
          "Find stays",
          "View Casa Flora",
        ];
        const operation = complete ? "DONE" : operations[index];
        if (!operation) return new Response("Unexpected step", { status: 400 });
        const answers: Record<string, unknown> = {};
        for (const [name, question] of Object.entries(body.questions)) {
          const ids = Object.keys(question.criteria);
          const choice =
            name === "operation"
              ? operation
              : (Object.entries(question.criteria).find(
                  ([, value]) =>
                    (typeof value === "string"
                      ? value
                      : value.element.replace(/^\[[^\]]*\] /, "")) ===
                    labels[index],
                )?.[0] ?? ids[0]);
          if (!choice || !ids.includes(choice))
            return new Response("Missing observed choice", { status: 400 });
          answers[name] = {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              ids.map((id) => [id, id === choice ? 1 : 0]),
            ),
          };
        }
        return Response.json({
          model: "scripted-protocol-fixture",
          answers,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      },
    });
    const env = {
      ...process.env,
      JEV_STATE_DIR: stateDir,
      JEV_TEST_API_KEY: "test-only",
    };
    const command = async (args: string[]) => {
      const result = await exec(controller, [...args, "--json"], {
        cwd: resolve(import.meta.dir, "../.."),
        env,
        timeout: 55_000,
        maxBuffer: 2_000_000,
      });
      return JSON.parse(result.stdout);
    };
    try {
      const payload = {
        prompt: "Find Casa Flora using these filters and open its details.",
        steps: [
          {
            instruction: "Enter Lisbon in Destination",
            ...(provider === "jev" ? { value: "Lisbon" } : {}),
          },
          "Select Design as the category",
          "Enable free cancellation",
          "Submit Find stays",
          {
            instruction: "Open Casa Flora",
            expect: {
              text: "Applied filters: Lisbon / Design / cancellation enabled",
              url: `${server.url}#casa-flora`,
            },
          },
        ],
        backend: {
          provider,
          baseUrl: String(server.url),
          apiKeyEnv: "JEV_TEST_API_KEY",
        },
        textModel: {
          baseUrl: String(server.url),
          model: "test-text",
          apiKeyEnv: "JEV_TEST_API_KEY",
        },
        session,
        url: String(server.url),
        actionsPerCall: 2,
      };
      let result = resultSchema.parse(
        await command([
          "plugin",
          "run",
          "jev",
          "agent.run",
          "--payload",
          JSON.stringify(payload),
        ]),
      );
      expect(result.data.status).toBe("paused");
      const runId = result.data.runId;
      for (let i = 0; i < 5 && result.data.status === "paused"; i++) {
        result = resultSchema.parse(
          await command([
            "plugin",
            "run",
            "jev",
            "agent.resume",
            "--payload",
            JSON.stringify({ runId }),
          ]),
        );
      }
      expect(
        result.data.status,
        JSON.stringify({
          visitedSteps,
          actions: result.data.actions,
          reason: result.data.reason,
        }),
      ).toBe("completed");
      expect(result.data.reason).toBeNull();
      expect(result.data.completedSteps).toHaveLength(5);
      expect(result.data.completedSteps.at(-1)?.verification).toBe("assertion");
      expect(result.data.actions.map((action) => action.operation)).toEqual([
        "TYPE_TEXT",
        "SELECT",
        "CLICK",
        "CLICK",
        "CLICK",
      ]);
      // Step 1 types its value and completes without a separate DONE decision.
      expect(visitedSteps).toEqual([1, 2, 2, 3, 3, 4, 4, 5]);
      expect(auth.every((value) => value === "Bearer test-only")).toBe(true);
      expect(textRequests).toBe(provider === "laya" ? 1 : 0);
      const final = z
        .object({ data: z.object({ text: z.string() }) })
        .parse(await command(["--session", session, "get", "text", "body"]));
      expect(final.data.text).toContain(
        "Applied filters: Lisbon / Design / cancellation enabled",
      );
      await mkdir("artifacts", { recursive: true });
      await command([
        "--session",
        session,
        "screenshot",
        resolve(`artifacts/plugin-${provider}.png`),
      ]);
      const saved = resultSchema.parse(
        await command([
          "plugin",
          "run",
          "jev",
          "agent.status",
          "--payload",
          JSON.stringify({ runId }),
        ]),
      );
      expect(saved.data.status).toBe("completed");
    } finally {
      try {
        await command(["--session", session, "close"]);
      } finally {
        server.stop(true);
        await rm(stateDir, { recursive: true, force: true });
      }
    }
  }, 120_000);
}
