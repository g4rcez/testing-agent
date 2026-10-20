# agent-browser Jev/Laya plugin

A Bun plugin for [agent-browser](https://agent-browser.dev/plugins) that follows an ordered list of instructions using Jev or Laya to decide the next browser action.

Each cycle captures the frontend, sends the original prompt and current step to the selected decision backend, validates the returned operation and target, executes through agent-browser, and observes again. The plugin advances one step at a time. A separate text model is optional when steps supply explicit field values.

## Setup

Requires Bun 1.3+ and agent-browser with Chrome installed. Tested against agent-browser 0.32.1.

```sh
bun install
agent-browser plugin show jev
```

The repository's `agent-browser.json` registers the local plugin. Run commands from this directory. For another project's config, use an absolute path to `src/plugin.ts` in the plugin's `args`, or register the executable at `bin/agent-browser-plugin-jev`.

## Follow a task

Open your app in a named session:

```sh
agent-browser --session my-app open http://localhost:3000
```

Send the task through the plugin:

```sh
agent-browser plugin run jev agent.run --payload '{
  "session": "my-app",
  "prompt": "Find a stay in Lisbon with Design and free cancellation, then open Casa Flora.",
  "backend": { "provider": "laya", "baseUrl": "http://127.0.0.1:8791" },
  "steps": [
    { "instruction": "Enter Lisbon in the destination field", "value": "Lisbon" },
    "Choose the Design category",
    "Enable free cancellation",
    "Submit the search",
    { "instruction": "Open Casa Flora", "expect": { "text": "Casa Flora" } }
  ]
}'
```

Replace the app URL and instructions with your app's workflow. You can supply `url` in the payload to navigate at the start. Supply `session` to control an existing browser; otherwise a unique session is created when `url` is present. The payload's session is authoritative: agent-browser's plugin envelope does not forward an outer `--session` flag.

The original prompt and full step list remain in each decision request. The current step is also embedded in the model's goal. Model choices are restricted to observed targets and supported operations: click, fill, select, check, uncheck, Enter, scrolling, wait, done, and blocked.

## Backend configuration

| Provider | Default endpoint                                 | Credential environment      | Model          |
| -------- | ------------------------------------------------ | --------------------------- | -------------- |
| `jev`    | `TYPESAFE_BASE_URL` or `https://api.typesafe.ai` | `TYPESAFE_API_KEY` required | `jev-latest`   |
| `laya`   | `LAYA_BASE_URL` or `http://127.0.0.1:8791`       | `LAYA_API_KEY` optional     | Server default |

Both use `POST /v1/systemone`. The payload's `backend` supports `baseUrl`, `model`, and `apiKeyEnv` overrides. Credentials are read from the named environment variable. Plugin config and task JSON contain environment variable names, not API keys.

For example, after configuring `TYPESAFE_API_KEY` in your shell, choose:

```json
{ "backend": { "provider": "jev", "model": "jev-latest" } }
```

Laya needs a running HTTP server. Its generic server and the browser-tuned [`cklxx/laya-browser` adapter](https://huggingface.co/cklxx/laya-browser) speak this protocol. The request includes structured elements, current field values, and operation-specific target descriptions. The browser-tuned adapter handles its own model input formatting. Choose and pin the checkpoint at the server; protocol compatibility does not establish task accuracy. This plugin does not download or start model servers.

For a field step without `value`, configure an OpenAI-compatible text helper:

```json
{
  "textModel": {
    "baseUrl": "http://127.0.0.1:8000/v1",
    "model": "your-text-model",
    "apiKeyEnv": "TEXT_MODEL_API_KEY"
  }
}
```

Alternatively set `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`, and optionally `TEXT_MODEL_API_KEY`. A text helper supplies only a validated string for the selected field. Native dropdown values come from observed options.

## Progress and resume

agent-browser kills a plugin call after 60 seconds. This plugin uses a maximum 45-second call budget and defaults to 20 input actions per call. It saves progress before and after input, then returns `status: "paused"` when a call budget is reached.

```sh
agent-browser plugin run jev agent.resume --payload '{"runId":"UUID_FROM_RESULT"}'
agent-browser plugin run jev agent.status --payload '{"runId":"UUID_FROM_RESULT"}'
agent-browser plugin run jev agent.context --payload '{"session":"my-app"}'
```

Continue `agent.resume` while status is `paused`. Resuming never navigates back to the initial URL. `completed` means every listed step was accepted. Each completed step reports `verification: "model"` or `"assertion"`. An `expect` object can require frontend text, an exact URL, or both; a failed assertion blocks the run even when the model returns DONE.

`blocked` records a failure, unavailable input value, or exhausted budget. `uncertain` means an input command was interrupted and may have taken effect; it cannot be resumed automatically. Inspect the app before creating a new task. A session lock prevents concurrent plugin runs. After a hard process kill, inspect the browser and saved run before removing its stale `session-*.lock` directory.

Runs are saved as private files in `.agent-browser-jev/`, or `JEV_STATE_DIR` when set. They include the prompt, supplied values, completed steps, and action metadata. Keep the same state directory when resuming. The plugin leaves browser sessions open for inspection.

Optional limits: `maxActions` (60), `maxStepDecisions` (20), `actionsPerCall` (20), and `timeoutMs` (45000). There are no automatic backend switches or retries of uncertain input.

## Verification and limits

```sh
bun run typecheck
bun test
```

`bun test` runs unit tests and real Chromium workflows through `agent-browser plugin run`. The browser tests use a **scripted HTTP decision fixture** for each backend, including text-helper generation and resume across plugin processes. They verify the browser, plugin protocol, provider requests, and ordered execution. They do not measure Jev/Laya inference accuracy. Screenshots are saved to `artifacts/plugin-jev.png` and `artifacts/plugin-laya.png`.

The plugin compares full accessibility snapshots after inference and text generation, discarding changed observations. This is a best-effort freshness check: native agent-browser refs can fall back to same-label replacement nodes, and a page can change between the final check and native input. This plugin does not claim atomic target binding. Other clients should not mutate the same session during a run.

Frontend context comes from the accessibility tree. Canvas-only controls, custom widgets without useful accessibility semantics, and workflows needing operations outside the supported set may block. Browser snapshots are bounded to 200,000 characters; page text sent to the backend is capped at 24,000 characters, while observed target descriptions and field summaries are supplied separately.
