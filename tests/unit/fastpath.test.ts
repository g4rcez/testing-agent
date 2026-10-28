import { expect, test } from "bun:test";
import { runSchema, type Observation, type Target } from "../../src/contracts.ts";
import { assumeDeterministic, matchTargets, resolveFast } from "../../src/fastpath.ts";

const target = (ref: string, label: string, role: string, extra: Partial<Target> = {}): Target => ({
  ref,
  label,
  role,
  ...extra,
});
const page = (targets: Observation["targets"], controls?: string[]): Observation => ({
  url: "https://example.com",
  tree: "App",
  fingerprint: "one",
  elements: [],
  snapshotId: "snap",
  targets,
  ...(controls ? { controls } : {}),
});
const search = target("e3", "Search Wikipedia", "searchbox", { currentValue: "" });
const wiki = page({
  TYPE_TEXT: { e3: search },
  PRESS_ENTER: { e3: search },
  CLICK: { e4: target("e4", "Log in", "link"), e5: target("e5", "View Casa Flora", "link") },
});
const run = (steps: unknown[]) =>
  runSchema.parse({ prompt: "Test", steps, session: "fast", backend: { provider: "laya" }, expect: [{ text: "App" }] });

test("typing a known value into a named field is resolved without the model", () => {
  const input = run([{ instruction: "Type IPv4 into the SEARCH Wikipedia box", value: "IPv4" }]);
  expect(resolveFast(input, 0, wiki, [])).toMatchObject({
    operation: "TYPE_TEXT",
    targetId: "e3",
    source: "fast",
    rule: "type",
    confidence: 1,
    snapshotId: "snap",
  });
  const filled = page({ ...wiki.targets, TYPE_TEXT: { e3: { ...search, currentValue: "ipv4" } } });
  expect(resolveFast(input, 0, filled, [])).toMatchObject({ operation: "DONE", rule: "type" });
  // A field that did not take the value goes to the model instead of being typed into again.
  expect(
    resolveFast(input, 0, wiki, [{ stepIndex: 0, operation: "TYPE_TEXT", target: "Search Wikipedia", source: "fast" }]),
  ).toBeNull();
  expect(resolveFast(run([{ instruction: "Type IPv4 into the Search Wikipedia box" }]), 0, wiki, [])).toBeNull();
  // A secret is bound to a selector; with no field on the page marked as matching it, the step is left to the model.
  expect(
    resolveFast(
      run([{ instruction: "Fill in the Search Wikipedia field with x", valueFromEnv: "TOKEN", selector: "#q" }]),
      0,
      wiki,
      [],
    ),
  ).toBeNull();
});

test("a step bound to a selector types into the field the page marked as matching it", () => {
  const password = target("e7", "Password", "textbox", { currentValue: "", bound: true });
  const form = page({ TYPE_TEXT: { e6: target("e6", "Username", "textbox", { currentValue: "" }), e7: password } });
  const input = run([
    { instruction: "Type the password into the Password field", valueFromEnv: "PASSWORD", selector: "#password" },
  ]);
  expect(resolveFast(input, 0, form, [])).toMatchObject({ operation: "TYPE_TEXT", targetId: "e7", rule: "type" });
  // Typed once, the field shows something (a password field shows <redacted>), and the step is done.
  const typed = page({ TYPE_TEXT: { e7: { ...password, currentValue: "<redacted>" } } });
  const history = [{ stepIndex: 0, operation: "TYPE_TEXT", target: "Password", source: "fast" }];
  expect(resolveFast(input, 0, typed, history)).toMatchObject({ operation: "DONE", rule: "type" });
  // A field that is still empty after typing goes to the model instead of being typed into again.
  expect(resolveFast(input, 0, form, history)).toBeNull();
  // Two fields match the selector: that is a guess, so the model decides.
  const twins = page({ TYPE_TEXT: { e7: password, e8: { ...password, ref: "e8" } } });
  expect(resolveFast(input, 0, twins, [])).toBeNull();
  // The selector is no license to click: only typing is settled here.
  expect(
    resolveFast(
      run([{ instruction: "Click Log in", selector: "#login" }]),
      0,
      page({ CLICK: { e4: target("e4", "Log in", "link", { bound: true }) } }),
      [],
    ),
  ).toBeNull();
});

