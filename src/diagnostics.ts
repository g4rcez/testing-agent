import type { Observation } from "./contracts.ts";

// Stable, machine-readable explanation for why a run stopped; the human sentence stays in `reason`.
export const reasonCodes = [
  "CANCELLED",
  "VIDEO_FAILED",
  "VIDEO_START_FAILED",
  "VIDEO_START_UNKNOWN",
  "VIDEO_ENDED",
  "VIDEO_FINALIZE_FAILED",
  "INPUT_RECEIPT_MISSING",
  "INPUT_ACK_INTERRUPTED",
  "CALL_BUDGET",
  "CALL_DEADLINE",
  "TOTAL_DEADLINE",
  "STEP_DECISION_BUDGET",
  "ACTION_BUDGET",
  "MODEL_BLOCKED",
  "MODEL_BLOCKED_NO_SCROLL",
  "NO_PAGE_CHANGE",
  "SEARCH_NOT_FOUND",
  "SEARCH_BUDGET",
  "DONE_ASSERTION_FAILED",
  "FINAL_ASSERTION_FAILED",
  "BACKEND_TIMEOUT",
  "BACKEND_UNREACHABLE",
  "BACKEND_NOT_READY",
  "BACKEND_START_FAILED",
  "BACKEND_MISCONFIGURED",
  "BACKEND_CONFIG_MISMATCH",
  "BACKEND_HTTP",
  "BACKEND_INVALID_RESPONSE",
  "LOW_CONFIDENCE",
  "STALE_OBSERVATION",
  "STALE_TARGET",
  "BROWSER_COMMAND_FAILED",
  "TAB_NOT_FOUND",
  "TEXT_VALUE_UNAVAILABLE",
  "INTERNAL",
] as const;
export type ReasonCode = (typeof reasonCodes)[number];

/** An error that knows its reason code and carries safe, structured details for the debug report. */
export class RunError extends Error {
  constructor(
    readonly code: ReasonCode,
    message: string,
    readonly details: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.name = "RunError";
  }
}

const roundProbability = (value: number) => Math.round(value * 10_000) / 10_000;

/** The few most likely options, enough to see a near-tie without bloating the saved state. */
export function topProbabilities(probabilities: Record<string, number>, count = 5): Record<string, number> {
  return Object.fromEntries(
    Object.entries(probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([key, value]) => [key, roundProbability(value)]),
  );
}

/** A small, redaction-friendly picture of what the runner saw; never the full tree or element list. */
export function observationDebug(observation: Observation, controlsFiltered: boolean) {
  return {
    url: observation.url,
    ...(observation.title ? { title: observation.title } : {}),
    fingerprint: observation.fingerprint.slice(0, 12),
    targetCounts: Object.fromEntries(
      Object.entries(observation.targets).map(([operation, targets]) => [operation, Object.keys(targets).length]),
    ),
    ...(observation.controls ? { controls: observation.controls } : {}),
    controlsFiltered,
    textExcerpt: (observation.text ?? observation.tree).replace(/\s+/g, " ").trim().slice(0, 400),
  };
}
