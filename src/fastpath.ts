import type { Decision, Observation, RunInput, Target } from "./contracts.ts";
import { normalizeText } from "./normalize.ts";

// Resolves a step from the page without asking the model, when the instruction and the page leave
// no doubt. Anything ambiguous, conditional or unfamiliar returns null and goes to the model.

type ActionRecord = {
  stepIndex: number;
  operation: string;
  target?: string | undefined;
  source?: string | undefined;
  rule?: string | undefined;
};
export type FastDecision = Decision & { source: "fast"; rule: FastRule };
export type FastRule = "type" | "press-enter" | "click" | "select" | "toggle" | "scroll" | "reveal";
// A step may scroll a container this many times to bring a control into view before the model is asked.
const MAX_REVEALS = 15;
type Match = { id: string; target: Target };

// Words that make an instruction conditional or negated; a literal reading would guess wrong.
const CAUTION = /\b(if|unless|never|not|only|without|already|whether|until|except|or|optional|maybe)\b/;
const FIELD_WORD = "(?:search box|search field|text box|text field|textbox|searchbox|box|field|input)";
const words = (text: string) =>
  normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The one target that the phrase names: an exact label first, then a label that contains every
 * word of the phrase. Zero matches or more than one in the best tier return null; it never falls
 * back to a looser tier when a stricter one is ambiguous.
 */
export function matchTargets(phrase: string, targets: Record<string, Target> | undefined): Match | null {
  return lookup(phrase, targets).match;
}

// Like matchTargets, but says whether nothing matched or several did.
function lookup(
  phrase: string,
  targets: Record<string, Target> | undefined,
): { match: Match | null; ambiguous: boolean } {
  const wanted = normalizeText(phrase);
  if (!wanted || !targets) return { match: null, ambiguous: false };
  const items = Object.entries(targets).flatMap(([id, target]) => {
    const label = normalizeText(target.label);
    // A label that is only the role ("textbox") says nothing about what the control is.
    return label && label !== normalizeText(target.role ?? "") ? [{ id, target, label }] : [];
  });
  const exact = items.filter((item) => item.label === wanted);
  if (exact.length)
    return exact.length === 1 ? { match: exact[0]!, ambiguous: false } : { match: null, ambiguous: true };
  const wantedWords = words(wanted);
  const contained = items.filter((item) => {
    const have = new Set(words(item.label));
    return wantedWords.every((word) => have.has(word));
  });
  if (contained.length === 1) return { match: contained[0]!, ambiguous: false };
  return { match: null, ambiguous: contained.length > 1 };
}

// "Field → Option" labels of dropdown choices.
function matchOption(field: string, option: string, targets: Record<string, Target> | undefined): Match | null {
  const fieldWords = words(field);
  const optionWords = words(option);
  if (!targets || !fieldWords.length || !optionWords.length) return null;
  const items = Object.entries(targets).flatMap(([id, target]) => {
    const [left, right] = target.label.split(" → ");
    return right === undefined ? [] : [{ id, target, left: normalizeText(left ?? ""), right: normalizeText(right) }];
  });
  const exact = items.filter((item) => item.left === normalizeText(field) && item.right === normalizeText(option));
  if (exact.length) return exact.length === 1 ? exact[0]! : null;
  const contained = items.filter((item) => {
    const left = new Set(words(item.left));
    const right = new Set(words(item.right));
    return fieldWords.every((word) => left.has(word)) && optionWords.every((word) => right.has(word));
  });
  return contained.length === 1 ? contained[0]! : null;
}

/**
 * The scrollable container that hides the control a phrase names, when exactly one control in one
 * container carries that label (an exact label first, then one containing every word).
 */
function reveal(
  phrases: string[],
  observation: Observation,
): { operation: "SCROLL_DOWN" | "SCROLL_UP"; match: Match } | null {
  for (const wanted of phrases.map((phrase) => normalizeText(phrase)).filter(Boolean)) {
    const wantedWords = words(wanted);
    const exact: Array<{ operation: "SCROLL_DOWN" | "SCROLL_UP"; match: Match }> = [];
    const contained: typeof exact = [];
    for (const operation of ["SCROLL_DOWN", "SCROLL_UP"] as const)
      for (const [id, target] of Object.entries(observation.targets[operation] ?? {})) {
        const hidden = (operation === "SCROLL_DOWN" ? target.scroll?.belowLabels : target.scroll?.aboveLabels) ?? [];
        for (const label of hidden) {
          const folded = normalizeText(label);
          const have = new Set(words(folded));
          if (folded === wanted) exact.push({ operation, match: { id, target } });
          else if (wantedWords.every((word) => have.has(word))) contained.push({ operation, match: { id, target } });
        }
      }
    const hits = exact.length ? exact : contained;
    // One control in one container; two of them would be a guess.
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return null;
  }
  return null;
}

