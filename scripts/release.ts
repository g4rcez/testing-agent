import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const patchTypes = new Set(["build", "chore", "style", "test", "docs"]);
const minorTypes = new Set(["feat", "refactor", "ci", "perf", "fix"]);

// Only a breaking feat (or a BREAKING CHANGE footer) is a major release; any other
// recognised type releases at least a patch, so every conventional commit ships.
export function nextVersion(previous: string | undefined, messages: string[]): string | null {
  if (previous === undefined) return "0.0.1";
  const match = stableVersion.exec(previous);
  if (!match) throw new Error("Invalid previous release version");
  let increment = 0;
  for (const message of messages) {
    const header = /^([a-z]+)(?:\([^\r\n)]+\))?(!)?:[\t ]+\S/.exec(message);
    const type = header?.[1] ?? "";
    if ((header?.[2] && type === "feat") || /^BREAKING[ -]CHANGE:[\t ]*\S/m.test(message)) increment = 3;
    else if (minorTypes.has(type)) increment = Math.max(increment, 2);
    else if (patchTypes.has(type)) increment = Math.max(increment, 1);
  }
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return increment === 3
    ? `${major + 1}.0.0`
    : increment === 2
      ? `${major}.${minor + 1}.0`
      : increment === 1
        ? `${major}.${minor}.${patch + 1}`
        : null;
}

type PublishedArtifact = { gitHead?: string | undefined; dist?: { integrity?: string | undefined } | undefined };
export function assertPublishedArtifact(published: PublishedArtifact, revision: string, integrity: string): void {
  if (published.gitHead !== revision || published.dist?.integrity !== integrity)
    throw new Error(
      "The npm version already exists with a different revision or artifact; refusing to overwrite or advance it",
    );
}

export async function verifyNpmPublication(
  version: string,
  revision: string,
  integrity: string,
  request: (url: string) => Promise<Response> = (url) =>
    fetch(url, { signal: AbortSignal.timeout(15000), cache: "no-store" }),
  retry = { attempts: 18, delayMs: 10_000 },
): Promise<void> {
  // A fresh publication can return 404 for a short time while the registry propagates.
  let response = await request(`https://registry.npmjs.org/testing-agent/${version}?verify=${Date.now()}`);
  for (let attempt = 1; response.status === 404 && attempt < retry.attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
    response = await request(`https://registry.npmjs.org/testing-agent/${version}?verify=${Date.now()}`);
  }
  if (!response.ok)
    throw new Error(
      `npm ${version} is not publicly available (${response.status}); check staged-publication approval before creating a GitHub release`,
    );
  const published = z
    .object({
      name: z.literal("testing-agent"),
      version: z.literal(version),
      gitHead: z.string(),
      dist: z.object({ integrity: z.string() }),
    })
    .parse(await response.json());
  assertPublishedArtifact(published, revision, integrity);
}

export function publicationBaseline(
  previousTag: string | undefined,
  previousPackage: string | undefined,
): string | undefined {
  if (!previousTag) return undefined;
  if (previousPackage === "agent-tester") return undefined;
  if (previousPackage !== "testing-agent") throw new Error("Unexpected package in release history");
  return previousTag.slice(1);
}

export function pendingRelease(
  previous: string | undefined,
  versions: Record<string, PublishedArtifact> | undefined,
  revision: string,
): string | undefined {
  if (versions === undefined) {
    if (previous !== undefined)
      throw new Error(
        "The GitHub release baseline is missing from npm; reconcile the release history before publishing",
      );
    return undefined;
  }
  const latest = Object.keys(versions)
    .filter((version) => stableVersion.test(version))
    .sort((left, right) => {
      const a = left.split(".").map(BigInt),
        b = right.split(".").map(BigInt);
      for (let index = 0; index < 3; index++) {
        if (a[index]! < b[index]!) return 1;
        if (a[index]! > b[index]!) return -1;
      }
      return 0;
    })[0];
  if (!latest)
    throw new Error(
      "npm has no stable version; resolve any staged publication and rerun its original revision before publishing another release",
    );
  if (latest === previous) return undefined;
  if (previous !== undefined && !Object.hasOwn(versions, previous))
    throw new Error("The GitHub release baseline is missing from npm; reconcile the release history before publishing");
  if (versions[latest]?.gitHead !== revision)
    throw new Error(
      `npm ${latest} is awaiting GitHub release completion; rerun its original revision before publishing another release`,
    );
  return latest;
}

