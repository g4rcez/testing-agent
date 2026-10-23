import { expect, test } from "bun:test";
import { z } from "zod";
import {
  nextVersion,
  assertPublishedArtifact,
  pendingRelease,
  assertOidcEnvironment,
  npmPublishEnvironment,
  verifyNpmPublication,
  publicationBaseline,
} from "../../scripts/release.ts";

test("provenance requires GitHub OIDC", () => {
  expect(() =>
    assertOidcEnvironment({
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-only",
    }),
  ).not.toThrow();
  for (const environment of [
    {},
    { ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc" },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-only" },
  ])
    expect(() => assertOidcEnvironment(environment)).toThrow("OIDC");
});

test("the npm token reaches only npm publish", () => {
  const environment = { PATH: "/tools", NPM_TOKEN: "token-fixture", NODE_AUTH_TOKEN: "unrelated-fixture" };
  expect(npmPublishEnvironment(environment, true)).toEqual({ PATH: "/tools", NODE_AUTH_TOKEN: "token-fixture" });
  expect(npmPublishEnvironment(environment)).toEqual({ PATH: "/tools" });
  expect(npmPublishEnvironment({ PATH: "/tools" }, true)).toEqual({ PATH: "/tools" });
  expect(environment.NPM_TOKEN).toBe("token-fixture");
});

test("a package rename keeps Git version history but starts a new npm reconciliation baseline", () => {
  expect(publicationBaseline("v0.0.1", "agent-tester")).toBeUndefined();
  expect(publicationBaseline("v0.0.2", "testing-agent")).toBe("0.0.2");
  expect(() => publicationBaseline("v0.0.1", "unexpected-package")).toThrow();
  const baseline = publicationBaseline("v0.0.1", "agent-tester");
  expect(pendingRelease(baseline, undefined, "rename-revision")).toBeUndefined();
  expect(nextVersion("0.0.1", ["chore: Rename the package"])).toBe("0.0.2");
  expect(pendingRelease(baseline, { "0.0.2": { gitHead: "rename-revision" } }, "rename-revision")).toBe("0.0.2");
  expect(() => pendingRelease(baseline, { "0.0.2": { gitHead: "rename-revision" } }, "other-revision")).toThrow(
    "awaiting GitHub",
  );
});

test("first release is always 0.0.1", () => {
  expect(nextVersion(undefined, ["feat!: Initial implementation"])).toBe("0.0.1");
});

test("Conventional Commits choose the highest explicit release increment", () => {
  for (const [messages, expected] of [
    [["feat!: Change the command contract"], "2.0.0"],
    [["feat(cli)!: Change the command contract"], "2.0.0"],
    [["chore: Update\n\nBREAKING CHANGE: Change the protocol"], "2.0.0"],
    [["feat: Update\n\nBREAKING-CHANGE: Change the protocol"], "2.0.0"],
    [["feat: Add a command"], "1.3.0"],
    [["refactor!: Change internals"], "1.3.0"],
    [["refactor: Change internals"], "1.3.0"],
    [["ci: Change the pipeline"], "1.3.0"],
    [["perf: Speed up the run"], "1.3.0"],
    [["fix(browser): Correct a defect"], "1.3.0"],
    [["fix!: Change the error contract"], "1.3.0"],
    [["build: Update the bundler"], "1.2.4"],
    [["chore: Tidy"], "1.2.4"],
    [["style: Format"], "1.2.4"],
    [["test: Cover a case"], "1.2.4"],
    [["docs: Update documentation"], "1.2.4"],
    [["chore!: Drop a script"], "1.2.4"],
    [["docs: Update", "fix: Correct a defect"], "1.3.0"],
    [["fix: Correct a defect", "feat!: Break it", "chore: Tidy"], "2.0.0"],
    [["docs: Mention feat!: in prose"], "1.2.4"],
    [["Merge pull request #1", "wip: scratch", "update things"], null],
    [[], null],
  ] as const)
    expect(nextVersion("1.2.3", [...messages])).toBe(expected);
  expect(nextVersion("0.0.1", ["feat: Add a command"])).toBe("0.1.0");
  expect(nextVersion("0.0.1", ["feat!: Break the contract"])).toBe("1.0.0");
  expect(() => nextVersion("invalid", ["fix: Correct a defect"])).toThrow();
});

test("npm command success is not proof of a public, matching publication", async () => {
  const artifact = {
    name: "testing-agent",
    version: "0.0.1",
    gitHead: "revision",
    dist: { integrity: "sha512-expected" },
  };
  const verify = (body: unknown, status = 200) =>
    verifyNpmPublication("0.0.1", "revision", "sha512-expected", async () => Response.json(body, { status }));
  await expect(verify(artifact)).resolves.toBeUndefined();
  await expect(verify("version not found", 404)).rejects.toThrow("staged");
  await expect(verify({}, 503)).rejects.toThrow("not publicly available");
  await expect(verify({ ...artifact, version: "0.0.0-stage" })).rejects.toThrow();
  await expect(verify({ ...artifact, gitHead: "different" })).rejects.toThrow("different revision or artifact");
  await expect(verify({ ...artifact, dist: { integrity: "sha512-different" } })).rejects.toThrow(
    "different revision or artifact",
  );
});

