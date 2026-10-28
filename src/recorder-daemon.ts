import { copyFile, link, mkdir, rename, rm } from "node:fs/promises";
import { toConstantRate, type RecorderResult, type RecorderSegment } from "./recorder.ts";

// The recorder's helper process (see recorder.ts). It connects to the browser over CDP, films the tab the runner
// names through the control file, and on "stop" writes one constant-rate video. It outlives the runner call that
// started it, so a run that pauses and resumes keeps one recording. It never sends input to a page.

type Message = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
  sessionId?: string;
};

class Cdp {
  private socket!: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private handlers: Array<(message: Message) => void> = [];
  onClose: () => void = () => undefined;
  async open(url: string): Promise<void> {
    this.socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("Cannot connect to the browser over CDP"));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message));
        else waiting?.resolve(message.result);
      } else for (const handler of this.handlers) handler(message);
    };
    this.socket.onclose = () => this.onClose();
  }
  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(handler: (message: Message) => void) {
    this.handlers.push(handler);
  }
  close() {
    this.onClose = () => undefined;
    this.socket.close();
  }
}

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
async function atomic(path: string, text: string) {
  await Bun.write(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}
async function size(file: string): Promise<{ width: number; height: number }> {
  const probe = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ],
    { stdout: "pipe" },
  );
  const [width, height] = (await new Response(probe.stdout).text()).trim().split(",").map(Number);
  if (!width || !height) throw new Error("Cannot read the size of the first frame; is ffmpeg installed?");
  return { width, height };
}

