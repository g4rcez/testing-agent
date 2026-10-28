import { expect, test } from "bun:test";
import fc from "fast-check";
import { toConstantRate } from "../../src/recorder.ts";

// Captured frames arrive only when the picture changes. The timeline turns them into a constant-rate video that
// holds a picture through any gap, such as the moment a recording moves from one tab to another.
test("a picture is held through a gap and the next one appears when it was taken", () => {
  expect(toConstantRate([0, 0.5], 2, 1.5)).toEqual([0, 1, 1]);
  expect(toConstantRate([10, 12], 1, 13)).toEqual([0, 0, 1]);
  expect(toConstantRate([], 60, 1)).toEqual([]);
  expect(toConstantRate([5], 60, 5)).toEqual([0]);
});

// Ascending capture times in seconds, and an end that is not before the last of them.
const timeline = fc
  .tuple(
    fc.double({ min: 1000, max: 2000, noNaN: true }),
    fc.array(fc.double({ min: 0, max: 3, noNaN: true }), { minLength: 1, maxLength: 40 }),
    fc.double({ min: 0, max: 4, noNaN: true }),
    fc.constantFrom(1, 24, 30, 60),
  )
  .map(([start, gaps, tail, fps]) => {
    const times = gaps.reduce<number[]>((all, gap) => [...all, (all.at(-1) ?? start) + gap], []);
    return { times, fps, end: times.at(-1)! + tail };
  });

test("the video never shows a picture from the future, and always the latest one taken", () => {
  fc.assert(
    fc.property(timeline, ({ times, fps, end }) => {
      const shown = toConstantRate(times, fps, end);
      shown.forEach((index, slot) => {
        const moment = times[0]! + slot / fps;
        expect(times[index]!).toBeLessThanOrEqual(moment + 1e-6);
        // Nothing newer than the one shown was already available.
        for (const later of times.slice(index + 1)) expect(later).toBeGreaterThan(moment + 1e-12);
      });
    }),
  );
});

test("the pictures only move forward and the video lasts as long as the recording", () => {
  fc.assert(
    fc.property(timeline, ({ times, fps, end }) => {
      const shown = toConstantRate(times, fps, end);
      expect(shown.every((index, slot) => slot === 0 || index >= shown[slot - 1]!)).toBe(true);
      expect(shown.every((index) => Number.isInteger(index) && index >= 0 && index < times.length)).toBe(true);
      const seconds = shown.length / fps;
      const recorded = end - times[0]!;
      expect(seconds).toBeGreaterThanOrEqual(recorded - 1e-6);
      expect(seconds).toBeLessThan(recorded + 1 / fps + 1e-6);
    }),
  );
});
