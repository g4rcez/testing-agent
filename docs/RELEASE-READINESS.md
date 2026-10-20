# Release readiness

Scope: a local CLI and agent-browser plugin for AI-driven tests of ordinary HTML/ARIA web apps. agent-browser owns browser launch, sessions, evaluation, and artifacts. Jev/Laya choose only offered operations and targets. This release does not claim arbitrary-site success or a universal model accuracy guarantee.

## Work ledger

1. Completed: guarded node identity, visibility, enabled state, occlusion, form state, and one-use input receipts. Dropdowns bind the actual option node and reject changed values, replacement options, and newly disabled optgroups without emitting input. Duplicate option values select the observed option. Browser regressions reproduced the original failures before the fix.
2. Completed: deterministic final assertions, durable version-2 state, transactional ownership, cancellation, call/total deadlines, and real SIGKILL recovery checks.
3. Completed locally: CLI, JSON/JUnit reports, examples, MIT license, CI configuration, release/security documentation, and installed-tarball browser verification. The local release check passed 39 tests with 148 assertions, type checking, formatting, and builds; dependency audit reported no vulnerabilities. The browser suite also passed all 17 cases with agent-browser 0.32.1; the full check used 0.39.1. Hosted CI has not run because no remote is configured.
4. Completed for local Laya: all six acceptance cases passed in each of three repetitions, using the pinned checkpoint on MPS. [The final runtime receipt](evidence/live-laya-2026-10-20T20-06-22-487Z.json) records 18/18 runs and 36 model-selected actions for runtime commit `4f91770c70090208a6a60abe278ab5fafb76932b`. Decision-request latency was 65–338 ms, median 145 ms and p95 202 ms; this excludes browser startup/input/assertions. The receipt's dirty flag reflects earlier evidence files and review receipts; runtime source was unchanged throughout the run. Historical failed diagnostic receipts remain available. These local fixtures do not establish general website accuracy. Live Jev requires credentials that are not configured in this workspace.
5. Completed for runtime `4f91770c70090208a6a60abe278ab5fafb76932b`: [fresh review](evidence/runtime-review.md) returned APPROVE / GO — repository evidence only, with no remaining high or critical findings. The earlier dropdown blocker, ineffective unit assertion, and Bun minimum mismatch were corrected and verified. The remaining low finding, omitted README-linked package documentation, was corrected by including release, contributor, and evidence documents in the archive. Runtime source remains identical to the reviewed revision. Publication and unavailable external evidence are not approved by this result.

## Release gates

- Every completed test has independently evaluated assertions. Model DONE alone never passes a test.
- A replaced, hidden, disabled, covered, or semantically changed selected node cannot receive redirected input.
- Lost input acknowledgements never trigger automatic replay.
- A second process cannot take an active session lock; orphan recovery cannot clear a live lock.
- Call and total-test deadlines terminate pending model/browser work and leave persisted status.
- Real browser tests cover supported controls, async UI changes, navigation, cancellation, and process interruption.
- Installed-package help, invalid input, plugin manifest, happy path, reports, and exit codes work outside the repository.
- Live-model receipts identify model revision, app fixture, successful/failed outcomes, and measured timing boundaries.
- Unit/browser/package checks and applicable dependency checks pass. Unsupported or unavailable external evidence remains explicitly recorded.

Publishing to npm or creating a public remote is a separate external action. This workspace has no configured remote or registry publication target.
