import { afterEach, beforeEach, expect, test } from "bun:test";
import { Browser, StaleDecisionError } from "../../src/browser.ts";
import type { Decision, Observation } from "../../src/contracts.ts";

let browser: Browser;
beforeEach(async () => {
  browser = new Browser(
    `jev-guard-${crypto.randomUUID()}`,
    Date.now() + 20_000,
  );
  await browser.command(["open", new URL("./app.html", import.meta.url).href]);
});
afterEach(async () => {
  await browser.command(["close"]);
});

function choice(
  observed: Observation,
  operation: string,
  label: string,
): Decision {
  const selected = Object.entries(observed.targets[operation] ?? {}).find(
    ([, target]) => target.label === label,
  );
  if (!selected || !observed.snapshotId)
    throw new Error(`Missing observed ${label}`);
  return {
    operation,
    targetId: selected[0],
    target: selected[1],
    snapshotId: observed.snapshotId,
    actionId: crypto.randomUUID(),
    confidence: 1,
  };
}

test("observes native options and checkbox states without treating select as text input", async () => {
  const observed = await browser.observe();
  expect(choice(observed, "SELECT", "Category → Design").target?.value).toBe(
    "Design",
  );
  expect(choice(observed, "CLICK", "Free cancellation").target?.checked).toBe(
    "false",
  );
  expect(
    Object.values(observed.targets.TYPE_TEXT ?? {}).some(
      (target) => target.label === "Category",
    ),
  ).toBe(false);
  await browser.execute(choice(observed, "TYPE_TEXT", "Destination"), "Lisbon");
  expect(
    (await browser.observe()).elements.find(
      (element) => element.label === "Destination",
    )?.value,
  ).toBe("Lisbon");
});

test("rejects a same-label replacement node at dispatch", async () => {
  const observed = await browser.observe();
  const selected = choice(observed, "CLICK", "Find stays");
  await browser.command([
    "eval",
    '(() => { const node = document.querySelector("button"); const replacement = node.cloneNode(true); replacement.type="button"; replacement.onclick=()=>document.body.dataset.replacementClicked="yes"; node.replaceWith(replacement); })()',
  ]);
  await expect(browser.execute(selected)).rejects.toBeInstanceOf(
    StaleDecisionError,
  );
  expect(
    await browser.command([
      "eval",
      'document.body.dataset.replacementClicked ?? "no"',
    ]),
  ).toMatchObject({
    result: "no",
    origin: new URL("./app.html", import.meta.url).href,
  });
});

test("rejects input covered by an overlay", async () => {
  const selected = choice(await browser.observe(), "CLICK", "Find stays");
  await browser.command([
    "eval",
    '(() => { const overlay=document.createElement("div"); overlay.style="position:fixed;inset:0;z-index:999999;background:white"; document.body.append(overlay); })()',
  ]);
  await expect(browser.execute(selected)).rejects.toBeInstanceOf(
    StaleDecisionError,
  );
});

test("rejects changed form values after a decision", async () => {
  const selected = choice(await browser.observe(), "CLICK", "Find stays");
  await browser.command([
    "eval",
    'document.querySelector("input").value="changed"',
  ]);
  await expect(browser.execute(selected)).rejects.toBeInstanceOf(
    StaleDecisionError,
  );
});

test("selects the observed option when options share a value", async () => {
  await browser.command([
    "eval",
    '(() => { const options=document.querySelector("select").options; options[1].value="shared"; options[2].value="shared"; })()',
  ]);
  await browser.execute(
    choice(await browser.observe(), "SELECT", "Category → Nature"),
  );
  expect(
    await browser.command([
      "eval",
      'document.querySelector("select").selectedOptions[0].textContent',
    ]),
  ).toMatchObject({ result: "Nature" });
});

