# Release readiness

Scope: a local CLI and agent-browser plugin for AI-driven tests of ordinary HTML/ARIA web apps. agent-browser owns browser launch, sessions, evaluation, and artifacts. Jev/Laya choose only offered operations and targets. This release does not claim arbitrary-site success or a universal model accuracy guarantee.

## Work ledger

1. Completed: guarded node identity, visibility, enabled state, occlusion, form state, and one-use input receipts; replacement/overlay/field-state browser checks pass.
2. Completed: deterministic final assertions, durable version-2 state, transactional ownership, cancellation, call/total deadlines, and real SIGKILL recovery checks.
3. Completed locally: CLI, JSON/JUnit reports, examples, MIT license, CI configuration, release/security documentation, and installed-tarball browser verification. The local release check passed 35 tests, type checking, formatting, and builds; dependency audit reported no vulnerabilities. Hosted CI has not run because no remote is configured.
4. In progress: repeat live pinned Laya acceptance tests against the frozen candidate. All six cases passed once after earlier failures were diagnosed and retained. Live Jev requires credentials that are not configured in this workspace.
5. Pending: fresh production-impact review of the final frozen source revision.

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
