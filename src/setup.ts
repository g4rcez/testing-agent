export type Manager = "brew" | "apt" | "dnf" | "pacman" | "apk" | "zypper" | "winget";

export type SetupEnv = {
  platform: NodeJS.Platform;
  manager: Manager | undefined;
  root: boolean;
  has(command: string): boolean;
  version(command: string): string | undefined;
};

export type SetupStep = {
  name: string;
  /** Why the tool is needed, shown next to the step. */
  reason: string;
  present: boolean;
  commands: string[];
  /** Shown instead of commands when nothing can be installed automatically. */
  note?: string;
};

const MIN_BUN = [1, 3, 14];
const MIN_NODE = 20;
const AGENT_BROWSER_RANGE = ">=0.32.1 <0.40.0";

const managers: [Manager, string][] = [
  ["brew", "brew"],
  ["apt", "apt-get"],
  ["dnf", "dnf"],
  ["pacman", "pacman"],
  ["apk", "apk"],
  ["zypper", "zypper"],
  ["winget", "winget"],
];

function semver(text: string | undefined): number[] {
  return (text?.match(/\d+(?:\.\d+)*/)?.[0] ?? "").split(".").map(Number);
}

function atLeast(actual: number[], minimum: number[]): boolean {
  for (let index = 0; index < minimum.length; index++) {
    const a = actual[index] ?? 0,
      b = minimum[index] ?? 0;
    if (a !== b) return a > b;
  }
  return actual.length > 0 && !Number.isNaN(actual[0]);
}

