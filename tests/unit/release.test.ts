import { expect, test } from "bun:test";
import { z } from "zod";
import {
  nextVersion,
  assertPublishedArtifact,
  pendingRelease,
  assertOidcEnvironment,
} from "../../scripts/release.ts";

test("trusted publishing requires GitHub OIDC, not an npm token", () => {
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

test("first release is always 0.0.1", () => {
  expect(nextVersion(undefined, ["feat!: Initial implementation"])).toBe(
    "0.0.1",
  );
});

test("Conventional Commits choose the highest explicit release increment", () => {
  for (const [messages, expected] of [
    [["fix: Correct a defect"], "1.2.4"],
    [["fix(browser): Correct a defect", "feat: Add a command"], "1.3.0"],
    [["feat(cli)!: Change the command contract"], "2.0.0"],
    [["fix!: Change the error contract"], "2.0.0"],
    [["chore: Update\n\nBREAKING CHANGE: Change the protocol"], "2.0.0"],
    [["feat: Update\n\nBREAKING-CHANGE: Change the protocol"], "2.0.0"],
    [["docs: Update documentation", "Merge pull request #1"], null],
    [["docs: Mention feat: in prose"], null],
    [[], null],
  ] as const)
    expect(nextVersion("1.2.3", [...messages])).toBe(expected);
  expect(nextVersion("0.0.1", ["feat: Add a command"])).toBe("0.1.0");
  expect(nextVersion("0.0.1", ["feat!: Break the contract"])).toBe("1.0.0");
  expect(() => nextVersion("invalid", ["fix: Correct a defect"])).toThrow();
});

test("release retries require the exact published revision and artifact", () => {
  const published = {
    gitHead: "revision",
    dist: { integrity: "sha512-expected" },
  };
  expect(() =>
    assertPublishedArtifact(published, "revision", "sha512-expected"),
  ).not.toThrow();
  expect(() =>
    assertPublishedArtifact(published, "other", "sha512-expected"),
  ).toThrow();
  expect(() =>
    assertPublishedArtifact(published, "revision", "sha512-other"),
  ).toThrow();
  expect(() =>
    assertPublishedArtifact({}, "revision", "sha512-expected"),
  ).toThrow();
});

test("an npm publication without its GitHub release blocks both older and newer revisions", () => {
  const initial = { "0.0.1": { gitHead: "initial" } };
  const featurePublishedFirst = {
    ...initial,
    "0.1.0": { gitHead: "feature-revision" },
  };
  expect(() =>
    pendingRelease("0.0.1", featurePublishedFirst, "older-fix-revision"),
  ).toThrow("awaiting GitHub");
  expect(() =>
    pendingRelease("0.0.1", featurePublishedFirst, "newer-revision"),
  ).toThrow("awaiting GitHub");
  expect(
    pendingRelease("0.0.1", featurePublishedFirst, "feature-revision"),
  ).toBe("0.1.0");
  const fixPublishedFirst = {
    ...initial,
    "0.0.2": { gitHead: "fix-revision" },
  };
  expect(() =>
    pendingRelease("0.0.1", fixPublishedFirst, "newer-feature-revision"),
  ).toThrow("awaiting GitHub");
  expect(pendingRelease("0.0.1", fixPublishedFirst, "fix-revision")).toBe(
    "0.0.2",
  );
  expect(
    pendingRelease("0.0.2", fixPublishedFirst, "newer-feature-revision"),
  ).toBeUndefined();
  expect(pendingRelease(undefined, {}, "first-revision")).toBeUndefined();
  expect(() => pendingRelease(undefined, initial, "other-revision")).toThrow();
  expect(() => pendingRelease("0.1.0", initial, "initial")).toThrow("baseline");
  const numericallySorted = {
    "0.0.9": { gitHead: "old" },
    "0.0.10": { gitHead: "new" },
  };
  expect(pendingRelease("0.0.9", numericallySorted, "new")).toBe("0.0.10");
});

test("CI provisions native recording dependencies on both platforms before verification", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        verify: z.object({
          steps: z.array(
            z.object({
              name: z.string().optional(),
              run: z.string().optional(),
              if: z.string().optional(),
            }),
          ),
        }),
      }),
    })
    .parse(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()));
  const steps = workflow.jobs.verify.steps;
  const linux = steps.findIndex(
    (step) => step.name === "Install ffmpeg on Linux",
  );
  const macos = steps.findIndex(
    (step) => step.name === "Install ffmpeg on macOS",
  );
  const verify = steps.findIndex(
    (step) => step.name === "Verify video recording tools",
  );
  const checks = steps.findIndex((step) => step.run === "bun run check");
  expect(linux).toBeGreaterThanOrEqual(0);
  expect(macos).toBeGreaterThanOrEqual(0);
  expect(steps[linux]?.if).toBe("runner.os == 'Linux'");
  expect(steps[macos]?.if).toBe("runner.os == 'macOS'");
  expect(steps[linux]?.run).toContain(
    "apt-get install --yes --no-install-recommends ffmpeg",
  );
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
        verify: z.object({
          strategy: z.object({ matrix: z.object({ os: z.array(z.string()) }) }),
        }),
        release: z.object({
          needs: z.string(),
          if: z.string(),
          permissions: z.object({
            contents: z.string(),
            "id-token": z.string(),
          }),
          concurrency: z.object({ "cancel-in-progress": z.boolean() }),
        }),
      }),
    })
    .parse(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()));
  expect(workflow.on.pull_request.branches).toEqual(["main"]);
  expect(workflow.on.push.branches).toEqual(["main"]);
  expect(workflow.permissions.contents).toBe("read");
  expect(workflow.jobs.verify.strategy.matrix.os).toEqual([
    "ubuntu-latest",
    "macos-latest",
  ]);
  const release = workflow.jobs.release;
  expect(release.needs).toBe("verify");
  expect(release.if).toContain("github.ref == 'refs/heads/main'");
  expect(release.if).toContain("github.event_name == 'push'");
  expect(release.if).toContain("needs.verify.result == 'success'");
  expect(release.permissions.contents).toBe("write");
  expect(release.permissions["id-token"]).toBe("write");
  expect(release.concurrency["cancel-in-progress"]).toBe(false);
  const source = await Bun.file(".github/workflows/ci.yml").text();
  expect(source).not.toContain("NPM_TOKEN");
  expect(source).not.toContain("NODE_AUTH_TOKEN");
  expect(await Bun.file("scripts/release.ts").text()).not.toContain(
    "NODE_AUTH_TOKEN",
  );
});