test("Enter is pressed in the named field, the field just typed into, or the only field", () => {
  const input = run([
    { instruction: "Press Enter in the Search Wikipedia box to search" },
    { instruction: "Press Enter" },
  ]);
  expect(resolveFast(input, 0, wiki, [])).toMatchObject({
    operation: "PRESS_ENTER",
    targetId: "e3",
    rule: "press-enter",
  });
  const typed = [{ stepIndex: 0, operation: "TYPE_TEXT", target: "Search Wikipedia", source: "fast" }];
  expect(resolveFast(input, 1, wiki, typed)).toMatchObject({ operation: "PRESS_ENTER", targetId: "e3" });
  expect(resolveFast(input, 1, wiki, [])).toMatchObject({ operation: "PRESS_ENTER", targetId: "e3" });
  const two = page({ PRESS_ENTER: { e1: target("e1", "From", "textbox"), e2: target("e2", "To", "textbox") } });
  expect(resolveFast(input, 1, two, [])).toBeNull();
  expect(resolveFast(input, 0, two, [])).toBeNull();
});

test("a click needs exactly one control that the instruction names", () => {
  const input = run([
    { instruction: "Click the Log in link" },
    { instruction: "Open Casa Flora" },
    { instruction: "Click Save" },
    { instruction: "Click Search" },
  ]);
  expect(resolveFast(input, 0, wiki, [])).toMatchObject({ operation: "CLICK", targetId: "e4", rule: "click" });
  expect(resolveFast(input, 1, wiki, [])).toMatchObject({ operation: "CLICK", targetId: "e5" });
  expect(resolveFast(input, 2, wiki, [])).toBeNull();
  // A trailing role word can be part of the label itself.
  const tabLink = page({ CLICK: { t: target("t", "Open link in new tab", "link") } });
  expect(resolveFast(run([{ instruction: "Click Open link in new tab" }]), 0, tabLink, [])).toMatchObject({
    operation: "CLICK",
    targetId: "t",
  });
  const twins = page({ CLICK: { a: target("a", "Search", "button"), b: target("b", "Search", "link") } });
  expect(resolveFast(input, 3, twins, [])).toBeNull();
  const wordy = page({
    CLICK: { a: target("a", "Search flights", "button"), b: target("b", "Search hotels", "button") },
  });
  expect(resolveFast(input, 3, wordy, [])).toBeNull();
  expect(
    resolveFast(input, 0, wiki, [{ stepIndex: 0, operation: "CLICK", target: "Log in", source: "fast" }]),
  ).toBeNull();
});

test("conditional, negated and selector-bound steps are left to the model", () => {
  const input = run([
    { instruction: "Click Log in if it is shown" },
    { instruction: "Never click Log in" },
    { instruction: "Click Log in", selector: "#login" },
    { instruction: "Click Log in or Sign up" },
  ]);
  for (const index of [0, 1, 2, 3]) expect(resolveFast(input, index, wiki, [])).toBeNull();
});

test("dropdown choices, switches and scrolling have their own rules", () => {
  const form = page(
    {
      SELECT: {
        "e1:1": target("e1:1", "Category → Design", "combobox"),
        "e1:2": target("e1:2", "Category → Travel", "combobox"),
      },
      CLICK: {
        e9: target("e9", "Notifications", "switch", { checked: "false" }),
        e8: target("e8", "Marketing emails", "checkbox", { checked: "true" }),
        e7: target("e7", "Beta", "checkbox"),
      },
    },
    ["SCROLL_DOWN"],
  );
  const input = run([
    { instruction: "Select Design as the Category" },
    { instruction: "Enable notifications" },
    { instruction: "Check marketing emails" },
    { instruction: "Enable beta" },
    { instruction: "Scroll down" },
    { instruction: "Scroll up" },
  ]);
  expect(resolveFast(input, 0, form, [])).toMatchObject({ operation: "SELECT", targetId: "e1:1", rule: "select" });
  const chosen = {
    ...form,
    elements: [{ index: "e1", label: "Category", role: "combobox", value: "Design", operations: ["SELECT"] }],
  };
  expect(resolveFast(input, 0, chosen, [])).toMatchObject({ operation: "DONE", rule: "select" });
  expect(resolveFast(input, 1, form, [])).toMatchObject({ operation: "CLICK", targetId: "e9", rule: "toggle" });
  expect(resolveFast(input, 2, form, [])).toMatchObject({ operation: "DONE", rule: "toggle" });
  expect(resolveFast(input, 3, form, [])).toBeNull();
  expect(resolveFast(input, 4, form, [])).toMatchObject({ operation: "SCROLL_DOWN", rule: "scroll" });
  expect(resolveFast(input, 4, form, [{ stepIndex: 4, operation: "SCROLL_DOWN", source: "fast" }])).toMatchObject({
    operation: "DONE",
  });
  expect(resolveFast(input, 5, form, [])).toBeNull();
});

