import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
  test("ships equivalent JSON/YAML examples and valid GitHub definitions", async () => {
    for (const name of ["garcez-ls", "stay-search"]) {
      const json = await Bun.file(`examples/${name}.json`).json();
      const yaml = Bun.YAML.parse(
        await Bun.file(`examples/${name}.yaml`).text(),
      );
      expect(runSchema.parse(yaml)).toEqual(runSchema.parse(json));
    }
    for (const name of ["github-star", "github-star-sign-in"]) {
      const yaml = Bun.YAML.parse(
        await Bun.file(`examples/${name}.yaml`).text(),
      );
      expect(runSchema.safeParse(yaml).success).toBe(true);
    }
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
