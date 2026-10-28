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

// The controls a phrase names: those with exactly that label, else those whose label has every word of it.
function candidatesFor(phrase: string, targets: Record<string, Target> | undefined): Match[] {
  const wanted = normalizeText(phrase);
  if (!wanted || !targets) return [];
  const items = Object.entries(targets).flatMap(([id, target]) => {
    const label = normalizeText(target.label);
    // A label that is only the role ("textbox") says nothing about what the control is.
    return label && label !== normalizeText(target.role ?? "") ? [{ id, target, label }] : [];
  });
  const exact = items.filter((item) => item.label === wanted);
  if (exact.length) return exact;
  const wantedWords = words(wanted);
  return items.filter((item) => {
    const have = new Set(words(item.label));
    return wantedWords.every((word) => have.has(word));
  });
}

// Like matchTargets, but says whether nothing matched or several did.
function lookup(
  phrase: string,
  targets: Record<string, Target> | undefined,
): { match: Match | null; ambiguous: boolean } {
  const found = candidatesFor(phrase, targets);
  return found.length === 1 ? { match: found[0]!, ambiguous: false } : { match: null, ambiguous: found.length > 1 };
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

const CLICK_PATTERN = /^(?:click|tap|open|follow|press|submit|go to|navigate to)\b(?:\s+on)?(?:\s+the)?\s+(.+)$/;
const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  last: -1,
};
// The word for a kind of control, and the role the page reports for it.
const KINDS: Record<string, string> = {
  button: "button",
  link: "link",
  tab: "tab",
  "menu item": "menuitem",
  checkbox: "checkbox",
  radio: "radio",
  switch: "switch",
};
const KIND_WORD = new RegExp(`^(.+?)\\s+(${Object.keys(KINDS).join("|")})$`);
const WHERE = /\s+(?:in|inside|within|from|under|near)\s+/g;
const CONTAINER_WORD = /\b(?:section|list|dialog|table|panel|card|form|area|modal|region|group|row|page)$/;

/**
 * What a click step names. `label` is the control's own words. What narrows it down is optional: its `kind`
 * ("the Pay button"), its place among the same ones ("the second Delete", "the last Edit": `ordinal`, -1 for the
 * last) and where it is ("in the row of Order #1002", "in the Billing section": `within`).
 */
export type ClickAim = { label: string; kind?: string; ordinal?: number; within?: string };
export function parseClick(named: string): ClickAim {
  const takeKind = (text: string) => {
    const kind = text.match(KIND_WORD);
    return kind ? { rest: kind[1]!, kind: KINDS[kind[2]!] } : { rest: text, kind: undefined };
  };
  let { rest, kind } = takeKind(named);
  let within: string | undefined;
  // "in the ...", "from the ... list", "in row 3": a place, not part of the label ("sign in with Google" is a label).
  for (const found of rest.matchAll(WHERE)) {
    const tail = rest.slice(found.index + found[0].length);
    if (!/^(?:the|rows?)\b/.test(tail) && !CONTAINER_WORD.test(tail)) continue;
    within =
      tail
        .replace(/^the\s+/, "")
        .replace(/^rows?\s+(?:(?:of|for|with|containing)\s+)?/, "")
        .replace(CONTAINER_WORD, "")
        .trim() || undefined;
    rest = rest.slice(0, found.index);
    if (kind === undefined) ({ rest, kind } = takeKind(rest));
    break;
  }
  let ordinal: number | undefined;
  const nth = rest.match(
    /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|\d+(?:st|nd|rd|th))\s+(.+)$/,
  );
  if (nth) {
    ordinal = ORDINALS[nth[1]!] ?? Number.parseInt(nth[1]!, 10);
    rest = nth[2]!;
  }
  return {
    label: rest,
    ...(kind ? { kind } : {}),
    ...(ordinal === undefined ? {} : { ordinal }),
    ...(within ? { within } : {}),
  };
}

/** The aim of a click step, or null when the step is not a plain click. */
export function clickAim(instruction: string): ClickAim | null {
  const text = normalizeText(instruction);
  if (CAUTION.test(text)) return null;
  const named = text.match(CLICK_PATTERN)?.[1];
  return named ? parseClick(named) : null;
}

// The phrase as written and without a trailing role word ("log in link" can be a label); then the shorter ones,
// without a trailing "from/near/in ..." clause, which say less about where the control is.
function clickPhrases(named: string): { written: string[]; shorter: string[] } {
  const withoutRole = (phrase: string) => phrase.replace(/\s+(?:button|link|tab|menu item|menu|icon)$/, "");
  const withoutClause = (phrase: string) =>
    phrase.replace(/\s+(?:from|near|in|on|to|at|under|inside|within)\s+.+$/, "");
  const stripped = withoutRole(named);
  return {
    written: [...new Set([named, stripped])],
    // Last, with both gone: "the Delete link from the Orders list" names a control called "Delete".
    shorter: [...new Set([withoutClause(stripped), withoutRole(withoutClause(stripped))])],
  };
}

