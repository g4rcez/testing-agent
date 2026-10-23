# Releasing testing-agent

## Policy

- PRs targeting `main` run checks only. They receive no npm publishing credentials.
- Pushes to `main` publish only after Linux and macOS verification succeeds, and only from `g4rcez/testing-agent`.
- Keep the existing `vX.Y.Z` GitHub tag history. The package/repository rename does not reset versions or rewrite `v0.0.1`, which published `agent-tester`.
- The rename is a patch: the next publication is `testing-agent@0.0.2` and GitHub `v0.0.2`.
- Later releases inspect all commits since the latest stable tag: `fix` increments patch, `feat` increments minor, and `!` or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer increments major. The highest increment wins. Other commit types do not publish.
- Version changes affect the release workspace only; there are no version-bump commits or CI loops. Tags and npm versions hold release history.
- Releases are serialized. Keep the legacy concurrency group identifier so renamed workflows also serialize against earlier runs.
- The release tags the exact source revision whose checks passed. npm publication with provenance and public-registry verification must succeed before GitHub Release creation.

## Package-name transition

The latest Git tag is still the version-planning baseline. The script reads that tag's `package.json` to identify which npm package it released.

If its name is exactly `agent-tester`, omit that version only from the **new npm package's reconciliation baseline**. The old npm versions are not expected to exist under `testing-agent`. An unexpected historical package name fails closed. After the first `testing-agent` tag exists, normal same-package reconciliation resumes.

HTTP 404 means the new npm package is absent. HTTP 200 with no stable versions, including a `0.0.0-stage` placeholder, is not absence: stop and resolve the pending publication before attempting another one. A stable npm publication awaiting GitHub completion can be repaired only from its original revision and identical archive.

## Publishing access

Use a short-lived granular npm token only for bootstrap. Set it privately:

```sh
gh secret set NPM_TOKEN --repo g4rcez/testing-agent
```

The token needs package publishing access and automated 2FA bypass. Never put it in a file or chat. The workflow exposes it only as `BOOTSTRAP_NPM_TOKEN` in the gated release step. Every child process strips both npm token variables by default.

Only `npm publish` can receive `NODE_AUTH_TOKEN`, and only when the registry returns 404 and either:

- there is no previous tag and the target is the initial `0.0.1`; or
- the previous tag is `v0.0.1`, its manifest names `agent-tester`, and the target is the authorized rename patch `0.0.2`.

Later publications and repair-only retries do not receive the bootstrap token, even if the secret still exists.

After bootstrap, configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) in the **testing-agent** package settings:

| Field                | Value                |
| -------------------- | -------------------- |
| Organization or user | `g4rcez`             |
| Repository           | `testing-agent`      |
| Workflow filename    | `ci.yml`             |
| Environment          | Leave blank          |
| Allowed actions      | Direct `npm publish` |

CI uses GitHub-hosted Ubuntu, Node 24, and `id-token: write`. npm requires Node 22.14.0+ and npm 11.5.1+. OIDC permission also supports provenance signing for token-authenticated bootstrap. GitHub Release access uses the separate job-scoped `GH_TOKEN` with `contents: write`.

Delete the GitHub bootstrap secret and revoke the granular npm token after the transition. Configure npm-side trust before the next release; the workflow cannot create that trust itself. After verifying OIDC publication, restrict traditional token publishing.

## Checks and evidence

Run `bun run check` and `bun audit` before pushing. CI uses the frozen Bun lockfile and explicit browser setup. Verification runners install system ffmpeg through Ubuntu apt or macOS Homebrew, then check availability before the full suite. This adds no npm dependency and installs nothing on contributors' machines. The verification budget is 30 minutes to include native downloads. Do not skip a platform, assertion, or package smoke check.

The package smoke test installs the archive into an isolated project, exercises all CLI aliases and the plugin, checks editor schemas, and runs a real Chromium test with default recording. Its scripted protocol fixture proves integration, not live-model accuracy. Live-model receipts and recordings must identify the actual backend and outcomes.

## Retry and recovery

After fixing authentication, rerun failed jobs on the **original workflow revision**. Do not bump the version to work around an authentication error. On `EOTP`, ask the maintainer to check token permissions or complete supported interactive authentication; do not disable account 2FA.

Before planning a publication, reconcile stable npm versions with Git tags. If npm succeeded but GitHub completion is pending, block every other revision until the original revision is repaired. Require matching `gitHead` and SHA-512 integrity before repairing a release. Never overwrite or unpublish an npm version or move `latest` backward.

A successful npm command alone is not proof that the intended version is publicly available. Registry propagation or staged approval can delay availability. Check the exact version's metadata, source revision, and archive integrity before GitHub creation. If the package is staged, use npm's **Staged Packages** tab or `npm stage list testing-agent` and review the result before requesting 2FA approval. An empty stage list is not evidence of failure: recheck the public registry. Do not restage while the original publication is pending.

Rollback by pinning a known-good version, then ship a fix through the same checks. Version 2 run-state files are not compatible with the early 0.1.0 prototype; preserve private state and start new runs when changing incompatible versions.
