import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Decision, Element, Observation, Target } from "./contracts.ts";

const exec = promisify(execFile);
const snapshotSchema = z.object({
  snapshot: z.string().max(200_000),
  origin: z.string(),
  refs: z.record(
    z.string().regex(/^e\d+$/),
    z.object({ role: z.string(), name: z.string() }),
  ),
});
const responseSchema = z.object({
  success: z.boolean(),
  data: z.unknown(),
  error: z.string().nullable().optional(),
});
const clickRoles = new Set([
  "button",
  "link",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
  "treeitem",
  "gridcell",
]);

export function parseSnapshot(input: unknown): Observation {
  const data = snapshotSchema.parse(input);
  const targets: Observation["targets"] = {};
  const elements: Element[] = [];
  const add = (operation: string, id: string, target: Target) => {
    (targets[operation] ??= {})[id] = target;
  };
  let select: { ref: string; label: string; indent: number } | undefined;
  for (const line of data.snapshot.split("\n")) {
    const match = Array.from(line.matchAll(/\[([^\[\]]*\bref=(e\d+))\]/g)).at(
      -1,
    );
    const ref = match?.[2];
    const attributes = match?.[1] ?? "";
    const element = ref ? data.refs[ref] : undefined;
    const indent = line.length - line.trimStart().length;
    if (select && indent <= select.indent) select = undefined;
    if (!ref || !element || /\bdisabled(?:,|$)/.test(attributes)) continue;
    const value =
      match?.index === undefined
        ? ""
        : line
            .slice(match.index + match[0].length)
            .replace(/^:\s*/, "")
            .trim();
    const checked = attributes.match(/\bchecked=([^,]+)/)?.[1];
    const target: Target = {
      ref: `@${ref}`,
      label: element.name,
      role: element.role,
      currentValue: value,
      ...(checked === undefined ? {} : { checked }),
    };
    const descriptor: Element = {
      index: ref,
      label: element.name,
      role: element.role,
      value,
      operations: [],
      ...(checked === undefined ? {} : { checked }),
    };
    elements.push(descriptor);
    if (element.role === "option" && select) {
      if (!/\bselected(?:,|$)/.test(attributes) && !line.includes("[selected]"))
        add("SELECT", `${select.ref}:${ref}`, {
          ref: select.ref,
          label: `${select.label} → ${element.name}`,
          value: element.name,
          role: "combobox",
        });
      continue;
    }
    if (element.role === "combobox" || element.role === "listbox")
      select = { ...target, indent };
    if (clickRoles.has(element.role)) add("CLICK", ref, target);
    if (
      ["textbox", "searchbox", "spinbutton", "combobox"].includes(
        element.role,
      ) &&
      !/\breadonly(?:,|$)/.test(attributes)
    )
      add("TYPE_TEXT", ref, target);
    if (element.role === "checkbox") {
      if (!/\bchecked(?:=true)?(?:,|$)/.test(attributes))
        add("CHECK", ref, target);
      if (!attributes.includes("checked=false")) add("UNCHECK", ref, target);
    }
  }
  for (const element of elements) {
    element.operations = Object.entries(targets)
      .filter(([, choices]) =>
        Object.values(choices).some(
          (target) => target.ref === `@${element.index}`,
        ),
      )
      .map(([operation]) => operation);
  }
  return {
    url: data.origin,
    tree: data.snapshot,
    targets,
    elements,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex"),
  };
}

export class Browser {
  constructor(
    readonly session: string,
    readonly deadline: number,
  ) {}

  async command(args: string[]): Promise<unknown> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error("Call deadline reached");
    let stdout: string;
    try {
      ({ stdout } = await exec(
        process.env.AGENT_BROWSER_BIN ?? "agent-browser",
        ["--session", this.session, "--json", ...args],
        {
          timeout: Math.min(12_000, remaining),
          maxBuffer: 2_000_000,
          encoding: "utf8",
        },
      ));
    } catch {
      throw new Error(
        `agent-browser ${args[0]} failed or timed out; inspect the browser before retrying input`,
      );
    }
    const response = responseSchema.parse(JSON.parse(stdout));
    if (!response.success)
      throw new Error(`agent-browser ${args[0]} rejected the command`);
    return response.data;
  }

  async observe(): Promise<Observation> {
    return parseSnapshot(await this.command(["snapshot"]));
  }

  async execute(decision: Decision, text?: string): Promise<void> {
    const ref = decision.target?.ref;
    switch (decision.operation) {
      case "CLICK":
      case "CHECK":
      case "UNCHECK":
        if (!ref) throw new Error("Missing observed target");
        await this.command([decision.operation.toLowerCase(), ref]);
        return;
      case "TYPE_TEXT":
        if (!ref || text === undefined) throw new Error("Missing field value");
        await this.command(["fill", ref, text]);
        return;
      case "SELECT":
        if (!ref || decision.target?.value === undefined)
          throw new Error("Missing observed option");
        await this.command(["select", ref, decision.target.value]);
        return;
      case "PRESS_ENTER":
        await this.command(["press", "Enter"]);
        return;
      case "SCROLL_DOWN":
        await this.command(["scroll", "down", "500"]);
        return;
      case "SCROLL_UP":
        await this.command(["scroll", "up", "500"]);
        return;
      case "WAIT":
        await this.command([
          "eval",
          "new Promise(resolve => { const observer = new MutationObserver(() => { observer.disconnect(); clearTimeout(timer); resolve('changed'); }); const timer = setTimeout(() => { observer.disconnect(); resolve('unchanged'); }, 500); observer.observe(document.documentElement, {subtree:true, childList:true, characterData:true, attributes:true}); })",
        ]);
        return;
      default:
        throw new Error("Unsupported operation");
    }
  }
}
