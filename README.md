# testing-agent

Write browser tests in plain-language **YAML or JSON**. agent-browser controls Chrome; Laya or Jev chooses the actions. Your assertions decide whether the test passes.

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

Tests check backend reachability before opening a browser. If the local Laya server is not running, an interactive terminal asks whether to set it up now (it starts `testing-agent setup laya` only if you answer yes); non-interactive runs return setup instructions and never download or start anything. Existing Python Laya and hosted Jev configurations remain supported.

## First test

Save this as **`blog.test.yaml`**. It defines three ordered steps and checks both the URL and page text after each one. No selectors are needed.

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

The same definition is in [examples/garcez-blog.yaml](examples/garcez-blog.yaml). **This terminal workflow still blocks with the tested local models.** Its assertions have not been weakened.

## Recorded passing test

The simpler [About example](examples/garcez-about.yaml) passed with the optional local backend: it opened About and checked both its URL and heading. The model first opened and closed the terminal before selecting About; those actions remain in the recording and receipt.

```sh
testing-agent test "$(npm root -g)/testing-agent/examples/garcez-about.yaml"
```

![Real passing Laya run on garcez.dev](docs/assets/garcez-about.gif)

[Watch the passing video](docs/assets/garcez-about.webm) · [Read the passing output](docs/evidence/garcez-about.json)

This proves that recorded run, not general model reliability or success of the three-step terminal workflow.

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
| [Passing About test](examples/garcez-about.yaml) | Navigation to About, exact URL, and page heading |
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
