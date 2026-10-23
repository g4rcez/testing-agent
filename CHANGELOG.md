# Changelog

## Unreleased

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
