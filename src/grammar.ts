import { LEXICONS, type Language, type Lexicon } from "./lexicon.ts";
import { normalizeText } from "./normalize.ts";

// Builds, once per language, the patterns that read a step instruction from its lexicon. All text that these
// patterns see is folded by normalizeText first, and so are the lexicon words.

// Word edges that know every letter, not only ASCII ones.
const START = String.raw`(?<![\p{L}\p{N}_])`;
const END = String.raw`(?![\p{L}\p{N}_])`;

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** A pattern for the text as a whole word or phrase. */
export const wholeWord = (text: string) => new RegExp(`${START}${escapeRegExp(text)}${END}`, "u");

// One alternation of phrases, longest first so that "fill in" wins over "fill".
function alt(phrases: readonly string[]): string {
  const folded = [...new Set(phrases.map((phrase) => normalizeText(phrase)))].sort((a, b) => b.length - a.length);
  if (!folded.length) throw new Error("A lexicon list cannot be empty");
  return `(?:${folded.map((phrase) => escapeRegExp(phrase).replace(/ /g, String.raw`\s+`)).join("|")})`;
}
const foldedSet = (phrases: readonly string[]) => new Set(phrases.map((phrase) => normalizeText(phrase)));
const foldedMap = <T>(entries: Record<string, T>) =>
  new Map(Object.entries(entries).map(([word, value]) => [normalizeText(word), value] as const));

type ScrollOperation = "SCROLL_DOWN" | "SCROLL_UP" | "SCROLL_LEFT" | "SCROLL_RIGHT";

