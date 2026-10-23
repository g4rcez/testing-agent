import { expect, test } from "bun:test";
import { formatManual, planSetup, runSetup, type Manager, type SetupEnv } from "../../src/setup.ts";

const env = (
  platform: NodeJS.Platform,
  manager: Manager | undefined,
  installed: string[] = [],
  root = false,
): SetupEnv => ({
  platform,
  manager,
  root,
  has: (command) => installed.includes(command) || command === "sudo",
  version: (command) => (command === "bun" ? "1.3.14" : command === "node" ? "v22.1.0" : undefined),
});

const commands = (value: SetupEnv) => planSetup(value).flatMap((step) => step.commands);
const missing = (value: SetupEnv) =>
  planSetup(value)
    .filter((step) => !step.present)
    .flatMap((step) => step.commands);

test("macOS uses Homebrew and offers to install it when missing", () => {
  expect(commands(env("darwin", "brew"))).toContain("brew install ffmpeg");
  expect(commands(env("darwin", "brew"))).toContain("brew install node");
  expect(commands(env("darwin", undefined))[0]).toContain("Homebrew/install");
});

test("Linux adapts to the package manager and prefixes sudo for non-root", () => {
  expect(commands(env("linux", "apt"))).toContain("sudo apt-get install -y ffmpeg");
  expect(commands(env("linux", "pacman", [], true))).toContain("pacman -S --noconfirm ffmpeg");
  expect(commands(env("linux", "dnf"))).toContain("sudo dnf install -y ffmpeg-free");
  expect(commands(env("linux", "apt"))).toContain("agent-browser install --with-deps");
});

test("Windows uses winget and the PowerShell Bun installer", () => {
  const all = commands({ ...env("win32", "winget"), has: () => false });
  expect(all).toContain("winget install --id Gyan.FFmpeg -e");
  expect(all.some((c) => c.includes("bun.sh/install.ps1"))).toBe(true);
});

test("installed tools are skipped and old Bun is upgraded", () => {
  const ready = env("linux", "apt", ["bun", "node", "ffmpeg", "agent-browser"]);
  expect(missing(ready)).toEqual(["agent-browser install --with-deps"]);
  expect(missing({ ...ready, version: () => "1.2.0" })).toContain("bun upgrade");
});

test("manual output lists commands without running anything", () => {
  const value = env("darwin", "brew");
  const text = formatManual(planSetup(value), value);
  expect(text).toContain("brew install ffmpeg");
  expect(text).toContain("testing-agent setup laya");
});

test("setup runs commands in order and stops at the first failure", async () => {
  const ran: string[] = [];
  const lines: string[] = [];
  const result = await runSetup(env("darwin", "brew"), {
    log: (line) => lines.push(line),
    exec: async (command) => {
      ran.push(command);
      return command.includes("ffmpeg") ? 1 : 0;
    },
  });
  expect(ran.at(-1)).toBe("brew install ffmpeg");
  expect(result.failed).toContain("--manual");
  expect(result.installed).toContain("Node.js 20+");
});
