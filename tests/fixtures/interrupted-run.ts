import { Browser } from "../../src/browser.ts";
import { decide, fieldValue } from "../../src/decision.ts";
import { runSchema } from "../../src/contracts.ts";
import { startRun, summarize } from "../../src/runner.ts";

const input = runSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const result = await startRun(input, {
  decide,
  fieldValue,
  browser: (session, deadline, signal) => {
    const browser = new Browser(session, deadline, signal);
    return {
      command: browser.command.bind(browser),
      observe: browser.observe.bind(browser),
      receipt: browser.receipt.bind(browser),
      assert: browser.assert.bind(browser),
      execute: async (decision, text) => {
        await browser.execute(decision, text);
        if (process.env.JEV_TEST_HOLD_ACK === "1") {
          console.log(JSON.stringify({ event: "input-applied" }));
          await Bun.stdin.text();
        }
      },
    };
  },
});
console.log(JSON.stringify(summarize(result)));
