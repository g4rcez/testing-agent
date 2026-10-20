# Final production-impact code review

**Verdict: GO — repository evidence only.**

- codeQualityStatus: WATCH
- recommendation: APPROVE
- blockers: []
- Frozen base: `3524fe90243142d410f217028dbcf4f8f7929812`
- Frozen head: `4f91770c70090208a6a60abe278ab5fafb76932b`
- Scope: full baseline-to-head product change, with special scrutiny of the final dropdown fix, assertions, recovery, provider boundaries, CLI and packaging.
- Report: `.omo/evidence/final-production-code-review.md`; requested identical receipt: `artifacts/final-production-review.md`.
- ULW status returned `ULW_LOOP_PLAN_MISSING`, so the required fallback evidence path is used. No notepad was supplied or found; the prior review is `.omo/evidence/production-impact-code-review.md`.

This approves the bounded repository candidate. It does not approve publication or establish general production safety, arbitrary-site model accuracy, live Jev readiness, or hosted CI success.

## Findings by severity

### CRITICAL

None identified.

### HIGH

None remaining in the inspected candidate.

### MEDIUM

None identified with a concrete remaining correctness, regression, or needless-complexity failure for this goal.

### LOW

**L1 — Installed README links point to omitted documentation.** `package.json:26` excludes `docs/RELEASE-READINESS.md`, `docs/RELEASE.md`, and `CONTRIBUTING.md`, while `README.md:5`, `README.md:132`, and `README.md:138` link to them. An installed package consumer following those local links cannot read the readiness limits/release instructions/contribution guidance. The runtime and SECURITY.md remain available, so this is a nonblocking packaging documentation issue. Include those specific files or replace the links with valid published destinations before publication; do not include the entire evidence directory by accident.

## Failure trajectories

### Dropdown choice redirected after inference — refuted for the reported cases

Trigger: option values are swapped, an option is replaced, an optgroup becomes disabled, or two options share a value.

The final code saves the actual option reference (`src/page.ts:25`, `src/page.ts:417`), includes every option's identity/value/label/selection/enabled ancestry in the guard (`src/page.ts:173`), checks the guard before dispatch (`src/page.ts:240`), and selects the bound index rather than assigning an ambiguous value (`src/page.ts:347`). Value reassignment, replacement, and enabled-state mutation invalidate the saved guard; duplicate values retain the selected option identity. Browser regression tests at `tests/browser/guards.test.ts:101` and `tests/browser/guards.test.ts:119` assert selected label and zero input/change events on stale rejection. The inspected release log records the expanded suite passing. The prior HIGH finding is resolved for these paths. This is not a hostile-page isolation guarantee.

### Interrupted action silently replayed or reported passed — refuted for inspected recovery paths

Trigger: browser input is applied, but the worker dies before acknowledging it.

`src/runner.ts` persists pending intent before dispatch, refuses normal replay, records an action only from an existing execution receipt during explicit recovery, and marks unknown receipts uncertain. `src/store.ts` uses a transactional ownership lock and rejects live-owner takeover. `tests/browser/recovery.test.ts` kills a real worker after the input-applied signal, checks live-owner refusal, then verifies recovery and an actual click count of one. The recovery fixture supplies protocol choices; it does not claim model quality. Navigation can erase receipts and remains explicitly documented as uncertain.

### Model DONE creates a false pass without a frontend result — refuted for the supported assertion contract

`src/contracts.ts` requires root final assertions or a final-step assertion. `src/runner.ts` checks final assertions before setting completed; `src/assertions.ts` reads browser DOM state; `src/report.ts` refuses a passing JUnit result without nonempty passing assertions. The caller can still author a weak assertion that matches the initial page, and intermediate steps without assertions are model-verified. README explicitly describes this distinction. Assertion scope is the main document and synthetic-event support is bounded. No source path was found that turns unknown execution into a passing result automatically.

### Optional Laya service load/accuracy outside local fixtures — plausible