export function detectEnv(): SetupEnv {
  const run = (command: string, args: string[]) =>
    Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "ignore" });
  const has = (command: string) => Boolean(Bun.which(command));
  const platform = process.platform;
  const wanted: Manager[] =
    platform === "darwin" ? ["brew"] : platform === "win32" ? ["winget"] : ["apt", "dnf", "pacman", "apk", "zypper"];
  return {
    platform,
    manager: managers.find(([name, binary]) => wanted.includes(name) && has(binary))?.[0],
    root: process.getuid?.() === 0,
    has,
    version(command) {
      try {
        const result = run(command, ["--version"]);
        return result.exitCode === 0 ? result.stdout.toString() : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

function packageCommands(env: SetupEnv, packages: Record<Manager, string[]>): string[] {
  if (!env.manager) return [];
  const sudo = env.platform === "linux" && !env.root && env.has("sudo") ? "sudo " : "";
  const commands = packages[env.manager];
  return env.manager === "brew" || env.manager === "winget" ? commands : commands.map((command) => sudo + command);
}

function bunInstall(env: SetupEnv): string[] {
  if (env.platform === "win32") return ['powershell -c "irm bun.sh/install.ps1 | iex"'];
  if (env.manager === "brew") return ["brew install oven-sh/bun/bun"];
  return ["curl -fsSL https://bun.sh/install | bash"];
}

/** Builds the ordered install plan for this machine, mirroring the README install section. */
export function planSetup(env: SetupEnv): SetupStep[] {
  const steps: SetupStep[] = [];
  const unsupported = env.platform !== "darwin" && env.platform !== "linux" && env.platform !== "win32";
  const noManager = !env.manager && !unsupported;

  if (env.platform === "darwin" && !env.manager)
    steps.push({
      name: "Homebrew",
      reason: "installs the other tools on macOS",
      present: false,
      commands: ['/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'],
    });
  const brew = env.platform === "darwin" && !env.manager;
  const system = (name: string, reason: string, present: boolean, packages: Record<Manager, string[]>): SetupStep => ({
    name,
    reason,
    present,
    commands: brew ? packageCommands({ ...env, manager: "brew" }, packages) : packageCommands(env, packages),
    ...(!present && noManager ? { note: `Install ${name} with your system package manager.` } : {}),
  });

  const bunOk = env.has("bun") && atLeast(semver(env.version("bun")), MIN_BUN);
  steps.push({
    name: "Bun 1.3.14+",
    reason: "runs the testing-agent CLI",
    present: bunOk,
    commands: env.has("bun") && !bunOk ? ["bun upgrade"] : bunInstall(env),
  });

  const nodeOk = env.has("node") && (semver(env.version("node"))[0] ?? 0) >= MIN_NODE;
  steps.push(
    system("Node.js 20+", "installs agent-browser through npm", nodeOk, {
      brew: ["brew install node"],
      apt: ["apt-get update", "apt-get install -y nodejs npm"],
      dnf: ["dnf install -y nodejs npm"],
      pacman: ["pacman -S --noconfirm nodejs npm"],
      apk: ["apk add nodejs npm"],
      zypper: ["zypper install -y nodejs npm"],
      winget: ["winget install --id OpenJS.NodeJS.LTS -e"],
    }),
  );

  steps.push(
    system("ffmpeg", "records the video of every test", env.has("ffmpeg"), {
      brew: ["brew install ffmpeg"],
      apt: ["apt-get update", "apt-get install -y ffmpeg"],
      dnf: ["dnf install -y ffmpeg-free"],
      pacman: ["pacman -S --noconfirm ffmpeg"],
      apk: ["apk add ffmpeg"],
      zypper: ["zypper install -y ffmpeg"],
      winget: ["winget install --id Gyan.FFmpeg -e"],
    }),
  );

  const agentBrowser = env.has("agent-browser");
  steps.push({
    name: "agent-browser",
    reason: "controls Chrome",
    present: agentBrowser,
    commands: [`npm install -g "agent-browser@${AGENT_BROWSER_RANGE}"`],
  });
  steps.push({
    name: "Chrome for agent-browser",
    reason: "the browser the tests run on",
    present: false,
    commands: [env.platform === "linux" ? "agent-browser install --with-deps" : "agent-browser install"],
  });
  return steps;
}

export function formatManual(steps: SetupStep[], env: SetupEnv): string {
  const lines = [
    `# Manual setup for ${env.platform}${env.manager ? ` (${env.manager})` : ""}`,
    "# Run these in order; skip tools you already have.",
  ];
  for (const step of steps) {
    lines.push("", `# ${step.name}: ${step.reason}`);
    if (step.commands.length) lines.push(...step.commands);
    else lines.push(`# ${step.note}`);
  }
  lines.push("", "# Optional local Laya backend (about 1.7 GB model download):", "testing-agent setup laya");
  return lines.join("\n");
}

export type SetupResult = { installed: string[]; skipped: string[]; failed?: string };

export async function runSetup(
  env: SetupEnv,
  options: { log?: (line: string) => void; exec?: (command: string) => Promise<number> } = {},
): Promise<SetupResult> {
  const log = options.log ?? ((line) => console.log(line));
  const exec =
    options.exec ??
    (async (command: string) => {
      const child = Bun.spawn(env.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return child.exited;
    });
  const result: SetupResult = { installed: [], skipped: [] };
  for (const step of planSetup(env)) {
    if (step.present) {
      log(`✓ ${step.name} already installed`);
      result.skipped.push(step.name);
      continue;
    }
    if (!step.commands.length) {
      result.failed = `${step.name} cannot be installed automatically here; run: testing-agent setup --manual`;
      log(`✗ ${result.failed}`);
      return result;
    }
    log(`→ Installing ${step.name} (${step.reason})`);
    for (const command of step.commands) {
      log(`  $ ${command}`);
      if ((await exec(command)) !== 0) {
        result.failed = `${step.name} failed at: ${command}. Run testing-agent setup --manual to install it by hand.`;
        log(`✗ ${result.failed}`);
        return result;
      }
    }
    result.installed.push(step.name);
  }
  log("Setup complete. Optional local Laya backend: testing-agent setup laya");
  return result;
}
