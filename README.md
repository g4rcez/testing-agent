# testing-agent

Write browser tests in plain-language **YAML or JSON**. agent-browser controls Chrome; Laya or Jev chooses the actions. Your assertions decide whether the test passes.

## Install

Requires **Bun 1.3.14+** and **ffmpeg** on your PATH. Install missing tools before continuing.

```sh
npm install -g testing-agent agent-browser
agent-browser install
```

The example below uses local Laya. With **Python 3.11+** and **uv** installed, start it in a separate terminal:

```sh
uv run "$(npm root -g)/testing-agent/tools/laya-server.py"
```

The first start downloads the pinned model and its Python dependencies. Wait for `"ready": true`; keep the service running while testing. No API key is needed for this local backend.

## First test

Save this as **`blog.test.yaml`**. It performs three actions and checks both the URL and page text after each one. No selectors are needed.

```yaml
name: Explore garcez.dev
url: https://garcez.dev/
prompt: Follow the three steps in order and validate each result.
backend:
  provider: laya
steps:
  - instruction: Type ls into the Interactive garcez.dev terminal
    value: ls
    expect:
      url: https://garcez.dev/
      text: '[~]>_ ls'
  - instruction: Press Enter in the Interactive garcez.dev terminal to execute ls
    expect:
      url: https://garcez.dev/
      text: README.md agents.ts posts projects skills.ts tags
  - instruction: Open About from the main navigation
    expect:
      url: https://garcez.dev/about
      text: Product engineering with frontend depth.
```

Run it:

```sh
testing-agent test blog.test.yaml
```

The CLI prints JSON with each step's `status` and `success`, the final `passed` result, and the video/report paths. A passing test exits with code `0`. Video recording is enabled by default.

The same definition is in [examples/garcez-blog.yaml](examples/garcez-blog.yaml).

<details>
<summary>Recorded local Laya attempt (blocked, not passed)</summary>

![Real blocked Laya run on garcez.dev](docs/assets/garcez-blog.gif)

[Watch the video](docs/assets/garcez-blog.webm) · [Read the output](docs/evidence/garcez-blog.json)

The local model selected unrelated controls and the runner blocked the test. This is real failure evidence, not a passing demo. Definitions and assertions are validated separately from model accuracy.

</details>

## Editor autocomplete

```sh
testing-agent lsp blog.test.yaml
```

This adds the bundled schema reference for JSON/YAML editor suggestions. It does not install an editor extension or start a language server.

## More examples

| Example | What it checks |
| --- | --- |
| [Blog test](examples/garcez-blog.yaml) | Terminal input, complete `ls` output, and About; three checked steps |
| [Terminal](examples/garcez-ls.yaml) | Runs `ls` and checks all six output entries in order |
| [GitHub tour](examples/github-repository-tour.yaml) | README, license, navigation, and the signed-out Star gate |
| [Stay search](examples/stay-search-journey.yaml) | Filtering and details in a compatible local app |

The authenticated [GitHub Star example](examples/github-star.yaml) changes account state and needs a manually signed-in session. The signed-out examples stop at sign-in and never add a star.

## Reference

- [Configuration, assertions, reports, backends, and plugin usage](docs/REFERENCE.md)
- [Security and supported execution boundaries](SECURITY.md)
- [Release policy](docs/RELEASE.md) · [Release evidence](docs/RELEASE-READINESS.md)

Legacy commands `agent-tester`, `agent-browser-jev`, and `jev-test`, plus the `agent-browser-plugin-jev` plugin, remain available. Tests run on Chromium with ordinary HTML/ARIA controls and open shadow roots; frames, canvas-only input, closed shadow roots, uploads/downloads, and pop-up workflows are outside this release's execution contract.

MIT licensed. [Contributing](CONTRIBUTING.md).
