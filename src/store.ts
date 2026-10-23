import { Database } from "bun:sqlite";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

export const stateRoot = () => resolve(process.env.JEV_STATE_DIR ?? ".agent-browser-jev");
export const statePath = (runId: string) => resolve(stateRoot(), `${z.uuid().parse(runId)}.json`);
export const cancelPath = (runId: string) => resolve(stateRoot(), `${z.uuid().parse(runId)}.cancel`);

export async function requestCancellation(runId: string): Promise<void> {
  const file = await open(cancelPath(runId), "r+");
  try {
    await file.write("1", 0, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(stateRoot(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(stateRoot(), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readState(runId: string): Promise<unknown> {
  return Bun.file(statePath(runId)).json();
}

type Owner = { session: string; run_id: string; token: string; pid: number; host: string };
export class SessionBusyError extends Error {}
export async function acquireSession(session: string, runId: string, recover = false): Promise<() => void> {
  await mkdir(stateRoot(), { recursive: true, mode: 0o700 });
  const path = resolve(stateRoot(), "locks.sqlite");
  const db = new Database(path, { create: true, strict: true });
  db.exec(
    "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS session_locks (session TEXT PRIMARY KEY, run_id TEXT NOT NULL, token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL)",
  );
  await chmod(path, 0o600);
  const token = crypto.randomUUID();
  try {
    db.transaction(() => {
      const owner = db.query<Owner, [string]>("SELECT * FROM session_locks WHERE session = ?").get(session);
      if (owner) {
        let alive = true;
        if (owner.host === hostname()) {
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false;
          }
        }
        if (alive) throw new SessionBusyError("Browser session is owned by a live process");
        if (!recover || owner.run_id !== runId)
          throw new Error(`Interrupted owner detected; use agent.recover for run ${owner.run_id}`);
        db.query("DELETE FROM session_locks WHERE session = ? AND token = ?").run(session, owner.token);
      }
      db.query("INSERT INTO session_locks (session, run_id, token, pid, host) VALUES (?, ?, ?, ?, ?)").run(
        session,
        runId,
        token,
        process.pid,
        hostname(),
      );
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  return () => {
    try {
      db.query("DELETE FROM session_locks WHERE session = ? AND token = ?").run(session, token);
    } finally {
      db.close();
    }
  };
}
