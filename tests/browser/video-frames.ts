// Reads a recording of anim.html back into numbers: for every frame, which page it shows (the colour of the
// page) and the frame counter drawn in its top-left corner. Plain ffmpeg, no model, no guessing.
export type VideoFrame = { page: "opener" | "popup" | "other"; counter: number };

async function ffmpeg(args: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(["ffmpeg", "-v", "error", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg failed: ${err}`);
  return new Uint8Array(out);
}

export async function probe(path: string): Promise<{ width: number; height: number; fps: number; seconds: number }> {
  const child = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate:format=duration",
      "-of",
      "json",
      path,
    ],
    { stdout: "pipe" },
  );
  const json = JSON.parse(await new Response(child.stdout).text()) as {
    streams: Array<{ width: number; height: number; r_frame_rate: string }>;
    format: { duration: string };
  };
  const [numerator, denominator] = json.streams[0]!.r_frame_rate.split("/").map(Number);
  return {
    width: json.streams[0]!.width,
    height: json.streams[0]!.height,
    fps: numerator! / denominator!,
    seconds: Number(json.format.duration),
  };
}

export async function decode(path: string): Promise<VideoFrame[]> {
  const { width } = await probe(path);
  // The page is laid out for a 1280px viewport; a recording of a denser or smaller screen is scaled to match.
  const scale = 1280 / width;
  const strip = await ffmpeg([
    "-i",
    path,
    "-vf",
    `scale=iw*${scale}:-2,crop=256:16:0:0`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  const band = await ffmpeg([
    "-i",
    path,
    "-vf",
    `scale=iw*${scale}:-2,crop=8:8:600:300`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  const stripBytes = 256 * 16 * 3;
  const bandBytes = 8 * 8 * 3;
  const frames: VideoFrame[] = [];
  for (let at = 0; at * stripBytes < strip.length; at++) {
    let counter = 0;
    for (let bit = 0; bit < 16; bit++) {
      // The middle of each 16px cell, on its middle row.
      const pixel = at * stripBytes + (8 * 256 + bit * 16 + 8) * 3;
      counter = (counter << 1) | (strip[pixel]! > 128 ? 1 : 0);
    }
    const [r, g, b] = [
      band[at * bandBytes + 28 * 3]!,
      band[at * bandBytes + 28 * 3 + 1]!,
      band[at * bandBytes + 28 * 3 + 2]!,
    ];
    const page = b > 180 && r < 80 && g < 80 ? "opener" : g > 120 && r < 80 && b < 80 ? "popup" : "other";
    frames.push({ page, counter });
  }
  return frames;
}

/** The pages in the order they were shown, repeats collapsed: ["opener", "popup", "opener"]. */
export function pagesShown(frames: VideoFrame[]): string[] {
  const shown: string[] = [];
  for (const frame of frames) if (frame.page !== "other" && shown.at(-1) !== frame.page) shown.push(frame.page);
  return shown;
}

/** The longest run of frames in which the counter did not change: a frozen picture. */
export function longestFreeze(frames: VideoFrame[]): number {
  let longest = 1,
    run = 1;
  for (let at = 1; at < frames.length; at++) {
    run = frames[at]!.counter === frames[at - 1]!.counter ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** How many different pictures a second the frames show, at the given frame rate: 60 means no picture is repeated. */
export function distinctPicturesPerSecond(frames: VideoFrame[], fps: number): number {
  let changes = 0;
  for (let at = 1; at < frames.length; at++) if (frames[at]!.counter !== frames[at - 1]!.counter) changes++;
  return changes / (frames.length / fps);
}
