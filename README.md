# testing-agent

Write browser tests in plain-language **YAML or JSON**. agent-browser controls Chrome; Laya or Jev chooses the actions. Your assertions decide whether the test passes.

## Quick start

```sh
npm install -g testing-agent agent-browser   # once
testing-agent setup                          # install missing dependencies
testing-agent init tests                     # scaffold a tests folder with an example
testing-agent test tests/example.test.yaml   # run it
```

![](./docs/assets/wikipedia-search.mp4)


| Command                                        | What it does                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `testing-agent setup [--manual]`               | Installs Bun, Node.js, ffmpeg, agent-browser and Chrome for your OS; `--manual` only prints the commands |
| `testing-agent setup laya`                     | Starts the optional local Laya backend                                                                   |
| `testing-agent init [folder] [--yaml\|--json]` | Creates a tests folder with an example test                                                              |
| `testing-agent test <file>`                    | Runs a YAML or JSON test                                                                                 |

## Install

Requires **Bun 1.3.14+**, **Node.js 20+**, and **ffmpeg** on your PATH.

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm install -g testing-agent agent-browser
testing-agent setup
```

`testing-agent setup` installs whatever is missing (Bun, Node.js, ffmpeg, agent-browser and its Chrome) with Homebrew on macOS, apt/dnf/pacman/apk/zypper on Linux, or winget on Windows, and skips what is already present. To only see the commands for your platform without running them, use `testing-agent setup --manual`.

Start the optional local Laya backend in a separate terminal. No Python or API key is needed:

```sh
testing-agent setup laya
```

This uses [`@receptron/laya`](https://github.com/receptron/laya). The first explicit setup downloads about **1.7 GB** of pinned model weights; allow at least **2 GB RAM**. Wait for `"ready": true` and keep that terminal running. The install command skips unused CUDA downloads; this backend uses the CPU.

Tests check backend reachability before opening a browser. If the local Laya server is not running, `testing-agent test` starts it for you (the first start downloads the weights, later starts take a few seconds), waits until it answers, and stops it when the run ends. A server that was already running is never touched. Turn this off with `--no-autostart`, `TESTING_AGENT_AUTOSTART=0` or `backend.autostart: false`; in CI (`CI` set) it stays off unless `TESTING_AGENT_AUTOSTART=1`. With autostart off, a missing server returns setup instructions and never downloads or starts anything. Existing Python Laya and hosted Jev configurations remain supported.

## Start a project

```sh
testing-agent init          # asks which folder to use (default: tests)
testing-agent init e2e      # uses the e2e folder
testing-agent init --json   # JSON example instead of the default YAML (--yaml is explicit)
```

This creates the folder with an `example.test.yaml` (or `.json`) you can run right away. Existing files are never overwritten.

## First test

Save this as **`wikipedia-search.yaml`**. One flow searches Wikipedia for four topics (a large language model, IPv4, IPv6 and Spider-Man) and checks the article after every search. Steps are plain-language prompts only: no selectors. Steps the page makes unambiguous are done straight from the page; the model decides the rest.

```yaml
name: Search Wikipedia for LLMs, IPv4, IPv6 and Spider-Man
url: https://en.wikipedia.org/wiki/Main_Page
prompt: Search Wikipedia for four topics, one after another, and check that each article opens.
backend:
  provider: laya
totalTimeoutMs: 300000
steps:
  - instruction: Type Large language model into the Search Wikipedia box
    value: Large language model
    assume: The Search Wikipedia box contains Large language model
  - instruction: Press Enter in the Search Wikipedia box to search
    expect:
      url: https://en.wikipedia.org/wiki/Large_language_model
      text: Large language model
  - instruction: Type IPv4 into the Search Wikipedia box
    value: IPv4
    assume: The Search Wikipedia box contains IPv4
  - instruction: Press Enter in the Search Wikipedia box to search
    expect:
      url: https://en.wikipedia.org/wiki/IPv4
      text: Internet Protocol version 4
  - instruction: Type IPv6 into the Search Wikipedia box
    value: IPv6
    assume: The Search Wikipedia box contains IPv6
  - instruction: Press Enter in the Search Wikipedia box to search
    expect:
      url: https://en.wikipedia.org/wiki/IPv6
      text: Internet Protocol version 6
  - instruction: Type Spider-Man into the Search Wikipedia box
    value: Spider-Man
    assume: The Search Wikipedia box contains Spider-Man
  - instruction: Press Enter in the Search Wikipedia box to search
    expect:
      url: https://en.wikipedia.org/wiki/Spider-Man
      text: Spider-Man
