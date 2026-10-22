# Releasing agent-tester

## Policy

- Pull requests targeting `main` run the complete checks on Linux and macOS. They cannot publish and receive no npm publishing credentials.
- Pushes to `main` run the same matrix. The `release` job in `.github/workflows/ci.yml` runs only after both runners pass, and only in `g4rcez/agent-browser-jev`.
- The first publication is `agent-tester@0.0.1`, regardless of earlier development versions.
- Later releases inspect all commit messages since the last stable `vX.Y.Z` tag. `fix:` or `fix(scope):` increments patch; `feat:` increments minor; any Conventional Commit header with `!`, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, increments major. The highest increment wins.
- Other commit types do not publish unless they declare a breaking change. Squash-merge PR titles must use Conventional Commits.
- Releases are serialized. The source revision is the exact `main` revision whose checks passed, not a later branch head. Version changes affect the published manifest only; tags and npm versions are the release history, without release-bump commits or CI loops.
- npm publication with provenance happens before GitHub Release creation. The GitHub release tags that source revision and includes the package archive and commit notes.

## Publishing access

For the first publication, a maintainer must configure a granular npm token with permission to publish `agent-tester` and bypass 2FA for automation. Set it as the repository secret `NPM_TOKEN`, without placing it in a file or chat:

```sh
gh secret set NPM_TOKEN --repo g4rcez/agent-browser-jev
```

The release job supplies this secret only to npm's `NODE_AUTH_TOKEN`. GitHub release access uses the job-scoped GitHub token with `contents: write`; npm provenance uses `id-token: write`.

After the package exists, prefer npm trusted publishing. In the npm package's settings, add a GitHub Actions trusted publisher for user `g4rcez`, repository `agent-browser-jev`, workflow **`ci.yml`**, with direct `npm publish` allowed. No GitHub environment is configured. Complete a successful publish within npm's trust configuration expiry period. After verifying OIDC publication, remove `NPM_TOKEN` and restrict traditional token publishing. Node 24 supplies the npm CLI needed for trusted publishing. See [npm's trusted publisher documentation](https://docs.npmjs.com/trusted-publishers).

The workflow fails closed when publishing authentication is unavailable. Never create a successful GitHub release to conceal a failed npm publication.

## Checks and evidence

Run `bun run check` and `bun audit` before pushing release changes. CI uses the frozen Bun lockfile, explicit browser setup, and an ffmpeg availability check. Do not skip a failing platform, assertion, or package smoke test to make a release green.

The package smoke test installs the packed artifact into an isolated temporary project, exercises all CLI aliases and the plugin, checks JSON/YAML schema references from the installed package, and runs a real Chromium test with default video recording. It uses a scripted protocol fixture; this proves package/controller integration, not model accuracy.

Live model acceptance remains separate: run the documented Laya/Jev cases only with an explicitly available backend and record actual model identity, outcomes, and timings. Historical GIFs and receipts do not prove a new revision's accuracy. Keep the current limitations in `docs/RELEASE-READINESS.md` visible.

## Retry and recovery

Use GitHub's **rerun failed jobs** on the original workflow when publication or GitHub release creation fails. A manual `workflow_dispatch` on `main` also runs both verification jobs before attempting release. Do not manually increment the version to work around an authentication failure.

Before a new publication, the script reconciles the highest stable npm version with the latest Git release tag. If npm publication succeeded but GitHub completion is pending, all other revisions are blocked until that original revision is repaired. This prevents an older workflow from moving npm `latest` backward or a newer workflow from skipping an incomplete release.

If npm already contains the target version, the script requires both its `gitHead` and archive SHA-512 integrity to match the rebuilt package. Only then can it repair a missing GitHub release. A version collision or different artifact stops publication. Fix the cause and rerun the original revision; do not overwrite or unpublish a release. An old workflow cannot release behind a newer tag.

Rollback by pinning a known-good npm version, then ship a Conventional Commit fix through the same checks. Version 2 run-state files are not compatible with the 0.1.0 prototype; preserve private state and start new runs when changing incompatible versions.
