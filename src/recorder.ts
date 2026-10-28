import { rename, rm } from "node:fs/promises";

// Recording that follows the tab the runner works in. agent-browser's own recorder films the page that was active
// when it started, so a pop-up or a new tab is never seen. This one watches the browser over CDP, in a helper
// process (recorder-daemon.ts) that outlives a paused run, and is told by the runner which tab is the active one.
// It only watches: it never sends input to a page.

/**
 * For every frame of a constant-rate video, the index of the captured frame it shows: the latest one taken at
 * or before that moment. Captured frames arrive only when the picture changes, and a tab switch can leave a long
 * gap; the video holds the last picture through it instead of freezing or skipping. `times` are seconds, ascending.
 */
export function toConstantRate(times: readonly number[], fps: number, end: number): number[] {
  const first = times[0];
  if (first === undefined) return [];
  const slots = Math.max(1, Math.ceil((end - first) * fps - 1e-9));
  const shown: number[] = [];
  let latest = 0;
  for (let slot = 0; slot < slots; slot++) {
    const moment = first + slot / fps + 1e-9;
    while (latest + 1 < times.length && times[latest + 1]! <= moment) latest++;
    shown.push(latest);
  }
  return shown;
}

export type RecorderSegment = { targetId: string; startedAt: number };
export type RecorderResult = { frames: number; segments: RecorderSegment[] };

const files = (out: string) => ({
  control: `${out}.control`,
  ready: `${out}.ready`,
  done: `${out}.done`,
  failed: `${out}.failed`,
  log: `${out}.log`,
});
const daemonPath = () =>
  new URL(import.meta.url.endsWith(".ts") ? "./recorder-daemon.ts" : "./recorder-daemon.js", import.meta.url).pathname;

async function write(path: string, text: string) {
  await Bun.write(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}
async function exists(path: string) {
  return Bun.file(path).exists();
}
async function waitFor(done: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (const started = Date.now(); Date.now() - started < ms; await Bun.sleep(25)) if (await done()) return true;
  return false;
}

let sequence = 0;
async function command(out: string, line: string) {
  await write(files(out).control, `${Date.now()}.${sequence++} ${line}`);
}

/** Starts the helper on the given tab and waits until it is attached and filming. */
export async function startRecorder(options: { cdpUrl: string; out: string; fps: number; targetId: string }) {
  const { cdpUrl, out, fps, targetId } = options;
  const { ready, failed, log, control, done } = files(out);
  // Files left by an earlier recording at this path must not be mistaken for this one's: a stale "stop" would end
  // it at once, a stale "ready" would say it had started.
  await Promise.all([ready, failed, control, done].map((file) => rm(file, { force: true })));
  const daemon = Bun.spawn(
    [process.execPath, daemonPath(), "--cdp", cdpUrl, "--out", out, "--fps", String(fps), "--target", targetId],
    { stdin: "ignore", stdout: "ignore", stderr: Bun.file(log) },
  );
  daemon.unref();
  const started = await waitFor(async () => (await exists(ready)) || (await exists(failed)), 10_000);
  if (!started || (await exists(failed))) {
    daemon.kill();
    throw new Error((await exists(failed)) ? await Bun.file(failed).text() : "The recorder did not start in time");
  }
}

/** Tells the helper which tab to film from now on. */
export async function followTarget(out: string, targetId: string) {
  await command(out, `follow ${targetId}`);
}

/** Ends the recording: the helper writes the video and says what it filmed. */
export async function stopRecorder(out: string): Promise<RecorderResult> {
  const { done, failed } = files(out);
  await command(out, "stop");
  if (!(await waitFor(async () => (await exists(done)) || (await exists(failed)), 60_000)))
    throw new Error("The recorder did not finish in time");
  if (await exists(failed)) throw new Error(await Bun.file(failed).text());
  return JSON.parse(await Bun.file(done).text()) as RecorderResult;
}
