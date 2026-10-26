import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../src/browser.ts";

// An agent-browser stand-in that fails its first call, as a page does while it is navigating.
let directory: string;
let counter: string;
const previous = process.env.AGENT_BROWSER_BIN;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "jev-retry-"));
  counter = join(directory, "calls");
  const fake = join(directory, "agent-browser");
  await Bun.write(
    fake,
    `#!/bin/sh
cat >/dev/null
n=$(cat "${counter}" 2>/dev/null || echo 0)
n=$((n + 1))
echo $n > "${counter}"
[ "$n" -le "$FAIL_FIRST" ] && exit 1
echo '{"success":true,"data":{"result":{"passed":true,"checks":[{"passed":true,"index":0,"message":"Passed"}]}}}'
`,
  );
  await chmod(fake, 0o700);
  process.env.AGENT_BROWSER_BIN = fake;
});
afterAll(async () => {
  if (previous === undefined) delete process.env.AGENT_BROWSER_BIN;
  else process.env.AGENT_BROWSER_BIN = previous;
  await rm(directory, { recursive: true, force: true });
});

test("an assertion is read again when the page is not ready the first time", async () => {
  await Bun.write(counter, "0");
  process.env.FAIL_FIRST = "1";
  const result = await new Browser("retry", Date.now() + 20_000).assert([{ text: "x", timeoutMs: 0 }]);
  expect(result.passed).toBe(true);
  expect(await Bun.file(counter).text()).toBe("2\n");
});

test("an assertion gives up after three failed reads", async () => {
  await Bun.write(counter, "0");
  process.env.FAIL_FIRST = "9";
  await expect(new Browser("retry", Date.now() + 20_000).assert([{ text: "x", timeoutMs: 0 }])).rejects.toThrow(
    "failed or timed out",
  );
  expect(await Bun.file(counter).text()).toBe("3\n");
});
