import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../src/browser.ts";
import { runSchema } from "../../src/contracts.ts";

const directory = await mkdtemp(join(tmpdir(), "jev-browser-config-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

test("passes browser options and environment without a shell or changing parent env", async () => {
  const executable = join(directory, "browser");
  await Bun.write(
    executable,
    `#!/usr/bin/env bun\nconsole.log(JSON.stringify({success:true,data:{args:process.argv.slice(2),headed:process.env.AGENT_BROWSER_HEADED,inherited:process.env.JEV_CONFIG_TEST}}));\n`,
  );
  await import("node:fs/promises").then(({ chmod }) => chmod(executable, 0o700));
  const previous = process.env.AGENT_BROWSER_BIN;
  process.env.AGENT_BROWSER_BIN = executable;
  process.env.JEV_CONFIG_TEST = "inherited";
  try {
    const browser = new Browser("config-test", Date.now() + 5000, undefined, {
      args: { headed: false, "color-scheme": "dark", extension: ["one", "two"] },
      env: { AGENT_BROWSER_HEADED: "true" },
    });
    expect(await browser.command(["open", "https://example.com"])).toEqual({
      args: [
        "--headed",
        "false",
        "--color-scheme",
        "dark",
        "--extension",
        "one",
        "--extension",
        "two",
        "--session",
        "config-test",
        "--json",
        "open",
        "https://example.com",
      ],
      headed: "true",
      inherited: "inherited",
    });
  } finally {
    if (previous === undefined) delete process.env.AGENT_BROWSER_BIN;
    else process.env.AGENT_BROWSER_BIN = previous;
    delete process.env.JEV_CONFIG_TEST;
  }
});

test("validates browser settings and rejects reserved flags and non-browser environment", () => {
  const base = {
    prompt: "Check",
    steps: ["Check"],
    url: "https://example.com",
    backend: { provider: "laya" },
    expect: [{ text: "Done" }],
  };
  expect(
    runSchema.parse({ ...base, browser: { args: { headed: true }, env: { AGENT_BROWSER_COLOR_SCHEME: "dark" } } })
      .browser,
  ).toBeDefined();
  for (const browser of [
    { args: { session: "other" } },
    { args: { json: false } },
    { args: { "--headed": true } },
    { env: { PATH: "/tmp" } },
    { env: { AGENT_BROWSER_BIN: "other" } },
  ])
    expect(runSchema.safeParse({ ...base, browser }).success).toBe(false);
});
