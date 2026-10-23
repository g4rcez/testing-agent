import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSchema } from "../../src/contracts.ts";
import { exampleTest, initTests } from "../../src/init.ts";

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "init-"));
  roots.push(root);
  return root;
};
afterAll(() => Promise.all(roots.map((r) => rm(r, { recursive: true }))));

test("example tests are valid in both formats", () => {
  for (const format of ["yaml", "json"] as const) {
    const text = exampleTest(format);
    const value = format === "json" ? JSON.parse(text) : Bun.YAML.parse(text);
    expect(runSchema.parse(value).steps).toHaveLength(2);
  }
});

test("creates the named folder with a yaml example by default", async () => {
  const cwd = await temp();
  const result = await initTests({ folder: "tests", cwd });
  expect(result.created).toEqual([join(cwd, "tests", "example.test.yaml")]);
  expect(await Bun.file(result.created[0]!).text()).toContain("steps:");
});

test("asks for the folder and honors --json; never overwrites", async () => {
  const cwd = await temp();
  const ask = async () => "e2e/browser";
  const first = await initTests({ format: "json", ask, cwd });
  expect(first.created[0]).toEndWith("e2e/browser/example.test.json");
  await Bun.write(first.created[0]!, "{}");
  const second = await initTests({ format: "json", ask, cwd });
  expect(second.skipped).toEqual(first.created);
  expect(await Bun.file(first.created[0]!).text()).toBe("{}");
});

test("empty answer falls back to tests", async () => {
  const cwd = await temp();
  const result = await initTests({ ask: async () => "  ", cwd });
  expect(result.folder).toBe("tests");
});
