import { expect, test } from "bun:test";
import type { Observation } from "../../src/contracts.ts";
import { isOnScreen, searchPlan } from "../../src/search.ts";

const page = (...labels: string[]): Observation => ({
  url: "https://example.com",
  tree: "",
  fingerprint: "one",
  targets: {},
  elements: labels.map((label, at) => ({ index: `e${at}`, label, role: "button", value: "", operations: ["CLICK"] })),
});

test("a click step names what to look for, and a label with digits names one thing", () => {
  expect(searchPlan({ instruction: "Click Open order #08731" })).toEqual({ needle: "open order #08731", exact: true });
  expect(searchPlan({ instruction: "Click the Confirm subscription button" })).toEqual({
    needle: "confirm subscription",
    exact: false,
  });
  expect(searchPlan({ instruction: "Open invoice 4217 from the list" })).toEqual({
    needle: "invoice 4217",
    exact: true,
  });
});

test("the words around the label are left out of what is looked for", () => {
  // "on the" before the label, a role word after it, and where it is ("from ...") are not part of the label.
  expect(searchPlan({ instruction: "Click on the Settings tab" })?.needle).toBe("settings");
  expect(searchPlan({ instruction: "Tap the Delete link from the Orders list" })?.needle).toBe("delete");
  // A role word inside the label is part of it; only a trailing one is dropped.
  expect(searchPlan({ instruction: "Click Save icon settings" })?.needle).toBe("save icon settings");
});

test("steps that do not name a control to click are not searched for", () => {
  expect(searchPlan({ instruction: "Scroll down" })).toBeNull();
  expect(searchPlan({ instruction: "Type ada into the Name field" })).toBeNull();
  expect(searchPlan({ instruction: "Click Log in if it is shown" })).toBeNull();
  expect(searchPlan({ instruction: "Click Open order #08731", selector: "#orders button" })).toBeNull();
  expect(searchPlan({ instruction: "Click !!!" })).toBeNull();
  // The click has to be what the step says first, not something mentioned later in it.
  expect(searchPlan({ instruction: "Please click Save" })).toBeNull();
});

test("a control is on screen when one of the elements has every word of the label", () => {
  const orders = page("Open order #00003", "Open order #00004", "Filter");
  expect(isOnScreen({ needle: "open order #00004" }, orders)).toBe(true);
  expect(isOnScreen({ needle: "order 00003" }, orders)).toBe(true);
  expect(isOnScreen({ needle: "open order #08731" }, orders)).toBe(false);
  expect(isOnScreen({ needle: "export" }, orders)).toBe(false);
  expect(isOnScreen({ needle: "open order" }, page())).toBe(false);
});

test("labels are compared without case, accents or punctuation", () => {
  expect(isOnScreen({ needle: "café menu" }, page("CAFE — Menu"))).toBe(true);
  expect(isOnScreen({ needle: "cafe menus" }, page("CAFE — Menu"))).toBe(false);
});

test("a step can say which control it means: by row, section, kind or place", () => {
  expect(searchPlan({ instruction: "Click Delete in the row of Order #1002" })).toEqual({
    needle: "delete",
    within: "order #1002",
    exact: true,
  });
  expect(searchPlan({ instruction: "Click the Edit button in the Billing section" })).toEqual({
    needle: "edit",
    within: "billing",
    exact: false,
  });
  // A place is only taken for one when it reads like one: this is a label.
  expect(searchPlan({ instruction: "Click Sign in with Google" })).toEqual({
    needle: "sign in with google",
    exact: false,
  });
  expect(searchPlan({ instruction: "Click Log in link" })).toEqual({ needle: "log in", exact: false });
  // "The second Delete" means the second one on screen; there is nothing to look for.
  expect(searchPlan({ instruction: "Click the second Delete button" })).toBeNull();
});

test("a control is on screen only in the place that was asked for", () => {
  const rows = (context: string) => ({ ref: "e1", label: "Delete", role: "button", context });
  const observation: Observation = {
    ...page("Delete"),
    targets: { CLICK: { e1: rows("Order #1001 Ada | Orders"), e2: rows("Order #1002 Grace | Orders") } },
  };
  expect(isOnScreen({ needle: "delete", within: "order #1002" }, observation)).toBe(true);
  expect(isOnScreen({ needle: "delete", within: "order #1009" }, observation)).toBe(false);
  expect(isOnScreen({ needle: "delete", within: "billing" }, observation)).toBe(false);
  expect(isOnScreen({ needle: "delete" }, observation)).toBe(true);
});

test("only what reads like a place is taken for one", () => {
  // These keep the words after "in": they do not start with "the" or "row", nor end with a container word.
  expect(searchPlan({ instruction: "Click Join in form builder pro" })?.needle).toBe("join in form builder pro");
  expect(searchPlan({ instruction: "Click Chat in all the rooms" })?.needle).toBe("chat in all the rooms");
  expect(searchPlan({ instruction: "Click Edit in the Billing section" })?.within).toBe("billing");
  expect(searchPlan({ instruction: "Click Edit in the Orders table" })?.within).toBe("orders");
  expect(searchPlan({ instruction: "Click Delete in row 3" })?.within).toBe("3");
});
