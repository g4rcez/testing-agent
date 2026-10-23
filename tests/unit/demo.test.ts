import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("demo setup failure still prints its owned browser session and close command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-demo-"));
  const controller = join(directory, "controller");
  try {
    await Bun.write(controller, "#!/bin/sh\nexit 1\n");
    await chmod(controller, 0o700);
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "../../scripts/demo.ts"),
        "--workflow",
        "github",
      ],
      {
        cwd: directory,
        env: { ...process.env, AGENT_BROWSER_BIN: controller },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toMatch(/Browser session: github-star-sign-in-[a-f0-9]{8}/);
    expect(stdout).toMatch(
      /Close with: agent-browser --session github-star-sign-in-[a-f0-9]{8} close/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
