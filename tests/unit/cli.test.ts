import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSchema } from "../../src/contracts.ts";

const directory = await mkdtemp(join(tmpdir(), "jev-cli-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const definition = {
  name: "Example",
  url: "https://example.com",
  prompt: "Open details",
  backend: { provider: "laya" },
  steps: ["Open details"],
  expect: [{ text: "Details" }],
};
const yaml = `# Same contract as JSON
name: Example
url: https://example.com
prompt: Open details
backend:
  provider: laya
steps:
  - Open details
expect:
  - text: Details
`;

async function validate(name: string, content: string, flags: string[] = []) {
  const path = join(directory, name);
  await Bun.write(path, content);
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "validate", path, ...flags],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("CLI test definitions", () => {
  test("publishes the primary CLI without removing legacy entry points", async () => {
    const metadata = await Bun.file("package.json").json();
    expect(metadata.name).toBe("testing-agent");
    expect(metadata.files).toContain("docs/REFERENCE.md");
    expect(metadata.repository.url).toBe(
      "git+https://github.com/g4rcez/testing-agent.git",
    );
    expect(metadata.bin["testing-agent"]).toBe("./bin/testing-agent");
    expect(metadata.bin["agent-tester"]).toBe("./bin/agent-tester");
    expect(metadata.bin["agent-browser-plugin-jev"]).toBe(
      "./bin/agent-browser-plugin-jev",
    );
    for (const path of Object.values(metadata.bin))
      expect(await Bun.file(String(path)).exists()).toBe(true);
    expect(metadata.bin["agent-browser-jev"]).toBe("./bin/agent-browser-jev");
    expect(metadata.bin["jev-test"]).toBe("./bin/jev-test");
    expect(await Bun.file(metadata.bin["agent-browser-jev"]).text()).toContain(
      "../dist/cli.js",
    );
  });

  test("README first test matches the three checked blog steps", async () => {
    const readme = await Bun.file("README.md").text();
    const firstTest = readme
      .split("## First test\n")[1]
      ?.split("## Editor autocomplete")[0];
    const snippet = firstTest?.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(snippet).toBeDefined();
    const example = Bun.YAML.parse(
      await Bun.file("examples/garcez-blog.yaml").text(),
    );
    expect(Bun.YAML.parse(snippet!)).toEqual(example);
    const input = runSchema.parse(example);
    expect(input.steps).toHaveLength(3);
    expect(
      input.steps.every((step) => step.expect?.url && step.expect?.text),
    ).toBe(true);
    expect(JSON.stringify(input)).not.toContain('"selector"');
    expect(firstTest).toContain("testing-agent test blog.test.yaml");
  });

  test("ships equivalent JSON/YAML examples and valid GitHub definitions", async () => {
    for (const name of ["garcez-ls", "stay-search"]) {
      const json = await Bun.file(`examples/${name}.json`).json();
      const yaml = Bun.YAML.parse(
        await Bun.file(`examples/${name}.yaml`).text(),
      );
      expect(runSchema.parse(yaml)).toEqual(runSchema.parse(json));
    }
    for (const name of [
      "github-star",
      "github-star-sign-in",
      "github-repository-tour",
      "stay-search-journey",
    ]) {
      const yaml = Bun.YAML.parse(
        await Bun.file(`examples/${name}.yaml`).text(),
      );
      expect(runSchema.safeParse(yaml).success).toBe(true);
      if (["github-repository-tour", "stay-search-journey"].includes(name)) {
        expect(runSchema.parse(yaml).steps.length).toBeGreaterThanOrEqual(5);
        expect(JSON.stringify(yaml)).not.toContain('"selector"');
      }
    }
  });
  test("test command records by default and prints steps plus final result as JSON", async () => {
    const fake = join(directory, "agent-browser");
    const log = join(directory, "commands.jsonl");
    await Bun.write(
      fake,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
await import("node:fs/promises").then(({appendFile}) => appendFile(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n"));
if (process.env.FAIL_VIDEO_STOP && args.includes("stop")) {
  console.log(JSON.stringify({success:false,data:null,error:"private failure"}));
  process.exit(0);
}
let data = {};
if (args.includes("eval")) {
  const source = await Bun.stdin.text();
  data = {result: source.includes('"type":"observe"')
    ? {url:"https://example.com",title:"Example",text:"Details",tree:"Details",elements:[],targets:{},controls:[],documentId:"11111111-1111-4111-8111-111111111111",snapshotId:"22222222-2222-4222-8222-222222222222"}
    : {passed:true,checks:[{passed:true,index:0,message:"Passed"}]}};
}
console.log(JSON.stringify({success:true,data}));
`,
    );
    await chmod(fake, 0o700);
    const path = join(directory, "run.yaml");
    await Bun.write(
      path,
      yaml.replace(
        "  - Open details",
        "  - instruction: Open details\n    expect:\n      text: Details",
      ),
    );
    const child = Bun.spawn([process.execPath, "src/cli.ts", "test", path], {
      env: {
        ...process.env,
        AGENT_BROWSER_BIN: fake,
        COMMAND_LOG: log,
        JEV_STATE_DIR: join(directory, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.passed).toBe(true);
    expect(result.steps).toEqual([
      {
        step: 1,
        instruction: "Open details",
        status: "passed",
        success: true,
        verification: "assertion",
      },
    ]);
    expect(result.video.status).toBe("saved");
    expect(result.video.path.endsWith(".webm")).toBe(true);
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands[0]).toContain("record");
    expect(commands[0]).toContain("start");
    expect(commands.at(-1)).toContain("stop");
    expect((await Bun.file(result.reports.json).json()).steps).toEqual(
      result.steps,
    );
    const failing = Bun.spawn([process.execPath, "src/cli.ts", "test", path], {
      env: {
        ...process.env,
        AGENT_BROWSER_BIN: fake,
        COMMAND_LOG: log,
        FAIL_VIDEO_STOP: "true",
        JEV_STATE_DIR: join(directory, "failed-state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const failed = JSON.parse(await new Response(failing.stdout).text());
    expect(await failing.exited).toBe(1);
    expect(failed.passed).toBe(false);
    expect(failed.video.status).toBe("failed");
    expect(failed.steps[0].success).toBe(true);
    expect(failed.reason).not.toContain("private failure");
  });

  test("preserves JSON validation, including extensionless files", async () => {
    for (const name of ["test.json", "extensionless"]) {
      const result = await validate(name, JSON.stringify(definition));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        valid: true,
        name: "Example",
        steps: 1,
      });
    }
  });

  test("accepts YAML and YML with the same result as JSON", async () => {
    for (const name of ["test.yaml", "test.yml", "test.YAML"]) {
      const result = await validate(name, yaml);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        valid: true,
        name: "Example",
        steps: 1,
      });
    }
  });

  test("applies CLI overrides to YAML before schema validation", async () => {
    const result = await validate(
      "override.yaml",
      yaml.replace("provider: laya", "provider: invalid"),
      ["--backend", "laya"],
    );
    expect(result.code).toBe(0);
  });

  test("rejects malformed YAML without exposing file contents", async () => {
    const result = await validate("broken.yaml", "password: [private-example");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Cannot read a valid YAML test definition");
    expect(result.stderr).not.toContain("private-example");
  });

  test("rejects YAML roots and definitions outside the existing contract", async () => {
    for (const content of [
      "null",
      "- one\n- two",
      "hello",
      yaml.replace("  - text: Details", "  - checked: true"),
    ]) {
      expect((await validate("invalid.yaml", content)).code).toBe(2);
    }
  });

  test("keeps the definition size limit for YAML", async () => {
    const result = await validate("large.yml", "#".repeat(1_000_001));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Test definition exceeds 1 MB");
  });
});
