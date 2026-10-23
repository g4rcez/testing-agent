import { expect, test } from "bun:test";
import { assertionExpression } from "../../src/assertions.ts";
import { normalizeText, urlsEqual } from "../../src/normalize.ts";

test("normalizeText folds case, accents, spacing, quotes, dashes and invisible characters", () => {
  expect(normalizeText("  Find   A STAY  ")).toBe("find a stay");
  expect(normalizeText("Café Müller")).toBe("cafe muller");
  expect(normalizeText("ﬁne “quotes” and ‘single’ — dash​")).toBe("fine \"quotes\" and 'single' - dash");
  expect(normalizeText("Zero­width﻿")).toBe("zerowidth");
  expect(normalizeText("İstanbul")).toBe(normalizeText("istanbul"));
});

test("caseSensitive keeps case and accents but still collapses whitespace", () => {
  expect(normalizeText("  Café   Müller ", true)).toBe("Café Müller");
  expect(normalizeText("Café", true)).not.toBe(normalizeText("Cafe", true));
  expect(normalizeText("Find a STAY", true)).not.toBe(normalizeText("find a stay", true));
});

test("urlsEqual ignores scheme and host case but keeps the path case", () => {
  expect(urlsEqual("HTTPS://EN.Wikipedia.org/wiki/IPv4", "https://en.wikipedia.org/wiki/IPv4")).toBe(true);
  expect(urlsEqual("https://example.com:443/a", "https://example.com/a")).toBe(true);
  expect(urlsEqual("https://en.wikipedia.org/wiki/ipv4", "https://en.wikipedia.org/wiki/IPv4")).toBe(false);
  expect(urlsEqual("not a url", "not a url")).toBe(true);
});

test("the copy shipped into the page folds text exactly like the module", () => {
  const expression = assertionExpression([{ text: "x", timeoutMs: 0 }], 0);
  const source = expression.slice(expression.lastIndexOf(",function normalizeText") + 1, -1);
  // eslint-disable-next-line no-new-func
  const shipped = new Function(`return (${source})`)() as typeof normalizeText;
  for (const sample of ["  Find   A STAY ", "Café Müller", "ﬁne “q” — d​", "İstanbul"])
    for (const exact of [false, true]) expect(shipped(sample, exact)).toBe(normalizeText(sample, exact));
});
