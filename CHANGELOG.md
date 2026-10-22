# Changelog

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
