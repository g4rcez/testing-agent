import { afterAll, beforeAll, expect, test } from "bun:test";
import { isolatedState, journey, serveGiantSite } from "./giant-site.ts";
import { decode, distinctPicturesPerSecond, longestFreeze, pagesShown, probe } from "./video-frames.ts";

// A recording that follows a window.open() popup and comes back. The pages draw a colour and a frame counter,
// so the recording itself can be read: did it show the popup, and did the animation keep moving?
let server: ReturnType<typeof serveGiantSite>;
let restore: () => Promise<void>;
beforeAll(async () => {
  server = serveGiantSite();
  restore = await isolatedState("jev-video");
});
afterAll(async () => {
  server.stop(true);
  await restore();
});

test("one continuous 60fps video shows the opener, the popup animating, and the opener again", async () => {
  const result = await journey(
    `${server.url}anim.html?role=opener`,
    [
      { instruction: "Click Open popup", expect: { text: "Popup ready", timeoutMs: 6000 } },
      { instruction: "Click Close popup", expect: { text: "Popup closed", timeoutMs: 6000 } },
    ],
    { recordVideo: true, videoFps: 60 },
  );
  expect(result.status, JSON.stringify({ reason: result.reason, debug: result.debug })).toBe("completed");
  expect(result.video?.status).toBe("saved");
  const path = result.video!.path;

  expect((await probe(path)).fps).toBe(60);
  const frames = await decode(path);
  // Shared macOS CI runners have no GPU: the opener can be left again before the browser delivers one picture of
  // it, so there the recording must still end on the popup and the opener, but may begin at the popup.
  const shown = pagesShown(frames);
  const slowRunner = process.env.CI && process.platform === "darwin";
  if (slowRunner) expect(shown.slice(-2)).toEqual(["popup", "opener"]);
  else expect(shown).toEqual(["opener", "popup", "opener"]);

  // The page draws a new picture on every one of its 60 frames a second. Shown 60 times a second, the video must
  // hold nearly as many different pictures: a recorder that sends the browser's frames through a slow path shows
  // a third of them (about 24 a second) and still passes any check that only looks for long freezes.
  const popup = frames.filter((frame) => frame.page === "popup");
  const opener = frames.filter((frame) => frame.page === "opener");
  expect(popup.length).toBeGreaterThan(60);
  // Shared macOS CI runners have no GPU and draw 20-40 pictures a second whatever the recorder does, so the
  // rate checks run on Ubuntu CI and on developer machines.
  if (process.env.CI && process.platform === "darwin") return;
  expect(distinctPicturesPerSecond(popup, 60)).toBeGreaterThanOrEqual(45);
  // The opener's share also holds the page loading and the browser busy creating the popup window.
  expect(distinctPicturesPerSecond(opener, 60)).toBeGreaterThanOrEqual(40);
  // And no picture is held long enough to be seen as a freeze: 6 frames is 100ms.
  expect(longestFreeze(popup)).toBeLessThanOrEqual(6);
}, 180_000);
