# Releasing

Run `bun install --frozen-lockfile` and `bun run check`. Run `bun audit` and investigate actionable runtime vulnerabilities. CI must pass on supported macOS/Linux runners. Keep Bun and agent-browser versions in the evidence record.

Run `bun run test:live -- --backend laya` against a pinned browser checkpoint. Run the same acceptance cases with `--backend jev` and configured `TYPESAFE_API_KEY`. Keep model identity, actual outcomes, inference timings, and total-test timing separate. A scripted provider proves protocol integration only. A failed live case remains a failed case; do not silently substitute a fixture or relax its assertions.

Review `docs/RELEASE-READINESS.md` and the current fresh review receipt. A release claim applies only to the tested control/workflow scope and exact revision. No amount of local checks establishes universal model accuracy.

Before publishing, configure the repository URL, package owner, and private security reporting. Verify the packed artifact with `bun run test:package`. The package includes source, the license, and compiled Bun entry points. Keep test data, model caches, credentials, profiles, and run artifacts out of the package.

Publish only after release approval and with registry provenance from the release environment. This workspace does not publish automatically. Roll back by pinning the previous package version. Version 2 run-state files are not compatible with the 0.1.0 prototype; preserve private state before changing versions and create new test runs after rollback.