```

Run it:

```sh
testing-agent test wikipedia-search.yaml
```

The CLI prints JSON with each step's `status` and `success`, the final `passed` result, and the video/report paths. A passing test exits with code `0`. Video recording is enabled by default. The same file ships as [examples/wikipedia-search.yaml](examples/wikipedia-search.yaml).

Two ways to say when a step is done:

- `expect` is a deterministic check (URL, page text) and is what decides the final result.
- `assume` is a plain-language statement about the page, for example `The Search Wikipedia box contains IPv4`. After the step's action, the step completes only if the model confirms it **and** every distinctive word of the statement is visible in a field, the title, the URL or the page text. The second condition exists because a small local model answers "yes" too easily: a false statement such as `The Search Wikipedia box contains Spider-Man` after typing IPv4 never completes the step. A statement of the plain form `The <field> box contains <value>` is read off the page itself and does not need the model at all.

### Fast path

Before asking the model, the runner tries to settle each step from the page: typing a known `value` into a field the instruction names, pressing Enter in it, clicking or opening a control whose label the instruction names, choosing a dropdown option, switching a checkbox, scrolling. It only acts when exactly one control matches (case, accents and spacing are ignored); anything ambiguous, conditional (`if`, `not`, `never`, `or`...) or bound to a `selector` still goes to the model. Fast actions are marked `source: "fast"` in the result. The Wikipedia example below completes this way in about 6 seconds with no model at all, so the local Laya server is not even started. Turn it off with `--no-fast-path` or `fastPath: false`.

## Recorded passing test

This is a real run of that file with the default settings: **8 of 8 steps passed in about 11 seconds**, and the URL and page text assertions held on all four articles. Every step was settled from the page, so no model was called and the local Laya server was never started. The recording is 60 fps.

<video src="docs/assets/wikipedia-search.mp4" controls muted loop autoplay playsinline width="900"></video>

[Watch the video](docs/assets/wikipedia-search.mp4) if it does not play above.

For comparison, here is an earlier run of the same file on the same machine with the optional local Laya backend (CPU, no API key) choosing every control (`--no-fast-path`): **8 of 8 steps passed in 37 seconds**.

| Step | What        | Model choice                        | Result                          | Time  |
| ---- | ----------- | ----------------------------------- | ------------------------------- | ----- |
| 1    | Type        | `TYPE_TEXT` on “Search Wikipedia”   | ✅ assumption holds on the page | 4.9 s |
| 2    | Press Enter | `PRESS_ENTER` on “Search Wikipedia” | ✅ URL and page text match      | 4.3 s |
| 3    | Type        | `TYPE_TEXT` on “Search Wikipedia”   | ✅ assumption holds on the page | 5.3 s |
| 4    | Press Enter | `PRESS_ENTER` on “Search Wikipedia” | ✅ URL and page text match      | 3.7 s |
| 5    | Type        | `TYPE_TEXT` on “Search Wikipedia”   | ✅ assumption holds on the page | 4.2 s |
| 6    | Press Enter | `PRESS_ENTER` on “Search Wikipedia” | ✅ URL and page text match      | 4.0 s |
| 7    | Type        | `TYPE_TEXT` on “Search Wikipedia”   | ✅ assumption holds on the page | 4.6 s |
| 8    | Press Enter | `PRESS_ENTER` on “Search Wikipedia” | ✅ URL and page text match      | 4.2 s |

Every step passed on the first model decision.

[Read the model-driven run's full output](docs/evidence/wikipedia-search.json)

Reproduce it with the local backend running: `bun run demo:wikipedia -- --record`. This is evidence for this recorded run and flow, not a guarantee for every site or prompt.

## Editor autocomplete

```sh
testing-agent lsp wikipedia-search.yaml
```

This adds the bundled schema reference for JSON/YAML editor suggestions. It does not install an editor extension or start a language server.

## More examples

| Example                                             | What it checks                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| [Wikipedia search](examples/wikipedia-search.yaml)  | Four searches in one flow, each checked by exact URL and article text |
| [GitHub tour](examples/github-repository-tour.yaml) | README, license, navigation, and the signed-out Star gate             |
| [Stay search](examples/stay-search-journey.yaml)    | Filtering and details in a compatible local app                       |

The authenticated [GitHub Star example](examples/github-star.yaml) changes account state and needs a manually signed-in session. The signed-out examples stop at sign-in and never add a star.

## Reference

- [Configuration, assertions, reports, backends, and plugin usage](docs/REFERENCE.md)
- [Security and supported execution boundaries](SECURITY.md)
- [Release policy](docs/RELEASE.md) · [Release evidence](docs/RELEASE-READINESS.md)

Legacy commands `agent-tester`, `agent-browser-jev`, and `jev-test`, plus the `agent-browser-plugin-jev` plugin, remain available. Tests run on Chromium with ordinary HTML/ARIA controls and open shadow roots; frames, canvas-only input, closed shadow roots, uploads/downloads, and pop-up workflows are outside this release's execution contract.

MIT licensed. [Contributing](CONTRIBUTING.md).
