# agent-browser Jev/Laya tests

Create browser tests from a prompt and ordered instructions. **agent-browser controls the browser; Jev or Laya chooses the next action.** User-authored assertions determine whether a test passes.

This is the 0.2.0 release candidate. Supported execution targets are ordinary HTML/ARIA controls and open shadow roots on Chromium. Release evidence and remaining external gates are recorded in [release readiness](docs/RELEASE-READINESS.md).

## Install from source

Requires Bun 1.3.14+, agent-browser, and Chrome. The browser controller is a peer dependency.

```sh
bun install
bun run build
bunx agent-browser install
./bin/jev-test --help
```

The packaged entry points are `jev-test` and `agent-browser-plugin-jev`. Package smoke tests install the tarball into a separate project and exercise both entry points through a real browser. This repository is prepared for publication; registry and repository ownership must be configured before publishing.

## Write a test

```json
{
  "name": "Find a stay",
  "url": "http://localhost:3000",
  "prompt": "Search Lisbon, select Design and free cancellation, and open Casa Flora.",
  "backend": { "provider": "laya" },
  "steps": [
    {
      "instruction": "Enter Lisbon in Destination",
      "value": "Lisbon",
      "expect": { "selector": "[name=destination]", "value": "Lisbon" }
    },
    {
      "instruction": "Choose Design in Category",
      "expect": { "selector": "[name=category]", "value": "Design" }
    },
    {
      "instruction": "Enable free cancellation",
      "expect": { "selector": "[name=cancellation]", "checked": true }
    },
    {
      "instruction": "Submit Find stays",
      "expect": { "text": "1 matching stay" }
    },
    "Open Casa Flora"
  ],
  "expect": [
    { "text": "Applied filters: Lisbon / Design / cancellation enabled" }
  ]
}
```

Use your app's URL, controls, and expected outcomes. Save the definition as `stay.test.json`, then run:

```sh
./bin/jev-test validate stay.test.json
./bin/jev-test run stay.test.json --report-dir artifacts/results
```

The CLI automatically continues paused calls. It emits JSON and JUnit reports and returns exit code **0 only for a passed test**, 1 for failed/blocked/uncertain, 2 for invalid input, and 130 for cancellation. Total-test time includes browser startup, inference, input, and assertions.

The prompt and full step list are preserved in the request's task context. Each decision question focuses on the current instruction. Satisfied step assertions advance without another model call; known-unsatisfied assertions withhold DONE. Inputs still come from the selected decision backend. Root `expect` assertions, or an explicit final step expectation, are required. DONE alone cannot pass a test.

## Assertions

An assertion can combine `text` and an exact `url`, or use a test-authored CSS `selector` with `visible`, `value`, `checked`, or `count`. Element value/checked checks require exactly one match. A selector by itself requires one match. `visible: false` and `count: 0` can assert absence. Read-only assertion waits observe DOM/input/history events, bounded by `timeoutMs` (default 2000, maximum 10000).

Assertions query the main document; they do not pierce shadow roots. Choose an outcome that distinguishes the final screen from a matching label on an earlier screen.

## Decision backends

| Provider | Endpoint                                         | Credential environment                     |
| -------- | ------------------------------------------------ | ------------------------------------------ |
| Jev      | `TYPESAFE_BASE_URL` or `https://api.typesafe.ai` | `TYPESAFE_API_KEY`                         |
| Laya     | `LAYA_BASE_URL` or `http://127.0.0.1:8791`       | `LAYA_API_KEY` when the server requires it |

Both use POST `/v1/systemone`. Override `backend.baseUrl`, `backend.model`, or `backend.apiKeyEnv` in a definition, or choose `--backend jev|laya` on the CLI. Jev defaults to `jev-latest`; pin a model when reproducibility matters. There is no automatic backend switch.

An optional local service pins the browser-tuned Laya checkpoint and inference format:

```sh
uv run tools/laya-server.py
bun run test:live -- --backend laya
```

