import type { Decision, Observation, RunInput, Target } from "./contracts.ts";
import { textModelFor } from "./decision.ts";
import { grammarFor, wholeWord, type Grammar } from "./grammar.ts";
import type { Language } from "./lexicon.ts";
import { normalizeText, words } from "./normalize.ts";

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

// The words of each language are in src/lexicon.ts; src/grammar.ts builds the patterns used below.
const ENGLISH: readonly Language[] = ["en"];

// The dropdowns on screen whose label has every word of the phrase.
function dropdownsNamed(phrase: string, observation: Observation) {
  const wanted = words(phrase);
  return observation.elements.filter((element) => {
    const have = new Set(words(element.label));
    return element.operations.includes("SELECT") && wanted.every((word) => have.has(word));
  });
}
const switchesOf = (observation: Observation) =>
  Object.fromEntries(
    Object.entries(observation.targets.CLICK ?? {}).filter(([, target]) =>
      ["checkbox", "switch"].includes(target.role ?? ""),
    ),
  );

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

/**
 * What a click step names. `label` is the control's own words. What narrows it down is optional: its `kind`
 * ("the Pay button"), its place among the same ones ("the second Delete", "the last Edit": `ordinal`, -1 for the
 * last) and where it is ("in the row of Order #1002", "in the Billing section": `within`).
 */
export type ClickAim = { label: string; kind?: string; ordinal?: number; within?: string };
export function parseClick(named: string, grammar: Grammar = grammarFor("en")): ClickAim {
  const takeKind = (text: string) => {
    const found = text.match(grammar.kindPattern)?.groups;
    return found ? { rest: found.rest!, kind: grammar.kinds.get(found.kind!) } : { rest: text, kind: undefined };
  };
  // The noun for a kind of control trails the label ("Pay button") or, in some languages, leads it ("botão Pagar").
  let { rest, kind } = grammar.nounFirst ? { rest: named, kind: undefined } : takeKind(named);
  let within: string | undefined;
  // "in the ...", "from the ... list", "in row 3": a place, not part of the label ("sign in with Google" is a label).
  for (const found of rest.matchAll(grammar.where)) {
    const tail = rest.slice(found.index + found[0].length);
    if (!grammar.placeStart.test(tail) && !grammar.placeNoun.test(tail)) continue;
    within =
      tail.replace(grammar.dropArticle, "").replace(grammar.dropRow, "").replace(grammar.dropPlaceNoun, "").trim() ||
      undefined;
    rest = rest.slice(0, found.index);
    if (kind === undefined && !grammar.nounFirst) ({ rest, kind } = takeKind(rest));
    break;
  }
  let ordinal: number | undefined;
  const nth = rest.match(grammar.ordinal)?.groups;
  if (nth) {
    ordinal = grammar.ordinals.get(nth.word!) ?? Number.parseInt(nth.word!, 10);
    rest = nth.rest!;
  }
  if (grammar.nounFirst) ({ rest, kind } = takeKind(rest));
  return {
    label: rest,
    ...(kind ? { kind } : {}),
    ...(ordinal === undefined ? {} : { ordinal }),
    ...(within ? { within } : {}),
  };
}

/** The aim of a click step, or null when the step is not a plain click. Each language is tried in turn. */
export function clickAim(instruction: string, languages: readonly Language[] = ENGLISH): ClickAim | null {
  const text = normalizeText(instruction);
  for (const language of languages) {
    const grammar = grammarFor(language);
    if (grammar.caution.test(text)) continue;
    const named = text.match(grammar.click)?.groups?.named;
    if (named) return parseClick(named, grammar);
  }
  return null;
}