for (const mutation of ["swap-values", "replace-option", "disable-group"]) {
  test(`rejects a dropdown choice after ${mutation} without emitting input`, async () => {
    await browser.command([
      "eval",
      '(() => { const select=document.querySelector("select"); select.innerHTML="<option>All</option><optgroup label=Styles><option value=Design>Design</option><option value=Nature>Nature</option></optgroup>"; document.body.dataset.events="0"; for(const type of ["input","change"]) select.addEventListener(type,()=>document.body.dataset.events=String(Number(document.body.dataset.events)+1)); })()',
    ]);
    const selected = choice(
      await browser.observe(),
      "SELECT",
      "Category → Design",
    );
    const script =
      mutation === "swap-values"
        ? 'const options=document.querySelector("select").options; options[1].value="Nature"; options[2].value="Design";'
        : mutation === "replace-option"
          ? 'const option=document.querySelector("select").options[1]; option.replaceWith(option.cloneNode(true));'
          : 'document.querySelector("optgroup").disabled=true;';
    await browser.command(["eval", `(() => { ${script} })()`]);
    await expect(browser.execute(selected)).rejects.toBeInstanceOf(
      StaleDecisionError,
    );
    expect(
      await browser.command([
        "eval",
        '({selected:document.querySelector("select").selectedOptions[0].textContent,events:document.body.dataset.events})',
      ]),
    ).toMatchObject({ result: { selected: "All", events: "0" } });
  });
}

test("an acknowledged action id cannot execute twice", async () => {
  await browser.command([
    "eval",
    '(() => { const button=document.querySelector("button"); button.type="button"; button.onclick=()=>document.body.dataset.clicks=String(Number(document.body.dataset.clicks ?? 0)+1); })()',
  ]);
  const selected = choice(await browser.observe(), "CLICK", "Find stays");
  await browser.execute(selected);
  await browser.execute(selected);
  expect(await browser.receipt(selected.actionId ?? "")).toBe("executed");
  const result = await browser.command([
    "eval",
    "document.body.dataset.clicks",
  ]);
  expect(result).toMatchObject({ result: "1" });
});

test("an explicit test binding prevents typing into a different selected field", async () => {
  const selected = choice(await browser.observe(), "TYPE_TEXT", "Destination");
  await expect(
    browser.execute(
      { ...selected, expectedSelector: "#another-field" },
      "fixture-secret",
    ),
  ).rejects.toBeInstanceOf(StaleDecisionError);
  expect(
    (await browser.observe()).elements.find(
      (element) => element.label === "Destination",
    )?.value,
  ).toBe("");
});

test("password contents stay out of model observations", async () => {
  await browser.command([
    "eval",
    '(() => { const input=document.querySelector("input"); input.type="password"; input.value="fixture-secret"; })()',
  ]);
  expect(JSON.stringify(await browser.observe())).not.toContain(
    "fixture-secret",
  );
});

test("deterministic assertions check real form values and fail absent outcomes", async () => {
  const observed = await browser.observe();
  await browser.execute(choice(observed, "SELECT", "Category → Design"));
  expect(
    (
      await browser.assert([
        { selector: "[name=category]", value: "Design", timeoutMs: 0 },
      ])
    ).passed,
  ).toBe(true);
  expect(
    (await browser.assert([{ text: "Never rendered", timeoutMs: 0 }])).passed,
  ).toBe(false);
  expect(
    (
      await browser.assert([
        { selector: "#not-present", count: 0, timeoutMs: 0 },
      ])
    ).passed,
  ).toBe(true);
});

test("ARIA checkboxes and open shadow-root buttons are executable", async () => {
  await browser.command([
    "eval",
    '(() => { document.body.innerHTML="<button role=checkbox aria-checked=false>Enable custom</button><div id=host></div>"; const checkbox=document.querySelector("button"); checkbox.onclick=()=>checkbox.setAttribute("aria-checked","true"); const root=document.getElementById("host").attachShadow({mode:"open"}); root.innerHTML="<button>Save shadow</button>"; root.querySelector("button").onclick=event=>event.target.textContent="Saved shadow"; })()',
  ]);
  let observed = await browser.observe();
  await browser.execute(choice(observed, "CLICK", "Enable custom"));
  expect(
    (
      await browser.assert([
        { selector: "[role=checkbox]", checked: true, timeoutMs: 0 },
      ])
    ).passed,
  ).toBe(true);
  observed = await browser.observe();
  await browser.execute(choice(observed, "CLICK", "Save shadow"));
  expect((await browser.observe()).text).toContain("Saved shadow");
});
