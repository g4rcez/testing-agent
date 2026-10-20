import { Browser } from "./browser.ts";
import {
  capabilities,
  contextSchema,
  envelopeSchema,
  PROTOCOL,
  resumeSchema,
  runSchema,
} from "./contracts.ts";
import { loadRun, resumeRun, startRun, summarize } from "./runner.ts";

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
      "agent-browser-plugin-jev: JSON stdio plugin for agent-browser. Requests: plugin.manifest, agent.context, agent.run, agent.resume, agent.status. See README.md for payloads and configuration.",
    );
  } else {
    try {
      const input: unknown = JSON.parse(await Bun.stdin.text());
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
