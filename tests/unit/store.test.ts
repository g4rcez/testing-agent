import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSession,
  atomicWrite,
  readState,
  statePath,
} from "../../src/store.ts";

let directory: string;
const previous = process.env.JEV_STATE_DIR;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jev-store-"));
  process.env.JEV_STATE_DIR = directory;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.JEV_STATE_DIR;
  else process.env.JEV_STATE_DIR = previous;
});

test("a live session owner cannot be stolen, including by recover", async () => {
  const runId = crypto.randomUUID();
  const release = await acquireSession("locked", runId);
  try {
    await expect(acquireSession("locked", runId)).rejects.toThrow(
      "live process",
    );
    await expect(acquireSession("locked", runId, true)).rejects.toThrow(
      "live process",
    );
  } finally {
    release();
  }
  const second = await acquireSession("locked", runId);
  second();
});

test("a run state is replaced durably without partial JSON", async () => {
  const runId = crypto.randomUUID();
  await atomicWrite(statePath(runId), { status: "running" });
  await atomicWrite(statePath(runId), { status: "completed" });
  expect(await readState(runId)).toEqual({ status: "completed" });
});