function fieldPhrase(text: string): string | undefined {
  const pattern = new RegExp(`.*\\b(?:into|in|on|inside)\\s+(?:the\\s+)?(.+?)(?:\\s+${FIELD_WORD})?(?:\\s+to\\s+.*)?$`);
  return text.match(pattern)?.[1];
}

export function resolveFast(
  input: RunInput,
  stepIndex: number,
  observation: Observation,
  history: ActionRecord[],
): FastDecision | null {
  const step = input.steps[stepIndex];
  // A selector binds the step to one element the page script has to verify; leave that to the model path.
  if (!step || step.selector !== undefined) return null;
  const instruction = normalizeText(step.instruction);
  if (CAUTION.test(instruction)) return null;
  const mine = history.filter((action) => action.stepIndex === stepIndex);
  const revealed = (actions: ActionRecord[]) => actions.filter((action) => action.rule === "reveal").length;
  const triedFast = (operation: string) =>
    mine.some((action) => action.source === "fast" && action.operation === operation);
  const base = { confidence: 1, targetConfidence: 1, source: "fast" as const };
  const snapshot = observation.snapshotId ? { snapshotId: observation.snapshotId } : {};
  const act = (rule: FastRule, operation: string, match?: Match): FastDecision => ({
    ...base,
    ...snapshot,
    rule,
    operation,
    target: match?.target,
    ...(match ? { targetId: match.id } : {}),
  });
  const done = (rule: FastRule): FastDecision => ({ ...base, ...snapshot, rule, operation: "DONE", target: undefined });

  const scroll = instruction.match(/^scroll\s+(down|up)\b\s*(.*)$/);
  if (scroll) {
    const operation = scroll[1] === "down" ? "SCROLL_DOWN" : "SCROLL_UP";
    if (triedFast(operation)) return done("scroll");
    const options = observation.targets[operation];
    if (options && Object.keys(options).length) {
      // Containers can scroll: the instruction has to name one, or say "the page".
      const named = scroll[2]!.replace(/^(?:(?:in|within|inside|of|on|through|the)\s+)+/, "").trim();
      if (!named || named === "page")
        return options.page ? act("scroll", operation, { id: "page", target: options.page }) : null;
      // As written first, then without a trailing noun ("the Results list" names a container called "Results").
      for (const phrase of new Set([
        named,
        named.replace(/\s+(?:list|panel|pane|area|container|section|dialog|menu|box)$/, ""),
      ])) {
        const found = lookup(phrase, options);
        if (found.match) return act("scroll", operation, found.match);
        if (found.ambiguous) return null;
      }
      return null;
    }
    return observation.controls?.includes(operation) ? act("scroll", operation) : null;
  }

  if (/^(?:type|enter|fill(?: in)?|input|write|put)\b/.test(instruction)) {
    if (step.value === undefined && step.valueFromEnv === undefined) return null;
    const value = step.value === undefined ? undefined : normalizeText(step.value);
    // The value may sit between the verb and the field ("type IPv4 into the box"); keep it out of the label.
    const stripped = value ? instruction.replace(value, " ").replace(/\s+/g, " ") : instruction;
    const label =
      stripped.match(new RegExp(`^fill(?: in)?\\s+(?:the\\s+)?(.+?)(?:\\s+${FIELD_WORD})?\\s+with\\b`))?.[1] ??
      fieldPhrase(stripped);
    const found = label ? lookup(label, observation.targets.TYPE_TEXT) : { match: null, ambiguous: false };
    const match = found.match;
    if (!match) {
      const hidden = label && !found.ambiguous && revealed(mine) < MAX_REVEALS ? reveal([label], observation) : null;
      return hidden ? act("reveal", hidden.operation, hidden.match) : null;
    }
    if (value !== undefined && normalizeText(match.target.currentValue ?? "") === value) return done("type");
    return triedFast("TYPE_TEXT") ? null : act("type", "TYPE_TEXT", match);
  }

  if (/^(?:press|hit)\s+(?:the\s+)?(?:enter|return)\b/.test(instruction)) {
    if (triedFast("PRESS_ENTER")) return null;
    const targets = observation.targets.PRESS_ENTER;
    const label = fieldPhrase(instruction.replace(/^(?:press|hit)\s+(?:the\s+)?(?:enter|return)\s*/, ""));
    let match = label ? matchTargets(label, targets) : null;
    if (!label) {
      // "Press Enter" alone: the field just typed into, else the only field that can submit.
      const typed = history.at(-1);
      match = typed?.operation === "TYPE_TEXT" && typed.target ? matchTargets(typed.target, targets) : null;
      if (!match && targets && Object.keys(targets).length === 1) {
        const [id, target] = Object.entries(targets)[0]!;
        match = { id, target };
      }
    }
    return match ? act("press-enter", "PRESS_ENTER", match) : null;
  }

  const choice = instruction.match(
    new RegExp(
      `^(?:select|choose|pick)\\s+(?:the\\s+)?(.+?)\\s+(?:as|in|for|from)\\s+(?:the\\s+)?(.+?)(?:\\s+(?:dropdown|select|menu|list|${FIELD_WORD.slice(3, -1)}))?$`,
    ),
  );
  if (choice) {
    // Once the dropdown shows the option, the step is done; the page says so, not the model.
    const fieldWords = words(choice[2]!);
    const fields = observation.elements.filter((element) => {
      const have = new Set(words(element.label));
      return element.operations.includes("SELECT") && fieldWords.every((word) => have.has(word));
    });
    if (fields.length === 1 && normalizeText(fields[0]!.value) === normalizeText(choice[1]!)) return done("select");
    const match = matchOption(choice[2]!, choice[1]!, observation.targets.SELECT);
    return match && !triedFast("SELECT") ? act("select", "SELECT", match) : null;
  }

  const toggle = instruction.match(
    /^(enable|check|tick|turn on|disable|uncheck|untick|turn off)\s+(?:the\s+)?(.+?)(?:\s+(?:checkbox|switch|toggle|option))?$/,
  );
  if (toggle) {
    const wanted = ["enable", "check", "tick", "turn on"].includes(toggle[1]!) ? "true" : "false";
    const switches = Object.fromEntries(
      Object.entries(observation.targets.CLICK ?? {}).filter(([, target]) =>
        ["checkbox", "switch"].includes(target.role ?? ""),
      ),
    );
    const match = matchTargets(toggle[2]!, switches);
    if (!match || (match.target.checked !== "true" && match.target.checked !== "false")) return null;
    if (match.target.checked === wanted) return done("toggle");
    return triedFast("CLICK") ? null : act("toggle", "CLICK", match);
  }

  const click = instruction.match(
    /^(?:click|tap|open|follow|press|submit|go to|navigate to)\b(?:\s+on)?(?:\s+the)?\s+(.+)$/,
  );
  if (click) {
    if (triedFast("CLICK")) return null;
    const targets = observation.targets.CLICK;
    const named = click[1]!;
    // The whole phrase first ("open link in new tab" can be a label), then without a trailing role word
    // ("log in link"), then without a trailing "from/near/in ..." clause. An ambiguous phrase stops the search.
    const stripped = named.replace(/\s+(?:button|link|tab|menu item|menu|icon)$/, "");
    const clause = (phrase: string) => phrase.replace(/\s+(?:from|near|in|on|to|at|under|inside|within)\s+.+$/, "");
    for (const phrase of new Set([named, stripped, clause(stripped)])) {
      const found = lookup(phrase, targets);
      if (found.match) return act("click", "CLICK", found.match);
      if (found.ambiguous) return null;
    }
    // Not on screen: if exactly one scrollable container hides it, scroll that one.
    const hidden = revealed(mine) < MAX_REVEALS ? reveal([named, stripped, clause(stripped)], observation) : null;
    return hidden ? act("reveal", hidden.operation, hidden.match) : null;
  }
  return null;
}

/**
 * Answers "The <field> box contains <value>" from the page itself. Returns undefined when the
 * statement is not of that form or names no single field, so the model is asked instead.
 */
export function assumeDeterministic(statement: string, observation: Observation): boolean | undefined {
  const text = normalizeText(statement);
  if (CAUTION.test(text)) return undefined;
  const parsed = text.match(
    /^(?:the\s+)?(.+?)\s+(?:box|field|input|textbox|searchbox)\s+(?:contains|has|shows|holds|equals|is set to)\s+(.+)$/,
  );
  if (!parsed) return undefined;
  const match = matchTargets(parsed[1]!, observation.targets.TYPE_TEXT);
  if (!match) return undefined;
  return normalizeText(match.target.currentValue ?? "") === parsed[2];
}
