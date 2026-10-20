import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "jev-package-"));
const controller = process.env.AGENT_BROWSER_BIN ?? Bun.which("agent-browser");
if (!controller)
  throw new Error("Install agent-browser before package verification");
const sessions: string[] = [];
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/")
      return new Response(
        "<button onclick=\"this.textContent='Completed'\">Continue</button>",
        { headers: { "Content-Type": "text/html" } },
      );
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    const body = await request.json();
    const operation = body.state.page.text.includes("Completed")
      ? "DONE"
      : "CLICK";
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([name, raw]) => {
          const question = z
            .object({ criteria: z.record(z.string(), z.unknown()) })
            .parse(raw);
          const keys = Object.keys(question.criteria),
            selected = name === "operation" ? operation : keys[0];
          return [
            name,
            {
              type: "choice",
              choice: selected,
              confidence: 1,
              probabilities: Object.fromEntries(
                keys.map((key) => [key, key === selected ? 1 : 0]),
              ),
            },
          ];
        }),
      ),
    });
  },
});
const env = {
  ...process.env,
  AGENT_BROWSER_BIN: controller,
  JEV_STATE_DIR: join(directory, "state"),
};
try {
  await exec("bun", ["pm", "pack", "--destination", directory], {
    maxBuffer: 2_000_000,
  });
  const archive = (await readdir(directory)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!archive) throw new Error("Package archive was not created");
  const inventory = await exec("tar", ["-tzf", join(directory, archive)]);
  if (
    /node_modules|\.env(?:\n|$)|\.agent-browser-jev|artifacts\//.test(
      inventory.stdout,
    )
  )
    throw new Error("Private or development artifacts leaked into the package");
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "agent-browser-plugin-jev": "./" + archive },
    }),
  );
  await exec("bun", ["install", "--ignore-scripts"], {
    cwd: directory,
    maxBuffer: 2_000_000,
  });
  const bin = join(directory, "node_modules", ".bin", "jev-test");
  const plugin = join(
    directory,
    "node_modules",
    ".bin",
    "agent-browser-plugin-jev",
  );
  const help = await exec(bin, ["--help"], { cwd: directory, env });
  if (!help.stdout.includes("AI-driven browser tests"))
    throw new Error("Installed CLI help failed");
  await exec(bin, ["schema"], { cwd: directory, env });
  const manifest = Bun.spawn([plugin], {
    cwd: directory,
    env,
    stdin: new Response(
      JSON.stringify({
        protocol: "agent-browser.plugin.v1",
        type: "plugin.manifest",
        request: {},
      }),
    ),
    stdout: "pipe",
  });
  if (
    !(await new Response(manifest.stdout).json()).success ||
    (await manifest.exited) !== 0
  )
    throw new Error("Installed plugin manifest failed");
  await Bun.write(join(directory, "invalid.json"), "{}");
  let rejected = false;
  try {
    await exec(bin, ["validate", "invalid.json"], { cwd: directory, env });
  } catch (error) {
    rejected = error instanceof Error && "code" in error && error.code === 2;
  }
  if (!rejected) throw new Error("Invalid test did not exit with code 2");
  const session = "jev-package-" + crypto.randomUUID();
  sessions.push(session);
  const testCase = {
    name: "Installed package smoke",
    prompt: "Click Continue",
    steps: ["Click Continue"],
    session,
    url: String(fixture.url),
    backend: { provider: "laya", baseUrl: String(fixture.url) },
    expect: [{ text: "Completed" }],
  };
  await Bun.write(join(directory, "test.json"), JSON.stringify(testCase));
  const result = JSON.parse(
    (
      await exec(bin, ["run", "test.json", "--report-dir", "reports"], {
        cwd: directory,
        env,
        timeout: 55_000,
        maxBuffer: 2_000_000,
      })
    ).stdout,
  );
  if (
    result.status !== "completed" ||
    !result.assertions.every((item: { passed: boolean }) => item.passed)
  )
    throw new Error("Installed test did not pass independent assertions");
  if (!(await Bun.file(result.reports.junit).text()).includes('failures="0"'))
    throw new Error("JUnit result is missing");
  await Bun.write(
    join(directory, "agent-browser.json"),
    JSON.stringify({
      plugins: [
        { name: "jev", command: plugin, capabilities: ["command.run"] },
      ],
    }),
  );
  const pluginSession = "jev-package-plugin-" + crypto.randomUUID();
  sessions.push(pluginSession);
  const throughPlugin = JSON.parse(
    (
      await exec(
        controller,
        [
          "plugin",
          "run",
          "jev",
          "agent.run",
          "--payload",
          JSON.stringify({ ...testCase, session: pluginSession }),
          "--json",
        ],
        { cwd: directory, env, timeout: 55_000 },
      )
    ).stdout,
  );
  if (throughPlugin.data.status !== "completed")
    throw new Error("Installed package failed through the plugin host");
  console.log(
    JSON.stringify({
      passed: true,
      archive,
      checks: [
        "archive contents",
        "clean installation",
        "help",
        "schema",
        "manifest",
        "invalid input exit",
        "real browser test",
        "JSON/JUnit reports",
        "plugin host",
      ],
    }),
  );
} finally {
  fixture.stop(true);
  for (const session of sessions)
    await exec(controller, ["--session", session, "close"], { env }).catch(
      () => {},
    );
  await rm(directory, { recursive: true, force: true });
}
