import { Browser } from "./browser.ts";
import {
  capabilities,
  contextSchema,
  envelopeSchema,
  PROTOCOL,
  resumeSchema,
  runSchema,
} from "./contracts.ts";
import {
  cancelRun,
  recoverRun,
  loadRun,
  resumeRun,
  startRun,
  summarize,
} from "./runner.ts";

export async function handlePlugin(
  input: unknown,
): Promise<Record<string, unknown>> {
  const envelope = envelopeSchema.parse(input);
  if (envelope.type === "plugin.manifest") {
    return {
      protocol: PROTOCOL,
      success: true,
      manifest: {
        name: "jev",
        capabilities,
        description:
          "Follow ordered app instructions using Jev or Laya decisions and agent-browser.",
      },
    };
  }
  let data: unknown;
  switch (envelope.type) {
    case "agent.run":
      data = summarize(await startRun(runSchema.parse(envelope.request)));
      break;
    case "agent.resume":
      data = summarize(
        await resumeRun(resumeSchema.parse(envelope.request).runId),
      );
      break;
    case "agent.status":
      data = summarize(
        await loadRun(resumeSchema.parse(envelope.request).runId),
      );
      break;
    case "agent.cancel":
      data = await cancelRun(resumeSchema.parse(envelope.request).runId);
      break;
    case "agent.recover":
      data = summarize(
        await recoverRun(resumeSchema.parse(envelope.request).runId),
      );
      break;
    case "agent.context": {
      const { session } = contextSchema.parse(envelope.request);
      data = await new Browser(session, Date.now() + 15_000).observe();
      break;
    }
    default:
      throw new Error(`Unsupported request type: ${envelope.type}`);
  }
  return { protocol: PROTOCOL, success: true, data };
}

if (import.meta.main || process.argv[1]?.endsWith("agent-browser-plugin-jev")) {
  if (process.argv.includes("--help")) {
    console.log(
      "agent-browser-plugin-jev: JSON stdio plugin. Requests: plugin.manifest, agent.context, agent.run, agent.resume, agent.status, agent.cancel, agent.recover. Use jev-test --help for the test runner.",
    );
  } else {
    try {
      const reader = Bun.stdin.stream().getReader();
      let raw = "";
      let length = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 1_000_000) {
          await reader.cancel();
          throw new Error("Plugin input exceeds 1 MB");
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
      let input: unknown;
      try {
        input = JSON.parse(raw);
      } catch {
        throw new Error("Plugin input must be valid JSON");
      }
      console.log(JSON.stringify(await handlePlugin(input)));
    } catch (error) {
      console.log(
        JSON.stringify({
          protocol: PROTOCOL,
          success: false,
          error: error instanceof Error ? error.message : "Plugin failed",
        }),
      );
    }
  }
}
