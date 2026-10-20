# Production-impact code review

- Reviewed candidate: `a050c816fa12c06fd11c53405c061100b9099cec`
- Baseline: `3524fe9`
- codeQualityStatus: BLOCK
- recommendation: REQUEST_CHANGES
- Review mode: source-only; no tests executed and no production/test files modified. This report is the sole write required by the review protocol.
- Report location: fallback path because `omo-agent-toolkit ulw-loop status --json` returned `ULW_LOOP_PLAN_MISSING`.
- Notepad: none supplied or discovered in the candidate's tracked `.omo` tree.

## CRITICAL

None identified.

## HIGH

### H1: SELECT does not bind the observed option's identity and semantics

References: `src/page.ts:335`, `src/page.ts:341`, `src/page.ts:159`, `src/page.ts:447`.

The snapshot binds the select element, while the chosen option is retained only as a value and label in the candidate. Dispatch searches the current options for any enabled option with that saved value and assigns `node.value`. The guard includes the select's current value and surrounding text, but not the identity, values, labels-as-attributes, or enabled state of its unselected options.

Concrete source-derived failure sequence: render a select containing selected All and unselected Alpha(value=a), Beta(value=b); observe and choose Alpha; while inference is pending, swap only the two unselected option values; dispatch the saved choice. The current select value, node identity, labels/text, visibility, and page key are unchanged. The old value `a` now resolves to Beta, which is selected and receives input/change events. This violates the documented guard against semantic redirection without requiring a hostile page or hardware events. A related case is an optgroup becoming disabled: observation excludes disabled optgroups at line 445, but dispatch checks only `option.disabled` at line 337.

Required fix: bind and revalidate the actual observed option and its relevant semantics/enabled ancestry before selection; reject stale choices without emitting events. Add real-browser regressions for option value reassignment/replacement and newly disabled optgroups, checking selected option and event count.

Counter-evidence: node replacement, overlays, form-value changes, and direct disabled select state are guarded; the ordinary dropdown happy path is covered in `tests/browser/guards.test.ts:142`. These protections do not cover the sequence above. A final value assertion can also remain satisfied by the wrong labeled option, so final assertions are not a universal mitigation. No runtime reproduction was performed in this source-only review.

## MEDIUM

### M1: stale-decision test's no-input assertion cannot fail

References: `tests/unit/runner.test.ts:90`, `tests/unit/runner.test.ts:97`, `tests/unit/runner.test.ts:106`.

`executed` is initialized to zero and never modified, then asserted to equal zero. The fake executor always throws, so this assertion proves nothing about production input or recording behavior. Replace the dead assertion with relevant runner outcomes (for example no recorded action and cleared pending intent following stale rejection); retain actual no-input checks at the real browser guard boundary.

Counter-evidence: the rest of this test still checks successful continuation and decision count. Real-browser replacement and overlay tests exist. This is a localized false-confidence issue, not evidence that all stale handling is broken.

## LOW

### L1: declared minimum Bun version differs from documented/tested minimum

Reference: `package.json:25`; README install requirements specify Bun 1.3.14+, while engines allows >=1.3.0 and CI pins 1.3.14. Align the supported minimum or provide lower-version evidence. No concrete older-runtime failure was demonstrated, so this is nonblocking.

## Skill-perspective check

Ran the `omo:programming` and `omo:remove-ai-slops` perspectives after reading both SKILL.md files and the programming TypeScript reference. M1 violates both skills' prohibition on tautological tests. No deletion-only test, removal-only test, or pinned natural-language prompt wording was identified in the reviewed tests. The decision request test checks supplied task routing/context fields rather than authored prompt prose.

Production parsing occurs at real provider/browser/state/input boundaries; DOM normalization and extraction support observation and assertions rather than speculative plumbing. No unnecessary production parsing is raised as a finding. There are strict skill-style deviations (large page/runner modules, string operation types, a window-registry assertion, broad catches); these were examined for concrete impact rather than automatically elevated into release blockers. The DOM bridge's serialization requirement explains keeping its helpers within the bridge. H1 is the demonstrated semantic integrity gap.

## Evidence and scope limits

Inspected frozen source for page, assertions, browser, runner, store, CLI, decision, plugin, contracts, reports, packaging and CI configuration; reviewed changed unit tests and guard/recovery browser tests. Consulted candidate README, SECURITY, RELEASE-READINESS, initial Laya diagnostic, and Jev not-run receipt. The parent reports 35 passing tests, typecheck, formatting, build, installed-package browser smoke and clean audit; those commands were not rerun by this reviewer, and their logs were not supplied as review artifacts. No independent test-pass claim is made here. Later benchmark receipts were excluded.

Counter-evidence supporting the design: deterministic final assertions are mandatory; unknown input acknowledgement remains uncertain; live lock ownership is refused; requests use finite observed choices; browser calls use argument arrays and stdin; model redirects are rejected; password observations are redacted. Main-document-only assertions, synthetic events, unavailable hostile-page isolation, retained browser sessions, and loss of receipts on navigation are documented limitations rather than hidden guarantees.

Live Jev, hosted CI, and publication remain unverified external gates. Scripted provider success and one live Laya pass do not establish general model accuracy. Dynamic target semantics beyond the tested guard cases remain residual risk.

## Blockers

Resolve H1 and verify its real-browser regression before approving this frozen candidate. M1 should be corrected as a localized test-quality issue. Recommendation applies only to this repository candidate and is not approval of remote CI, registry publication, or provider accuracy.