test("matchTargets prefers an exact label and never relaxes past an ambiguous tier", () => {
  const targets = {
    a: target("a", "Search", "button"),
    b: target("b", "Search Wikipedia", "searchbox"),
    c: target("c", "searchbox", "searchbox"),
  };
  expect(matchTargets("search", targets)?.id).toBe("a");
  expect(matchTargets("wikipedia", targets)?.id).toBe("b");
  expect(matchTargets("searchbox", targets)).toBeNull();
  expect(matchTargets("", targets)).toBeNull();
  expect(matchTargets("search", { a: targets.a, d: target("d", "SEARCH", "link") })).toBeNull();
});

test("a field assumption is answered from the page, or left to the model", () => {
  const typed = page({ TYPE_TEXT: { e3: { ...search, currentValue: "IPv4" } } });
  expect(assumeDeterministic("The Search Wikipedia box contains IPv4", typed)).toBe(true);
  expect(assumeDeterministic("the search wikipedia BOX contains ipv4", typed)).toBe(true);
  expect(assumeDeterministic("The Search Wikipedia box contains IPv6", typed)).toBe(false);
  expect(assumeDeterministic("The Missing box contains IPv4", typed)).toBeUndefined();
  expect(assumeDeterministic("The page shows the article", typed)).toBeUndefined();
  expect(assumeDeterministic("The Search Wikipedia box contains IPv4 or IPv6", typed)).toBeUndefined();
});

const container = (id: string, label: string, below: string[], above: string[] = []): Target =>
  target(id, label, "scrollable", {
    currentValue: "0% scrolled",
    scroll: { progress: 0, below: below.length, above: above.length, belowLabels: below, aboveLabels: above },
  });
const items = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `Item ${from + index}`);

test("a control that a scrollable container hides is revealed by scrolling that container", () => {
  const list = container("s1", "Results", items(8, 40));
  const filters = container("s2", "Filters", ["Category", "Price"]);
  const screen = page({
    CLICK: { a: target("a", "Item 1", "button") },
    SCROLL_DOWN: { s1: list, s2: filters, page: target("page", "Page", "scrollable") },
  });
  const input = run([
    { instruction: "Click Item 30" },
    { instruction: "Click Item 3" },
    { instruction: "Click Price" },
    { instruction: "Click Item 999" },
    { instruction: "Type hello into the Price field", value: "hello" },
  ]);
  expect(resolveFast(input, 0, screen, [])).toMatchObject({ operation: "SCROLL_DOWN", targetId: "s1", rule: "reveal" });
  // "Item 3" is not hidden anywhere exactly, and no hidden label holds just those words: not guessed.
  expect(resolveFast(input, 1, screen, [])).toBeNull();
  expect(resolveFast(input, 2, screen, [])).toMatchObject({ operation: "SCROLL_DOWN", targetId: "s2" });
  expect(resolveFast(input, 3, screen, [])).toBeNull();
  const above = page({ SCROLL_UP: { s1: container("s1", "Results", [], items(1, 7)) } });
  expect(resolveFast(run([{ instruction: "Click Item 4" }]), 0, above, [])).toMatchObject({
    operation: "SCROLL_UP",
    targetId: "s1",
  });
  // The same label hidden in two containers is ambiguous; a step gives up after 15 scrolls.
  const twin = page({ SCROLL_DOWN: { s1: list, s3: container("s3", "Archive", ["Item 30"]) } });
  expect(resolveFast(input, 0, twin, [])).toBeNull();
  const tried = Array.from({ length: 15 }, () => ({
    stepIndex: 0,
    operation: "SCROLL_DOWN",
    source: "fast",
    rule: "reveal",
  }));
  expect(resolveFast(input, 0, screen, tried)).toBeNull();
  const hiddenField = page({ SCROLL_DOWN: { s2: filters } });
  expect(resolveFast(input, 4, hiddenField, [])).toMatchObject({ operation: "SCROLL_DOWN", targetId: "s2" });
});

test("scrolling names its container, or the page, once containers can scroll", () => {
  const screen = page({
    SCROLL_DOWN: { s1: container("s1", "Results", items(8, 40)), page: target("page", "Page", "scrollable") },
  });
  const input = run([
    { instruction: "Scroll down the Results list" },
    { instruction: "Scroll down" },
    { instruction: "Scroll down the page" },
    { instruction: "Scroll down in the Sidebar" },
  ]);
  expect(resolveFast(input, 0, screen, [])).toMatchObject({ operation: "SCROLL_DOWN", targetId: "s1", rule: "scroll" });
  expect(resolveFast(input, 1, screen, [])).toMatchObject({ operation: "SCROLL_DOWN", targetId: "page" });
  expect(resolveFast(input, 2, screen, [])).toMatchObject({ operation: "SCROLL_DOWN", targetId: "page" });
  expect(resolveFast(input, 3, screen, [])).toBeNull();
  const containersOnly = page({ SCROLL_DOWN: { s1: container("s1", "Results", items(8, 40)) } });
  expect(resolveFast(input, 1, containersOnly, [])).toBeNull();
});

