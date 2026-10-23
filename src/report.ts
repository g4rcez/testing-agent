import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { summarize, type RunState } from "./runner.ts";

const xml = (value: string) =>
  value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? "",
    );

// A plain-text version of the debug fields, for CI pages that only show the failure body.
function failureDetails(state: RunState): string {
  const { debug } = summarize(state);
  const step = state.input.steps[state.stepIndex];
  const lines = [
    `status: ${state.status}`,
    `code: ${state.reasonCode ?? "none"}`,
    ...(step ? [`step ${state.stepIndex + 1}: ${step.instruction}`] : []),
  ];
  const decision = debug?.lastDecision;
  if (decision)
    lines.push(
      `last decision: ${decision.operation}${decision.target ? ` -> ${decision.target}` : ""} ` +
        `(confidence ${decision.confidence}, ${decision.source ?? "model"}, ${decision.inferenceMs} ms)`,
    );
  const seen = debug?.lastObservation;
  if (seen)
    lines.push(`page: ${seen.url}`, `targets: ${JSON.stringify(seen.targetCounts)}`, `text: ${seen.textExcerpt}`);
  if (debug?.error) lines.push(`error: ${debug.error.code}${debug.error.message ? ` ${debug.error.message}` : ""}`);
  return lines.join("\n");
}

export function junitReport(state: RunState): string {
  const elapsed = Math.max(0, ((state.endedAt ?? state.updatedAt) - state.createdAt) / 1000).toFixed(3);
  const passed =
    state.status === "completed" &&
    state.assertions.length > 0 &&
    state.assertions.every((assertion) => assertion.passed);
  const failure = passed
    ? ""
    : '<failure type="' +
      xml(state.reasonCode ?? state.status) +
      '" message="' +
      xml(state.reason ?? "Test did not pass") +
      '">' +
      xml(failureDetails(state)) +
      "</failure>";
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" failures="' +
    (passed ? "0" : "1") +
    '"><testsuite name="jev-browser-tests" tests="1" failures="' +
    (passed ? "0" : "1") +
    '" time="' +
    elapsed +
    '"><testcase name="' +
    xml(state.input.name) +
    '" classname="agent-browser" time="' +
    elapsed +
    '">' +
    failure +
    "<system-out>" +
    xml(
      JSON.stringify({
        runId: state.runId,
        reasonCode: state.reasonCode ?? null,
        actions: state.actions,
        assertions: state.assertions,
        debug: summarize(state).debug,
      }),
    ) +
    "</system-out></testcase></testsuite></testsuites>\n"
  );
}

export async function writeReports(state: RunState, directory: string) {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const json = resolve(path, `${state.runId}.json`);
  const junit = resolve(path, `${state.runId}.xml`);
  await writeFile(
    json,
    JSON.stringify(
      {
        schemaVersion: 1,
        ...summarize(state),
        backend: state.input.backend.provider,
        createdAt: new Date(state.createdAt).toISOString(),
        endedAt: state.endedAt === null ? null : new Date(state.endedAt).toISOString(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await writeFile(junit, junitReport(state), { mode: 0o600 });
  return { json, junit };
}
