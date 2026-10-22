import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function nextVersion(
  previous: string | undefined,
  messages: string[],
): string | null {
  if (previous === undefined) return "0.0.1";
  const match = stableVersion.exec(previous);
  if (!match) throw new Error("Invalid previous release version");
  let increment = 0;
  for (const message of messages) {
    const header = /^([a-z]+)(?:\([^\r\n)]+\))?(!)?:[\t ]+\S/.exec(message);
    if (header?.[2] || /^BREAKING[ -]CHANGE:[\t ]*\S/m.test(message))
      increment = 3;
    else if (header?.[1] === "feat") increment = Math.max(increment, 2);
    else if (header?.[1] === "fix") increment = Math.max(increment, 1);
  }
  const [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  return increment === 3
    ? `${major + 1}.0.0`
    : increment === 2
      ? `${major}.${minor + 1}.0`
      : increment === 1
        ? `${major}.${minor}.${patch + 1}`
        : null;
}

type PublishedArtifact = {
  gitHead?: string | undefined;
  dist?: { integrity?: string | undefined } | undefined;
};
export function assertPublishedArtifact(
  published: PublishedArtifact,
  revision: string,
  integrity: string,
): void {
  if (published.gitHead !== revision || published.dist?.integrity !== integrity)
    throw new Error(
      "The npm version already exists with a different revision or artifact; refusing to overwrite or advance it",
    );
}

export function pendingRelease(
  previous: string | undefined,
  versions: Record<string, PublishedArtifact>,
  revision: string,
): string | undefined {
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
  if (latest === previous) return undefined;
  if (!latest || (previous !== undefined && !Object.hasOwn(versions, previous)))
    throw new Error(
      "The GitHub release baseline is missing from npm; reconcile the release history before publishing",
    );
  if (versions[latest]?.gitHead !== revision)
    throw new Error(
      `npm ${latest} is awaiting GitHub release completion; rerun its original revision before publishing another release`,
    );
  return latest;
}

export function assertOidcEnvironment(
  environment: Record<string, string | undefined>,
): void {
  if (
    !environment.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new Error(
      "GitHub OIDC is unavailable; grant id-token: write and configure the npm trusted publisher for ci.yml",
    );
}

export function npmPublishEnvironment(
  environment: Record<string, string | undefined>,
  release?: {
    version: string;
    previousTag: string | undefined;
    registryExists: boolean;
  },
): Record<string, string | undefined> {
  const clean = { ...environment };
  delete clean.BOOTSTRAP_NPM_TOKEN;
  delete clean.NODE_AUTH_TOKEN;
  if (
    release?.version === "0.0.1" &&
    !release.previousTag &&
    !release.registryExists &&
    environment.BOOTSTRAP_NPM_TOKEN
  )
    clean.NODE_AUTH_TOKEN = environment.BOOTSTRAP_NPM_TOKEN;
  return clean;
}

async function command(
  binary: string,
  args: string[],
  environment = npmPublishEnvironment(process.env),
): Promise<string> {
  return (
    await exec(binary, args, {
      encoding: "utf8",
      env: environment,
      timeout: 180_000,
      maxBuffer: 2_000_000,
    })
  ).stdout.trim();
}

async function release(): Promise<void> {
  const repository = "g4rcez/agent-browser-jev";
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "")
  )
    throw new Error(
      "Publishing is allowed only from this repository's green main-branch GitHub workflow",
    );
  assertOidcEnvironment(process.env);
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(process.env.GITHUB_SHA);
  if ((await command("git", ["rev-parse", "HEAD"])) !== revision)
    throw new Error("Release checkout does not match the checked revision");
  const tags = (
    await command("git", ["tag", "--list", "v*", "--sort=-version:refname"])
  )
    .split("\n")
    .filter((tag) => stableVersion.test(tag.slice(1)));
  const previousTag = tags[0];
  let sameRevision = false;
  if (previousTag) {
    // A rerun of an old workflow must never publish behind a newer release.
    await command("git", [
      "merge-base",
      "--is-ancestor",
      previousTag,
      revision,
    ]);
    sameRevision =
      (await command("git", ["rev-list", "-n", "1", previousTag])) === revision;
  }
  const range = previousTag ? `${previousTag}..${revision}` : revision;
  const messages = (await command("git", ["log", range, "--format=%B%x00"]))
    .split("\0")
    .map((message) => message.trim())
    .filter(Boolean);
  const response = await fetch("https://registry.npmjs.org/agent-tester", {
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`npm registry lookup failed (${response.status})`);
  const registry =
    response.status === 404
      ? undefined
      : z
          .object({
            name: z.literal("agent-tester"),
            versions: z.record(
              z.string(),
              z.object({
                gitHead: z.string().optional(),
                dist: z.object({ integrity: z.string().optional() }).optional(),
              }),
            ),
          })
          .parse(await response.json());
  const pending = pendingRelease(
    previousTag?.slice(1),
    registry?.versions ?? {},
    revision,
  );
  const version =
    pending ??
    (sameRevision
      ? previousTag!.slice(1)
      : nextVersion(previousTag?.slice(1), messages));
  if (!version) {
    console.log(
      JSON.stringify({
        released: false,
        reason:
          "No fix, feat, or breaking-change commits since the last release",
      }),
    );
    return;
  }
  const tag = `v${version}`;
  const manifest = await Bun.file("package.json").json();
  if (manifest.name !== "agent-tester")
    throw new Error("Unexpected package name");
  await writeFile(
    "package.json",
    JSON.stringify({ ...manifest, version, gitHead: revision }, null, 2) + "\n",
  );
  await command("bun", ["run", "build"]);
  const packed = z
    .array(z.object({ filename: z.string() }))
    .min(1)
    .parse(
      JSON.parse(await command("npm", ["pack", "--ignore-scripts", "--json"])),
    );
  const archive = packed[0]!.filename;
  if (archive !== `agent-tester-${version}.tgz`)
    throw new Error("Unexpected package archive");
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
      [
        "publish",
        archive,
        "--access",
        "public",
        "--provenance",
        "--ignore-scripts",
      ],
      npmPublishEnvironment(process.env, {
        version,
        previousTag,
        registryExists: registry !== undefined,
      }),
    );

  // A failed GitHub release after a successful npm publish is repairable by
  // rerunning this exact workflow, but only for the identical package bytes.
  const github = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (github.status === 404) {
    const directory = await mkdtemp(join(tmpdir(), "agent-tester-release-"));
    try {
      const notes = join(directory, "notes.md");
      const commits = await command("git", [
        "log",
        range,
        "--format=- %s (%h)",
      ]);
      await writeFile(
        notes,
        `npm: https://www.npmjs.com/package/agent-tester/v/${version}\n\nRevision: ${revision}\n\n${commits}\n`,
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
        `agent-tester ${version}`,
        "--notes-file",
        notes,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else if (!github.ok)
    throw new Error(`GitHub release lookup failed (${github.status})`);
  console.log(
    JSON.stringify({
      released: true,
      package: `agent-tester@${version}`,
      tag,
      revision,
      integrity,
    }),
  );
}

if (import.meta.main) await release();
