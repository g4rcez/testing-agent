# testing-agent reference

Start with the [three-step first test](../README.md#first-test).

## From source

```sh
bun install
bun run build
bunx --no-install agent-browser install
uv run tools/laya-server.py
```

In another terminal:

```sh
./bin/testing-agent test examples/garcez-blog.yaml
```

Bun 1.3.14+, Chrome, agent-browser, and ffmpeg are required. The optional local Laya service needs Python 3.11+ and uv. Install missing tools manually. The package includes the service script, not its Python dependencies or model weights.

## Test definitions

JSON and YAML (`.yaml` / `.yml`, case-insensitive) share the same fields, overrides, limits, and reports. Bun parses YAML; no YAML dependency is needed. Quote numeric/boolean-looking strings when you mean text. YAML does not interpolate `${...}` environment variables.

```sh
testing-agent validate test.yaml
testing-agent schema
testing-agent test test.yaml --backend laya --report-dir artifacts/my-test
```

A test needs a prompt, ordered steps, a backend, and a URL or existing session. Use root `expect` assertions or an explicit final step `expect`. Model DONE alone cannot pass. Each step can provide `instruction`, exact `value`, and `expect`. Satisfied step assertions advance without another model call; known-unsatisfied assertions withhold DONE.

CLI overrides include `--backend jev|laya`, `--url`, `--session`, and `--report-dir`. `jev-test run` remains an alias for `testing-agent test`. Existing commands and plugin protocol stay compatible.

## Assertions

Each assertion can combine visible `text` and an exact `url`. Text checks collapse whitespace and are case-sensitive. Choose outcomes that distinguish the new state from labels already present on an earlier screen.

For element checks, a test-authored CSS `selector` can be combined with `visible`, `value`, `checked`, or `count`. Element value/checked checks require exactly one match. A selector alone requires one match. Use `visible: false` or `count: 0` to assert absence.

`timeoutMs` defaults to 2000 and can be at most 10000. Assertion waits observe DOM, input, and history events. Assertions inspect the main document; they do not pierce shadow roots.

## Browser configuration

Use long agent-browser option names without `--`. The installed `agent-browser --help` is the authority for supported options.

```yaml
browser:
  args:
    headed: true
    color-scheme: light
  env:
    AGENT_BROWSER_DEFAULT_TIMEOUT: "10000"
```

Strings supply values; `true` enables flags, `false` disables boolean options, and lists repeat an option. Options can select profiles, extensions, proxies, a browser executable, and other trusted settings. Keep the test's `session` separate; `browser.args.session` and `browser.args.json` are rejected because the runner manages session selection and JSON transport.

Session precedence: CLI `--session`, top-level YAML `session`, YAML `browser.env.AGENT_BROWSER_SESSION`, inherited `AGENT_BROWSER_SESSION`, then an isolated generated session. Agent-browser applies its normal config-file/environment/flag precedence.

`browser.env` supports the documented `AGENT_BROWSER_*`, selected `BROWSER_USE_*`, `OBSCURA_ALLOW_PRIVATE_NETWORK`, and standard proxy variables. It applies only to browser subprocesses. Test files cannot change `AGENT_BROWSER_BIN`; set it in the process environment if needed.

Only run trusted definitions: browser settings can load profiles, extensions, scripts, and plugins. Do not store credentials in YAML or browser flags. Browser settings remain in private state and are not printed in results. Videos can contain sensitive page content.

## Results and recording

The CLI automatically resumes paused calls and prints one JSON result. It writes JSON/JUnit reports and returns:

| Exit code | Meaning |
| --- | --- |
| `0` | Passed |
| `1` | Failed, blocked, or uncertain |
| `2` | Invalid input |
| `130` | Cancelled |

Results contain `steps`, `passed`, final `assertions`, `reason`, `video`, elapsed time, actions, and report paths. Steps expose `status`, `success`, and whether verification used an `assertion` or the `model`. Model verification is not independent proof; add an `expect` for important outcomes. Unvisited steps are skipped. Final assertions can fail even if every step passed.

CLI runs record WebM by default and require ffmpeg. Videos live in `.agent-browser-jev/videos/<run-id>.webm`, or under `JEV_STATE_DIR`. Recording spans pauses and is finalized on terminal completion. Recording failure prevents success. A separate bounded 12-second cleanup budget applies even after cancellation/deadline. `--report-dir` changes report paths, not video paths. Plugin runs record only with `recordVideo: true`.

State, reports, and videos persist; remove them when no longer needed. Never mutate a session concurrently with a test. Abrupt termination cannot finalize video. Recovery reconciles receipts but does not resume input after recording has ended; start a new test for a complete video. Close only your own sessions:

```sh
agent-browser --session YOUR_SESSION close
```

## Decision backends

| Backend | Default endpoint | Credential |
| --- | --- | --- |
| Laya | `http://127.0.0.1:8791` or `LAYA_BASE_URL` | Optional `LAYA_API_KEY` |
| Jev | `https://api.typesafe.ai` or `TYPESAFE_BASE_URL` | `TYPESAFE_API_KEY` |

Both use POST `/v1/systemone`. Override `backend.baseUrl`, `backend.model`, or `backend.apiKeyEnv` in the definition. There is no automatic provider switch. Jev defaults to `jev-latest`; pin a model for reproducibility.

The local service pins `cklxx/laya-browser@645cf366a2ae35f1086e8c20eff48f909bb49206`, binds to loopback, and uses the installed Python runtime. Successful source runs are not installed-package verification. Scripted fixtures prove protocol integration, not model accuracy.

## Values and secrets

Use a step's `value` for exact nonsecret text. For secrets, bind the intended field and supply the value through the environment:

```yaml
instruction: Fill the password
selector: input[type=password]
valueFromEnv: TEST_PASSWORD
```

The selected field must match the binding. Password values are redacted from observations. Browser scripts and field values travel through stdin, not process arguments. Saved state still contains the test definition; keep it private.

To generate missing text, configure `textModel: { baseUrl, model, apiKeyEnv }` or `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`, and optional `TEXT_MODEL_API_KEY`. The helper uses an OpenAI-compatible endpoint and returns validated text. Without an explicit value or helper, TYPE_TEXT is not offered.

## Editor schemas

`testing-agent lsp file.yaml` puts a YAML language-server directive on the first line. For JSON, it puts `$schema` first. The reference is relative to the installed bundled schema and works offline.

The command preserves formatting, BOM, line endings, YAML comments, JSON numeric spellings, and final newline. It updates existing references without duplication. JSON must be a valid object; YAML can be unfinished. Only YAML's leading comment header is edited; directive-like scalar content is untouched. Run it again after moving a file or changing the installation path.

The schema is generated from the CLI contract with `bun run schema:generate`, also run during builds. Do not edit generated schema directly. Editor validation cannot replace CLI/runtime cross-field checks.

## Plugin and recovery

The legacy `agent-browser-plugin-jev` executable and `jev` plugin remain supported:

```sh
agent-browser plugin run jev agent.run --payload '{"url":"https://example.com","prompt":"Open details","backend":{"provider":"laya"},"steps":["Open details"],"expect":[{"text":"Details"}]}'
agent-browser plugin run jev agent.status --payload '{"runId":"RUN_UUID"}'
agent-browser plugin run jev agent.resume --payload '{"runId":"RUN_UUID"}'
agent-browser plugin run jev agent.cancel --payload '{"runId":"RUN_UUID"}'
agent-browser plugin run jev agent.recover --payload '{"runId":"RUN_UUID"}'
```

Supply `session` in the payload to reuse a manually prepared browser. Plugin calls last at most 45 seconds; resume while paused. The CLI does that automatically. Use the same `JEV_STATE_DIR` across resume/recovery. Transactional ownership prevents live-owner takeover. An absent execution receipt leaves interrupted input uncertain and never causes blind replay.

Defaults: `maxActions: 60`, `maxStepDecisions: 20`, `actionsPerCall: 20`, per-call `timeoutMs: 45000`, and `totalTimeoutMs: 120000`. Maximum total time is 30 minutes. Time includes startup, recording, inference, input, and assertions. Optional `minConfidence` is provider-specific, not proof of correctness.

## Existing recordings and development checks

The [three-step blog receipt](evidence/garcez-blog.json) and [video](assets/garcez-blog.webm) show a real **blocked** local Laya attempt against the current definition. Its assertions were not weakened to produce a pass.

The older [terminal GIF](assets/garcez-ls.gif) and [signed-out GitHub GIF](assets/github-star-sign-in.gif) are historical real-model evidence. Their receipts are in `docs/evidence/`; they do not verify the current definitions or renamed repository. The signed-out GitHub demo reaches sign-in, not a successful star. Never record credential entry.

With the local backend running, `bun run demo:garcez -- --record` and `bun run demo:github -- --record` run the source demos and capture real screenshot frames. These helpers leave their named browser open and print a close command. The authenticated Star example changes account state and has not been live-verified.

```sh
bun run check
bun audit
bun run test:live -- --backend laya --repeats 3
```

The full check covers types, build, unit/browser tests, and isolated npm-archive installation including actual video and plugin execution. Live-model runs remain a separate, environment-dependent check. See [security boundaries](../SECURITY.md) and [release readiness](RELEASE-READINESS.md).
