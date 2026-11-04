// Reads a check written as an English sentence into the assertion it means:
//   "The page shows Large language model"      -> { text }
//   "I see Large language model"               -> { text }
//   "The URL is https://example.com/a"         -> { url }
//   "The URL is https://example.com/a and the page shows Hello" -> { url, text }
// A text can be in quotes to keep a trailing period or the word "and" in it. Anything else returns null.

type Parsed = { text?: string | undefined; url?: string | undefined };

const SHOWS =
  /^(?:the\s+)?(?:page|screen|app|site)(?:\s+now)?\s+(?:shows?|contains?|displays?|has|have|includes?|says|reads)\s+(?<text>.+)$/i;
const SEE = /^(?:i\s+|we\s+)?(?:should\s+|can\s+)?see(?:\s+that)?\s+(?<text>.+)$/i;
const VISIBLE = /^(?<text>.+?)\s+(?:is|are)\s+(?:visible|shown|displayed)(?:\s+on\s+the\s+page)?$/i;
const URL_IS = /^(?:the\s+)?(?:page\s+)?url\s+(?:is|equals|becomes|should\s+be)\s+(?<url>\S+)$/i;

// A text in matching quotes is taken as written; otherwise one closing period belongs to the sentence.
function plain(value: string): string {
  const quoted = value.match(/^(["'“‘])(.*)(["'”’])$/s);
  return quoted ? quoted[2]! : value.replace(/\.$/, "");
}

function clause(sentence: string): Parsed | null {
  const url = sentence.match(URL_IS)?.groups?.url;
  if (url) return { url: plain(url) };
  const text = (sentence.match(SHOWS) ?? sentence.match(SEE) ?? sentence.match(VISIBLE))?.groups?.text;
  return text ? { text: plain(text.trim()) } : null;
}

export function parseExpectation(sentence: string): Parsed | null {
  const whole = sentence.trim().replace(/\s+/g, " ");
  const single = clause(whole);
  if (single) return single;
  // Two clauses joined by "and": a URL and a text, in either order.
  for (const join of whole.matchAll(/\s+and\s+/gi)) {
    const first = clause(whole.slice(0, join.index));
    const second = clause(whole.slice(join.index + join[0].length));
    if (first && second && (first.url === undefined) !== (second.url === undefined)) return { ...first, ...second };
  }
  return null;
}