async function main() {
  const cdpUrl = argument("cdp"),
    out = argument("out"),
    fps = Number(argument("fps")),
    first = argument("target");
  const frames = `${out}.frames`;
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames, { recursive: true });

  const cdp = new Cdp();
  await cdp.open(cdpUrl);
  const captured: Array<{ at: number; file: string }> = [];
  const writes: Array<Promise<number>> = [];
  const segments: RecorderSegment[] = [];
  const sessions = new Map<string, string>();
  let current: { targetId: string; session: string } | undefined;
  let queue: Promise<void> = Promise.resolve();

  // Films one tab at a time. A tab that is not the one in front is not painted at full rate, so the tab is brought
  // to the front and told it has focus before its screencast starts.
  const follow = (targetId: string) =>
    (queue = queue.then(async () => {
      if (current?.targetId === targetId) return;
      try {
        let session = sessions.get(targetId);
        if (!session) {
          session = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }))
            .sessionId;
          sessions.set(targetId, session);
        }
        if (current) await cdp.send("Page.stopScreencast", {}, current.session).catch(() => undefined);
        await cdp.send("Target.activateTarget", { targetId }).catch(() => undefined);
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, session).catch(() => undefined);
        // The tab is the current one before its screencast starts, so its first frame is not mistaken for a late one.
        const before = current;
        current = { targetId, session };
        try {
          await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 }, session);
        } catch (error) {
          current = before;
          throw error;
        }
        segments.push({ targetId, startedAt: Date.now() / 1000 });
      } catch (error) {
        console.error(`follow ${targetId}: ${error instanceof Error ? error.message : error}`);
      }
    }));

  cdp.on((message) => {
    if (message.method === "Page.screencastFrame") {
      const { data, metadata, sessionId: ack } = message.params;
      void cdp.send("Page.screencastFrameAck", { sessionId: ack }, message.sessionId).catch(() => undefined);
      // Frames of a tab that is no longer the one being filmed can still be in flight.
      if (!current || message.sessionId !== current.session) return;
      const file = `${frames}/${String(captured.length).padStart(7, "0")}.jpg`;
      captured.push({ at: metadata?.timestamp ?? Date.now() / 1000, file });
      writes.push(Bun.write(file, Buffer.from(data, "base64")));
    } else if (message.method === "Target.targetDestroyed" && current?.targetId === message.params.targetId) {
      // A pop-up closed itself: carry on with the tab the recording began on until the runner says otherwise.
      current = undefined;
      void follow(first);
    }
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await follow(first);
  await queue;
  if (!current) throw new Error(`Cannot film the tab ${first}`);
  await atomic(`${out}.ready`, "1");

  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    try {
      await queue;
      // From here on no more frames are accepted: the ones still in flight would be added to the list after the
      // files being waited for were counted, and read while they are only half written.
      const filming = current;
      current = undefined;
      if (filming) await cdp.send("Page.stopScreencast", {}, filming.session).catch(() => undefined);
      await Promise.all(writes);
      if (!captured.length) throw new Error("The browser sent no frames to record");
      const end = Date.now() / 1000;
      const shown = toConstantRate(
        captured.map((frame) => frame.at),
        fps,
        Math.max(end, captured.at(-1)!.at),
      );
      const { width, height } = await size(captured[0]!.file);
      const even = (value: number) => Math.max(2, value - (value % 2));
      const [w, h] = [even(width), even(height)];
      // Every tab may have its own size; each is kept at its own size in the top-left corner of one frame.
      const filter = `scale='min(${w},iw)':'min(${h},ih)':force_original_aspect_ratio=decrease,pad=${w}:${h}:0:0`;
      const codec = out.endsWith(".webm")
        ? ["-c:v", "libvpx", "-b:v", "2M", "-pix_fmt", "yuv420p"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
      // ffmpeg reads an exact frame sequence: one numbered file per video frame, each a link to the captured picture
      // it shows. Nothing is left to timestamps, which is where picture rates were lost (a concat list with
      // durations, or a stream of pictures, gave a fraction of the distinct pictures the browser had sent).
      const slots = `${out}.slots`;
      await rm(slots, { recursive: true, force: true });
      await mkdir(slots, { recursive: true });
      for (let from = 0; from < shown.length; from += 200)
        await Promise.all(
          shown.slice(from, from + 200).map(async (index, at) => {
            const target = `${slots}/${String(from + at).padStart(7, "0")}.jpg`;
            await link(captured[index]!.file, target).catch(() => copyFile(captured[index]!.file, target));
          }),
        );
      const ffmpeg = Bun.spawn(
        [
          "ffmpeg",
          "-y",
          "-v",
          "error",
          "-framerate",
          String(fps),
          "-i",
          `${slots}/%07d.jpg`,
          "-vf",
          filter,
          "-r",
          String(fps),
          ...codec,
          out,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      const [error, code] = await Promise.all([new Response(ffmpeg.stderr).text(), ffmpeg.exited]);
      if (code !== 0) throw new Error(`ffmpeg failed: ${error.trim()}`);
      const result: RecorderResult = { frames: captured.length, segments };
      await atomic(`${out}.done`, JSON.stringify(result));
    } catch (error) {
      await atomic(`${out}.failed`, error instanceof Error ? error.message : String(error));
    } finally {
      await rm(frames, { recursive: true, force: true });
      await rm(`${out}.slots`, { recursive: true, force: true });
      cdp.close();
      process.exit(0);
    }
  };
  // The browser going away ends the recording with what was filmed.
  cdp.onClose = () => void finish();
  process.on("SIGTERM", () => void finish());

  // The runner talks to this process through one small file: "<stamp> follow <targetId>" or "<stamp> stop".
  let seen = "";
  const started = Date.now();
  while (!finishing) {
    await Bun.sleep(25);
    const text = (await Bun.file(`${out}.control`).exists()) ? await Bun.file(`${out}.control`).text() : "";
    if (text && text !== seen) {
      seen = text;
      const [, verb, targetId] = text.trim().split(" ");
      if (verb === "follow" && targetId) void follow(targetId);
      if (verb === "stop") await finish();
    }
    // A runner that died without stopping must not leave this process behind for ever.
    if (Date.now() - started > 4 * 3600_000) await finish();
  }
}

main().catch(async (error) => {
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (out) await atomic(`${out}.failed`, error instanceof Error ? error.message : String(error)).catch(() => undefined);
  console.error(error);
  process.exit(1);
});
