# Contributing

Use Bun 1.3.14 or newer. Install agent-browser and Chrome, then run:

```sh
bun install
bun run check
```

Keep agent-browser as the browser controller. New model capabilities must return finite, validated choices. New input operations need a bound node, a guard, an execution receipt, and browser tests for stale state and interrupted input.

Tests must pass through deterministic frontend assertions. Do not replace live-model failures with scripted answers or describe protocol fixtures as model accuracy evidence. Real-model checks run separately with `bun run test:live -- --backend laya` or `--backend jev`; configure the corresponding endpoint/credentials in your environment. Store only redacted receipts under `docs/evidence/`.

CI checks code, real Chromium integration, and the packed artifact. Publishing requires the live-model release gates and the release instructions in `docs/RELEASE.md`.