export function assertOidcEnvironment(environment: Record<string, string | undefined>): void {
  if (!environment.ACTIONS_ID_TOKEN_REQUEST_URL || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw new Error("GitHub OIDC is unavailable; grant id-token: write so npm can sign provenance");
}

// Child processes never see the npm token; only `npm publish` receives it.
export function npmPublishEnvironment(
  environment: Record<string, string | undefined>,
  publishing = false,
): Record<string, string | undefined> {
  const clean = { ...environment };
  delete clean.NPM_TOKEN;
  delete clean.NODE_AUTH_TOKEN;
  if (publishing && environment.NPM_TOKEN) clean.NODE_AUTH_TOKEN = environment.NPM_TOKEN;
  return clean;
}

async function command(
  binary: string,
  args: string[],
  environment = npmPublishEnvironment(process.env),
): Promise<string> {
  return (
    await exec(binary, args, { encoding: "utf8", env: environment, timeout: 180_000, maxBuffer: 2_000_000 })
  ).stdout.trim();
}

// Replaces only the version line so the committed file keeps its formatting.
export function withVersion(manifest: string, version: string): string {
  return manifest.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
}

// Keeps main's package.json in step with npm. The message is untyped on purpose:
// nextVersion ignores it, so the commit never triggers a release of its own.
async function syncVersion(repository: string, version: string): Promise<void> {
  const url = `https://x-access-token:${process.env.GH_TOKEN ?? ""}@github.com/${repository}.git`;
  await command("git", ["fetch", url, "main"]);
  await command("git", ["checkout", "--force", "-B", "version-sync", "FETCH_HEAD"]);
  const current = await readFile("package.json", "utf8");
  const next = withVersion(current, version);
  if (next === current) return;
  await writeFile("package.json", next);
  await command("git", [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "--only",
    "package.json",
    "--message",
    `Sync package.json version to ${version} [skip ci]`,
  ]);
  // A plain push fails if main moved; a rerun of this workflow repairs that.
  await command("git", ["push", url, "version-sync:main"]);
}

async function release(): Promise<void> {
  const repository = "g4rcez/testing-agent";
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "")
  )
    throw new Error("Publishing is allowed only from this repository's green main-branch GitHub workflow");
  assertOidcEnvironment(process.env);
  if (!process.env.NPM_TOKEN) throw new Error("NPM_TOKEN is not set; add it as a repository secret");
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(process.env.GITHUB_SHA);
  if ((await command("git", ["rev-parse", "HEAD"])) !== revision)
    throw new Error("Release checkout does not match the checked revision");
  const tags = (await command("git", ["tag", "--list", "v*", "--sort=-version:refname"]))
    .split("\n")
    .filter((tag) => stableVersion.test(tag.slice(1)));
  const previousTag = tags[0];
  let sameRevision = false;
  if (previousTag) {
    // A rerun of an old workflow must never publish behind a newer release.
    await command("git", ["merge-base", "--is-ancestor", previousTag, revision]);
    sameRevision = (await command("git", ["rev-list", "-n", "1", previousTag])) === revision;
  }
  const previousPackage = previousTag
    ? z.object({ name: z.string() }).parse(JSON.parse(await command("git", ["show", `${previousTag}:package.json`])))
        .name
    : undefined;
  const baseline = publicationBaseline(previousTag, previousPackage);
  const range = previousTag ? `${previousTag}..${revision}` : revision;
  const messages = (await command("git", ["log", range, "--format=%B%x00"]))
    .split("\0")
    .map((message) => message.trim())
    .filter(Boolean);
  const response = await fetch(`https://registry.npmjs.org/testing-agent?verify=${Date.now()}`, {
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 404) throw new Error(`npm registry lookup failed (${response.status})`);
  const registry =
    response.status === 404
      ? undefined
      : z
          .object({
            name: z.literal("testing-agent"),
            versions: z.record(
              z.string(),
              z.object({
                gitHead: z.string().optional(),
                dist: z.object({ integrity: z.string().optional() }).optional(),
              }),
            ),
          })
          .parse(await response.json());
  const pending = pendingRelease(baseline, registry?.versions, revision);
  const version = pending ?? (sameRevision ? previousTag!.slice(1) : nextVersion(previousTag?.slice(1), messages));
  if (!version) {
    console.log(JSON.stringify({ released: false, reason: "No conventional commits since the last release" }));
    return;
  }
  const tag = `v${version}`;
  const manifest = await Bun.file("package.json").json();
  if (manifest.name !== "testing-agent") throw new Error("Unexpected package name");
  await writeFile("package.json", JSON.stringify({ ...manifest, version, gitHead: revision }, null, 2) + "\n");
  await command("bun", ["run", "build"]);
  const packed = z
    .array(z.object({ filename: z.string() }))
    .min(1)
    .parse(JSON.parse(await command("npm", ["pack", "--ignore-scripts", "--json"])));
  const archive = packed[0]!.filename;
  if (archive !== `testing-agent-${version}.tgz`) throw new Error("Unexpected package archive");
  const integrity =
    "sha512-" +
    createHash("sha512")
      .update(await readFile(archive))
      .digest("base64");
  const published = registry?.versions[version];
  if (published) assertPublishedArtifact(published, revision, integrity);
  else
    await command(
      "npm",
      ["publish", archive, "--access", "public", "--provenance", "--ignore-scripts"],
      npmPublishEnvironment(process.env, true),
    );

  await verifyNpmPublication(version, revision, integrity);

  // A failed GitHub release after a successful npm publish is repairable by
  // rerunning this exact workflow, but only for the identical package bytes.
  const github = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (github.status === 404) {
    const directory = await mkdtemp(join(tmpdir(), "testing-agent-release-"));
    try {
      const notes = join(directory, "notes.md");
      const commits = await command("git", ["log", range, "--format=- %s (%h)"]);
      await writeFile(
        notes,
        `npm: https://www.npmjs.com/package/testing-agent/v/${version}\n\nRevision: ${revision}\n\n${commits}\n`,
      );
      await command("gh", [
        "release",
        "create",
        tag,
        archive,
        "--repo",
        repository,
        "--target",
        revision,
        "--title",
        `testing-agent ${version}`,
        "--notes-file",
        notes,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else if (!github.ok) throw new Error(`GitHub release lookup failed (${github.status})`);
  await syncVersion(repository, version);
  console.log(JSON.stringify({ released: true, package: `testing-agent@${version}`, tag, revision, integrity }));
}

if (import.meta.main) await release();