// Delete and Edit buttons in three order rows, and two sections that each have a Pay: a link and a button.
const repeated = page({
  CLICK: {
    e1: target("e1", "Edit", "button", { context: "Order #1001 Ada Edit Delete | Orders" }),
    e2: target("e2", "Delete", "button", { context: "Order #1001 Ada Edit Delete | Orders" }),
    e3: target("e3", "Edit", "button", { context: "Order #1002 Grace Edit Delete | Orders" }),
    e4: target("e4", "Delete", "button", { context: "Order #1002 Grace Edit Delete | Orders" }),
    e5: target("e5", "Pay", "link", { context: "Billing" }),
    e6: target("e6", "Pay", "button", { context: "Shipping" }),
  },
});
const clicked = (instruction: string) => resolveFast(run([instruction]), 0, repeated, [])?.targetId;

test("controls with the same label are told apart by place, kind and position", () => {
  expect(clicked("Click Delete in the row of Order #1002")).toBe("e4");
  expect(clicked("Click the Edit button in the row for Order #1001")).toBe("e1");
  expect(clicked("Click Pay in the Shipping section")).toBe("e6");
  expect(clicked("Click the Pay link")).toBe("e5");
  expect(clicked("Click the Pay button")).toBe("e6");
  expect(clicked("Click the second Edit button")).toBe("e3");
  expect(clicked("Click the first Delete")).toBe("e2");
  expect(clicked("Click the last Edit")).toBe("e3");
  expect(clicked("Click the 2nd Delete button")).toBe("e4");
  expect(clicked("Click the second Delete in the row of Order #1001")).toBeUndefined();
});

test("a place, kind or position that does not narrow to one control is never guessed", () => {
  // Several left, or none: the model decides.
  expect(clicked("Click Delete")).toBeUndefined();
  expect(clicked("Click Pay")).toBeUndefined();
  expect(clicked("Click Delete in the row of Order #9999")).toBeUndefined();
  expect(clicked("Click Delete in the row of Order")).toBeUndefined();
  expect(clicked("Click the Edit link")).toBeUndefined();
  expect(clicked("Click the third Delete")).toBeUndefined();
  expect(clicked("Click Delete in the Billing section")).toBeUndefined();
});

test("words that look like a place are part of the label when the label has them", () => {
  const labels = page({
    CLICK: {
      e1: target("e1", "Sign in with Google", "button"),
      e2: target("e2", "Log in", "link"),
      e3: target("e3", "Save", "button"),
    },
  });
  const click = (instruction: string) => resolveFast(run([instruction]), 0, labels, [])?.targetId;
  expect(click("Click Sign in with Google")).toBe("e1");
  expect(click("Click Log in link")).toBe("e2");
  expect(click("Click the Save button from the toolbar")).toBe("e3");
});

test("every kind of control can be named, and the one the page puts somewhere else is not chosen", () => {
  const mixed = page({
    CLICK: {
      e1: target("e1", "Alerts", "tab"),
      e2: target("e2", "Alerts", "menuitem"),
      e3: target("e3", "Alerts", "checkbox"),
      e4: target("e4", "Alerts", "radio"),
      e5: target("e5", "Alerts", "switch"),
      e6: target("e6", "Alerts", "button"),
      e7: target("e7", "Save", "button", { context: "Settings" }),
    },
  });
  const click = (instruction: string) => resolveFast(run([instruction]), 0, mixed, [])?.targetId;
  expect(click("Click the Alerts tab")).toBe("e1");
  expect(click("Click the Alerts menu item")).toBe("e2");
  expect(click("Click the Alerts checkbox")).toBe("e3");
  expect(click("Click the Alerts radio")).toBe("e4");
  expect(click("Click the Alerts switch")).toBe("e5");
  expect(click("Click the Alerts button")).toBe("e6");
  // The only Save is in Settings, and the step says Billing: it is not the one meant.
  expect(click("Click Save in the Billing section")).toBeUndefined();
  expect(click("Click Save in the Settings section")).toBe("e7");
  // A clause that is not a place is dropped to find the label.
  expect(click("Click Save at the top")).toBe("e7");
  expect(click("Click Save on the left")).toBe("e7");
});

test("a row can be named by its number alone", () => {
  expect(clicked("Click Delete in row 1002")).toBe("e4");
  expect(clicked("Click Edit in rows with Order #1001")).toBe("e1");
});