It binds to loopback and loads `cklxx/laya-browser@645cf366a2ae35f1086e8c20eff48f909bb49206`. Python and model weights are optional; they are not bundled into the JavaScript product. Model accuracy depends on the chosen checkpoint and workflow. Timestamped live receipts preserve actual successes and failures separately from scripted protocol tests.

## Field values

A step's `value` supplies an exact string. For secrets, use an environment variable and bind the field:

```json
{
  "instruction": "Fill the password",
  "valueFromEnv": "TEST_PASSWORD",
  "selector": "input[type=password]"
}
```

The executor rejects a selected field that does not match that binding. Password contents are redacted from model observations. Browser scripts and field values travel through the controller's stdin, not its process arguments.

To generate a missing field value, configure `textModel: { baseUrl, model, apiKeyEnv }` or `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`, and optionally `TEXT_MODEL_API_KEY`. This uses an OpenAI-compatible chat endpoint and accepts only a validated text value. Without an explicit value or text helper, TYPE_TEXT is not offered. Native dropdown options come from observed controls.

## agent-browser plugin

The repository config registers the plugin as `jev`. Supply an explicit session to reuse your app, or a URL to create an isolated session:

```sh
agent-browser plugin run jev agent.run --payload '{"session":"my-app","prompt":"Open details","backend":{"provider":"laya"},"steps":["Open details"],"expect":[{"text":"Details screen"}]}'
agent-browser plugin run jev agent.status --payload '{"runId":"RUN_UUID"}'
agent-browser plugin run jev agent.resume --payload '{"runId":"RUN_UUID"}'
agent-browser plugin run jev agent.cancel --payload '{"runId":"RUN_UUID"}'
agent-browser plugin run jev agent.recover --payload '{"runId":"RUN_UUID"}'
```

Plugin calls use at most 45 seconds because the host allows 60 seconds. Continue resume while status is paused; the CLI does this automatically. The payload's session is authoritative because the host's plugin envelope does not forward an outer session flag. For an installed package, configure its executable as the plugin command.

Runs persist under `.agent-browser-jev/` or `JEV_STATE_DIR`. Use the same directory for resume/recovery. Session ownership is transactional and refuses live-owner takeover. Recover checks browser execution receipts before confirming interrupted input; an absent receipt leaves the run uncertain and never triggers automatic replay. Navigation can destroy a document's receipt, so that case requires inspection. Browser sessions remain available for inspection.

Limits are `maxActions` (60), `maxStepDecisions` (20), `actionsPerCall` (20), `timeoutMs` (45000), and `totalTimeoutMs` (120000). Optional `minConfidence` is a provider-specific gate, not proof of correctness.

## Validation and scope

```sh
bun run check
bun audit
bun run test:live -- --backend laya --repeats 3
bun run test:live -- --backend jev --repeats 3
```

Checks cover types, builds, real Chromium controls, stale targets, overlays, secret-field binding, process-kill recovery, cancellation, deadlines, reports, and installation outside the repository. Scripted provider fixtures validate the protocol; only live runs measure model-driven outcomes. See [release instructions](docs/RELEASE.md) and [security boundaries](SECURITY.md).

The guarded DOM adapter runs through agent-browser's eval API and dispatches synthetic DOM events. It supports standard forms, common HTML/ARIA controls, navigation, scrolling, and open shadow roots. Widgets requiring trusted hardware events, frames, closed shadow roots, canvas input, uploads/downloads, and pop-up tabs are outside this release's execution contract. agent-browser remains the sole browser controller; no separate CDP or Playwright connection is used.

The page shares JavaScript globals with the adapter. Identity guards prevent accidental stale-node redirection; they are not a hostile-page sandbox. Use isolated sessions and apps you control. State files contain the test definition; reports omit typed values and API keys. See [SECURITY.md](SECURITY.md) before sharing artifacts.

MIT licensed. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
