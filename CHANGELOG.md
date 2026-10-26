# Changelog

## Unreleased

- Speed up the local Laya model about 3×: four ONNX threads, a warm-up before ready, an exact-input answer cache with in-flight joining, and operation/target questions asked separately through `only` (answers verified identical; Wikipedia example decisions 6.2 s → 2.1 s on an M1). Run `bun run build` after updating: the `bin/` wrappers load `dist/`.
- Long lists of controls are no longer cut to what fits the local model's window: a target question with more than about 30 options is asked in groups of `backend.chunkSize` (default 25) and settled in a final round (`rounds` on the action); `chunkSize: 0` turns it off.
- Scrollable containers (lists, panels, dialogs) are reported as `SCROLL_DOWN` / `SCROLL_UP` targets with the controls they hide above and below; controls clipped out of a container are no longer offered as click targets. The model sees what each container hides, and the fast path scrolls the one container that holds the control a step names before clicking or typing.
- Dialogs no longer freeze a click: `alert`, `confirm` and `prompt` are answered by `browser.dialogs` (accept or dismiss, optional prompt text) and recorded on the action. New tabs and pop-ups are followed (`browser.tabs.follow`: `auto` or `never`), pop-ups that close themselves return to the opener, and a step can pick its tab with `tab: current | new | opener | <id>`; `TAB_NOT_FOUND` when it is not open.
- Add a deterministic fast path (`fastPath`, default on; `--no-fast-path`): steps the page makes unambiguous (type a value into a named field, press Enter, click a uniquely named control, choose a dropdown option, toggle a checkbox, scroll) are done without the model, `assume` statements of the form "The <field> box contains <value>" are read off the page, and a local Laya server is started only when a step actually needs the model. The Wikipedia example now passes in about 6 s with no model calls (it took about 100 s). Actions record `source` and `rule`.
- Text and `value` assertions now ignore case, accents, spacing, quotes and dashes by default (`caseSensitive: true` restores exact matching); URLs are compared after parsing (scheme and host ignore case, paths keep it). The same folding is used for assumption checks and option pruning, and `--backend LAYA` is accepted.
- Add `backend.laya` (`language`, `maxLen`, `headMaxLen`, `threads`, `revision`, `modelDir`), the matching `LAYA_*` variables and `setup laya` flags. `laya_config.json` can be edited to change the window and is never overwritten by the model download; a running server whose settings differ from the test's is reported as `BACKEND_CONFIG_MISMATCH`.
- Fix runs failing with `agent-browser eval failed or timed out` right after a fast Enter press on pages that navigate away (the live Wikipedia example failed 13 of 14 times): an assertion read that fails is retried up to three times, and the re-check of a fast step's expectation can no longer fail the run by itself.
- Start the local Laya server automatically when it is not running and stop it when the run ends (only if this run started it). Opt out with `--no-autostart`, `TESTING_AGENT_AUTOSTART=0` or `backend.autostart: false`; off in CI unless `TESTING_AGENT_AUTOSTART=1`. The plugin does not autostart.
- Failed, blocked and uncertain runs now report a `reasonCode` and a `debug` object (last decision with probabilities, last observation, counters, timings, backend/browser error details); JUnit failures carry the same.
- When the model answers BLOCKED before anything was tried on a step, scroll and ask again (`blockedRetries`, default 2).
- A refused connection to the model endpoint is reported as `BACKEND_UNREACHABLE` instead of a generic failure.
- Add `backend.timeoutMs` and `LAYA_TIMEOUT_MS` (default 60 s for Laya). A decision cut off by the call deadline now pauses the run instead of blocking it, a busy local model is retried, and the Wikipedia example allows five minutes.
- Add `videoFps` test field and `--video-fps 1-60` CLI flag to set the recording frame rate (default 60).

## 1.0.0

First stable release. Versions before 1.0.0 were pre-release.

- Format with oxfmt, lint with oxlint, and run both in CI.
- Use Bun APIs instead of `node:` equivalents where one exists.
- Release on every conventional commit type: `feat!` is major; `feat`, `refactor`, `ci`, `perf`, `fix` are minor; `build`, `chore`, `style`, `test`, `docs` are patch.

- Record test videos as MP4 (H.264) instead of WebM.
- Add `testing-agent setup [--manual]` to install missing dependencies per OS, and `testing-agent init [folder] [--yaml|--json]` to scaffold a tests folder.
- Replace the personal-site examples with one Wikipedia search flow (LLMs, IPv4, IPv6 and Spider-Man) that passes 8 of 8 steps on the local Laya backend, with a recorded GIF and receipt.
- Local Laya: fit long pages into the model's small window by pruning click targets to those matching the step and shedding the step list when needed; send only the current step's actions as history.
- Add `assume`: a plain-language statement about the page that completes a step when the model confirms it and the page shows its distinctive words, so flows need no selectors.
- Retry a page observation that fails while the page is still navigating.

## 0.0.2 — testing-agent

- Rename the npm package and GitHub repository to `testing-agent` without resetting the existing release history.
- Add the `testing-agent` command and keep all existing CLI and plugin aliases.
- Verify the exact public npm version, source revision, and archive integrity before creating its GitHub release.

## 0.0.1 — agent-tester

First publication under the `agent-tester` package name. Earlier entries describe development versions before this package was published.

- Add `agent-tester test` and preserve existing CLI and plugin entry points.
- Add selector-free, multi-step examples, browser configuration, default video recording, and JSON step/final results.
- Add a bundled JSON Schema and formatting-preserving `lsp` annotation for YAML and JSON.
- Check PRs without publishing; release npm packages and GitHub releases from green `main` builds using Conventional Commits.

## 0.2.0

- Accept `.yaml` and `.yml` CLI test definitions with the same validation and limits as JSON, using Bun's built-in YAML parser.
- Add YAML terminal/form examples and separate GitHub Star sign-in and authenticated examples, with real Laya GIFs for the terminal and signed-out GitHub workflows.
- Add a visible garcez.dev `ls` CLI demo, real-browser GIF recording, and guarded DOM terminal text/Enter support.
- Add a CLI for JSON test definitions, automatic continuation, JSON/JUnit reports, validation, and JSON Schema output.
- Require deterministic final assertions; model DONE alone cannot pass a test.
- Bind decisions to observed DOM nodes and reject changed, detached, hidden, disabled, or covered targets.
- Bind native dropdown options by identity, revalidate option semantics and disabled ancestry, and distinguish duplicate values.
- Add action receipts, transactional session ownership, explicit orphan recovery, cancellation, and total deadlines.
- Keep Jev and Laya on the System-1 decision contract and agent-browser as browser controller.
- Add browser interruption tests, package verification, an optional pinned local Laya service, and reproducible live-model checks.

Breaking changes: saved state format is version 2; 0.1.0 run files cannot be resumed. Tests need final `expect` assertions. Execution uses a guarded DOM adapter through agent-browser and supports ordinary HTML/ARIA controls; trusted-input-only widgets and frames are outside its scope.
