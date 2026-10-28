import type { Observation, Step } from "./contracts.ts";
import { clickAim } from "./fastpath.ts";
import { normalizeText } from "./normalize.ts";

// When a step names a control that is not on screen, the runner looks for it by scrolling before the model is
// asked to guess. The model would only see what is on screen, and the answer it gives for a control that
// is not there is a wrong control.

export type SearchPlan = {
  needle: string;
  // Where the control is (the row or section it sits in): the search wants this control, not the first one with
  // the label.
  within?: string;
  // The label or the place has digits ("order #08731"): it names one thing. Absent after a full search, the step
  // fails instead of going to a model that would pick the nearest look-alike.
  exact: boolean;
};

const words = (text: string) =>
  normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const covers = (wanted: string[], text: string) => {
  const have = new Set(words(text));
  return wanted.every((word) => have.has(word));
};

/** What to look for on behalf of a step, or null when the step does not name a control. */
export function searchPlan(step: Pick<Step, "instruction" | "selector">): SearchPlan | null {
  if (step.selector !== undefined) return null;
  const aim = clickAim(step.instruction);
  // "The second Delete" only means something among the controls on screen.
  if (!aim || aim.ordinal !== undefined || !words(aim.label).length) return null;
  return {
    needle: aim.label,
    ...(aim.within ? { within: aim.within } : {}),
    exact: /\d/.test(aim.label) || /\d/.test(aim.within ?? ""),
  };
}

/** Whether the control is already among those on screen: a label with every word of the needle, in the place asked for. */
export function isOnScreen(plan: Pick<SearchPlan, "needle" | "within">, observation: Observation): boolean {
  const wanted = words(plan.needle);
  if (plan.within === undefined) return observation.elements.some((element) => covers(wanted, element.label));
  const place = words(plan.within);
  // A control the page says nothing about is not known to be elsewhere.
  return Object.values(observation.targets.CLICK ?? {}).some(
    (target) => covers(wanted, target.label) && (!target.context || covers(place, target.context)),
  );
}