`tools/laya-server.py` binds loopback, uses a serialized model lock, and accepts concurrent HTTP threads. Local fixture receipts do not establish sustained-load capacity, timeout cancellation inside inference, or arbitrary-site accuracy. Requests already accepted by the Python service may continue inference after the client deadline. This is a residual operational limit of the optional local service, not an observed production incident. Keep it local and scoped to the documented testing workload; a shared service deployment needs separate capacity/cancellation evidence.

## Deterministic checks

- State migration/rollback: version-2 schema and incompatibility with 0.1.0 are documented in `docs/RELEASE.md`. Preserve state and start new runs after rollback. No database service migration is introduced.
- Endpoint/schema changes: plugin operation expansion and explicit deterministic-assertion requirement are visible in contracts and documented as the 0.2.0 candidate.
- Secrets/bindings: environment credentials remain explicit; provider redirects are rejected; password observations are redacted; secret field values require selector binding. No claim of isolation from hostile page scripts.
- Retry/deadline/concurrency: no automatic replay of uncertain input, finite action/decision budgets, call/total deadlines, and transactional ownership were inspected. Optional Python inference cancellation is bounded as above.
- Packaging: compiled Bun entry points, prepack build, peer dependency, and clean installed-package smoke are present. L1 remains.
- Runtime minimum: `package.json:24` now agrees with README and CI on Bun 1.3.14.
- Scope freshness: HEAD was rechecked at the end; runtime/test/tool/config diff against HEAD was empty. Only evidence files and `.omo` were dirty during the review.

## Skill-perspective check

Ran the requested `omo:remove-ai-slops` and `omo:programming` review perspectives after loading both SKILL.md files and the TypeScript reference. The production-impact-review skill was also consulted. This was a read-only assessment; cleanup/refactoring instructions were not executed.

The stale unit test now asserts real returned state (`actions` empty and `pendingAction` cleared), replacing the never-mutated local counter. The new option tests exercise browser behavior and can fail under the reported defects. No remaining deletion-only, requested-removal-only, tautological, implementation-constant-only, or natural-language prompt-pinning test was identified. Request-context tests cover routed structured task fields, not authored prose. Browser/model fixtures are distinguished from live model evidence.

DOM extraction/normalization serves observation, finite choices, stale guards, and assertions. Provider/state/browser parsing occurs at real trust boundaries. No speculative production extraction or needless abstraction is raised as a finding. Literal skill-style deviations remain: large page/runner modules, mutable state and string operation tags, a typed page-registry assertion, broad boundary catches, and existing Prettier tooling. The page bridge must serialize into the browser; error paths fail closed; these deviations were not elevated into invented runtime blockers. This is not blanket conformance to every stylistic rule in either skill.

## Inspected evidence and limits

- `artifacts/release-check.log`: typecheck, formatting, build, 39 passing tests / 0 failures / 148 assertions, and clean installed-package checks (help/schema/manifest/invalid input/real browser/JSON-JUnit/plugin host). I inspected the log and relevant test source; I did not rerun browser/model tests because the parent owned those active checks.
- `docs/evidence/live-laya-2026-10-20T20-06-22-487Z.json`: runtime SHA matches the frozen head, pinned model `cklxx/laya-browser@645cf366a2ae35f1086e8c20eff48f909bb49206`, agent-browser 0.39.1, 18/18 local fixture cases; every recorded terminal result is completed with passing assertions. Dirty-tree flag is true; runtime files were independently checked unchanged. This is local acceptance evidence, not production telemetry.
- Prior candidate review and final commit were compared directly. The prior review's verdict was not inherited.
- Parent additionally reports 17 passing browser tests / 93 assertions with agent-browser 0.32.1 and a clean dependency audit. Separate logs were not present in the inspected artifact directory, so these are attributed reports, not independently verified claims here.
- Live Jev is unavailable without its API key. Hosted macOS/Linux CI is unrun because no remote is configured. Publication owner/security contact/registry provenance remain release gates.
- Frozen `docs/RELEASE-READINESS.md` still says 35 tests and repeats/review pending; consolidate the newer receipts into that ledger after this review, without implying the external gates passed.
- No production telemetry or deployed consumer topology was supplied. No forecast is possible. Investigation stayed below the 30-action limit. No runtime source, tests, or configuration were changed.
