# testing-agent reference

Start with the [Wikipedia first test](../README.md#first-test).

## From source

```sh
bun install
bun run build
bunx --no-install agent-browser install
./bin/testing-agent setup laya
```

In another terminal:

```sh
./bin/testing-agent test examples/wikipedia-search.yaml
```

Bun 1.3.14+, Node.js 20+, Chrome, agent-browser, and ffmpeg are required. Run `testing-agent setup` to install missing tools for your OS (Homebrew, apt/dnf/pacman/apk/zypper, or winget); `testing-agent setup --manual` only prints the commands. The optional Node Laya backend needs no Python. Its model weights are downloaded only by explicit setup, not by a test command. Use `ONNXRUNTIME_NODE_INSTALL=skip` with npm installation to skip unused CUDA downloads; the backend uses CPU inference.

## Test definitions

JSON and YAML (`.yaml` / `.yml`, case-insensitive) share the same fields, overrides, limits, and reports. Bun parses YAML; no YAML dependency is needed. Quote numeric/boolean-looking strings when you mean text. YAML does not interpolate `${...}` environment variables.

```sh
testing-agent validate test.yaml
testing-agent schema
testing-agent test test.yaml --backend laya --report-dir artifacts/my-test
```

A test needs a prompt, ordered steps, a backend, and a URL or existing session. Use root `expect` assertions or an explicit final step `expect`. Model DONE alone cannot pass. Each step can provide `instruction`, exact `value`, and `expect`. Satisfied step assertions advance without another model call; known-unsatisfied assertions withhold DONE.

CLI overrides include `--backend jev|laya`, `--url`, `--session`, `--video-fps 1-60`, and `--report-dir`. `jev-test run` remains an alias for `testing-agent test`. Existing commands and plugin protocol stay compatible.

## Assertions

Each assertion can combine visible `text` and a `url`. Text and element `value` checks ignore case, accents, repeated whitespace, typographic quotes and dashes, and zero-width characters, so `find a stay` matches `Find a STAY`; set `caseSensitive: true` on an assertion to compare case and accents (whitespace is still collapsed). The `url` is compared after URL parsing: scheme and host ignore case, the path and query do not. Choose outcomes that distinguish the new state from labels already present on an earlier screen.

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

| Exit code | Meaning                       |
| --------- | ----------------------------- |
| `0`       | Passed                        |
| `1`       | Failed, blocked, or uncertain |
| `2`       | Invalid input                 |
| `130`     | Cancelled                     |

Results contain `steps`, `passed`, final `assertions`, `reason`, `video`, elapsed time, actions, and report paths. Steps expose `status`, `success`, and whether verification used an `assertion`, the page itself (`deterministic`), an `assumption` or the `model`; each action records its `source` (`model`, `fast` or `deterministic`) and, for fast actions, the `rule`. Model verification is not independent proof; add an `expect` for important outcomes. Unvisited steps are skipped. Final assertions can fail even if every step passed.

### Long lists of controls

The local model's window holds about 30 options for one question, and the server drops the rest by how few words they share with the goal. When a target question has more options than that, `backend.chunkSize` (default 25, `0` turns it off) splits them into groups in page order, asks about each group on its own, and then asks one more question among the group winners. Probabilities from different groups are never compared with each other; only the final round's decide the answer and are checked against `minConfidence`. Up to six groups are asked (150 controls), and the action records `rounds`. A decision takes one operation pass plus one pass per group plus the final one, so a 60-control page costs about four target passes instead of one. Shorter lists are asked exactly as before. In one check on a 29-control page the grouped and single answers chose the same control, which is why grouping only starts above the window size.

### Scrollable containers

A list, side panel or dialog that scrolls on its own hides controls even when the page itself does not scroll. The observation reports each visible scrollable container as a target of `SCROLL_DOWN` / `SCROLL_UP` (its label is its `aria-label`, a heading inside or just before it, or `Scrollable list #id`), with how far it is scrolled and how many controls are out of view above and below, with their labels. Controls clipped out of a container are not offered as click targets, because they cannot be clicked until the container scrolls. When at least one container can scroll, the page itself is offered as one more target named `Page`.

The model sees each container as, for example, `Countries (scrollable, 20% scrolled; 7 below: Spain, Sweden, Switzerland, Turkey, ...; 3 above: Albania, Austria, Belgium)`, so the words of what it is looking for can match what a container hides, and it scrolls that container by choosing the operation and then the target. Scrolling moves a container by 80% of its height. The fast path does the same without the model: `Click Item 30` or `Type x into the Price field` scrolls the one container that hides a control with that label (up to 15 scrolls per step) and then acts; `Scroll down the Results list` names a container, and a bare `Scroll down` means the page. If two containers hide the same label, or the label is in none of them, the model decides. Horizontal scrolling is not covered.

### Dialogs, new tabs and pop-ups

`alert`, `confirm` and `prompt` would freeze the click that raised them, so the runner answers them inside the page: `browser.dialogs` is `{ policy: accept | dismiss, promptText }` (default `accept`; `accept` returns `true` for a confirm and `promptText`, else the prompt's default text, for a prompt; `dismiss` returns `false` / `null`). What was asked is recorded in the action's `dialogs`.

A click or Enter that opens a tab or pop-up (`target=_blank`, `window.open`) is noticed because the page reports it, and the runner waits up to two seconds for the tab. `browser.tabs.follow` decides what happens next: `auto` (default) keeps working in the new tab, `never` switches back to the opener. A pop-up that closes itself (`window.close()`) returns control to its opener. A step can choose its tab with `tab`: `current` (default), `new` (the latest tab opened), `opener` (the first tab) or a tab id or label such as `t2`; it is chosen once, when the step starts, and `expect` assertions run in whichever tab is active. A step that names a tab that is not open fails with `TAB_NOT_FOUND`. Recovery switches to the tab an interrupted action ran in before reading its receipt, and the saved run state remembers the opener, the known tabs and the newest one. Tab tracking is best-effort: if `agent-browser` cannot list tabs, the run carries on without it. The model is not offered tab operations, and video recording across tabs has not been verified.

### Fast path

`fastPath` (default `true`; `--no-fast-path` on the command line) lets the runner settle a step from the observed page before it asks the model. The rules, tried in this order, each need exactly one matching control (an exact label first, then a label containing every word of the instruction's phrase; ambiguity never falls back to a looser match):

| Rule        | Instruction looks like                                                             | Action                                                                       |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| scroll      | `Scroll down` / `Scroll up`                                                        | the scroll, then done                                                        |
| type        | `Type X into the <field> box` / `Fill in the <field> field with X`, with a `value` | `TYPE_TEXT`; done once the field shows the value                             |
| press-enter | `Press Enter` (in the <field> box)                                                 | `PRESS_ENTER` in the named field, the field just typed into, or the only one |
| select      | `Select <option> as the <field>`                                                   | `SELECT`; done once the field shows the option                               |
| toggle      | `Enable` / `Disable <checkbox>`                                                    | `CLICK` if the state differs, done if it already matches                     |
| click       | `Click` / `Open` / `Submit` / `Follow <label>`                                     | `CLICK` (a trailing role word such as `button` or `link` is ignored)         |

Steps with a `selector`, with words such as `if`, `unless`, `not`, `never`, `only`, `without`, `already`, `until` or `or`, or with an instruction the rules do not recognise, go to the model. A fast action is tried once per step; if the page does not change as expected the model takes over. A step that only needs `value` typed is finished by the page (`verification: deterministic`), and `assume: "The <field> box contains <value>"` is checked on the page too. Clicks without an `expect` still ask the model whether the step is done.

When no step needs the model, a local Laya server that autostart would have launched is never started.

A run that does not complete explains itself. `reasonCode` is a stable identifier next to the human `reason` (`MODEL_BLOCKED`, `MODEL_BLOCKED_NO_SCROLL`, `BACKEND_TIMEOUT`, `BACKEND_UNREACHABLE`, `BACKEND_HTTP`, `BACKEND_INVALID_RESPONSE`, `LOW_CONFIDENCE`, `NO_PAGE_CHANGE`, `STEP_DECISION_BUDGET`, `ACTION_BUDGET`, `CALL_DEADLINE`, `TOTAL_DEADLINE`, `DONE_ASSERTION_FAILED`, `FINAL_ASSERTION_FAILED`, `STALE_OBSERVATION`, `STALE_TARGET`, `BROWSER_COMMAND_FAILED`, `INPUT_ACK_INTERRUPTED`, `INPUT_RECEIPT_MISSING`, `VIDEO_*`, `CANCELLED`, `INTERNAL`), and `debug` holds the last decision (operation, target, confidence, the most likely options and their probabilities, whether the model chose it, inference time), the last observation (URL, title, number of targets per operation, offered controls, a 400-character page excerpt), counters, timings, the backend or browser error with its details, and the failing assertion checks. The failed step carries the same codes, the JSON report includes all of it, and the JUnit failure body prints it. Page excerpts can contain page content; treat reports like logs.

If the model answers BLOCKED before anything was tried on a step, the runner scrolls (down, otherwise up) and asks again, up to `blockedRetries` times (default 2, at most 5; `0` disables it). Those scrolls are recorded as actions with `source: "deterministic"`.

CLI runs record MP4 (H.264) by default and require ffmpeg. `videoFps` (or `--video-fps`, integer 1-60, default 60) sets the frame rate; higher values only smooth motion the browser actually renders. Videos live in `.agent-browser-jev/videos/<run-id>.mp4`, or under `JEV_STATE_DIR`. Recording spans pauses and is finalized on terminal completion. Recording failure prevents success. A separate bounded 12-second cleanup budget applies even after cancellation/deadline. `--report-dir` changes report paths, not video paths. Plugin runs record only with `recordVideo: true`.

State, reports, and videos persist; remove them when no longer needed. Never mutate a session concurrently with a test. Abrupt termination cannot finalize video. Recovery reconciles receipts but does not resume input after recording has ended; start a new test for a complete video. Close only your own sessions:

```sh
agent-browser --session YOUR_SESSION close
```

## Decision backends

| Backend | Default endpoint                                 | Credential              |
| ------- | ------------------------------------------------ | ----------------------- |
| Laya    | `http://127.0.0.1:8791` or `LAYA_BASE_URL`       | Optional `LAYA_API_KEY` |
| Jev     | `https://api.typesafe.ai` or `TYPESAFE_BASE_URL` | `TYPESAFE_API_KEY`      |

Both use POST `/v1/systemone`. Override `backend.baseUrl`, `backend.model`, or `backend.apiKeyEnv` in the definition. `backend.timeoutMs` (or `LAYA_TIMEOUT_MS` for Laya) bounds one decision request: 60 s for Laya, whose model runs on the CPU, and 15 s for Jev. A request that is still waiting when the call deadline passes pauses the run for `resume` instead of failing it, and a busy local model is retried until the deadline. There is no automatic provider switch. Jev defaults to `jev-latest`; pin a model for reproducibility.

### Optional local setup

### Laya model settings

The model window and a few runtime options can be set in the test file and are handed to the server a test starts:

```yaml
backend:
  provider: laya
  laya:
    language: en # "en" is the English checkpoint; any other name is a bundle subfolder, e.g. multilingual
    maxLen: 512 # model window in tokens (max_len)
    headMaxLen: 192 # tokens reserved for the question and its options (head_max_len)
    threads: 4 # ONNX intra-op threads
    # revision: <hf revision>   # default: the pinned one
    # modelDir: /path/to/bundle # a bundle you exported yourself; nothing is downloaded
```

The same settings are the `LAYA_LANGUAGE`, `LAYA_MAX_LEN`, `LAYA_HEAD_MAX_LEN`, `LAYA_THREADS`, `LAYA_REVISION` and `LAYA_MODEL_DIR` environment variables, and the `--language`, `--max-len`, `--head-max-len`, `--threads`, `--revision` and `--model-dir` flags of `testing-agent setup laya` (flags win over the environment, which wins over the file). Anything left unset comes from `laya_config.json` in the model cache (`~/.cache/receptron-laya/receptron--laya-onnx/<revision>/`, or `$LAYA_CACHE`). You can edit `max_len` and `head_max_len` there: the server never overwrites that file, even though the runtime's downloader replaces cached files whose size differs from the published one (a copy of your file is kept aside while the download check runs, so an interrupted start cannot lose it). `head_max_len` cannot exceed `max_len`. A larger window than the model was trained on (512) can lower accuracy and slows every decision.

A server that is already running keeps the settings it started with. If a test asks for a different `language`, `revision`, `maxLen` or `headMaxLen`, it stops before opening a browser with `BACKEND_CONFIG_MISMATCH` and the command that starts a matching server; `/health` reports the settings in use. Only the English checkpoint is published for the pinned revision today, so another `language` needs a bundle you export (`export_onnx.py` in the Laya repository) and point `modelDir` at.

`testing-agent test` starts this server automatically when nothing answers on the configured local address, and stops it again when the run ends if it started it; the progress lines go to stderr so stdout stays the single JSON result (`LAYA_START_TIMEOUT_MS` bounds the wait, 15 minutes by default; a custom local `backend.baseUrl` port is passed on to the server). To keep one running yourself, run `testing-agent setup laya` in a separate terminal. It uses optional `@receptron/laya@0.2.0` and pins `receptron/laya-onnx@d42786bdff8a7550316339c5fbf8f46caa83ea1b`. First setup downloads about 1.7 GB; allow at least 2 GB RAM. The cache is under `~/.cache/receptron-laya` by default (`LAYA_CACHE` can override it). Keep the process running after `"ready": true`; Ctrl+C stops its HTTP service and releases the model. No inference runs during setup.

The service binds only to `127.0.0.1:8791`. `LAYA_PORT` changes its port; configure the same port in `LAYA_BASE_URL` or `backend.baseUrl` for tests. Optional `LAYA_API_KEY` protects inference requests. Browser-origin and invalid-host requests are rejected. Requests are limited to 1 MB, at most eight choice questions with 200 choices each, and one active request; there is no inference queue, so a different request gets HTTP 503 while one runs (the client retries until its deadline). An identical request body is answered from a 64-entry cache, or joins the run already computing it, so a retry after a timeout or a repeat run on an unchanged page costs nothing. The server runs a full-size warm-up request before it reports ready. An optional `only` list of question names answers just those questions while sizing the page text for all of them, so each answer is identical to the one in a full request; the client asks for the operation first and for a target only when the chosen operation takes one. Each question is a separate pass through the model, which is why this cuts a decision from about 6 s to about 2 s on an Apple M1.

The adapter preserves every offered choice and maps the model's probabilities back to the original IDs without adding confidence. It preserves the current instruction, full task, decision rules, field values, and recent actions within the pinned model's token budget. Only page text can be shortened, with a truncation marker. Required context that cannot fit is rejected, not silently discarded. Finite model context and model accuracy remain limits; a reachable service does not guarantee a passing test.

The optional runtime can be omitted for Jev-only installations with `npm install --omit=optional`. Ordinary commands load no model and do not fetch weights. If the optional dependency is missing, `setup laya` asks for installation rather than installing it itself.

The existing Python alternative remains available with `uv run "$(npm root -g)/testing-agent/tools/laya-server.py"` (Python 3.11+ and uv required). It pins `cklxx/laya-browser@645cf366a2ae35f1086e8c20eff48f909bb49206`; its model and adapter differ from the Node backend.

Before `test`/`run`, the CLI checks backend configuration and performs a bounded, non-generating GET to `/v1/systemone`. It refuses redirects and hides transport details. A POST-only endpoint may return 400, 404, 405, or 501; those establish reachability, not model readiness or valid inference credentials. Configuration, connection, and other HTTP failures return JSON setup guidance on stderr with exit code 1 before browser or run-state creation. `validate`, status, and recovery remain usable without an online model.

Successful source runs are not installed-package verification. Scripted fixtures prove protocol integration, not model accuracy.

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

The [Wikipedia receipt](evidence/wikipedia-search.json) and [video](assets/wikipedia-search.mp4) show a real **passing** source CLI run with the optional Node Laya backend: 8 of 8 steps, one model decision each, with URL and page-text assertions after every search, `assume` checks after each typing step, and no selectors.

The older [signed-out GitHub GIF](assets/github-star-sign-in.gif) is historical real-model evidence. Its receipt is in `docs/evidence/`; it does not verify the current definition or renamed repository. The signed-out GitHub demo reaches sign-in, not a successful star. Never record credential entry.

With the local backend running, `bun run demo:wikipedia -- --record` and `bun run demo:github -- --record` run the source demos and capture real screenshot frames. These helpers leave their named browser open and print a close command. The authenticated Star example changes account state and has not been live-verified.

```sh
bun run check
bun audit
bun run test:live -- --backend laya --repeats 3
```

The full check covers types, build, unit/browser tests, and isolated npm-archive installation including actual video and plugin execution. Live-model runs remain a separate, environment-dependent check. See [security boundaries](../SECURITY.md) and [release readiness](RELEASE-READINESS.md).
