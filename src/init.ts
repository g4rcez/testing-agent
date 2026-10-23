import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type InitFormat = "yaml" | "json";

const example = {
  name: "Search Wikipedia for IPv6",
  url: "https://en.wikipedia.org/wiki/Main_Page",
  prompt: "Search Wikipedia for IPv6 and check that its article opens.",
  backend: { provider: "laya" },
  steps: [
    {
      instruction: "Type IPv6 into the Search Wikipedia box",
      value: "IPv6",
    },
    {
      instruction: "Press Enter in the Search Wikipedia box to search",
      expect: {
        url: "https://en.wikipedia.org/wiki/IPv6",
        text: "Internet Protocol version 6",
      },
    },
  ],
};

const expectation = example.steps[1]!.expect!;

const exampleYaml = `name: ${example.name}
url: ${example.url}
prompt: ${example.prompt}
backend:
  provider: laya
steps:
  - instruction: ${example.steps[0]!.instruction}
    value: IPv6
  - instruction: ${example.steps[1]!.instruction}
    expect:
      url: ${expectation.url}
      text: ${expectation.text}
`;

export function exampleTest(format: InitFormat): string {
  return format === "json"
    ? JSON.stringify(example, null, 2) + "\n"
    : exampleYaml;
}

export type InitOptions = {
  folder?: string;
  format?: InitFormat;
  /** Returns the answer typed by the user, or "" for the default. */
  ask?: (question: string) => Promise<string>;
  cwd?: string;
};

export type InitResult = {
  folder: string;
  created: string[];
  skipped: string[];
};

async function askLine(question: string): Promise<string> {
  process.stderr.write(question);
  for await (const line of console) return line;
  return "";
}

export async function initTests(
  options: InitOptions = {},
): Promise<InitResult> {
  const format = options.format ?? "yaml";
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let folder = options.folder;
  if (!folder) {
    const answer = options.ask
      ? await options.ask("Folder for your tests [tests]: ")
      : interactive
        ? await askLine("Folder for your tests [tests]: ")
        : "";
    folder = answer.trim() || "tests";
  }
  const directory = resolve(options.cwd ?? process.cwd(), folder);
  const existing = await stat(directory).catch(() => undefined);
  if (existing && !existing.isDirectory())
    throw new Error(`${folder} exists and is not a folder`);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `example.test.${format}`);
  const result: InitResult = { folder, created: [], skipped: [] };
  if (await Bun.file(file).exists()) result.skipped.push(file);
  else {
    await Bun.write(file, exampleTest(format));
    result.created.push(file);
  }
  return result;
}
