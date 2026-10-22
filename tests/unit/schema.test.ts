import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { runSchema } from "../../src/contracts.ts";

const directory = await mkdtemp(join(tmpdir(), "jev-schema-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const reference = relative(directory, resolve("schema/test.schema.json"))
  .split(sep)
  .map(encodeURIComponent)
  .join("/");

async function lsp(name: string, content: string) {
  const file = join(directory, name);
  await Bun.write(file, content);
  const child = Bun.spawn([process.execPath, "src/cli.ts", "lsp", file], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { file, stdout, stderr, code, content: await readFile(file, "utf8") };
}

test("YAML adds the schema directive before comments and preserves bytes and repeated runs", async () => {
  for (const extension of ["yaml", "yml", "YAML"]) {
    const original =
      "# Keep this comment\r\nname: 'Example' # keep quotes\r\nsteps:\r\n\t- Check\r\n";
    const result = await lsp(`test.${extension}`, original);
    expect(result.code).toBe(0);
    expect(result.content).toBe(
      `# yaml-language-server: $schema=${reference}\r\n${original}`,
    );
    expect(JSON.parse(result.stdout).changed).toBe(true);
    const repeated = await lsp(`test.${extension}`, result.content);
    expect(repeated.content).toBe(result.content);
    expect(JSON.parse(repeated.stdout).changed).toBe(false);
  }
});

test("YAML moves an existing directive to the first line without changing other comments", async () => {
  const original =
    "# Keep\n# yaml-language-server: $schema=old.json\nname: Example";
  const result = await lsp("existing.yaml", original);
  expect(result.code).toBe(0);
  expect(result.content).toBe(
    `# yaml-language-server: $schema=${reference}\n# Keep\nname: Example`,
  );
});

test("YAML preserves scalar content, BOM, and a missing final newline", async () => {
  for (const original of [
    "prompt: |\n  # yaml-language-server: $schema=keep\n  Keep this text\n",
    "\uFEFF# Keep\r\nname: Example",
    "# yaml-language-server: $schema=old.json",
  ]) {
    const result = await lsp("preserved.yaml", original);
    expect(result.code).toBe(0);
    expect(result.content.startsWith("\uFEFF")).toBe(
      original.startsWith("\uFEFF"),
    );
    expect(result.content.endsWith("\n")).toBe(original.endsWith("\n"));
    if (original.includes("  # yaml-language-server:"))
      expect(result.content).toContain(
        "  # yaml-language-server: $schema=keep",
      );
    expect((await lsp("preserved.yaml", result.content)).content).toBe(
      result.content,
    );
  }
});

test("YAML does not remove directive-like lines inside unfinished quoted scalars", async () => {
  const originals = ['"', "'"].map(
    (quote) =>
      `prompt: ${quote}First line\n# yaml-language-server: $schema=keep-this-text\n  Last line${quote}\n`,
  );
  originals.push(
    '"First line\n# yaml-language-server: $schema=keep-this-text\nLast line"\n',
  );
  originals.push(
    'prompt: |\n  "\nother: "First line\n# yaml-language-server: $schema=keep-this-text\n  Last line"\n',
  );
  for (const original of originals) {
    const result = await lsp("quoted.yaml", original);
    expect(result.code).toBe(0);
    expect(result.content).toBe(
      `# yaml-language-server: $schema=${reference}\n${original}`,
    );
    expect((await lsp("quoted.yaml", result.content)).content).toBe(
      result.content,
    );
  }
});

test("JSON preserves compact, spaced, tab-indented and CRLF formatting and number spellings", async () => {
  for (const [index, original] of [
    '{"name":"Example","number":1e2,"nested":{"$schema":"keep"}}',
    '{ "name" : "Example", "steps" : [] }\n',
    '{\r\n\t"name": "Example",\r\n\t"steps": []\r\n}\r\n',
  ].entries()) {
    const result = await lsp(`format-${index}.json`, original);
    const leading = original.slice(1).match(/^\s*/)?.[0] ?? "";
    const separator = original.includes('"name" : ')
      ? " : "
      : original.includes(': "')
        ? ": "
        : ":";
    expect(result.code).toBe(0);
    expect(result.content).toBe(
      "{" +
        leading +
        '"$schema"' +
        separator +
        JSON.stringify(reference) +
        "," +
        original.slice(1),
    );
    expect(Object.keys(JSON.parse(result.content))[0]).toBe("$schema");
    expect((await lsp(`format-${index}.json`, result.content)).content).toBe(
      result.content,
    );
  }
});

test("JSON moves existing schema properties first, including escaped keys, without touching nested ones", async () => {
  const original =
    '{\n  "name": "Example",\n  "$schema": "old",\n  "nested": {"$schema":"keep","text":"},\\\""},\n  "$\\u0073chema": "duplicate"\n}\n';
  const result = await lsp("existing.json", original);
  expect(result.code).toBe(0);
  expect(result.content).toBe(
    '{\n  "$schema": "' +
      reference +
      '",\n  "name": "Example",\n  "nested": {"$schema":"keep","text":"},\\\""}\n}\n',
  );
});

test("supports empty JSON objects and UTF-8 BOM without normalizing the file", async () => {
  for (const original of [
    "{}",
    "{\n}\n",
    '\uFEFF{\n  "name": "Example"\n}\n',
  ]) {
    const result = await lsp("empty.json", original);
    expect(result.code).toBe(0);
    expect(
      Object.keys(JSON.parse(result.content.replace(/^\uFEFF/, "")))[0],
    ).toBe("$schema");
    expect(result.content.startsWith("\uFEFF")).toBe(
      original.startsWith("\uFEFF"),
    );
    expect((await lsp("empty.json", result.content)).content).toBe(
      result.content,
    );
  }
});

test("invalid JSON roots, malformed JSON and unsupported files are not modified", async () => {
  for (const [name, original] of [
    ["array.json", "[]"],
    ["null.json", "null"],
    ["broken.json", '{"secret":"private-example",}'],
    ["file.txt", "name: Example"],
  ]) {
    const result = await lsp(name!, original!);
    expect(result.code).toBe(2);
    expect(result.content).toBe(original!);
    expect(result.stderr).not.toContain("private-example");
  }
});

test("large files and extra command arguments are rejected without modification", async () => {
  const content = "#".repeat(1_000_001);
  const large = await lsp("large.yaml", content);
  expect(large.code).toBe(2);
  expect(large.content).toBe(content);
  const file = join(directory, "options.json");
  await Bun.write(file, "{}");
  const child = Bun.spawn(
    [
      process.execPath,
      "src/cli.ts",
      "lsp",
      file,
      "--url",
      "https://example.com",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(2);
  expect(await Bun.file(file).text()).toBe("{}");
});

test("annotated JSON and YAML still pass CLI validation", async () => {
  for (const [name, content] of [
    [
      "runnable.json",
      JSON.stringify({
        prompt: "Check",
        backend: { provider: "laya" },
        url: "https://example.com",
        steps: ["Check"],
        expect: [{ text: "Done" }],
      }),
    ],
    [
      "runnable.yaml",
      "prompt: Check\nbackend:\n  provider: laya\nurl: https://example.com\nsteps:\n  - Check\nexpect:\n  - text: Done\n",
    ],
  ]) {
    const result = await lsp(name!, content!);
    expect(result.code).toBe(0);
    const child = Bun.spawn(
      [process.execPath, "src/cli.ts", "validate", result.file],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).json()).valid).toBe(true);
  }
});

test("published schema matches the CLI schema and offers all test fields", async () => {
  const schema = await Bun.file("schema/test.schema.json").json();
  const child = Bun.spawn([process.execPath, "src/cli.ts", "schema"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(schema).toEqual(await new Response(child.stdout).json());
  expect(await child.exited).toBe(0);
  for (const field of [
    "$schema",
    "name",
    "url",
    "prompt",
    "backend",
    "browser",
    "steps",
    "expect",
  ])
    expect(schema.properties[field]).toBeDefined();
  expect(
    runSchema.parse({
      $schema: reference,
      prompt: "Check",
      backend: { provider: "laya" },
      url: "https://example.com",
      steps: ["Check"],
      expect: [{ text: "Done" }],
    }).steps,
  ).toHaveLength(1);
  expect((await Bun.file("package.json").json()).files).toContain("schema");
});