// The phrase as written and without a trailing role word ("log in link" can be a label); then the shorter ones,
// without a trailing "from/near/in ..." clause, which say less about where the control is.
function clickPhrases(named: string, grammar: Grammar): { written: string[]; shorter: string[] } {
  const withoutRole = (phrase: string) => phrase.replace(grammar.dropRole, "");
  const withoutClause = (phrase: string) => phrase.replace(grammar.dropClause, "");
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

function fieldPhrase(text: string, grammar: Grammar): string | undefined {
  return text.match(grammar.field)?.groups?.label;
}

/** The first language of the test that settles the step, or null when none does. */
export function resolveFast(
  input: RunInput,
  stepIndex: number,
  observation: Observation,
  history: ActionRecord[],
): FastDecision | null {
  for (const language of input.languages) {
    const decision = resolveIn(grammarFor(language), input, stepIndex, observation, history);
    if (decision) return decision;
  }
  return null;
}

// The text in a typing step and the field it goes to: "Type IPv4 into the Search box", "Fill in the Login field with
// "ana"". A quoted text is always the text to type. Without quotes it is only read when no text model is set up to
// write it. Where the sentence could split in more than one place ("Type Sign in into the Login box"), the split
// whose field the page has wins; a field that is not there yet (to be revealed) takes the last one.
function typedText(
  grammar: Grammar,
  raw: string,
  targets: Record<string, Target> | undefined,
  textModel: boolean,
): { text: string; label: string } | null {
  const written = raw.trim();
  // Fold one character at a time so a place in the folded text is a place in the text as written.
  let folded = "";
  const at: number[] = [];
  let position = 0;
  for (const character of written) {
    const piece = character
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase();
    for (let index = 0; index < piece.length; index++) at.push(position);
    folded += piece;
    position += character.length;
  }
  at.push(written.length);
  const candidates: { text: string; label: string }[] = [];
  const add = (from: number, to: number, label: string | undefined) => {
    const cut = written.slice(at[from], at[to]).trim();
    const quoted = cut.match(/^(["“'‘])(.+)(["”'’])$/s);
    if (!label || !cut || (!quoted && textModel)) return;
    candidates.push({ text: quoted ? quoted[2]! : cut, label });
  };
  const fill = folded.match(grammar.fillValue);
  if (fill?.indices?.groups?.value) add(fill.indices.groups.value[0], fill.indices.groups.value[1], fill.groups?.label);
  const lead = folded.match(grammar.typeLead);
  if (lead && !fill)
    for (const into of [...folded.matchAll(grammar.typeInto)].reverse()) {
      if (into.index < lead[0].length) continue;
      add(
        lead[0].length,
        into.index,
        folded.slice(into.index + into[0].length).match(grammar.typeField)?.groups?.label,
      );
    }
  return candidates.find((item) => lookup(item.label, targets).match) ?? candidates[0] ?? null;
}

function resolveIn(
  grammar: Grammar,
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
  const typing = grammar.typing.test(instruction);
  if (step.selector !== undefined && !typing) return null;
  if (grammar.caution.test(instruction)) return null;
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

  const scroll = instruction.match(grammar.scroll)?.groups;
  if (scroll) {
    const operation = grammar.directions.get(scroll.direction!)!;
    if (triedFast(operation)) return done("scroll");
    const options = observation.targets[operation];
    if (options && Object.keys(options).length) {
      // Containers can scroll: the instruction has to name one, or say "the page".
      const named = scroll.rest!.replace(grammar.scrollWithin, "").trim();
      if (!named || grammar.scrollPage.has(named))
        return options.page ? act("scroll", operation, { id: "page", target: options.page }) : null;
      // As written first, then without a trailing noun ("the Results list" names a container called "Results").
      for (const phrase of new Set([named, named.replace(grammar.scrollNoun, "")])) {
        const found = lookup(phrase, options);
        if (found.match) return act("scroll", operation, found.match);
        if (found.ambiguous) return null;
      }
      return null;
    }
    return observation.controls?.includes(operation) ? act("scroll", operation) : null;
  }

  if (typing) {
    const given = step.value !== undefined || step.valueFromEnv !== undefined;
    const written = given
      ? null
      : typedText(grammar, step.instruction, observation.targets.TYPE_TEXT, textModelFor(input) !== undefined);
    if (!given && !written) return null;
    const literal = step.value ?? written?.text;
    const value = literal === undefined ? undefined : normalizeText(literal);
    // The value may sit between the verb and the field ("type IPv4 into the box"); keep it out of the label.
    // Whole word only: the value "log" must not be cut out of "login".
    const stripped = value && !written ? instruction.replace(wholeWord(value), " ").replace(/\s+/g, " ") : instruction;
    const label = written?.label ?? stripped.match(grammar.fillWith)?.groups?.label ?? fieldPhrase(stripped, grammar);
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
    if (triedFast("TYPE_TEXT")) return null;
    return written ? { ...act("type", "TYPE_TEXT", match), text: written.text } : act("type", "TYPE_TEXT", match);
  }

  if (grammar.pressEnter.test(instruction)) {
    if (triedFast("PRESS_ENTER")) return null;
    const targets = observation.targets.PRESS_ENTER;
    const label = fieldPhrase(instruction.replace(grammar.pressEnterPrefix, ""), grammar);
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

  const choice = instruction.match(grammar.choice)?.groups;
  if (choice) {
    // Once the dropdown shows the option, the step is done; the page says so, not the model.
    const fields = dropdownsNamed(choice.field!, observation);
    if (fields.length === 1 && normalizeText(fields[0]!.value) === normalizeText(choice.option!)) return done("select");
    const match = matchOption(choice.field!, choice.option!, observation.targets.SELECT);
    return match && !triedFast("SELECT") ? act("select", "SELECT", match) : null;
  }

  const toggle = instruction.match(grammar.toggle)?.groups;
  if (toggle) {
    const wanted = grammar.toggleOn.has(toggle.verb!) ? "true" : "false";
    const match = matchTargets(toggle.label!, switchesOf(observation));
    if (!match || (match.target.checked !== "true" && match.target.checked !== "false")) return null;
    if (match.target.checked === wanted) return done("toggle");
    return triedFast("CLICK") ? null : act("toggle", "CLICK", match);
  }

  const click = instruction.match(grammar.click)?.groups;
  if (click) {
    if (triedFast("CLICK")) return null;
    const targets = observation.targets.CLICK;
    const named = click.named!;
    const { written, shorter } = clickPhrases(named, grammar);
    const aim = parseClick(named, grammar);
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
 * Answers "The <field> box contains <value>", "The <dropdown> shows <option>" and "The <checkbox> is checked" from
 * the page itself. Returns undefined when the statement is not of one of these forms or names no single control,
 * so the model is asked instead.
 */
export function assumeDeterministic(
  statement: string,
  observation: Observation,
  languages: readonly Language[] = ENGLISH,
): boolean | undefined {
  const text = normalizeText(statement);
  for (const language of languages) {
    const grammar = grammarFor(language);
    if (grammar.caution.test(text)) continue;
    const parsed = text.match(grammar.assume)?.groups;
    const field = parsed && matchTargets(parsed.label!, observation.targets.TYPE_TEXT);
    if (field) return normalizeText(field.target.currentValue ?? "") === parsed.value;
    const shown = text.match(grammar.assumeDropdown)?.groups;
    const dropdowns = shown ? dropdownsNamed(shown.label!, observation) : [];
    if (dropdowns.length === 1) return normalizeText(dropdowns[0]!.value) === shown!.value;
    const state = text.match(grammar.assumeSwitch)?.groups;
    const control = state && matchTargets(state.label!, switchesOf(observation));
    if (control && (control.target.checked === "true" || control.target.checked === "false"))
      return (control.target.checked === "true") === grammar.checkedStates.has(state.state!);
  }
  return undefined;
}
