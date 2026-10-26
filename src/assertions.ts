import { z } from "zod";
import type { Assertion } from "./contracts.ts";
import { normalizeText } from "./normalize.ts";

export const assertionResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({ passed: z.boolean(), index: z.number(), message: z.string() })),
});
export type AssertionResult = z.infer<typeof assertionResultSchema>;

function assertInPage(
  assertions: Assertion[],
  timeoutMs: number,
  normalize: (text: string, caseSensitive?: boolean) => string,
): Promise<AssertionResult> {
  return new Promise((resolve) => {
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      assertions.map((assertion, index) => {
        try {
          const exact = assertion.caseSensitive === true;
          const sameUrl = (expected: string) => {
            try {
              return new URL(expected, location.href).href === location.href;
            } catch {
              return location.href === expected;
            }
          };
          let passed =
            (assertion.text === undefined ||
              normalize(document.body.innerText, exact).includes(normalize(assertion.text, exact))) &&
            (assertion.url === undefined || sameUrl(assertion.url));
          if (assertion.selector !== undefined) {
            const elements = Array.from(document.querySelectorAll(assertion.selector));
            if (assertion.count !== undefined) passed &&= elements.length === assertion.count;
            else if (assertion.visible !== false) passed &&= elements.length === 1;
            if (assertion.visible !== undefined)
              passed &&= assertion.visible
                ? elements.length > 0 &&
                  elements.every((element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
                : elements.every(
                    (element) => !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
                  );
            if (assertion.value !== undefined)
              passed &&=
                elements.length === 1 &&
                (elements[0] instanceof HTMLInputElement ||
                  elements[0] instanceof HTMLSelectElement ||
                  elements[0] instanceof HTMLTextAreaElement) &&
                (exact
                  ? elements[0].value === assertion.value
                  : normalize(elements[0].value) === normalize(assertion.value));
            if (assertion.checked !== undefined)
              passed &&=
                elements.length === 1 &&
                (elements[0] instanceof HTMLInputElement
                  ? elements[0].checked === assertion.checked
                  : elements[0]?.getAttribute("aria-checked") === String(assertion.checked));
          }
          return { index, passed, message: passed ? "Assertion passed" : "Expected frontend state was not observed" };
        } catch {
          return { index, passed: false, message: "Invalid or unsupported assertion selector" };
        }
      });
    const finish = (checks: AssertionResult["checks"]) => {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      window.removeEventListener("hashchange", evaluate);
      window.removeEventListener("popstate", evaluate);
      document.removeEventListener("input", evaluate);
      document.removeEventListener("change", evaluate);
      resolve({ passed: checks.every((item) => item.passed), checks });
    };
    const evaluate = () => {
      const checks = check();
      if (checks.every((item) => item.passed)) finish(checks);
    };
    const initial = check();
    if (initial.every((item) => item.passed) || timeoutMs === 0) {
      finish(initial);
      return;
    }
    observer = new MutationObserver(evaluate);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    window.addEventListener("hashchange", evaluate);
    window.addEventListener("popstate", evaluate);
    document.addEventListener("input", evaluate);
    document.addEventListener("change", evaluate);
    timer = setTimeout(() => finish(check()), timeoutMs);
    evaluate();
  });
}

export function assertionExpression(assertions: Assertion[], timeoutMs: number): string {
  return `(${assertInPage.toString()})(${JSON.stringify(assertions)},${timeoutMs},${normalizeText.toString()})`;
}
