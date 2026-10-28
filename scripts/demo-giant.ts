import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runSchema } from "../src/contracts.ts";
import { defaultDependencies, startRun } from "../src/runner.ts";
import { demoLogin, serveGiantSite } from "../tests/browser/giant-site.ts";

// Records a tour of the test pages in fixtures/giant-website, one run for each, and joins the videos into
// docs/assets/giant-tour.mp4: bun run demo:giant. No model is involved; every step is settled by the page.
if (!Bun.which("agent-browser")) throw new Error("Install agent-browser first");
if (!Bun.which("ffmpeg")) throw new Error("Recording requires ffmpeg on PATH");

const tour: Array<{ name: string; page: string; steps: unknown[] }> = [
  {
    name: "Popup with a login and a react-window list of 5,000 invoices",
    page: "billing.html",
    steps: [
      { instruction: "Click Choose invoice", expect: { text: "Sign in" } },
      { instruction: "Type demo into the Username field", value: "demo" },
      {
        instruction: "Type the password into the Password field",
        selector: "#password",
        valueFromEnv: "GIANT_PASSWORD",
      },
      { instruction: "Click Sign in", expect: { text: "Open invoice #00001" } },
      { instruction: "Click Open invoice #04217", expect: { text: "Confirm #04217" } },
      { instruction: "Click Confirm", expect: { text: "Invoice #04217 selected" } },
    ],
  },
  {
    name: "Virtual list of 10,000 orders",
    page: "virtual-list.html",
    steps: [{ instruction: "Click Open order #08731", expect: { text: "Opened order #08731" } }],
  },
  {
    name: "Two virtual lists with the same rows",
    page: "two-lists.html",
    steps: [
      { instruction: "Click Open item #04217 in the Invoices list", expect: { text: "Opened invoices item #04217" } },
    ],
  },
  {
    name: "Strip of 1,000 columns that scrolls sideways",
    page: "virtual-grid.html",
    steps: [{ instruction: "Click Open column #0640", expect: { text: "Opened column #0640" } }],
  },
  {
    name: "Infinite feed",
    page: "infinite.html",
    steps: [{ instruction: "Click Post 170 (page 9)", expect: { text: "Opened post 170" } }],
  },
  {
    name: "Noisy page with 3,000 links",
    page: "noise.html",
    steps: [{ instruction: "Click Confirm subscription", expect: { text: "Subscription confirmed" } }],
  },
  {
    name: "Repeated controls: by row, section and kind",
    page: "precision.html",
    steps: [
      { instruction: "Click Delete in the row of Order #1002", expect: { text: "Deleted order #1002" } },
      { instruction: "Click the Edit button in the Billing section", expect: { text: "Edited billing" } },
      { instruction: "Click the Pay link", expect: { text: "Paid billing (link)" } },
    ],
  },
];

const server = serveGiantSite();
process.env.GIANT_PASSWORD = demoLogin.password;
const videos: string[] = [];
let failed = false;
try {
  for (const scene of tour) {
    const session = `giant-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const result = await startRun(
        runSchema.parse({
          name: scene.name,
          prompt: scene.name,
          session,
          url: `${server.url}${scene.page}`,
          backend: { provider: "laya" },
          recordVideo: true,
          videoFps: 60,
          actionsPerCall: 30,
          maxStepDecisions: 30,
          steps: scene.steps,
        }),
        {
          ...defaultDependencies,
          decide: async () => {
            throw new Error("the model must not be asked");
          },
        },
      );
      const ok = result.status === "completed" && result.video?.status === "saved";
      console.log(`${ok ? "ok    " : "FAILED"} ${scene.name}${ok ? "" : `: ${result.reasonCode} ${result.reason}`}`);
      if (ok) videos.push(result.video!.path);
      else failed = true;
    } finally {
      await Bun.spawn([Bun.which("agent-browser")!, "--session", session, "close"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    }
  }
  if (failed || !videos.length) process.exitCode = 1;
  else {
    const assets = resolve("docs", "assets");
    await mkdir(assets, { recursive: true });
    const list = resolve(assets, ".tour.txt");
    await Bun.write(list, videos.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
    const output = resolve(assets, "giant-tour.mp4");
    // The scenes have their own sizes (a popup is smaller); each is kept at its own size in the corner of one frame.
    const joined = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-vf",
        "scale='min(1280,iw)':'min(632,ih)':force_original_aspect_ratio=decrease,pad=1280:632:0:0,setsar=1",
        "-r",
        "60",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      { stderr: "pipe" },
    );
    const [error, code] = await Promise.all([new Response(joined.stderr).text(), joined.exited]);
    await Bun.file(list).delete();
    if (code !== 0) throw new Error(`ffmpeg failed: ${error.trim()}`);
    console.log(`Saved ${output}`);
  }
} finally {
  server.stop(true);
}
