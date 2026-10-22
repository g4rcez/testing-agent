import { readFile, writeFile } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runSchema } from "./contracts.ts";

export function testJsonSchema() {
  const schema = z.toJSONSchema(runSchema, { io: "input" });
  return {
    ...schema,
    title: "agent-tester test",
    description:
      "Ordered browser test instructions, browser configuration, and expected results. Final assertions are required; model DONE alone cannot pass a test.",
    properties: {
      $schema: {
        type: "string",
        description:
          "Editor JSON Schema reference. Ignored when running the test.",
      },
      ...schema.properties,
    },
  };
}

// Split only root members. Do not serialize values: that changes whitespace,
// escape sequences, and number spellings (or precision for large integers).
function jsonMembers(body: string): string[] {
  const members: string[] = [];
  let start = 0,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
    else if (character === "," && depth === 0) {
      members.push(body.slice(start, index));
      start = index + 1;
    }
  }
  members.push(body.slice(start));
  return members;
}

function jsonWithSchema(content: string, reference: string): string {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Cannot read a valid JSON object; file was not changed");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("A JSON test must be an object; file was not changed");
  const open = content.indexOf("{"),
    close = content.lastIndexOf("}");
  const body = content.slice(open + 1, close);
  const trailing = body.match(/\s*$/)?.[0] ?? "";
  const members = body.trim()
    ? jsonMembers(body.slice(0, body.length - trailing.length))
    : [];
  const first = members[0]?.match(/^(\s*)("(?:\\.|[^"\\])*")(\s*:\s*)/);
  const leading =
    first?.[1] ??
    (body.includes("\n") ? (body.includes("\r\n") ? "\r\n  " : "\n  ") : "");
  const separator = first?.[3] ?? (body.includes("\n") ? ": " : ":");
  const remaining = members.filter((member) => {
    const key = member.match(/^\s*("(?:\\.|[^"\\])*")\s*:/)?.[1];
    return key !== undefined && JSON.parse(key) !== "$schema";
  });
  return (
    content.slice(0, open + 1) +
    leading +
    '"$schema"' +
    separator +
    JSON.stringify(reference) +
    (remaining.length ? "," + remaining.join(",") : "") +
    trailing +
    content.slice(close)
  );
}

function yamlWithoutSchemaDirectives(body: string): string {
  let header = true;
  // Only edit the comment preamble. Later directive-like lines can be scalar
  // content, especially in unfinished YAML; leave the document body untouched.
  return (body.match(/[^\n]*\n|[^\n]+$/g) ?? [])
    .filter((line) => {
      if (line.trim() && !line.trimStart().startsWith("#")) header = false;
      return (
        !header ||
        !/^[\t ]*#[\t ]*yaml-language-server:[\t ]*\$schema=/.test(line)
      );
    })
    .join("");
}

function yamlWithSchema(content: string, reference: string): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = content.slice(bom.length);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const remaining = yamlWithoutSchemaDirectives(body);
  const updated =
    `# yaml-language-server: $schema=${reference}` + newline + remaining;
  return (
    bom +
    (body && !body.endsWith("\n") ? updated.replace(/\r?\n$/, "") : updated)
  );
}

export async function insertEditorSchema(path: string) {
  const extension = extname(path).toLowerCase();
  if (![".yaml", ".yml", ".json"].includes(extension))
    throw new Error("The lsp command requires a .yaml, .yml, or .json file");
  if (Bun.file(path).size > 1_000_000)
    throw new Error("Test definition exceeds 1 MB");
  const content = await readFile(path, "utf8");
  const schemaPath = resolve(import.meta.dir, "../schema/test.schema.json");
  if (!(await Bun.file(schemaPath).exists()))
    throw new Error(
      "Bundled test schema is missing; rebuild or reinstall the package",
    );
  const relativePath = relative(dirname(resolve(path)), schemaPath);
  const schema = isAbsolute(relativePath)
    ? pathToFileURL(schemaPath).href
    : relativePath.split(sep).map(encodeURIComponent).join("/");
  const updated =
    extension === ".json"
      ? jsonWithSchema(content, schema)
      : yamlWithSchema(content, schema);
  if (updated !== content) await writeFile(path, updated, "utf8");
  return { file: resolve(path), schema, changed: updated !== content };
}