// The one control an aim names among those on screen: narrowed by kind, by place (what the control sits in), and
// by its position among the rest. More than one left, or none, is not a guess to make.
function pick(aim: ClickAim, targets: Record<string, Target> | undefined): Match | null {
  let found = candidatesFor(aim.label, targets);
  if (aim.kind) found = found.filter((item) => item.target.role === aim.kind);
  if (aim.within) {
    const wanted = words(aim.within);
    const inPlace = found.filter((item) => {
      const have = new Set(words(item.target.context ?? ""));
      return wanted.every((word) => have.has(word));
    });
    // The ones the page puts in that place win. With none, only a control the page says nothing about stays: one
    // that has a context which is not the place asked for is somewhere else.
    found = inPlace.length ? inPlace : found.filter((item) => !item.target.context);
  }
  if (aim.ordinal !== undefined) return found[aim.ordinal < 0 ? found.length + aim.ordinal : aim.ordinal - 1] ?? null;
  return found.length === 1 ? found[0]! : null;
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
  if (!step) return null;
  const instruction = normalizeText(step.instruction);
  // A selector binds the step to one element the page script verifies. Typing into it is settled here, through
  // the target the page marked as matching the selector; any other kind of step with a selector goes to the model.
  const typing = /^(?:type|enter|fill(?: in)?|input|write|put)\b/.test(instruction);
  if (step.selector !== undefined && !typing) return null;
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

  const scroll = instruction.match(/^scroll\s+(down|up|left|right)\b\s*(.*)$/);
  if (scroll) {
    const operation = { down: "SCROLL_DOWN", up: "SCROLL_UP", left: "SCROLL_LEFT", right: "SCROLL_RIGHT" }[
      scroll[1] as "down" | "up" | "left" | "right"
    ];
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
    let found: { match: Match | null; ambiguous: boolean };
    if (step.selector !== undefined) {
      const bound = Object.entries(observation.targets.TYPE_TEXT ?? {}).filter(([, target]) => target.bound);
      found =
        bound.length === 1
          ? { match: { id: bound[0]![0], target: bound[0]![1] }, ambiguous: false }
          : { match: null, ambiguous: bound.length > 1 };
    } else found = label ? lookup(label, observation.targets.TYPE_TEXT) : { match: null, ambiguous: false };
    const match = found.match;
    if (!match) {
      const hidden =
        step.selector === undefined && label && !found.ambiguous && revealed(mine) < MAX_REVEALS
          ? reveal([label], observation)
          : null;
      return hidden ? act("reveal", hidden.operation, hidden.match) : null;
    }
    if (value !== undefined && normalizeText(match.target.currentValue ?? "") === value) return done("type");
    // A value read from the environment is not known here, and a password field never shows it: once the field
    // has been typed into and is not empty, the step is done.
    if (value === undefined && triedFast("TYPE_TEXT") && (match.target.currentValue ?? "") !== "") return done("type");
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

  const click = instruction.match(CLICK_PATTERN);
  if (click) {
    if (triedFast("CLICK")) return null;
    const targets = observation.targets.CLICK;
    const named = click[1]!;
    const { written, shorter } = clickPhrases(named);
    const aim = parseClick(named);
    // The words as written first ("open link in new tab" can be a label).
    let ambiguous = false;
    for (const phrase of written) {
      const found = lookup(phrase, targets);
      if (found.match) return act("click", "CLICK", found.match);
      ambiguous ||= found.ambiguous;
    }
    // Several controls share the label, or the step says which one: kind, place and position decide. What does
    // not narrow down to one control is left alone (to a search, to the model), never guessed.
    if (ambiguous || aim.kind !== undefined || aim.within !== undefined || aim.ordinal !== undefined) {
      const picked = pick(aim, targets);
      if (picked) return act("click", "CLICK", picked);
      if (ambiguous || aim.within !== undefined) return revealed(mine) < MAX_REVEALS ? hiddenControl() : null;
    }
    for (const phrase of shorter) {
      const found = lookup(phrase, targets);
      if (found.match) return act("click", "CLICK", found.match);
      if (found.ambiguous) return null;
    }
    return hiddenControl();
    // Not on screen: if exactly one scrollable container hides it, scroll that one.
    function hiddenControl() {
      const hidden = revealed(mine) < MAX_REVEALS ? reveal([...written, ...shorter], observation) : null;
      return hidden ? act("reveal", hidden.operation, hidden.match) : null;
    }
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