function compile(lexicon: Lexicon) {
  const first = lexicon.nounFirst === true;
  const article = alt(lexicon.articles);
  const optionalArticle = String.raw`(?:${article}\s+)?`;
  // A generic noun around a name ("Email field", "campo Email"): after it, or before it when nounFirst.
  const around = (nouns: readonly string[]) => {
    const noun = alt(nouns);
    return first ? { lead: String.raw`(?:${noun}\s+)?`, trail: "" } : { lead: "", trail: String.raw`(?:\s+${noun})?` };
  };
  const field = around(lexicon.fieldNouns);
  const dropdown = around([...lexicon.select.nouns, ...lexicon.fieldNouns]);
  const switchNoun = around(lexicon.toggle.nouns);
  const directions = new Map<string, ScrollOperation>();
  for (const [words, operation] of [
    [lexicon.scroll.down, "SCROLL_DOWN"],
    [lexicon.scroll.up, "SCROLL_UP"],
    [lexicon.scroll.left, "SCROLL_LEFT"],
    [lexicon.scroll.right, "SCROLL_RIGHT"],
  ] as const)
    for (const word of words) directions.set(normalizeText(word), operation);
  const kinds = foldedMap(lexicon.kinds);
  const kind = alt([...kinds.keys()]);
  const places = alt(lexicon.places);
  // "The Y <noun> <tail>": the noun after the name, or before it when nounFirst. Groups: `label`, then the tail's.
  const statement = (nouns: readonly string[], tail: string) =>
    new RegExp(
      first
        ? String.raw`^${optionalArticle}${alt(nouns)}\s+(?<label>.+?)\s+${tail}$`
        : String.raw`^${optionalArticle}(?<label>.+?)\s+${alt(nouns)}\s+${tail}$`,
      "u",
    );
  const contains = String.raw`${alt(lexicon.contains)}\s+(?<value>.+)`;
  const pressEnterPrefix = String.raw`^${alt(lexicon.pressEnter.verbs)}\s+${optionalArticle}${alt(lexicon.pressEnter.keys)}`;

  return {
    caution: new RegExp(`${START}${alt(lexicon.caution)}${END}`, "u"),
    typing: new RegExp(String.raw`^${alt(lexicon.type)}${END}`, "u"),
    // "fill the Y field with X": group `label` is Y.
    fillWith: new RegExp(
      String.raw`^${alt(lexicon.fill.verbs)}\s+${optionalArticle}${field.lead}(?<label>.+?)${field.trail}\s+${alt(lexicon.fill.with)}${END}`,
      "u",
    ),
    // "fill the Y field with X": groups `label` and `value`; the match has indices to cut X out of the text as written.
    fillValue: new RegExp(
      String.raw`^${alt(lexicon.fill.verbs)}\s+${optionalArticle}${field.lead}(?<label>.+?)${field.trail}\s+${alt(lexicon.fill.with)}\s+(?<value>.+)$`,
      "du",
    ),
    // "type X into the Y box to search" is read in three parts: the verb, each word that can start the field
    // (X is what lies between), and the field with its article, noun and purpose clause taken off.
    typeLead: new RegExp(String.raw`^${alt(lexicon.type)}\s+`, "u"),
    typeInto: new RegExp(String.raw`\s+${alt(lexicon.into)}\s+`, "gu"),
    typeField: new RegExp(
      String.raw`^${optionalArticle}${field.lead}(?<label>.+?)${field.trail}(?:\s+${alt(lexicon.to)}\s+.*)?$`,
      "u",
    ),
    // The field a step names after "into/in/on": group `label`, without its article, its noun and a purpose clause.
    field: new RegExp(
      String.raw`.*${START}${alt(lexicon.into)}\s+${optionalArticle}${field.lead}(?<label>.+?)${field.trail}(?:\s+${alt(lexicon.to)}\s+.*)?$`,
      "u",
    ),
    pressEnter: new RegExp(`${pressEnterPrefix}${END}`, "u"),
    pressEnterPrefix: new RegExp(String.raw`${pressEnterPrefix}\s*`, "u"),
    directions,
    scroll: new RegExp(
      String.raw`^${alt(lexicon.scroll.verbs)}\s+(?<direction>${alt([...directions.keys()])})${END}\s*(?<rest>.*)$`,
      "u",
    ),
    scrollWithin: new RegExp(String.raw`^(?:${alt([...lexicon.scroll.within, ...lexicon.articles])}\s+)+`, "u"),
    scrollPage: foldedSet(lexicon.scroll.page),
    scrollNoun: new RegExp(
      first ? String.raw`^${alt(lexicon.scroll.nouns)}\s+` : String.raw`\s+${alt(lexicon.scroll.nouns)}$`,
      "u",
    ),
    // "select X in the Y dropdown": groups `option` and `field`.
    choice: new RegExp(
      String.raw`^${alt(lexicon.select.verbs)}\s+${optionalArticle}(?<option>.+?)\s+${alt(lexicon.select.links)}\s+${optionalArticle}${dropdown.lead}(?<field>.+?)${dropdown.trail}$`,
      "u",
    ),
    // "check the Y checkbox": groups `verb` and `label`.
    toggle: new RegExp(
      String.raw`^(?<verb>${alt([...lexicon.toggle.on, ...lexicon.toggle.off])})\s+${optionalArticle}${switchNoun.lead}(?<label>.+?)${switchNoun.trail}$`,
      "u",
    ),
    toggleOn: foldedSet(lexicon.toggle.on),
    click: new RegExp(
      String.raw`^${alt(lexicon.click.verbs)}${END}(?:\s+${alt(lexicon.click.on)})?(?:\s+${article})?\s+(?<named>.+)$`,
      "u",
    ),
    ordinal: new RegExp(
      String.raw`^(?<word>${alt(Object.keys(lexicon.ordinals))}|\d+${alt(lexicon.numbered)})\s+(?<rest>.+)$`,
      "u",
    ),
    ordinals: foldedMap(lexicon.ordinals),
    kindPattern: new RegExp(
      first ? String.raw`^(?<kind>${kind})\s+(?<rest>.+)$` : String.raw`^(?<rest>.+?)\s+(?<kind>${kind})$`,
      "u",
    ),
    kinds,
    where: new RegExp(String.raw`\s+${alt(lexicon.where)}\s+`, "gu"),
    // What can start a place after "in": an article, a row, or (with the noun first) the noun for a place.
    placeStart: new RegExp(String.raw`^(?:${alt([...lexicon.articles, ...lexicon.rows])})${END}`, "u"),
    placeNoun: new RegExp(first ? String.raw`^${places}${END}` : String.raw`${START}${places}$`, "u"),
    dropArticle: new RegExp(String.raw`^${article}\s+`, "u"),
    dropRow: new RegExp(String.raw`^${alt(lexicon.rows)}\s+(?:${alt(lexicon.rowLinks)}\s+)?`, "u"),
    dropPlaceNoun: new RegExp(first ? String.raw`^${places}(?:\s+|$)` : String.raw`${START}${places}$`, "u"),
    dropRole: new RegExp(first ? String.raw`^${alt(lexicon.roles)}\s+` : String.raw`\s+${alt(lexicon.roles)}$`, "u"),
    dropClause: new RegExp(String.raw`\s+${alt(lexicon.clauses)}\s+.+$`, "u"),
    nounFirst: first,
    // "The Y box contains X": groups `label` and `value`.
    assume: statement(lexicon.fieldNouns, contains),
    // "The Y dropdown shows X": groups `label` and `value`.
    assumeDropdown: statement(lexicon.select.nouns, contains),
    // "The Y checkbox is checked": groups `label` and `state`.
    assumeSwitch: statement(
      lexicon.toggle.nouns,
      String.raw`(?<state>${alt([...lexicon.checked, ...lexicon.unchecked])})`,
    ),
    checkedStates: foldedSet(lexicon.checked),
  };
}

export type Grammar = ReturnType<typeof compile>;
const compiled = new Map<Language, Grammar>();

export function grammarFor(language: Language): Grammar {
  let grammar = compiled.get(language);
  if (!grammar) {
    grammar = compile(LEXICONS[language]);
    compiled.set(language, grammar);
  }
  return grammar;
}
