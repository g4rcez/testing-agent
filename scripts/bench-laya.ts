// Times Laya decisions on real requests and checks that two servers/modes give identical answers.
// Usage: bun run scripts/bench-laya.ts --url http://127.0.0.1:8791 [--url http://127.0.0.1:8793#split]
// A "#split" suffix asks for the operation first and the chosen target second (`only` request field).
// With two --url values the answers are compared: same choices and probabilities within --tolerance.
import { Browser } from "../src/browser.ts";
import { runSchema } from "../src/contracts.ts";
import { makeRequest } from "../src/decision.ts";

const urls: string[] = [];
let tolerance = 1e-3;
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === "--url") urls.push(process.argv[++index] ?? "");
  else if (flag === "--tolerance") tolerance = Number(process.argv[++index]);
  else throw new Error("Usage: bun run scripts/bench-laya.ts --url URL[#split] [--url URL[#split]] [--tolerance N]");
}
if (!urls.length || urls.length > 2 || urls.includes("")) throw new Error("Pass one or two --url values");

const controller = process.env.AGENT_BROWSER_BIN ?? Bun.which("agent-browser");
if (!controller) throw new Error("Install agent-browser first");
const session = `bench-laya-${crypto.randomUUID().slice(0, 8)}`;
const open = Bun.spawnSync([controller, "--session", session, "open", "https://en.wikipedia.org/wiki/Main_Page"]);
if (open.exitCode !== 0) throw new Error("Could not open the benchmark page");

type Choice = { choice: string; probabilities: Record<string, number> };
type Result = { step: number; ms: number; operation: Choice; target?: Choice & { key: string } };

try {
  const example = Bun.YAML.parse(await Bun.file(new URL("../examples/wikipedia-search.yaml", import.meta.url)).text());
  const { url: _url, ...rest } = example as Record<string, unknown>;
  const input = runSchema.parse({ ...rest, session });
  const observation = await new Browser(session, Date.now() + 120_000).observe();

  const ask = async (base: string, body: unknown) => {
    const response = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`${base} answered HTTP ${response.status}`);
    return ((await response.json()) as { answers: Record<string, Choice> }).answers;
  };

  const run = async (spec: string): Promise<Result[]> => {
    const [base = "", mode] = spec.split("#");
    const results: Result[] = [];
    for (let step = 0; step < input.steps.length; step++) {
      const { state, questions } = makeRequest(input, step, observation, []);
      const started = performance.now();
      let operation: Choice;
      let target: Result["target"];
      if (mode === "split") {
        operation = (await ask(base, { state, questions, only: ["operation"] })).operation!;
        const key = `${operation.choice.toLowerCase()}_target`;
        if (observation.targets[operation.choice]) {
          const answer = (await ask(base, { state, questions, only: [key] }))[key]!;
          target = { ...answer, key };
        }
      } else {
        const answers = await ask(base, { state, questions });
        operation = answers.operation!;
        const key = `${operation.choice.toLowerCase()}_target`;
        if (answers[key]) target = { ...answers[key]!, key };
      }
      results.push({ step, ms: Math.round(performance.now() - started), operation, ...(target ? { target } : {}) });
    }
    return results;
  };

  const runs = [];
  for (const spec of urls) {
    const results = await run(spec);
    runs.push(results);
    const total = results.reduce((sum, item) => sum + item.ms, 0);
    for (const item of results)
      console.log(
        JSON.stringify({
          spec,
          step: item.step,
          ms: item.ms,
          operation: item.operation.choice,
          ...(item.target ? { target: item.target.choice } : {}),
        }),
      );
    console.log(JSON.stringify({ spec, totalMs: total, meanMs: Math.round(total / results.length) }));
  }

  if (runs.length === 2) {
    const delta = (a: Choice | undefined, b: Choice | undefined) =>
      Math.max(
        0,
        ...Object.keys(a?.probabilities ?? {}).map((key) =>
          Math.abs((a?.probabilities[key] ?? 0) - (b?.probabilities[key] ?? 0)),
        ),
      );
    let identical = true;
    let worst = 0;
    for (const [index, left] of runs[0]!.entries()) {
      const right = runs[1]![index]!;
      const sameChoice =
        left.operation.choice === right.operation.choice && left.target?.choice === right.target?.choice;
      const spread = Math.max(delta(left.operation, right.operation), delta(left.target, right.target));
      worst = Math.max(worst, spread);
      if (!sameChoice || spread > tolerance) identical = false;
      console.log(JSON.stringify({ step: index, sameChoice, maxProbabilityDelta: Number(spread.toFixed(6)) }));
    }
    const speedup = runs[0]!.reduce((s, r) => s + r.ms, 0) / runs[1]!.reduce((s, r) => s + r.ms, 0);
    console.log(
      JSON.stringify({
        identical,
        worstDelta: Number(worst.toFixed(6)),
        tolerance,
        speedup: Number(speedup.toFixed(2)),
      }),
    );
    process.exitCode = identical ? 0 : 1;
  }
} finally {
  Bun.spawnSync([controller, "--session", session, "close"]);
}