test("release retries require the exact published revision and artifact", () => {
  const published = { gitHead: "revision", dist: { integrity: "sha512-expected" } };
  expect(() => assertPublishedArtifact(published, "revision", "sha512-expected")).not.toThrow();
  expect(() => assertPublishedArtifact(published, "other", "sha512-expected")).toThrow();
  expect(() => assertPublishedArtifact(published, "revision", "sha512-other")).toThrow();
  expect(() => assertPublishedArtifact({}, "revision", "sha512-expected")).toThrow();
});

test("an npm publication without its GitHub release blocks both older and newer revisions", () => {
  const initial = { "0.0.1": { gitHead: "initial" } };
  const featurePublishedFirst = { ...initial, "0.1.0": { gitHead: "feature-revision" } };
  expect(() => pendingRelease("0.0.1", featurePublishedFirst, "older-fix-revision")).toThrow("awaiting GitHub");
  expect(() => pendingRelease("0.0.1", featurePublishedFirst, "newer-revision")).toThrow("awaiting GitHub");
  expect(pendingRelease("0.0.1", featurePublishedFirst, "feature-revision")).toBe("0.1.0");
  const fixPublishedFirst = { ...initial, "0.0.2": { gitHead: "fix-revision" } };
  expect(() => pendingRelease("0.0.1", fixPublishedFirst, "newer-feature-revision")).toThrow("awaiting GitHub");
  expect(pendingRelease("0.0.1", fixPublishedFirst, "fix-revision")).toBe("0.0.2");
  expect(pendingRelease("0.0.2", fixPublishedFirst, "newer-feature-revision")).toBeUndefined();
  expect(pendingRelease(undefined, undefined, "first-revision")).toBeUndefined();
  expect(() => pendingRelease(undefined, { "0.0.0-stage": {} }, "other-revision")).toThrow("staged");
  expect(() => pendingRelease(undefined, {}, "other-revision")).toThrow("staged");
  expect(() => pendingRelease(undefined, initial, "other-revision")).toThrow();
  expect(() => pendingRelease("0.1.0", initial, "initial")).toThrow("baseline");
  const numericallySorted = { "0.0.9": { gitHead: "old" }, "0.0.10": { gitHead: "new" } };
  expect(pendingRelease("0.0.9", numericallySorted, "new")).toBe("0.0.10");
});

test("CI provisions native recording dependencies on both platforms before verification", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        verify: z.object({
          "timeout-minutes": z.number(),
          steps: z.array(
            z.object({ name: z.string().optional(), run: z.string().optional(), if: z.string().optional() }),
          ),
        }),
      }),
    })
    .parse(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()));
  expect(workflow.jobs.verify["timeout-minutes"]).toBe(30);
  const steps = workflow.jobs.verify.steps;
  const linux = steps.findIndex((step) => step.name === "Install ffmpeg on Linux");
  const macos = steps.findIndex((step) => step.name === "Install ffmpeg on macOS");
  const verify = steps.findIndex((step) => step.name === "Verify video recording tools");
  const checks = steps.findIndex((step) => step.run === "bun run check");
  expect(linux).toBeGreaterThanOrEqual(0);
  expect(macos).toBeGreaterThanOrEqual(0);
  expect(steps[linux]?.if).toBe("runner.os == 'Linux'");
  expect(steps[macos]?.if).toBe("runner.os == 'macOS'");
  expect(steps[linux]?.run).toContain("apt-get install --yes --no-install-recommends ffmpeg");
  expect(steps[macos]?.run).toContain("brew install ffmpeg");
  expect(verify).toBeGreaterThan(linux);
  expect(verify).toBeGreaterThan(macos);
  expect(checks).toBeGreaterThan(verify);
});

test("publishing is gated by both CI runners and restricted to main, never PRs", async () => {
  const workflow = z
    .object({
      on: z.object({
        pull_request: z.object({ branches: z.array(z.string()) }),
        push: z.object({ branches: z.array(z.string()) }),
      }),
      permissions: z.object({ contents: z.string() }),
      jobs: z.object({
        verify: z.object({ strategy: z.object({ matrix: z.object({ os: z.array(z.string()) }) }) }),
        release: z.object({
          needs: z.string(),
          if: z.string(),
          permissions: z.object({ contents: z.string(), "id-token": z.string() }),
          concurrency: z.object({ "cancel-in-progress": z.boolean() }),
        }),
      }),
    })
    .parse(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()));
  expect(workflow.on.pull_request.branches).toEqual(["main"]);
  expect(workflow.on.push.branches).toEqual(["main"]);
  expect(workflow.permissions.contents).toBe("read");
  expect(workflow.jobs.verify.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
  const release = workflow.jobs.release;
  expect(release.needs).toBe("verify");
  expect(release.if).toContain("github.ref == 'refs/heads/main'");
  expect(release.if).toContain("github.repository == 'g4rcez/testing-agent'");
  expect(release.if).toContain("github.event_name == 'push'");
  expect(release.if).toContain("needs.verify.result == 'success'");
  expect(release.permissions.contents).toBe("write");
  expect(release.permissions["id-token"]).toBe("write");
  expect(release.concurrency["cancel-in-progress"]).toBe(false);
  const source = await Bun.file(".github/workflows/ci.yml").text();
  expect(source).not.toContain("NODE_AUTH_TOKEN:");
  expect(source).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
  expect(source.indexOf("NPM_TOKEN: $")).toBeGreaterThan(
    source.indexOf("name: Publish npm package and GitHub release"),
  );
});
