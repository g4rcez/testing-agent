/**
 * Folds text for matching: Unicode compatibility forms, accents, case, zero-width characters,
 * typographic quotes and dashes, and runs of whitespace. With `caseSensitive`, case and accents are
 * kept. This function is also serialized into the page for assertions, so it must stay
 * self-contained: no imports and no references to anything outside its body.
 */
export function normalizeText(text: string, caseSensitive = false): string {
  let out = String(text).normalize("NFKD");
  if (!caseSensitive) out = out.replace(/\p{M}+/gu, "");
  out = out
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return caseSensitive ? out.normalize("NFC") : out.toLowerCase();
}

/** Same address after URL parsing: scheme and host ignore case, the path and query keep it. */
export function urlsEqual(expected: string, actual: string): boolean {
  try {
    return new URL(expected).href === new URL(actual).href;
  } catch {
    return expected === actual;
  }
}
