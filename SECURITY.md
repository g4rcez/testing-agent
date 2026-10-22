# Security and execution boundaries

This is a local test runner, not a service for untrusted tenants. Run tests against apps and accounts you control. Page content and model output are untrusted. Models select only offered operation/target IDs; they cannot supply executable JavaScript, shell commands, or selectors. Test-authored assertion selectors are evaluated as data by a fixed reader.

agent-browser owns browser launch, sessions, evaluation, and screenshots. The plugin uses its `eval` command for a fixed DOM adapter. The adapter retains observed nodes and checks document/form state, identity, semantics, visibility, enabled state, and hit testing before DOM input. These DOM events are synthetic; widgets requiring trusted hardware input are outside the supported execution contract. Open shadow roots are inspected; closed roots, frame contents, canvas interaction, uploads, downloads, and pop-up tab workflows are not supported by this adapter.

The page and plugin share the page's JavaScript environment. Node binding prevents accidental redirection to replaced controls; it is not a sandbox against a hostile page that tampers with browser globals or the adapter registry. Use isolated browser sessions and appropriate host/network isolation for untrusted applications. Other clients must not mutate a session owned by a running test.

Credentials are read from environment variables. Use a step's `valueFromEnv` for sensitive field values. Password field values are redacted from observations. API keys and typed values are excluded from action reports. A test definition can still contain sensitive explicit values: saved run state retains the definition in a private directory with private file modes. Do not commit state, reports, screenshots, `.env`, or browser profiles. Screenshots can contain application data.

Input and provider responses are size-limited. Provider calls reject redirects and support cancellation and deadlines. Recover never replays unknown input. An absent receipt, including after navigation destroys its document, leaves an interrupted run `uncertain` for inspection.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/g4rcez/agent-browser-jev/security/advisories/new). Private reporting is enabled for this repository. Do not include credentials or private page captures in public issues. The npm publication target is `agent-tester`, maintained through `g4rcez/agent-browser-jev`.
