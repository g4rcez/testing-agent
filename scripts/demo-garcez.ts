import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const exec = promisify(execFile);
const args = process.argv.slice(2);
let backend = "laya";
let record = false;
let workflow = "garcez";
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--record") record = true;
  else if (
    args[index] === "--workflow" &&
    ["garcez", "github"].includes(args[index + 1] ?? "")
  )
    workflow = args[++index] ?? "garcez";
  else if (
    args[index] === "--backend" &&
    ["jev", "laya"].includes(args[index + 1] ?? "")
  )
    backend = args[++index] ?? "laya";
  else
    throw new Error(
      "Usage: bun run scripts/demo-garcez.ts [--workflow garcez|github] [--backend laya|jev] [--record]",
    );
}
const controller = process.env.AGENT_BROWSER_BIN ?? Bun.which("agent-browser");
if (!controller) throw new Error("Install agent-browser first");
if (record && !Bun.which("ffmpeg"))
  throw new Error("Recording requires ffmpeg on PATH");
const example = workflow === "github" ? "github-star-sign-in" : "garcez-ls";
const session = `${example}-${crypto.randomUUID().slice(0, 8)}`;
const output = resolve("artifacts", session);
await mkdir(output, { recursive: true });
const browser = (args: string[]) =>
  exec(controller, ["--session", session, ...args], {
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });
const { url, ...definition } = Bun.YAML.parse(
  await Bun.file(
    new URL(`../examples/${example}.yaml`, import.meta.url),
  ).text(),
) as { url: string; [key: string]: unknown };
const testFile = resolve(output, "test.yaml");
await Bun.write(testFile, Bun.YAML.stringify({ ...definition, session }));
const frames = resolve(output, "frames");
const captures: Array<{ name: string; at: number }> = [];
let stopCapture = false;
let captureError: unknown;
let capture: Promise<void> | undefined;
let code = 1;
console.log(`Browser session: ${session}`);
try {
  await browser(["--headed", "open", url]);
  await browser(["set", "viewport", "1100", "780", "1"]);
  if (workflow === "garcez") {
    await browser([
      "wait",
      "--fn",
      'Array.from(document.querySelectorAll(\'[role="group"][aria-roledescription="terminal"]\')).some(node => node.innerText.includes("[~]>_") && node.querySelector("textarea"))',
    ]);
  } else {
    await browser([
      "wait",
      'a[href="/login?return_to=%2Fg4rcez%2Ftesting-agent"]',
    ]);
  }
  if (record) {
    await mkdir(frames, { recursive: true });
    capture = (async () => {
      while (!stopCapture) {
        const name = `frame-${String(captures.length).padStart(5, "0")}.png`;
        await browser(["screenshot", resolve(frames, name)]);
        captures.push({ name, at: performance.now() });
        await Bun.sleep(100);
      }
    })().catch((error) => {
      captureError = error;
    });
    await Bun.sleep(800);
  }
  console.log(`Running ${backend} in visible browser session ${session}`);
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("src/cli.ts"),
      "run",
      testFile,
      "--backend",
      backend,
      "--report-dir",
      output,
    ],
    {
      env: { ...process.env, AGENT_BROWSER_BIN: controller },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const result = await new Response(child.stdout).text();
  code = await child.exited;
  await Bun.write(resolve(output, "cli.json"), result);
  console.log(result.trim());
  if (record) await Bun.sleep(2200);
} finally {
  stopCapture = true;
  await capture;
  console.log(
    `Browser left open. Close with: agent-browser --session ${session} close`,
  );
}
await browser(["screenshot", resolve(output, "result.png")]);
if (record && code === 0) {
  if (captureError) throw captureError;
  if (!captures.length) throw new Error("No browser frames were captured");
  const timeline =
    captures
      .map((frame, index) => {
        const duration =
          ((captures[index + 1]?.at ?? frame.at + 100) - frame.at) / 1000;
        return `file '${frame.name}'\nduration ${duration.toFixed(3)}`;
      })
      .join("\n") + `\nfile '${captures.at(-1)?.name}'\n`;
  await Bun.write(resolve(frames, "frames.txt"), timeline);
  await exec(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      resolve(frames, "frames.txt"),
      "-c:v",
      "libvpx",
      "-crf",
      "20",
      "-b:v",
      "0",
      "-pix_fmt",
      "yuv420p",
      resolve(output, "browser.webm"),
    ],
    { timeout: 60_000, maxBuffer: 2_000_000 },
  );
  const gif = resolve(`docs/assets/${example}.gif`);
  await mkdir(resolve("docs/assets"), { recursive: true });
  await exec(
    "ffmpeg",
    [
      "-y",
      "-i",
      resolve(output, "browser.webm"),
      "-filter_complex",
      "fps=10,scale=1000:-1:flags=lanczos,setsar=1,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
      "-loop",
      "0",
      gif,
    ],
    { timeout: 60_000, maxBuffer: 2_000_000 },
  );
  console.log(`Recorded the real browser run: ${gif}`);
}
process.exitCode = code;
